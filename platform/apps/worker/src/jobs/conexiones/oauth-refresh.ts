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
 * Fallo transitorio (red, 5xx, rate limit): cuenta como failed, no toca
 * el estado, y pg-boss reintenta. Fallo definitivo (invalid_grant,
 * revocado, refresh vencido): status = needs_reauth, status_detail en
 * español y una fila en notification para que el creador lo vea.
 *
 * Aquí NO hay tokens en logs ni en metadata: solo ids y fechas.
 */
import { TokenRefreshError, type OAuthTokens, type PlatformId, isPlatformId } from '@mc/connectors';
import { envInt } from '../../runner/config.ts';
import type { JobDatabase, Queryable } from '../../runner/db.ts';
import { defineJob, type JobContext, type JobPayload } from '../../runner/registry.ts';

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
const ENDPOINT = 'oauth.refresh';

type Outcome =
  | { kind: 'renewed' }
  | { kind: 'needs_reauth'; code: string }
  | { kind: 'transient'; code: string };

export async function selectDueConnections(db: Queryable, payload: OAuthRefreshPayload, cutoff: Date): Promise<ConnectionRow[]> {
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
  const { rows } = await db.query<ConnectionRow>(
    `SELECT id, workspace_id, platform_id, handle, secret_ref, access_expires_at, refresh_expires_at
       FROM social_connection
      WHERE status = 'active' AND deleted_at IS NULL AND access_mode = 'direct_oauth'
        AND access_expires_at IS NOT NULL AND access_expires_at <= $1
      ORDER BY access_expires_at ASC`,
    [cutoff],
  );
  return rows;
}

function asDate(v: Date | string | null): Date | null {
  if (v === null) return null;
  return v instanceof Date ? v : new Date(v);
}

function fechaEs(d: Date): string {
  return new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }).format(d) + ' UTC';
}

export const oauthRefreshJob = defineJob<OAuthRefreshPayload>('oauth.refresh', async (payload, ctx) => {
  const marginMinutes = payload.marginMinutes ?? envInt(ctx.env, 'OAUTH_REFRESH_MARGIN_MINUTES', DEFAULT_MARGIN_MINUTES);
  const now = ctx.now();
  const cutoff = new Date(now.getTime() + marginMinutes * 60_000);
  const due = await selectDueConnections(ctx.db, payload, cutoff);
  ctx.logger.info('conexiones por renovar', { total: due.length, marginMinutes, cutoff: cutoff.toISOString() });

  const renewed: string[] = [];
  const needsReauth: string[] = [];
  const transient: string[] = [];

  const byPlatform = new Map<string, ConnectionRow[]>();
  for (const c of due) byPlatform.set(c.platform_id, [...(byPlatform.get(c.platform_id) ?? []), c]);

  await Promise.all(
    [...byPlatform.entries()].map(([platform, rows]) =>
      mapLimit(rows, ctx.definition.maxConcurrency, async (conn) => {
        if (ctx.signal.aborted) {
          transient.push(conn.id);
          return;
        }
        const outcome = await refreshOne(conn, ctx, now);
        if (outcome.kind === 'renewed') renewed.push(conn.id);
        else if (outcome.kind === 'needs_reauth') needsReauth.push(conn.id);
        else transient.push(conn.id);
        ctx.logger.info('conexión procesada', { connectionId: conn.id, workspaceId: conn.workspace_id, platform, resultado: outcome.kind, code: 'code' in outcome ? outcome.code : undefined });
      }),
    ),
  );

  return {
    processed: renewed.length + needsReauth.length,
    failed: transient.length,
    metadata: { due: due.length, marginMinutes, renewed, needsReauth, transient },
  };
});

async function refreshOne(conn: ConnectionRow, ctx: JobContext, now: Date): Promise<Outcome> {
  const log = ctx.logger.child({ connectionId: conn.id, workspaceId: conn.workspace_id, platform: conn.platform_id });
  const platformName = isPlatformId(conn.platform_id) ? PLATFORM_NAMES[conn.platform_id] : conn.platform_id;

  const tokens = await ctx.secrets.get(conn.secret_ref);
  if (!tokens) {
    return markNeedsReauth(ctx.db, conn, platformName, 'missing_secret',
      'No hay credenciales guardadas para esta conexión; hay que volver a autorizar la cuenta.', log);
  }

  const refreshExpiry = tokens.refreshExpiresAt ?? asDate(conn.refresh_expires_at);
  if (refreshExpiry && refreshExpiry.getTime() <= now.getTime()) {
    return markNeedsReauth(ctx.db, conn, platformName, 'refresh_expired',
      `El permiso de renovación venció el ${fechaEs(refreshExpiry)}; hay que volver a autorizar la cuenta.`, log);
  }

  const refresher = isPlatformId(conn.platform_id) ? ctx.refreshers.get(conn.platform_id) : undefined;
  if (!refresher) {
    log.error('no hay TokenRefresher para esta plataforma (llega con CON-3/CON-8)');
    await markTransient(ctx.db, conn);
    return { kind: 'transient', code: 'no_refresher' };
  }

  const started = Date.now();
  let fresh: OAuthTokens;
  try {
    fresh = await refresher.refresh(tokens, { signal: ctx.signal });
  } catch (err) {
    const durationMs = Date.now() - started;
    const e = err instanceof TokenRefreshError
      ? err
      : new TokenRefreshError({ kind: 'transient', code: 'unexpected', messageEs: 'Error inesperado al renovar; se volverá a intentar.', cause: err });
    await logApiCall(ctx.db, conn, { ok: false, httpStatus: e.httpStatus ?? null, errorCode: e.code, errorMessage: e.messageEs, durationMs, rateLimited: e.isRateLimited, retryAfterS: e.retryAfterS ?? null });
    if (e.isPermanent) {
      return markNeedsReauth(ctx.db, conn, platformName, e.code, `${e.messageEs} (${e.code})`, log);
    }
    log.warn('renovación con fallo transitorio', { code: e.code, httpStatus: e.httpStatus, err: e.code === 'unexpected' ? err : undefined });
    await markTransient(ctx.db, conn);
    return { kind: 'transient', code: e.code };
  }
  const durationMs = Date.now() - started;
  await logApiCall(ctx.db, conn, { ok: true, httpStatus: 200, errorCode: null, errorMessage: null, durationMs, rateLimited: false, retryAfterS: null });

  // Primero el almacén, después la base (ver cabecera).
  await ctx.secrets.set(conn.secret_ref, fresh);
  await ctx.db.query(
    `UPDATE social_connection
        SET access_expires_at = $3, refresh_expires_at = COALESCE($4, refresh_expires_at),
            scopes = CASE WHEN cardinality($5::text[]) > 0 THEN $5::text[] ELSE scopes END,
            status = 'active', status_detail = NULL, consecutive_failures = 0
      WHERE id = $1 AND workspace_id = $2`,
    [conn.id, conn.workspace_id, fresh.accessExpiresAt, fresh.refreshExpiresAt ?? null, fresh.scopes],
  );
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

/** Bitácora de la llamada saliente. Sin cuerpo de respuesta: solo código, estado y duración. */
async function logApiCall(db: JobDatabase, conn: ConnectionRow, call: ApiCall): Promise<void> {
  await db.query(
    `INSERT INTO api_call_log (connection_id, platform_id, endpoint, http_status, ok, error_code, error_message, duration_ms, rate_limited, retry_after_s)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [conn.id, conn.platform_id, ENDPOINT, call.httpStatus, call.ok, call.errorCode, call.errorMessage, call.durationMs, call.rateLimited, call.retryAfterS],
  );
}

/** Ejecuta fn sobre items con a lo sumo `limit` en paralelo, conservando el orden de arranque. */
export async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) {
        const item = items[next++]!;
        await fn(item);
      }
    }),
  );
}
