/**
 * oauth.refresh · renueva los tokens que están por vencer.
 *
 * Cada 15 minutos (job_definition.default_cron) busca las conexiones
 * activas por OAuth directo cuyo access token vence dentro del margen
 * (OAUTH_REFRESH_MARGIN_MINUTES, 30 por defecto), las agrupa por
 * plataforma y renueva hasta max_concurrency a la vez por plataforma.
 *
 * Por conexión:
 *   1. lee los tokens del SecretStore por secret_ref
 *   2. llama al TokenRefresher de su platform_id
 *   3. guarda los tokens nuevos en el SecretStore (PRIMERO: si después
 *      falla el UPDATE, la próxima corrida vuelve a intentarlo con el
 *      refresh token ya rotado, que sigue siendo válido)
 *   4. UPDATE social_connection con las fechas nuevas
 *
 * Fallo transitorio (red, 5xx, rate limit, o nuestro propio almacén de
 * secretos sin la credencial): cuenta como failed, no toca el estado, y
 * pg-boss reintenta salvo que reintentar no ayude (rate limit, conector
 * sin implementar). Fallo definitivo, y solo cuando lo dice LA PLATAFORMA
 * (invalid_grant, revocado) o el refresh token ya venció: status =
 * needs_reauth, status_detail en español y una fila en notification para
 * que el creador lo vea. Un problema nuestro nunca cambia el estado de la
 * cuenta de un creador.
 *
 * Dos corridas no se pisan: la cola es 'stately' (una activa) y, por si
 * acaso, el UPDATE final exige que access_expires_at siga siendo el que
 * leímos.
 *
 * Aquí NO hay tokens en logs ni en metadata: solo ids y fechas.
 */
import { PLATFORM_IDS, TokenRefreshError, type OAuthTokens, type PlatformId, isPlatformId } from '@mc/connectors';
import { envInt } from '../../runner/config.ts';
import type { JobDatabase, Queryable } from '../../runner/db.ts';
import { defineJob, type JobContext, type JobPayload } from '../../runner/registry.ts';
import { mapLimit } from '../../runner/concurrency.ts';

export interface OAuthRefreshPayload extends JobPayload {
  /** Renovar solo esta conexión (p. ej. desde la pantalla Conexiones), sin mirar el margen. */
  connectionId?: string;
  /** Sobrescribe OAUTH_REFRESH_MARGIN_MINUTES para esta corrida. */
  marginMinutes?: number;
}

export interface ConnectionRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  platform_id: string;
  handle: string | null;
  secret_ref: string;
  access_expires_at: Date | string | null;
  refresh_expires_at: Date | string | null;
}

export const PLATFORM_NAMES: Record<PlatformId, string> = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  facebook: 'Facebook',
  youtube: 'YouTube',
};

export const DEFAULT_MARGIN_MINUTES = 30;
/**
 * Margen por plataforma cuando el token dura semanas: el de Instagram vive
 * 60 días y Meta solo lo renueva con más de 24 h de vida y al menos 24 h
 * de antigüedad. Renovarlo a media hora del vencimiento sería jugársela;
 * 7 días es la opción conservadora (docs/propuestas/CON-3.md §0.2 · 9).
 * Se sobrescribe con OAUTH_REFRESH_MARGIN_MINUTES_<PLATAFORMA>.
 */
export const PLATFORM_MARGIN_MINUTES: Partial<Record<PlatformId, number>> = {
  instagram: 7 * 24 * 60,
};
const ENDPOINT = 'oauth.refresh';

/** Un margen pedido en el payload manda sobre el de la plataforma y sobre el entorno: es para ESA corrida. */
export function marginFor(platformId: string, baseMinutes: number, env: JobContext['env'], override?: number): number {
  if (override !== undefined) return override;
  if (!isPlatformId(platformId)) return baseMinutes;
  const fallback = PLATFORM_MARGIN_MINUTES[platformId] ?? baseMinutes;
  return envInt(env, `OAUTH_REFRESH_MARGIN_MINUTES_${platformId.toUpperCase()}`, fallback);
}

type Outcome =
  | { kind: 'renewed' }
  | { kind: 'needs_reauth'; code: string }
  | { kind: 'transient'; code: string; retryHelps: boolean };

/** Fallos que un reintento inmediato de pg-boss no va a arreglar. */
const RETRY_USELESS_CODES = new Set(['no_refresher', 'not_implemented', 'not_configured', 'missing_secret', 'rate_limit', 'invalid_client', 'invalid_request', 'unsupported_grant_type', 'invalid_scope', 'redirect_uri_mismatch']);

/** Una fila por plataforma con su propio corte; el UNION deja una sola consulta indexada por access_expires_at. */
export async function selectDueConnections(db: Queryable, payload: OAuthRefreshPayload, cutoffs: ReadonlyMap<string, Date> | Date): Promise<ConnectionRow[]> {
  if (payload.connectionId) {
    const { rows } = await db.query<ConnectionRow>(
      `SELECT id, workspace_id, platform_id, handle, secret_ref, access_expires_at, refresh_expires_at
         FROM social_connection
        WHERE id = $1 AND ($2::uuid IS NULL OR workspace_id = $2)
          AND status = 'active' AND deleted_at IS NULL AND access_mode = 'direct_oauth'`,
      [payload.connectionId, payload.workspaceId ?? null],
    );
    return rows;
  }
  const byPlatform = cutoffs instanceof Date ? new Map(PLATFORM_IDS.map((p) => [p, cutoffs])) : cutoffs;
  const platforms = [...byPlatform.keys()];
  const dates = platforms.map((p) => byPlatform.get(p)!);
  const { rows } = await db.query<ConnectionRow>(
    `SELECT c.id, c.workspace_id, c.platform_id, c.handle, c.secret_ref, c.access_expires_at, c.refresh_expires_at
       FROM social_connection c
       JOIN unnest($1::text[], $2::timestamptz[]) AS m(platform_id, cutoff) ON m.platform_id = c.platform_id
      WHERE c.status = 'active' AND c.deleted_at IS NULL AND c.access_mode = 'direct_oauth'
        AND c.access_expires_at IS NOT NULL AND c.access_expires_at <= m.cutoff
      ORDER BY c.access_expires_at ASC`,
    [platforms, dates],
  );
  return rows;
}

export function cutoffsFor(now: Date, baseMinutes: number, env: JobContext['env'], override?: number): Map<string, Date> {
  return new Map(PLATFORM_IDS.map((p) => [p, new Date(now.getTime() + marginFor(p, baseMinutes, env, override) * 60_000)]));
}

function asDate(v: Date | string | null): Date | null {
  if (v === null) return null;
  return v instanceof Date ? v : new Date(v);
}

function formatDateEs(d: Date): string {
  return new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }).format(d) + ' UTC';
}

export const oauthRefreshJob = defineJob<OAuthRefreshPayload>('oauth.refresh', async (payload, ctx) => {
  const marginMinutes = payload.marginMinutes ?? envInt(ctx.env, 'OAUTH_REFRESH_MARGIN_MINUTES', DEFAULT_MARGIN_MINUTES);
  const now = ctx.now();
  const cutoffs = cutoffsFor(now, marginMinutes, ctx.env, payload.marginMinutes);
  const due = await selectDueConnections(ctx.db, payload, cutoffs);
  ctx.logger.info('conexiones por renovar', { total: due.length, marginMinutes, cutoffs: Object.fromEntries([...cutoffs].map(([p, d]) => [p, d.toISOString()])) });

  const renewed: string[] = [];
  const needsReauth: string[] = [];
  const transient: string[] = [];
  const retryUseless: string[] = [];

  const byPlatform = new Map<string, ConnectionRow[]>();
  for (const c of due) byPlatform.set(c.platform_id, [...(byPlatform.get(c.platform_id) ?? []), c]);

  await Promise.all(
    [...byPlatform.entries()].map(([platform, rows]) =>
      mapLimit(rows, ctx.definition.maxConcurrency, async (conn) => {
        if (ctx.signal.aborted) {
          transient.push(conn.id);
          return;
        }
        const outcome = await refreshOne(conn, ctx, now).catch((err: unknown): Outcome => {
          // Un error nuestro (base, almacén) no puede tumbar el lote ni
          // cambiar el estado de la cuenta: cuenta como transitorio.
          ctx.logger.error('error inesperado renovando una conexión', { connectionId: conn.id, workspaceId: conn.workspace_id, platform, err });
          return { kind: 'transient', code: 'unexpected', retryHelps: true };
        });
        if (outcome.kind === 'renewed') renewed.push(conn.id);
        else if (outcome.kind === 'needs_reauth') needsReauth.push(conn.id);
        else {
          transient.push(conn.id);
          if (!outcome.retryHelps) retryUseless.push(conn.id);
        }
        ctx.logger.info('conexión procesada', { connectionId: conn.id, workspaceId: conn.workspace_id, platform, outcome: outcome.kind, code: 'code' in outcome ? outcome.code : undefined });
      }),
    ),
  );

  return {
    processed: renewed.length + needsReauth.length,
    failed: transient.length,
    // Si TODO lo que falló es de los que no mejoran con un reintento
    // inmediato, el siguiente tick del cron es el reintento.
    retry: transient.length > 0 && retryUseless.length < transient.length,
    metadata: { due: due.length, marginMinutes, renewed, needsReauth, transient },
  };
});

async function refreshOne(conn: ConnectionRow, ctx: JobContext, now: Date): Promise<Outcome> {
  const log = ctx.logger.child({ connectionId: conn.id, workspaceId: conn.workspace_id, platform: conn.platform_id });
  const platformName = isPlatformId(conn.platform_id) ? PLATFORM_NAMES[conn.platform_id] : conn.platform_id;

  const tokens = await ctx.secrets.get(conn.secret_ref);
  if (!tokens) {
    // Es un problema del almacén (mal configurado, ref perdida), no de
    // la cuenta del creador: no se toca su estado. Ruidoso en el log.
    log.error('el SecretStore no tiene credenciales para este secret_ref; revisa SECRET_STORE', { secretRef: conn.secret_ref });
    await markTransient(ctx.db, conn);
    return { kind: 'transient', code: 'missing_secret', retryHelps: false };
  }

  const refreshExpiry = tokens.refreshExpiresAt ?? asDate(conn.refresh_expires_at);
  if (refreshExpiry && refreshExpiry.getTime() <= now.getTime()) {
    return markNeedsReauth(ctx.db, conn, platformName, 'refresh_expired',
      `El permiso de renovación venció el ${formatDateEs(refreshExpiry)}; hay que volver a autorizar la cuenta.`, log);
  }

  const refresher = isPlatformId(conn.platform_id) ? ctx.refreshers.get(conn.platform_id) : undefined;
  if (!refresher) {
    log.error('no hay TokenRefresher para esta plataforma');
    await markTransient(ctx.db, conn);
    return { kind: 'transient', code: 'no_refresher', retryHelps: false };
  }

  const started = Date.now();
  let fresh: OAuthTokens;
  try {
    fresh = await refresher.refresh(tokens, { signal: ctx.signal, connectionId: conn.id, secretRef: conn.secret_ref });
  } catch (err) {
    const durationMs = Date.now() - started;
    const e = err instanceof TokenRefreshError
      ? err
      : new TokenRefreshError({ kind: 'transient', code: 'unexpected', messageEs: 'Error inesperado al renovar; se volverá a intentar.', cause: err });
    await logApiCall(ctx, conn, { ok: false, httpStatus: e.httpStatus ?? null, errorCode: e.code, errorMessage: e.messageEs, durationMs, rateLimited: e.isRateLimited, retryAfterS: e.retryAfterS ?? null });
    if (e.isPermanent) {
      return markNeedsReauth(ctx.db, conn, platformName, e.code, `${e.messageEs} (${e.code})`, log);
    }
    log.warn('renovación con fallo transitorio', { code: e.code, httpStatus: e.httpStatus, retryAfterS: e.retryAfterS, err: e.code === 'unexpected' ? err : undefined });
    await markTransient(ctx.db, conn);
    return { kind: 'transient', code: e.code, retryHelps: !e.isRateLimited && !RETRY_USELESS_CODES.has(e.code) };
  }
  const durationMs = Date.now() - started;
  await logApiCall(ctx, conn, { ok: true, httpStatus: 200, errorCode: null, errorMessage: null, durationMs, rateLimited: false, retryAfterS: null });

  // Primero el almacén, después la base (ver cabecera). Si el almacén
  // falla aquí, la plataforma ya rotó el refresh token y lo perdimos: es
  // lo más grave que puede pasar en este job, y se dice con esas palabras.
  try {
    await ctx.secrets.set(conn.secret_ref, fresh);
  } catch (err) {
    log.error('TOKENS RENOVADOS PERO NO GUARDADOS: el SecretStore falló al escribir; la plataforma ya rotó el refresh token', { secretRef: conn.secret_ref, err });
    await markTransient(ctx.db, conn);
    return { kind: 'transient', code: 'secret_store_write', retryHelps: false };
  }
  const updated = await ctx.db.query(
    `UPDATE social_connection
        SET access_expires_at = $3, refresh_expires_at = COALESCE($4, refresh_expires_at),
            scopes = CASE WHEN cardinality($5::text[]) > 0 THEN $5::text[] ELSE scopes END,
            status = 'active', status_detail = NULL, consecutive_failures = 0
      WHERE id = $1 AND workspace_id = $2 AND status = 'active'
        AND access_expires_at IS NOT DISTINCT FROM $6`,
    [conn.id, conn.workspace_id, fresh.accessExpiresAt, fresh.refreshExpiresAt ?? null, fresh.scopes, asDate(conn.access_expires_at)],
  );
  if (updated.rowCount === 0) {
    // Otra corrida la renovó (o la desactivó) mientras tanto. El almacén
    // ya tiene tokens válidos; no hay nada que deshacer.
    log.warn('la conexión cambió mientras se renovaba; se respeta el estado más reciente');
    return { kind: 'renewed' };
  }
  log.info('token renovado', { accessExpiresAt: fresh.accessExpiresAt.toISOString(), durationMs });
  return { kind: 'renewed' };
}

async function markNeedsReauth(db: JobDatabase, conn: ConnectionRow, platformName: string, code: string, detailEs: string, log: JobContext['logger']): Promise<Outcome> {
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE social_connection
          SET status = 'needs_reauth', status_detail = $3, last_error_at = now(), consecutive_failures = consecutive_failures + 1
        WHERE id = $1 AND workspace_id = $2`,
      [conn.id, conn.workspace_id, detailEs],
    );
    await tx.query(
      `INSERT INTO notification (workspace_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url)
       VALUES ($1, 'connection_error', 'critical', $2, $3, 'social_connection', $4, '/conexiones')`,
      [conn.workspace_id, `Vuelve a conectar tu cuenta de ${platformName}${conn.handle ? ` (${conn.handle})` : ''}`, detailEs, conn.id],
    );
  });
  log.warn('conexión pasa a needs_reauth', { code });
  return { kind: 'needs_reauth', code };
}

async function markTransient(db: JobDatabase, conn: ConnectionRow): Promise<void> {
  await db.query(
    `UPDATE social_connection SET last_error_at = now(), consecutive_failures = consecutive_failures + 1
      WHERE id = $1 AND workspace_id = $2`,
    [conn.id, conn.workspace_id],
  );
}

interface ApiCall {
  ok: boolean;
  httpStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number;
  rateLimited: boolean;
  retryAfterS: number | null;
}

/**
 * Bitácora de la llamada saliente por el sink de CON-1 (ctx.callLog →
 * api_call_log). Sin cuerpo de respuesta: solo código, estado y duración.
 * Un fallo al escribir el log no puede tumbar la renovación: se avisa y sigue.
 */
async function logApiCall(ctx: JobContext, conn: ConnectionRow, call: ApiCall): Promise<void> {
  if (!isPlatformId(conn.platform_id)) return;
  try {
    await ctx.callLog.record({
      connection_id: conn.id, platform_id: conn.platform_id, endpoint: ENDPOINT, http_status: call.httpStatus, ok: call.ok,
      error_code: call.errorCode, error_message: call.errorMessage, request_units: 1, duration_ms: call.durationMs,
      rate_limited: call.rateLimited, retry_after_s: call.retryAfterS,
    });
  } catch (err) {
    ctx.logger.warn('no se pudo escribir api_call_log; la renovación sigue', { connectionId: conn.id, err });
  }
}

/** Se mudó al runner (CAM-5 también la usa); se reexporta para no tocar a quien la importa de aquí. */
export { mapLimit } from '../../runner/concurrency.ts';
