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
 *   - Consentimiento delegado (ACC-8): el titular es creator_profile
 *     (getConsentCreator); quien actúa es current_user_id()
 *     (getSessionMember). Si no son la misma persona, la evidencia lleva
 *     actedBy, el titular recibe notification 'connection_added' (0034)
 *     y audit_log dice quién fue. Los textos de los avisos los arma la
 *     web: aquí no se escriben frases.
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

/** El titular de los datos: el creator_profile del workspace y, si tiene cuenta, su app_user. */
export interface ConsentCreator {
  id: string;
  /** app_user.id del creador, o null si el perfil no tiene cuenta (seed, alta por agencia). */
  userId: string | null;
  displayName: string;
}

/**
 * El creador a cuyo nombre queda todo consentimiento del workspace: el
 * perfil del workspace actual (RLS lo filtra; un workspace de creador
 * tiene exactamente uno, 0001). La sesión —quien actúa— es
 * current_user_id(): son dos preguntas distintas y ACC-8 las separa.
 */
export async function getConsentCreator(tx: WorkspaceTx): Promise<ConsentCreator> {
  const { rows } = await tx.query<{ id: string; user_id: string | null; display_name: string }>(
    `SELECT id, user_id, display_name FROM creator_profile WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`,
  );
  const r = rows[0];
  if (!r) throw new NoCreatorProfile();
  return { id: r.id, userId: r.user_id, displayName: r.display_name };
}

/** Solo el id del titular (ver getConsentCreator). */
export async function getDefaultCreatorId(tx: WorkspaceTx): Promise<string> {
  return (await getConsentCreator(tx)).id;
}

/** Quien abrió la transacción, como miembro de este workspace. */
export interface SessionMember {
  userId: string;
  email: string;
  name: string | null;
  /**
   * membership.role de 0001 ('owner', 'admin', 'member', 'viewer',
   * 'client'). Con ACC-3 pasa a ser role.key: el campo se llama igual
   * para que la evidencia (evidence.actedBy.roleKey) no cambie de forma.
   */
  roleKey: string;
}

/**
 * La persona de la sesión y su rol en el workspace actual, o null si la
 * transacción no lleva identidad (modo demo sin sesión) o la persona no
 * es miembro. Sale de current_user_id() —lo fijó lib/workspace/current
 * desde el correo verificado— y de membership por RLS (0028): nada
 * viene del navegador.
 */
export async function getSessionMember(tx: WorkspaceTx): Promise<SessionMember | null> {
  const { rows } = await tx.query<{ user_id: string; email: string; name: string | null; role: string }>(
    `SELECT u.id AS user_id, u.email::text AS email, u.name, m.role
       FROM app_user u
       JOIN membership m ON m.user_id = u.id AND m.workspace_id = current_workspace_id()
      WHERE u.id = current_user_id() AND u.deleted_at IS NULL`,
  );
  const r = rows[0];
  return r ? { userId: r.user_id, email: r.email, name: r.name, roleKey: r.role } : null;
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

export interface DisconnectedConnection {
  id: string;
  secretRef: string;
  platformId: ConnectionPlatformId;
  handle: string | null;
  accessMode: string;
  creatorId: string;
}

/**
 * Desconectar sin borrar: deleted_at, status 'disabled', consentimientos
 * revocados y el ciphertext fuera de connection_secret. Reconectar
 * vuelve a escribirlo en la misma ref.
 *
 * `revocation` (ACC-8) se anexa como evidence.revocation a cada
 * consentimiento que se revoca —quién lo quitó, cuándo y a nombre de
 * quién—; la evidencia del otorgamiento queda intacta. Sin tokens: el
 * llamador la pasa por redactSecrets.
 */
export async function disconnectConnection(tx: WorkspaceTx, id: string, revocation?: Record<string, unknown>): Promise<DisconnectedConnection> {
  const { rows } = await tx.query<{ secret_ref: string; platform_id: ConnectionPlatformId; handle: string | null; access_mode: string; creator_id: string }>(
    `UPDATE social_connection
        SET deleted_at = now(), status = 'disabled', status_detail = $2
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING secret_ref, platform_id, handle, access_mode, creator_id`,
    [id, DISCONNECTED_DETAIL_ES],
  );
  const r = rows[0];
  if (!r) throw new ConnectionNotFound(id);
  await tx.query(
    `UPDATE data_consent
        SET revoked_at = now(),
            evidence = CASE WHEN $2::jsonb IS NULL THEN evidence ELSE evidence || jsonb_build_object('revocation', $2::jsonb) END
      WHERE connection_id = $1 AND revoked_at IS NULL`,
    [id, revocation ? JSON.stringify(revocation) : null],
  );
  await tx.query(`DELETE FROM connection_secret WHERE secret_ref = $1`, [r.secret_ref]);
  return { id, secretRef: r.secret_ref, platformId: r.platform_id, handle: r.handle, accessMode: r.access_mode, creatorId: r.creator_id };
}

// ---------------------------------------------------------------------
// Consentimiento delegado (ACC-8): aviso al titular y bitácora
// ---------------------------------------------------------------------

export interface NotifyConnectionAddedInput {
  /** app_user del titular (creator_profile.user_id). */
  userId: string;
  connectionId: string;
  titleEs: string;
  bodyEs: string;
}

/**
 * Aviso 'connection_added' (0034) al titular: alguien conectó una cuenta
 * en su nombre. `user_id` tiene que ser visible para la transacción
 * (0025 §3): el titular es miembro del workspace, así que lo es. No se
 * duplica mientras haya uno sin leer ni descartar para la misma
 * conexión y persona: «Agregar» dos veces la misma cuenta deja UN
 * aviso. Devuelve true si se creó.
 */
export async function notifyConnectionAdded(tx: WorkspaceTx, input: NotifyConnectionAddedInput): Promise<boolean> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO notification (workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url)
     SELECT current_workspace_id(), $1, 'connection_added', 'info', $3, $4, 'social_connection', $2, '/conexiones'
      WHERE NOT EXISTS (SELECT 1 FROM notification n
                         WHERE n.kind = 'connection_added' AND n.entity_type = 'social_connection' AND n.entity_id = $2
                           AND n.user_id = $1 AND n.read_at IS NULL AND n.dismissed_at IS NULL)
     RETURNING id`,
    [input.userId, input.connectionId, input.titleEs, input.bodyEs],
  );
  return rows.length > 0;
}

export type ConnectionAuditAction = 'connection.added' | 'connection.removed';

export interface ConnectionAuditInput {
  action: ConnectionAuditAction;
  connectionId: string;
  /**
   * Lo que quedó: connectionId, platformId, handle, accessMode,
   * onBehalfOf { creatorId } y, si actuó un tercero, actedBy { userId,
   * roleKey }. Sin correo, IP ni tokens: la bitácora no lleva PII.
   */
  after: Record<string, unknown>;
}

/**
 * Fila de audit_log por conectar o quitar una cuenta, con
 * actor_user_id = current_user_id() (NULL en modo demo sin sesión).
 *
 * TODO(ACC-2): cuando withAudit() esté en @mc/db, esta función se
 * reemplaza por esa llamada; la forma de `after` se conserva.
 */
export async function recordConnectionAudit(tx: WorkspaceTx, input: ConnectionAuditInput): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, after)
     VALUES (current_workspace_id(), current_user_id(), 'user', $1, 'social_connection', $2, $3::jsonb)`,
    [input.action, input.connectionId, JSON.stringify(input.after)],
  );
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
   * Quién conectó la cuenta en nombre del titular (evidence.actedBy del
   * consentimiento vigente), o null si la conectó el propio titular.
   * `name` sale de app_user si esa persona sigue siendo visible; si no,
   * queda el correo que la evidencia guardó ese día.
   */
  connectedBy: { userId: string; name: string | null; email: string | null; at: string } | null;
}

/** Cuentas vivas con su último snapshot público y el de hace una semana. */
export async function listAccounts(tx: WorkspaceTx): Promise<AccountRow[]> {
  const base = await listConnections(tx);
  if (base.length === 0) return [];
  const { rows } = await tx.query<{
    id: string; access_mode: AccountRow['accessMode']; day: string | null; followers: string | number | null; following: string | number | null;
    media_count: string | number | null; views: string | number | null; followers_week_ago: string | number | null;
    acted_by_user_id: string | null; acted_by_email: string | null; acted_by_name: string | null; acted_at: string | Date | null;
  }>(
    `SELECT c.id, c.access_mode,
            to_char(l.day, 'YYYY-MM-DD') AS day, l.followers, l.following, l.media_count, l.views,
            (SELECT w.followers FROM account_metric_snapshot w
              WHERE w.connection_id = c.id AND w.source = ANY($1::text[]) AND w.day <= l.day - 7
              ORDER BY w.day DESC LIMIT 1) AS followers_week_ago,
            a.acted_by_user_id, a.acted_by_email, u.name AS acted_by_name, a.acted_at
       FROM social_connection c
       LEFT JOIN LATERAL (
         SELECT s.day, s.followers, s.following, s.media_count, s.views
           FROM account_metric_snapshot s
          WHERE s.connection_id = c.id AND s.source = ANY($1::text[])
          ORDER BY s.day DESC, s.captured_at DESC LIMIT 1
       ) l ON true
       LEFT JOIN LATERAL (
         SELECT (d.evidence->'actedBy'->>'userId')::uuid AS acted_by_user_id,
                d.evidence->'actedBy'->>'email' AS acted_by_email,
                d.granted_at AS acted_at
           FROM data_consent d
          WHERE d.connection_id = c.id AND d.revoked_at IS NULL AND d.evidence ? 'actedBy'
          ORDER BY d.granted_at DESC LIMIT 1
       ) a ON true
       LEFT JOIN app_user u ON u.id = a.acted_by_user_id
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
      connectedBy: e?.acted_by_user_id && e.acted_at
        ? { userId: e.acted_by_user_id, name: e.acted_by_name ?? null, email: e.acted_by_email ?? null, at: iso(e.acted_at)! }
        : null,
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

