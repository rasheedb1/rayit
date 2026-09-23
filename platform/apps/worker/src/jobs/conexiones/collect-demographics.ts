/**
 * collect.demographics · la audiencia de cada cuenta conectada, una vez
 * al día (cron 20 5, job_definition de 0009).
 *
 * Escribe `audience_breakdown` con scope 'account' y, cuando la
 * plataforma no entrega el dato, escribe POR QUÉ en `metric_gap`
 * (migración 0038) con el `message_es` de `metric_requirement`. Esa es
 * la historia entera: una celda vacía manda a la persona a WhatsApp; una
 * frase que dice qué le falta, no.
 *
 *   instagram  me/insights follower_demographics, un corte por llamada
 *              (edad, género, país, ciudad). Absolutos, no porcentajes.
 *   youtube    Analytics: viewerPercentage por ageGroup × gender, y
 *              views por país. Porcentajes; no suman 100 y se guardan
 *              tal cual (Analytics omite los tramos con pocas vistas).
 *   tiktok     Accounts API business/get: país, género y edad en una
 *              sola llamada. Porcentajes.
 *
 * Las tres exigen el token del dueño. Ninguna fuente pública da
 * demografía, así que una cuenta agregada por @ (CON-10) queda siempre
 * con su `metric_gap` de `owner_authorization`: es el hueco más común
 * del MVP y el que la pantalla más va a enseñar.
 *
 * Idempotencia: si ya hay filas de hoy para esa cuenta, se salta entera
 * y no se gasta ni una llamada. La tabla es append-only —nunca se borra
 * ni se corrige una fila— y el UNIQUE parcial de 0038 respalda el
 * `ON CONFLICT DO NOTHING`.
 *
 * ctx.db corre como mc_worker y se salta RLS: cada SELECT, INSERT,
 * UPDATE y DELETE de aquí lleva su workspace_id explícito.
 */
import { isPlatformApiError, type NormalizedDemographics } from '@mc/connectors';
import { mapLimit } from '../../runner/concurrency.ts';
import type { Queryable } from '../../runner/db.ts';
import { defineJob, type JobContext, type JobPayload } from '../../runner/registry.ts';
import {
  analyticsWindow, DEMOGRAPHICS_GROUP, dimensionsOf, planDemographics, requirementFromApiError,
  type DemographicsPlan,
} from './prerrequisitos-demografia.ts';

export interface CollectDemographicsPayload extends JobPayload {
  /** Solo esta cuenta (desde la pantalla). */
  connectionId?: string;
}

interface AccountRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  platform_id: string;
  handle: string | null;
  external_account_id: string;
  access_mode: string;
  account_type: string | null;
  status: string;
  scopes: string[] | string;
  secret_ref: string;
  followers: string | number | null;
  /** Las dimensiones que YA tienen fila de hoy para esta cuenta. */
  today_dimensions: string[] | string;
}

/** pg devuelve text[] como arreglo; alguna capa lo devuelve como '{a,b}'. */
function textArray(v: string[] | string): string[] {
  if (Array.isArray(v)) return v;
  const inner = v.replace(/^\{|\}$/g, '');
  return inner === '' ? [] : inner.split(',').map((s) => s.replace(/^"|"$/g, ''));
}

function numOrNull(v: string | number | null): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Lo que la plataforma entregó, y el fallo si lo hubo. Las dos cosas
 * juntas a propósito: Instagram son cuatro llamadas, y si la cuarta
 * falla, tirar las tres que ya respondieron gasta la cuota dos veces y
 * deja la pantalla sin lo que sí se pudo leer.
 */
interface DemographicsRead {
  rows: NormalizedDemographics;
  error?: unknown;
}

/** Las llamadas del plan, ya normalizadas a filas de audience_breakdown. */
async function readDemographics(ctx: JobContext, acc: AccountRow, plan: DemographicsPlan, pendientes: ReadonlySet<string>): Promise<DemographicsRead> {
  const tokens = await ctx.secrets.get(acc.secret_ref);
  if (!tokens) throw new Error(`El almacén no tiene el permiso de la conexión ${acc.id}; hay que volver a autorizarla.`);
  const auth = { connectionId: acc.id, tokens };
  const opts = { signal: ctx.signal };
  const rows: NormalizedDemographics = [];

  if (plan.platform === 'instagram') {
    const client = ctx.connectors.instagram(auth);
    // En serie a propósito: son cuatro llamadas a la MISMA conexión y el
    // límite de Instagram se cuenta por conexión y hora (CON-1 §0.4).
    for (const breakdown of plan.breakdowns) {
      if (!pendientes.has(breakdown)) continue;
      try {
        const { data } = await client.audienceDemographics('followers', breakdown, opts);
        rows.push(...data);
      } catch (error) {
        // El primer fallo corta: los cuatro cortes comparten token,
        // cuota y cuenta, así que lo que tumbó a uno tumbará a los demás.
        return { rows, error };
      }
    }
    return { rows };
  }
  const { startDate, endDate } = analyticsWindow(ctx.now());
  if (plan.platform === 'youtube') {
    const client = ctx.connectors.youtube(auth);
    try {
      if (pendientes.has('age_gender')) rows.push(...(await client.channelDemographics(startDate, endDate, opts)).data);
      if (pendientes.has('country')) rows.push(...(await client.countryBreakdown(null, startDate, endDate, opts)).data);
    } catch (error) {
      return { rows, error };
    }
    return { rows };
  }
  // TikTok entrega las tres dimensiones en UNA llamada: no hay nada
  // parcial que salvar, y `pendientes` ya dijo que falta alguna.
  const client = ctx.connectors.tiktokAccounts(auth, acc.external_account_id);
  const { data } = await client.accountInfo({ ...opts, startDate, endDate });
  return { rows: data.demographics };
}

/** Guarda las filas del día. Append-only: el UNIQUE parcial de 0038 respalda el ON CONFLICT DO NOTHING. */
async function saveRows(tx: Queryable, acc: AccountRow, day: string, rows: NormalizedDemographics): Promise<void> {
  await tx.query(
    `INSERT INTO audience_breakdown (workspace_id, scope, connection_id, day, population, dimension, bucket, share, absolute)
     SELECT $1, 'account', $2, $3::date, t.population, t.dimension, t.bucket, t.share, t.absolute
       FROM unnest($4::text[], $5::text[], $6::text[], $7::numeric[], $8::bigint[])
         AS t(population, dimension, bucket, share, absolute)
     ON CONFLICT DO NOTHING`,
    [
      acc.workspace_id, acc.id, day,
      rows.map((d) => d.population), rows.map((d) => d.dimension),
      rows.map((d) => d.bucket), rows.map((d) => d.share), rows.map((d) => d.absolute),
    ],
  );
}

/**
 * Deja escrito el requisito que falta. Una fila viva por (conexión,
 * grupo): la de hoy reemplaza a la de ayer.
 *
 * `day` NO se mueve mientras sea el mismo requisito: es «desde cuándo»,
 * y pisarlo cada mañana convertiría «te falta autorizar desde hace tres
 * semanas» en «te falta autorizar desde hoy». Lo que sí se mueve en
 * cada corrida es `detected_at`, la última comprobación.
 */
async function writeGap(ctx: JobContext, acc: AccountRow, requirementId: string, day: string): Promise<void> {
  await ctx.db.query(
    `INSERT INTO metric_gap (workspace_id, connection_id, metric_group, requirement_id, day)
     VALUES ($1, $2, $3, $4, $5::date)
     ON CONFLICT (connection_id, metric_group) DO UPDATE
       SET requirement_id = EXCLUDED.requirement_id,
           day = CASE WHEN metric_gap.requirement_id = EXCLUDED.requirement_id THEN metric_gap.day ELSE EXCLUDED.day END,
           detected_at = now()`,
    [acc.workspace_id, acc.id, DEMOGRAPHICS_GROUP, requirementId, day],
  );
}

export const collectDemographicsJob = defineJob<CollectDemographicsPayload>('collect.demographics', async (payload, ctx) => {
  const day = ctx.now().toISOString().slice(0, 10);
  const { rows } = await ctx.db.query<AccountRow>(
    `SELECT c.id, c.workspace_id, c.platform_id, c.handle, c.external_account_id, c.access_mode,
            c.account_type, c.status, c.scopes, c.secret_ref,
            (SELECT s.followers FROM account_metric_snapshot s
              WHERE s.connection_id = c.id AND s.workspace_id = c.workspace_id
              ORDER BY s.day DESC, s.captured_at DESC LIMIT 1) AS followers,
            COALESCE((SELECT array_agg(DISTINCT a.dimension) FROM audience_breakdown a
                       WHERE a.scope = 'account' AND a.connection_id = c.id
                         AND a.workspace_id = c.workspace_id AND a.day = $3::date), '{}') AS today_dimensions
       FROM social_connection c
      WHERE c.deleted_at IS NULL AND c.status IN ('active', 'error', 'needs_reauth')
        AND ($1::uuid IS NULL OR c.id = $1) AND ($2::uuid IS NULL OR c.workspace_id = $2)
      ORDER BY c.platform_id, c.connected_at`,
    [payload.connectionId ?? null, payload.workspaceId ?? null, day],
  );

  const saved: string[] = [];
  const empty: string[] = [];
  const alreadyToday: string[] = [];
  const gaps: Record<string, string> = {};
  const unsupported: string[] = [];
  const errored: string[] = [];
  const transient: string[] = [];
  let onlyQuota = true;

  const byPlatform = new Map<string, AccountRow[]>();
  for (const r of rows) byPlatform.set(r.platform_id, [...(byPlatform.get(r.platform_id) ?? []), r]);

  await Promise.all(
    [...byPlatform.entries()].map(async ([platform, accounts]) =>
      mapLimit(accounts, ctx.definition.maxConcurrency, async (acc) => {
        if (ctx.signal.aborted) { transient.push(acc.id); onlyQuota = false; return; }
        const log = ctx.logger.child({ connectionId: acc.id, workspaceId: acc.workspace_id, platform, accessMode: acc.access_mode });

        // 1 · Los prerrequisitos, con lo que ya está en la base.
        const decision = planDemographics({
          platformId: acc.platform_id, accessMode: acc.access_mode, accountType: acc.account_type,
          status: acc.status, scopes: textArray(acc.scopes), followers: numOrNull(acc.followers),
        });
        if (!decision.ok) {
          if (decision.requirementId === null) {
            unsupported.push(acc.id);
            log.info('la red no entrega demografía de cuenta', { reason: decision.reason });
            return;
          }
          await writeGap(ctx, acc, decision.requirementId, day);
          gaps[acc.id] = decision.requirementId;
          log.info('sin demografía: falta un prerrequisito', { requirement: decision.requirementId });
          return;
        }

        // 2 · Lo que YA hay de hoy no se vuelve a pedir. Por dimensión y
        //     no por cuenta: una corrida que se cortó a medias (el cuarto
        //     corte de Instagram) la completa la siguiente, en vez de
        //     darse por hecha porque había «algo» del día.
        const yaHoy = new Set(textArray(acc.today_dimensions));
        const pendientes = new Set(dimensionsOf(decision.plan).filter((d) => !yaHoy.has(d)));
        if (pendientes.size === 0) { alreadyToday.push(acc.id); log.debug('ya está toda la demografía de hoy'); return; }

        // 3 · Solo ahora se llama.
        let leido: DemographicsRead;
        try {
          leido = await readDemographics(ctx, acc, decision.plan, pendientes);
        } catch (err) {
          leido = { rows: [], error: err };
        }
        // Lo que sí respondió se guarda, aunque después algo fallara: la
        // cuota ya se gastó y la pantalla puede enseñarlo.
        if (leido.rows.length > 0) {
          await ctx.db.transaction(async (tx) => {
            await saveRows(tx, acc, day, leido.rows);
            // El hueco de ayer deja de existir en cuanto el dato llega.
            await tx.query(
              `DELETE FROM metric_gap WHERE connection_id = $1 AND workspace_id = $2 AND metric_group = $3`,
              [acc.id, acc.workspace_id, DEMOGRAPHICS_GROUP],
            );
          });
        }
        try {
          if (leido.error !== undefined) throw leido.error;
          // Respuesta buena pero sin filas: YouTube Analytics devuelve la
          // tabla vacía cuando hay muy pocas vistas. No es un dato, así
          // que no se guarda ni se borra el hueco que hubiera: mañana se
          // vuelve a preguntar.
          if (leido.rows.length === 0) {
            empty.push(acc.id);
            log.info('la plataforma respondió sin filas de demografía');
            return;
          }
          saved.push(acc.id);
          log.info('demografía guardada', { day, filas: leido.rows.length });
        } catch (err) {
          // 3a · La plataforma corrige nuestra evaluación previa: es un
          //      requisito, no un fallo. Se anota igual que si lo
          //      hubiéramos sabido antes.
          const requirementId = requirementFromApiError(acc.platform_id, err);
          if (requirementId !== null) {
            await writeGap(ctx, acc, requirementId, day);
            gaps[acc.id] = requirementId;
            log.info('la plataforma confirma que falta un prerrequisito', { requirement: requirementId });
            return;
          }
          if (isPlatformApiError(err) && err.kind === 'auth') {
            // El token ya no sirve: lo mismo que hace oauth.refresh.
            await ctx.db.query(
              `UPDATE social_connection SET status = 'needs_reauth', status_detail = $3, last_error_at = now(),
                      consecutive_failures = consecutive_failures + 1
                WHERE id = $1 AND workspace_id = $2`,
              [acc.id, acc.workspace_id, err.messageEs],
            );
            errored.push(acc.id);
            log.warn('la plataforma rechazó el token', { code: err.code });
            return;
          }
          if (isPlatformApiError(err) && err.kind === 'permanent') {
            // No toca onlyQuota: esta cuenta no entra en `transient`, y
            // un rechazo suyo no puede decidir si conviene reintentar la
            // cuota agotada de OTRA.
            errored.push(acc.id);
            log.warn('la plataforma rechazó la petición de demografía', { code: err.code, subcode: err.subcode });
            return;
          }
          if (!(isPlatformApiError(err) && err.kind === 'quota')) onlyQuota = false;
          transient.push(acc.id);
          log.warn('la demografía no se pudo leer; se reintenta', { code: isPlatformApiError(err) ? err.code : 'unexpected', err: isPlatformApiError(err) ? undefined : err });
        }
      }),
    ),
  );

  return {
    processed: saved.length + empty.length + alreadyToday.length + Object.keys(gaps).length + unsupported.length + errored.length,
    failed: transient.length,
    // Reintentar una cuota agotada en el mismo minuto no ayuda: el
    // siguiente tick del cron es el reintento (README del worker).
    retry: transient.length > 0 && onlyQuota ? false : undefined,
    metadata: { day, accounts: rows.length, saved, empty, alreadyToday, gaps, unsupported, errored, transient },
  };
});
