/**
 * Consultas del módulo Conexiones (CON-3: alta por OAuth, consentimiento,
 * lista sobre connection_health y desconexión).
 *
 * Reglas (las mismas de queries/finanzas.ts):
 *   - Toda función recibe un WorkspaceTx: una transacción con el
 *     workspace ya fijado. Ninguna recibe workspace_id suelto. Las
 *     lecturas las filtra RLS; los INSERT usan current_workspace_id().
 *   - Las fechas timestamptz se devuelven como ISO 8601 (UTC).
 *   - Los tokens NUNCA pasan por aquí: solo `secret_ref`. Quien los
 *     guarda es el SecretStore de @mc/connectors, en la misma transacción.
 *
 * TODO(CIM-3): `getDefaultCreatorId` saldrá de la sesión.
 */
import type { WorkspaceTx } from '../client.ts';

// ---------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------

/** social_connection.platform_id (tabla platform, 0002). */
export type ConnectionPlatformId = 'tiktok' | 'instagram' | 'facebook' | 'youtube';
/** social_connection.status (CHECK en 0002). */
export type ConnectionStatus = 'active' | 'expired' | 'revoked' | 'error' | 'needs_reauth' | 'disabled';
/** social_connection.account_type (CHECK en 0002). */
export type ConnectionAccountType = 'personal' | 'creator' | 'business' | 'page' | 'channel' | 'unknown';
/** data_consent.purpose (CHECK en 0002). */
export type ConsentPurpose = 'analytics' | 'publishing' | 'audience_demographics' | 'brand_reporting' | 'ai_analysis' | 'data_sharing_with_brands';

export interface ConnectionListRow {
  id: string;
  platformId: ConnectionPlatformId;
  externalAccountId: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  accountType: ConnectionAccountType;
  status: ConnectionStatus;
  statusDetail: string | null;
  secretRef: string;
  scopes: string[];
  /** ISO. Última autorización del creador. */
  connectedAt: string;
  /** ISO o null si nunca se sincronizó. Nunca un cero. */
  lastSyncedAt: string | null;
  hoursSinceSync: number | null;
  accessExpiresAt: string | null;
  tokenExpiringSoon: boolean;
  consecutiveFailures: number;
  postsTracked: number;
  failedCalls24h: number;
}

export interface UpsertConnectionInput {
  creatorId: string;
  platformId: ConnectionPlatformId;
  externalAccountId: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  accountType: ConnectionAccountType;
  /** La ref del SecretStore, ya escrita en la misma transacción. */
  secretRef: string;
  scopes: readonly string[];
  accessExpiresAt: Date;
  refreshExpiresAt: Date | null;
  /** Instante de la autorización; por defecto now() de la base. */
  connectedAt?: Date;
}

export interface UpsertConnectionResult {
  id: string;
  /** true si la fila no existía; false si se reactivó/actualizó una cuenta ya conocida. */
  created: boolean;
}

export interface ExistingConnection {
  id: string;
  secretRef: string;
  deletedAt: string | null;
  status: ConnectionStatus;
}

export interface RecordConsentInput {
  connectionId: string;
  creatorId: string;
  purpose: ConsentPurpose;
  policyVersion: string;
  /** ip, userAgent, textShown, scopesRequested, scopesGranted, at. Sin tokens: el llamador lo pasa por redactSecrets. */
  evidence: Record<string, unknown>;
}

export interface ConsentRow {
  id: string;
  purpose: ConsentPurpose;
  granted: boolean;
  grantedAt: string;
  revokedAt: string | null;
  policyVersion: string;
}

export class ConnectionNotFound extends Error {
  constructor(id: string) {
    super(`No existe una conexión activa con id ${id} en este workspace.`);
    this.name = 'ConnectionNotFound';
  }
}

export class CreatorNotInWorkspace extends Error {
  constructor(creatorId: string) {
    super(`El perfil de creador ${creatorId} no pertenece a este workspace.`);
    this.name = 'CreatorNotInWorkspace';
  }
}

export class NoCreatorProfile extends Error {
  constructor() {
    super('Este workspace no tiene un perfil de creador; no se puede conectar una cuenta.');
    this.name = 'NoCreatorProfile';
  }
}

// ---------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------

interface ListRow {
  id: string;
  platform_id: ConnectionPlatformId;
  external_account_id: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  account_type: ConnectionAccountType | null;
  status: ConnectionStatus;
  status_detail: string | null;
  secret_ref: string;
  scopes: string[] | string;
  connected_at: string | Date;
  last_synced_at: string | Date | null;
  hours_since_sync: string | number | null;
  access_expires_at: string | Date | null;
  token_expiring_soon: boolean | null;
  consecutive_failures: number | string;
  posts_tracked: number | string;
  failed_calls_24h: number | string;
}

function iso(v: string | Date | null): string | null {
  if (v === null || v === undefined) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
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

/** Conexiones vivas del workspace sobre la vista connection_health (0010), con los datos de la fila que la vista no expone. */
export async function listConnections(tx: WorkspaceTx): Promise<ConnectionListRow[]> {
  const { rows } = await tx.query<ListRow>(
    `SELECT h.id, h.platform_id, c.external_account_id, h.handle, c.display_name, c.avatar_url, c.profile_url,
            h.account_type, h.status, c.status_detail, c.secret_ref, c.scopes, c.connected_at,
            h.last_synced_at, h.hours_since_sync, h.access_expires_at, h.token_expiring_soon,
            h.consecutive_failures, h.posts_tracked, h.failed_calls_24h
       FROM connection_health h
       JOIN social_connection c ON c.id = h.id
      ORDER BY h.platform_id, c.connected_at DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    platformId: r.platform_id,
    externalAccountId: r.external_account_id,
    handle: r.handle,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    profileUrl: r.profile_url,
    accountType: r.account_type ?? 'unknown',
    status: r.status,
    statusDetail: r.status_detail,
    secretRef: r.secret_ref,
    scopes: textArray(r.scopes),
    connectedAt: iso(r.connected_at)!,
    lastSyncedAt: iso(r.last_synced_at),
    hoursSinceSync: numOrNull(r.hours_since_sync),
    accessExpiresAt: iso(r.access_expires_at),
    tokenExpiringSoon: r.token_expiring_soon === true,
    consecutiveFailures: Number(r.consecutive_failures),
    postsTracked: Number(r.posts_tracked),
    failedCalls24h: Number(r.failed_calls_24h),
  }));
}

/**
 * La fila de esa cuenta en este workspace, esté viva o desconectada
 * (el UNIQUE de 0002 incluye las borradas). Sirve para reutilizar su
 * secret_ref al reconectar y no dejar ciphertexts huérfanos.
 */
export async function findConnectionByAccount(tx: WorkspaceTx, platformId: ConnectionPlatformId, externalAccountId: string): Promise<ExistingConnection | null> {
  const { rows } = await tx.query<{ id: string; secret_ref: string; deleted_at: string | Date | null; status: ConnectionStatus }>(
    `SELECT id, secret_ref, deleted_at, status FROM social_connection WHERE platform_id = $1 AND external_account_id = $2`,
    [platformId, externalAccountId],
  );
  const r = rows[0];
  return r ? { id: r.id, secretRef: r.secret_ref, deletedAt: iso(r.deleted_at), status: r.status } : null;
}

/** TODO(CIM-3): el creador vendrá de la sesión. Hoy, el perfil del workspace actual (RLS lo filtra). */
export async function getDefaultCreatorId(tx: WorkspaceTx): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(`SELECT id FROM creator_profile ORDER BY created_at ASC LIMIT 1`);
  const id = rows[0]?.id;
  if (!id) throw new NoCreatorProfile();
  return id;
}

/** Una fila del catálogo `metric_requirement` (0011): qué exige una red para entregar un grupo de métricas. */
export interface MetricRequirement {
  id: string;
  platformId: ConnectionPlatformId;
  metricGroup: string;
  requirement: string;
  /** El texto que ve el creador, en español. La pantalla no lo copia: lo lee de aquí. */
  messageEs: string;
  fixUrl: string | null;
}

/**
 * Un prerrequisito por su id ('tt.insights.optin'…). `metric_requirement`
 * es un catálogo GLOBAL de solo lectura: sin workspace_id, sin RLS y sin
 * escritura para mc_app (0024 §7.1). Se lee dentro de la transacción de
 * workspace que ya está abierta; no hace falta otra.
 */
export async function getMetricRequirement(tx: WorkspaceTx, id: string): Promise<MetricRequirement | null> {
  const { rows } = await tx.query<{ id: string; platform_id: ConnectionPlatformId; metric_group: string; requirement: string; message_es: string; fix_url: string | null }>(
    `SELECT id, platform_id, metric_group, requirement, message_es, fix_url FROM metric_requirement WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  return r ? { id: r.id, platformId: r.platform_id, metricGroup: r.metric_group, requirement: r.requirement, messageEs: r.message_es, fixUrl: r.fix_url } : null;
}

export async function listConsents(tx: WorkspaceTx, connectionId: string): Promise<ConsentRow[]> {
  const { rows } = await tx.query<{ id: string; purpose: ConsentPurpose; granted: boolean; granted_at: string | Date; revoked_at: string | Date | null; policy_version: string }>(
    `SELECT id, purpose, granted, granted_at, revoked_at, policy_version FROM data_consent WHERE connection_id = $1 ORDER BY granted_at ASC, purpose`,
    [connectionId],
  );
  return rows.map((r) => ({ id: r.id, purpose: r.purpose, granted: r.granted, grantedAt: iso(r.granted_at)!, revokedAt: iso(r.revoked_at), policyVersion: r.policy_version }));
}

// ---------------------------------------------------------------------
// Escrituras
// ---------------------------------------------------------------------

/**
 * Alta o reactivación por el UNIQUE (platform_id, external_account_id,
 * workspace_id): al reconectar se actualizan identidad, scopes y fechas,
 * y la fila vuelve a 'active' con status_detail y deleted_at en null.
 */
export async function upsertConnection(tx: WorkspaceTx, input: UpsertConnectionInput): Promise<UpsertConnectionResult> {
  // La FK a creator_profile se comprueba por debajo de RLS: sin esto, un
  // workspace podría colgar su conexión del creador de otro.
  const creator = await tx.query<{ id: string }>(`SELECT id FROM creator_profile WHERE id = $1`, [input.creatorId]);
  if (creator.rows.length === 0) throw new CreatorNotInWorkspace(input.creatorId);
  const { rows } = await tx.query<{ id: string; created: boolean }>(
    `INSERT INTO social_connection
       (workspace_id, creator_id, platform_id, external_account_id, handle, display_name, avatar_url, profile_url,
        account_type, secret_ref, scopes, access_expires_at, refresh_expires_at, access_mode, status, connected_at)
     VALUES (current_workspace_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11, $12, 'direct_oauth', 'active', COALESCE($13, now()))
     ON CONFLICT (platform_id, external_account_id, workspace_id) DO UPDATE
       SET creator_id = EXCLUDED.creator_id,
           handle = EXCLUDED.handle,
           display_name = EXCLUDED.display_name,
           avatar_url = EXCLUDED.avatar_url,
           profile_url = EXCLUDED.profile_url,
           account_type = EXCLUDED.account_type,
           secret_ref = EXCLUDED.secret_ref,
           scopes = EXCLUDED.scopes,
           access_expires_at = EXCLUDED.access_expires_at,
           refresh_expires_at = EXCLUDED.refresh_expires_at,
           access_mode = 'direct_oauth',
           status = 'active',
           status_detail = NULL,
           deleted_at = NULL,
           last_error_at = NULL,
           consecutive_failures = 0,
           connected_at = EXCLUDED.connected_at
     RETURNING id, (xmax = 0) AS created`,
    [
      input.creatorId, input.platformId, input.externalAccountId, input.handle, input.displayName, input.avatarUrl, input.profileUrl,
      input.accountType, input.secretRef, [...input.scopes], input.accessExpiresAt, input.refreshExpiresAt, input.connectedAt ?? null,
    ],
  );
  const r = rows[0]!;
  return { id: r.id, created: r.created === true };
}

/**
 * Una fila de consentimiento por finalidad. Si había una vigente para la
 * misma conexión y finalidad, se revoca primero: queda el historial y
 * una sola activa.
 */
export async function recordConsent(tx: WorkspaceTx, input: RecordConsentInput): Promise<string> {
  await tx.query(
    `UPDATE data_consent SET revoked_at = now() WHERE connection_id = $1 AND purpose = $2 AND revoked_at IS NULL`,
    [input.connectionId, input.purpose],
  );
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO data_consent (workspace_id, creator_id, connection_id, purpose, granted, policy_version, evidence)
     VALUES (current_workspace_id(), $1, $2, $3, true, $4, $5::jsonb) RETURNING id`,
    [input.creatorId, input.connectionId, input.purpose, input.policyVersion, JSON.stringify(input.evidence)],
  );
  return rows[0]!.id;
}

export const DISCONNECTED_DETAIL_ES = 'Desconectada por el creador.';

/**
 * Desconectar sin borrar: deleted_at, status 'disabled', consentimientos
 * revocados y el ciphertext fuera de connection_secret. Reconectar
 * vuelve a escribirlo en la misma ref.
 */
export async function disconnectConnection(tx: WorkspaceTx, id: string): Promise<{ id: string; secretRef: string }> {
  const { rows } = await tx.query<{ secret_ref: string }>(
    `UPDATE social_connection
        SET deleted_at = now(), status = 'disabled', status_detail = $2
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING secret_ref`,
    [id, DISCONNECTED_DETAIL_ES],
  );
  const secretRef = rows[0]?.secret_ref;
  if (!secretRef) throw new ConnectionNotFound(id);
  await tx.query(`UPDATE data_consent SET revoked_at = now() WHERE connection_id = $1 AND revoked_at IS NULL`, [id]);
  await tx.query(`DELETE FROM connection_secret WHERE secret_ref = $1`, [secretRef]);
  return { id, secretRef };
}

// ---------------------------------------------------------------------
// Cuentas por @ con datos públicos (CON-10)
// ---------------------------------------------------------------------

export const PUBLIC_SNAPSHOT_SOURCE = 'public_profile';
/** Lectura hecha con el token del dueño (cuenta autorizada): la misma que escribe el worker. */
export const API_SNAPSHOT_SOURCE = 'api';
/** Las fuentes que la pantalla considera «la última lectura» de la cuenta. */
export const ACCOUNT_SNAPSHOT_SOURCES: readonly string[] = [PUBLIC_SNAPSHOT_SOURCE, API_SNAPSHOT_SOURCE];

export interface AddPublicAccountInput {
  creatorId: string;
  platformId: ConnectionPlatformId;
  /** Sin @. */
  handle: string;
  externalAccountId: string;
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  accountType: ConnectionAccountType;
}

/** La ref de una cuenta pública no apunta a ningún secreto; la columna es NOT NULL. */
export function publicSecretRef(platformId: ConnectionPlatformId, handle: string): string {
  return `public:${platformId}:${handle.toLowerCase()}`;
}

/**
 * Alta o reactivación de una cuenta por @: misma clave natural que una
 * conexión autorizada (plataforma + id externo + workspace), con
 * access_mode 'public_profile' y sin tokens.
 */
export async function addPublicAccount(tx: WorkspaceTx, input: AddPublicAccountInput): Promise<UpsertConnectionResult> {
  const creator = await tx.query<{ id: string }>(`SELECT id FROM creator_profile WHERE id = $1`, [input.creatorId]);
  if (creator.rows.length === 0) throw new CreatorNotInWorkspace(input.creatorId);
  const { rows } = await tx.query<{ id: string; created: boolean }>(
    `INSERT INTO social_connection
       (workspace_id, creator_id, platform_id, external_account_id, handle, display_name, avatar_url, profile_url,
        account_type, secret_ref, scopes, access_mode, status, connected_at)
     VALUES (current_workspace_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, '{}', 'public_profile', 'active', now())
     ON CONFLICT (platform_id, external_account_id, workspace_id) DO UPDATE
       SET handle = EXCLUDED.handle,
           display_name = COALESCE(EXCLUDED.display_name, social_connection.display_name),
           avatar_url = COALESCE(EXCLUDED.avatar_url, social_connection.avatar_url),
           profile_url = COALESCE(EXCLUDED.profile_url, social_connection.profile_url),
           account_type = EXCLUDED.account_type,
           status = 'active', status_detail = NULL, deleted_at = NULL, last_error_at = NULL, consecutive_failures = 0,
           connected_at = CASE WHEN social_connection.deleted_at IS NULL THEN social_connection.connected_at ELSE now() END
     RETURNING id, (xmax = 0) AS created`,
    [input.creatorId, input.platformId, input.externalAccountId, input.handle, input.displayName, input.avatarUrl, input.profileUrl, input.accountType, publicSecretRef(input.platformId, input.handle)],
  );
  const r = rows[0]!;
  return { id: r.id, created: r.created === true };
}

export interface AccountSnapshotInput {
  connectionId: string;
  /** YYYY-MM-DD (UTC). */
  day: string;
  followers: number | null;
  following: number | null;
  mediaCount: number | null;
  views: number | null;
  raw: unknown;
  /** 'public_profile' (por @) o 'api' (con el token del dueño). Por defecto, por @. */
  source?: string;
}

/**
 * Snapshot diario de la cuenta con source 'public_profile' (o 'api' si se lee con token). UNIQUE
 * (connection_id, day, source): «Actualizar» dos veces el mismo día no
 * duplica la fila ni la corrige; la primera lectura del día es la del
 * día. Las métricas se insertan, nunca se actualizan, y la base lo
 * exige: mc_app no tiene UPDATE sobre account_metric_snapshot (0025 §5).
 * El recolector diario (mc_worker, quien mide) sí puede reemplazarla.
 *
 * last_synced_at anuncia la frescura del dato que se muestra, así que
 * solo se mueve cuando esta lectura quedó guardada. Si ya había lectura
 * de hoy, devuelve 'ya_hay_lectura_de_hoy' y deja last_synced_at en la
 * hora de esa primera lectura; la lectura sí respondió, así que limpia
 * los fallos anotados.
 */
export type AccountSnapshotOutcome = 'guardada' | 'ya_hay_lectura_de_hoy';

export async function recordAccountSnapshot(tx: WorkspaceTx, input: AccountSnapshotInput): Promise<AccountSnapshotOutcome> {
  const inserted = await tx.query(
    `INSERT INTO account_metric_snapshot (connection_id, workspace_id, day, followers, following, media_count, views, raw, source)
     VALUES ($1, current_workspace_id(), $2::date, $3, $4, $5, $6, $7::jsonb, $8)
     ON CONFLICT (connection_id, day, source) DO NOTHING
     RETURNING 1`,
    [input.connectionId, input.day, input.followers, input.following, input.mediaCount, input.views, JSON.stringify(input.raw ?? {}), input.source ?? PUBLIC_SNAPSHOT_SOURCE],
  );
  const saved = inserted.rows.length > 0;
  await tx.query(
    `UPDATE social_connection
        SET last_synced_at = CASE WHEN $2 THEN now() ELSE last_synced_at END,
            last_error_at = NULL, consecutive_failures = 0, status_detail = NULL
      WHERE id = $1`,
    [input.connectionId, saved],
  );
  return saved ? 'guardada' : 'ya_hay_lectura_de_hoy';
}

export interface AccountRow extends ConnectionListRow {
  accessMode: 'direct_oauth' | 'business_portfolio' | 'aggregator' | 'manual_csv' | 'public_profile';
  /** Último snapshot público, o null si nunca se leyó. */
  latest: { day: string; followers: number | null; following: number | null; mediaCount: number | null; views: number | null } | null;
  /** Seguidores hace siete días o más, para la variación; null si no hay historia. */
  followersWeekAgo: number | null;
  /**
   * La variación de seguidores en esos siete días, ya calculada aquí
   * (0,012 = +1,2 %). Ninguna pantalla resta ni divide métricas: la
   * aritmética es de la base o de @mc/core (§3.3 del backlog).
   */
  followersDelta7d: number | null;
}

/** Cuentas vivas con su último snapshot público y el de hace una semana. */
export async function listAccounts(tx: WorkspaceTx): Promise<AccountRow[]> {
  const base = await listConnections(tx);
  if (base.length === 0) return [];
  const { rows } = await tx.query<{
    id: string; access_mode: AccountRow['accessMode']; day: string | null; followers: string | number | null; following: string | number | null;
    media_count: string | number | null; views: string | number | null; followers_week_ago: string | number | null;
    followers_delta_7d: string | number | null;
  }>(
    `SELECT c.id, c.access_mode,
            to_char(l.day, 'YYYY-MM-DD') AS day, l.followers, l.following, l.media_count, l.views,
            w.followers AS followers_week_ago,
            CASE WHEN w.followers > 0 AND l.followers IS NOT NULL
                 THEN round((l.followers - w.followers)::numeric / w.followers, 6)
            END AS followers_delta_7d
       FROM social_connection c
       LEFT JOIN LATERAL (
         SELECT s.day, s.followers, s.following, s.media_count, s.views
           FROM account_metric_snapshot s
          WHERE s.connection_id = c.id AND s.source = ANY($1::text[])
          ORDER BY s.day DESC, s.captured_at DESC LIMIT 1
       ) l ON true
       LEFT JOIN LATERAL (
         SELECT p.followers
           FROM account_metric_snapshot p
          WHERE p.connection_id = c.id AND p.source = ANY($1::text[]) AND p.day <= l.day - 7
          ORDER BY p.day DESC LIMIT 1
       ) w ON true
      WHERE c.deleted_at IS NULL`,
    [[...ACCOUNT_SNAPSHOT_SOURCES]],
  );
  const extra = new Map(rows.map((r) => [r.id, r]));
  return base.map((b) => {
    const e = extra.get(b.id);
    const n = (v: string | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));
    return {
      ...b,
      accessMode: e?.access_mode ?? 'direct_oauth',
      latest: e?.day ? { day: e.day, followers: n(e.followers), following: n(e.following), mediaCount: n(e.media_count), views: n(e.views) } : null,
      followersWeekAgo: n(e?.followers_week_ago),
      followersDelta7d: n(e?.followers_delta_7d),
    };
  });
}

/** Anota un fallo de lectura pública sin tocar las filas históricas. `permanent` pasa la cuenta a 'error'. */
export async function markAccountLookupFailure(tx: WorkspaceTx, connectionId: string, detailEs: string, permanent: boolean): Promise<void> {
  await tx.query(
    `UPDATE social_connection
        SET last_error_at = now(), consecutive_failures = consecutive_failures + 1, status_detail = $2,
            status = CASE WHEN $3 THEN 'error' ELSE status END
      WHERE id = $1 AND deleted_at IS NULL`,
    [connectionId, detailEs, permanent],
  );
}

// ---------------------------------------------------------------------
// De cuenta por @ a cuenta autorizada (híbrido de CON-10 + CON-3)
// ---------------------------------------------------------------------

/**
 * La fila 'public_profile' de esa red con ese handle, si existe y está
 * viva: es la que «Autorizar» debe convertir, para conservar id e historial.
 */
export async function findPublicAccountByHandle(tx: WorkspaceTx, platformId: ConnectionPlatformId, handle: string): Promise<ExistingConnection | null> {
  const { rows } = await tx.query<{ id: string; secret_ref: string; deleted_at: string | Date | null; status: ConnectionStatus }>(
    `SELECT id, secret_ref, deleted_at, status FROM social_connection
      WHERE platform_id = $1 AND access_mode = 'public_profile' AND deleted_at IS NULL AND lower(handle) = lower($2)`,
    [platformId, handle],
  );
  const r = rows[0];
  return r ? { id: r.id, secretRef: r.secret_ref, deletedAt: iso(r.deleted_at), status: r.status } : null;
}

export interface UpgradeToOAuthInput {
  /** El open_id / user_id que la plataforma dio al autorizar; reemplaza al handle como id externo. */
  externalAccountId: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  accountType: ConnectionAccountType;
  secretRef: string;
  scopes: readonly string[];
  accessExpiresAt: Date;
  refreshExpiresAt: Date | null;
  connectedAt?: Date;
}

/**
 * Convierte una cuenta agregada por @ en una autorizada: misma fila
 * (mismo id, mismos snapshots), access_mode 'direct_oauth', tokens en el
 * almacén bajo secretRef. Si ya existía otra fila con ese open_id (una
 * autorización anterior), se desactiva para no chocar con el UNIQUE.
 */
export async function upgradePublicAccountToOAuth(tx: WorkspaceTx, id: string, input: UpgradeToOAuthInput): Promise<void> {
  // El UNIQUE (platform_id, external_account_id, workspace_id) cuenta también
  // las filas con deleted_at: la fila anterior con ese open_id se retira y su
  // id externo se marca como sustituido para liberar la clave.
  await tx.query(
    `UPDATE social_connection
        SET deleted_at = COALESCE(deleted_at, now()), status = 'disabled',
            status_detail = 'Reemplazada por la cuenta agregada por @ al autorizarla.',
            external_account_id = external_account_id || '~sustituida~' || left(id::text, 8)
      WHERE platform_id = (SELECT platform_id FROM social_connection WHERE id = $1) AND external_account_id = $2 AND id <> $1`,
    [id, input.externalAccountId],
  );
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE social_connection
        SET external_account_id = $2, handle = COALESCE($3, handle), display_name = COALESCE($4, display_name),
            avatar_url = COALESCE($5, avatar_url), profile_url = COALESCE($6, profile_url), account_type = $7,
            secret_ref = $8, scopes = $9::text[], access_expires_at = $10, refresh_expires_at = $11,
            access_mode = 'direct_oauth', status = 'active', status_detail = NULL, last_error_at = NULL, consecutive_failures = 0,
            connected_at = COALESCE($12, now())
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id`,
    [id, input.externalAccountId, input.handle, input.displayName, input.avatarUrl, input.profileUrl, input.accountType, input.secretRef, [...input.scopes], input.accessExpiresAt, input.refreshExpiresAt, input.connectedAt ?? null],
  );
  if (rows.length === 0) throw new ConnectionNotFound(id);
}

