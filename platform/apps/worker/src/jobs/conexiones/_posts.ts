/**
 * Lo que comparten collect.posts y collect.post_metrics (CON-5).
 *
 * Aquí vive la parte que no es «descubrir» ni «medir»: a qué cuentas
 * les toca, con qué fuente se leen, y cómo se anota lo que salió mal.
 * Los dos jobs se quedan con su trabajo y nada más.
 *
 * ctx.db corre como mc_worker, que se salta RLS: TODA consulta de este
 * archivo lleva workspace_id explícito.
 */
import {
  createAuthorizedPostSource,
  createPublicPostSources,
  isPlatformApiError,
  isPlatformId,
  PublicLookupError,
  type PostSource,
  type PostSourceTarget,
  type PostSources,
} from '@mc/connectors';
import type { Queryable } from '../../runner/db.ts';
import type { JobContext, JobPayload } from '../../runner/registry.ts';
import { connectionErrorSeverity, connectionErrorTitle, type BrokenAccountKind } from './aviso-cuenta.ts';
import { PLATFORM_NAMES } from './oauth-refresh.ts';

export interface CollectPayload extends JobPayload {
  /** Solo esta cuenta (desde la pantalla o una prueba). */
  connectionId?: string;
}

/** Una conexión de la que se pueden leer posts. */
export interface CollectableAccount extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  creator_id: string;
  platform_id: string;
  handle: string | null;
  external_account_id: string;
  access_mode: string;
  secret_ref: string;
}

/**
 * Las cuentas por @ (por la fuente oficial o por el proveedor de pago de
 * CON-12, 'aggregator') y las autorizadas, vivas y en un estado del que se
 * pueda leer. Una cuenta que collect.account_metrics pasó a 'aggregator'
 * conserva su id, así que sus posts siguen casando por (plataforma, id
 * externo, conexión) y no se duplican. Una cuenta en 'error' se vuelve a intentar: el error
 * anterior pudo ser de la plataforma, no de la cuenta. Una en
 * 'needs_reauth' no, porque el token ya no sirve y la llamada fallaría
 * igual; vuelve cuando el creador reautoriza.
 */
export async function selectCollectableAccounts(ctx: JobContext, payload: CollectPayload): Promise<CollectableAccount[]> {
  const { rows } = await ctx.db.query<CollectableAccount>(
    `SELECT id, workspace_id, creator_id, platform_id, handle, external_account_id, access_mode, secret_ref
       FROM social_connection
      WHERE access_mode IN ('public_profile', 'aggregator', 'direct_oauth') AND deleted_at IS NULL AND status IN ('active', 'error')
        AND ($1::uuid IS NULL OR id = $1) AND ($2::uuid IS NULL OR workspace_id = $2)
      ORDER BY platform_id, connected_at`,
    [payload.connectionId ?? null, payload.workspaceId ?? null],
  );
  return rows;
}

export function groupByPlatform<T extends { platform_id: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) out.set(r.platform_id, [...(out.get(r.platform_id) ?? []), r]);
  return out;
}

export type SourceChoice =
  | { kind: 'source'; source: PostSource; target: PostSourceTarget }
  | { kind: 'sin_fuente'; noteEs: string }
  | { kind: 'sin_configurar'; missing: readonly string[] };

/**
 * Qué fuente le toca a esta cuenta. `direct_oauth` usa el token del
 * dueño (y el almacén de secretos); cualquier otra, la fuente pública
 * de su plataforma. Una cuenta autorizada sin credencial en el almacén
 * NO es una cuenta rota: es un problema nuestro, y sale como
 * `sin_configurar`.
 */
export async function chooseSource(ctx: JobContext, acc: CollectableAccount, publicas: PostSources): Promise<SourceChoice> {
  if (acc.access_mode === 'direct_oauth') {
    const source = createAuthorizedPostSource(ctx.connectors.core, acc.platform_id);
    if (!source) return { kind: 'sin_fuente', noteEs: `Todavía no leemos publicaciones de ${platformName(acc.platform_id)} con el permiso del dueño.` };
    const tokens = await ctx.secrets.get(acc.secret_ref);
    if (!tokens) return { kind: 'sin_configurar', missing: ['connection_secret'] };
    return { kind: 'source', source, target: targetFor(acc, tokens) };
  }
  const source = isPlatformId(acc.platform_id) ? publicas[acc.platform_id] : undefined;
  if (!source) return { kind: 'sin_fuente', noteEs: `${platformName(acc.platform_id)} no tiene una fuente pública de publicaciones en esta versión.` };
  if (source.noPostsNoteEs !== null) return { kind: 'sin_fuente', noteEs: source.noPostsNoteEs };
  if (source.missing.length > 0) return { kind: 'sin_configurar', missing: source.missing };
  return { kind: 'source', source, target: targetFor(acc, null) };
}

function targetFor(acc: CollectableAccount, tokens: PostSourceTarget['tokens']): PostSourceTarget {
  return { connectionId: acc.id, handle: acc.handle, externalAccountId: acc.external_account_id, tokens };
}

export function platformName(platformId: string): string {
  return isPlatformId(platformId) ? PLATFORM_NAMES[platformId] : platformId;
}

export function sourcesFor(ctx: JobContext): PostSources {
  return createPublicPostSources(ctx.connectors.core, ctx.env);
}

// ---------------------------------------------------------------------
// Qué hacer con lo que salió mal
// ---------------------------------------------------------------------

export type Failure =
  | { kind: 'auth'; detailEs: string }
  | { kind: 'cuenta'; detailEs: string }
  | { kind: 'cuota'; detailEs: string; retryAfterS: number | null }
  | { kind: 'transitorio'; code: string };

/**
 * Traduce cualquier cosa que haya salido mal a lo que el job sabe
 * hacer. Los códigos vienen de CON-1 (PlatformApiError.kind) y de
 * CON-10 (PublicLookupError.code), sin inventar vocabulario nuevo.
 */
export function classifyFailure(err: unknown): Failure {
  if (isAborted(err)) return { kind: 'transitorio', code: 'aborted' };
  if (isPlatformApiError(err)) {
    if (err.kind === 'auth') return { kind: 'auth', detailEs: err.messageEs };
    if (err.kind === 'quota') return { kind: 'cuota', detailEs: err.messageEs, retryAfterS: err.retryAfterS ?? null };
    if (err.kind === 'permanent') return { kind: 'cuenta', detailEs: err.messageEs };
    return { kind: 'transitorio', code: err.code };
  }
  if (err instanceof PublicLookupError) {
    if (err.code === 'not_found' || err.code === 'not_discoverable' || err.code === 'invalid_handle') return { kind: 'cuenta', detailEs: err.messageEs };
    if (err.code === 'not_configured') {
      const causa = err.cause;
      // La credencial de la CASA vencida es problema nuestro; la del
      // creador, suya. Las dos llegan como not_configured, así que se
      // distinguen por quién la rechazó.
      if (isPlatformApiError(causa) && causa.kind === 'auth') return { kind: 'transitorio', code: 'house_credential' };
      return { kind: 'transitorio', code: 'not_configured' };
    }
    const causa = err.cause;
    if (isPlatformApiError(causa) && causa.kind === 'quota') return { kind: 'cuota', detailEs: causa.messageEs, retryAfterS: causa.retryAfterS ?? null };
    if (isPlatformApiError(causa) && causa.kind === 'auth') return { kind: 'auth', detailEs: causa.messageEs };
    return { kind: 'transitorio', code: err.code };
  }
  return { kind: 'transitorio', code: 'unexpected' };
}

/**
 * ¿Esto es un aborto nuestro? Llega de dos formas: como
 * PlatformApiError con code 'aborted' (HttpCore corta antes de llamar)
 * o envuelto en un PublicLookupError 'transient' por la fuente.
 */
export function isAborted(err: unknown): boolean {
  if (isPlatformApiError(err)) return err.code === 'aborted';
  if (err instanceof PublicLookupError) return isPlatformApiError(err.cause) && err.cause.code === 'aborted';
  return false;
}

/** Lo que necesita el aviso de una cuenta rota: la cuenta, su espacio, su red y su @. */
export type BrokenAccount = Pick<CollectableAccount, 'id' | 'workspace_id' | 'platform_id' | 'handle'>;

/**
 * El aviso de una cuenta que se rompió por un camino que no avisaba
 * (RES-3): la cuenta que ya no se puede leer ('error', aquí y en
 * collect.account_metrics) y el token rechazado al leer las métricas de
 * la cuenta. Es lo que «Lo que importa esta semana» enseña con su enlace
 * a Conexiones; sin aviso, la cuenta caía en silencio.
 *
 * También lo usa markNeedsReauth (el token rechazado al recolectar
 * posts): el título y la severidad viven en aviso-cuenta.ts, y
 * oauth.refresh toma de allí el mismo título.
 *
 * Como mucho uno por cuenta y por semana para la MISMA avería: la cuenta
 * en 'error' se vuelve a intentar cada día (selectCollectableAccounts) y
 * cada intento fallido pasa por aquí. Se escribe otro aviso si:
 *   - pasó una semana y sigue rota (sigue importando);
 *   - la avería subió de gravedad: un «No podemos leer» (warning) no
 *     calla el «Vuelve a conectar» (critical) del día siguiente, que
 *     tiene que ir arriba del bloque y no debajo de los cobros;
 *   - la cuenta se leyó bien después del último aviso
 *     (last_synced_at): es otra avería, aunque caiga en la misma semana.
 * Corre dentro de la transacción de quien cambia el estado de la cuenta:
 * el estado y su aviso entran juntos o no entra ninguno.
 */
export async function notifyBrokenAccount(db: Queryable, acc: BrokenAccount, kind: BrokenAccountKind, detailEs: string): Promise<void> {
  await db.query(
    `INSERT INTO notification (workspace_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url)
     SELECT $1::uuid, 'connection_error', $2, $3, $4, 'social_connection', $5::uuid, '/conexiones'
      WHERE NOT EXISTS (
        SELECT 1 FROM notification n
         WHERE n.workspace_id = $1::uuid AND n.kind = 'connection_error' AND n.entity_type = 'social_connection'
           AND n.entity_id = $5::uuid AND n.dismissed_at IS NULL AND n.created_at > now() - interval '7 days'
           AND NOT ($2::text = 'critical' AND n.severity <> 'critical')
           AND n.created_at >= coalesce(
                 (SELECT s.last_synced_at FROM social_connection s WHERE s.id = $5::uuid AND s.workspace_id = $1::uuid),
                 '-infinity'::timestamptz))`,
    [acc.workspace_id, connectionErrorSeverity(kind), connectionErrorTitle(platformName(acc.platform_id), acc.handle, kind), detailEs, acc.id],
  );
}

/** La cuenta del creador no se puede leer: queda en 'error' con la razón en español, y se avisa (RES-3). */
export async function markAccountError(ctx: JobContext, acc: CollectableAccount, detailEs: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await tx.query(
      `UPDATE social_connection
          SET status = 'error', status_detail = $3, last_error_at = now(), consecutive_failures = consecutive_failures + 1
        WHERE id = $1 AND workspace_id = $2`,
      [acc.id, acc.workspace_id, detailEs],
    );
    await notifyBrokenAccount(tx, acc, 'unreadable', detailEs);
  });
}

/**
 * El token del dueño ya no sirve: needs_reauth y una notificación, como
 * hace oauth.refresh. Sin esto el creador no se entera hasta que mira.
 * El aviso es el de notifyBrokenAccount: mismo título, misma severidad,
 * misma regla para no repetirse.
 */
export async function markNeedsReauth(ctx: JobContext, acc: CollectableAccount, detailEs: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await tx.query(
      `UPDATE social_connection
          SET status = 'needs_reauth', status_detail = $3, last_error_at = now(), consecutive_failures = consecutive_failures + 1
        WHERE id = $1 AND workspace_id = $2`,
      [acc.id, acc.workspace_id, detailEs],
    );
    await notifyBrokenAccount(tx, acc, 'reauth', detailEs);
  });
}

/** Un fallo pasajero se anota sin tocar el estado de la cuenta. */
export async function markTransient(ctx: JobContext, acc: CollectableAccount): Promise<void> {
  await ctx.db.query(
    `UPDATE social_connection SET last_error_at = now(), consecutive_failures = consecutive_failures + 1
      WHERE id = $1 AND workspace_id = $2`,
    [acc.id, acc.workspace_id],
  );
}

/** La lectura salió bien: se limpia lo que hubiera quedado de un intento anterior. */
export async function markRead(ctx: JobContext, acc: CollectableAccount, detailEs: string | null = null): Promise<void> {
  await ctx.db.query(
    `UPDATE social_connection
        SET last_error_at = NULL, consecutive_failures = 0, status_detail = $3,
            status = CASE WHEN status = 'error' THEN 'active' ELSE status END
      WHERE id = $1 AND workspace_id = $2`,
    [acc.id, acc.workspace_id, detailEs],
  );
}

/**
 * Anota el fallo donde toca y dice cómo contarlo. Devuelve 'cuota'
 * cuando hay que dejar de pedirle a esa plataforma por hoy.
 *
 * Un aborto NO se le apunta a la cuenta: apagar el worker o vencer el
 * timeout es cosa nuestra, y sumarlo a consecutive_failures acabaría
 * pintando de rota, en connection_health, una cuenta que está bien.
 */
export async function recordFailure(ctx: JobContext, acc: CollectableAccount, err: unknown, log: JobContext['logger']): Promise<Failure> {
  const fallo = ctx.signal.aborted ? ({ kind: 'transitorio', code: 'aborted' } as const) : classifyFailure(err);
  if (fallo.kind === 'transitorio' && fallo.code === 'aborted') {
    log.info('la corrida se abortó antes de terminar con esta cuenta; se retoma en la siguiente');
    return fallo;
  }
  if (fallo.kind === 'auth') {
    await markNeedsReauth(ctx, acc, fallo.detailEs);
    log.warn('la plataforma rechazó el token de la cuenta autorizada');
  } else if (fallo.kind === 'cuenta') {
    await markAccountError(ctx, acc, fallo.detailEs);
    log.warn('la cuenta ya no se puede leer', { detalle: fallo.detailEs });
  } else if (fallo.kind === 'cuota') {
    await markTransient(ctx, acc);
    log.warn('se acabó la cuota de la plataforma; el resto queda para la próxima corrida', { retryAfterS: fallo.retryAfterS });
  } else {
    await markTransient(ctx, acc);
    log.warn('lectura con fallo transitorio', { code: fallo.code, err: fallo.code === 'unexpected' ? err : undefined });
  }
  return fallo;
}
