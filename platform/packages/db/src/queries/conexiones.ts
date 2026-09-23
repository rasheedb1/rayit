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
 *   - Toda escritura de cuenta conectada o consentimiento deja su fila en
 *     audit_log con audit() (ACC-2), en la misma transacción y antes de
 *     devolver, sin secret_ref ni evidencia; test/audit-convencion.test.ts
 *     lo exige. Los snapshots y la salud técnica de la lectura pública no
 *     auditan (declarado ahí con su motivo).
 *   - Consentimiento delegado (ACC-8): el titular es creator_profile
 *     (getConsentCreator); quien actúa es current_user_id()
 *     (getSessionMember). Cada fila de bitácora de conexiones y
 *     consentimientos lleva en `after` a nombre de quién (onBehalfOf) y,
 *     si actuó un tercero, quién (actedBy: id y rol, sin correo). La
 *     evidencia la arma la web; el aviso al titular es
 *     notifyConnectionAdded (kind connection_added, 0038). Aquí no se
 *     escriben frases.
 */
import { audit } from '../audit.ts';
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

/**
 * El titular de UNA conexión: su creator_profile (el de la fila, no «el
 * primero del workspace») con su app_user. Sin filtrar borrados: una
 * cuenta de un perfil dado de baja se tiene que poder quitar igual, y la
 * revocación tiene que nombrar al mismo titular que la bitácora.
 */
export async function getConnectionCreator(tx: WorkspaceTx, connectionId: string): Promise<ConsentCreator> {
  const { rows } = await tx.query<{ id: string; user_id: string | null; display_name: string }>(
    `SELECT cp.id, cp.user_id, cp.display_name
       FROM social_connection c JOIN creator_profile cp ON cp.id = c.creator_id
      WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [connectionId],
  );
  const r = rows[0];
  if (!r) throw new ConnectionNotFound(connectionId);
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
   * role.key del rol de su membresía (0034): 'owner', 'manager',
   * 'editor', 'finance', 'viewer' o la clave de un rol a medida del
   * workspace. Es lo que queda en evidence.actedBy.roleKey.
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
    `SELECT u.id AS user_id, u.email::text AS email, u.name, r.key AS role
       FROM app_user u
       JOIN membership m ON m.user_id = u.id AND m.workspace_id = current_workspace_id()
       JOIN role r ON r.id = m.role_id
      WHERE u.id = current_user_id() AND u.deleted_at IS NULL`,
  );
  const r = rows[0];
  return r ? { userId: r.user_id, email: r.email, name: r.name, roleKey: r.role } : null;
}

/**
 * ¿Tiene la persona de la sesión este permiso en el workspace actual?
 * Se lee de role_permission (0034) por su membresía, dentro de la misma
 * transacción que va a escribir: así el permiso y la escritura ven la
 * misma membresía. Sin identidad (modo demo) o sin membresía, false.
 *
 * TODO(ACC-5): cuando permisosDeLaSesion() (apps/web/lib/permisos) lea
 * la base, las dos preguntas son la misma; esta queda como la
 * comprobación dentro de la transacción.
 */
export async function sessionHasPermission(tx: WorkspaceTx, permissionKey: string): Promise<boolean> {
  const { rows } = await tx.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM membership m
         JOIN role_permission rp ON rp.role_id = m.role_id
        WHERE m.workspace_id = current_workspace_id() AND m.user_id = current_user_id() AND rp.permission_key = $1
     ) AS ok`,
    [permissionKey],
  );
  return rows[0]?.ok === true;
}

/** Lo que cada fila de bitácora de conexiones dice de la delegación. Sin correo: la bitácora no lleva PII. */
export interface ConnectionDelegation {
  onBehalfOf: { creatorId: string };
  actedBy?: { userId: string; roleKey: string };
}

/**
 * A nombre de quién y, si no es el titular, quién actuó: se añade al
 * `after` de toda fila de audit_log de conexiones y consentimientos
 * (ACC-8). El actor ya va en audit_log.actor_user_id; `actedBy` repite
 * su id junto al rol de ese día, que la bitácora no guarda en otro sitio.
 */
async function delegationFor(tx: WorkspaceTx, creatorId: string): Promise<ConnectionDelegation> {
  const { rows } = await tx.query<{ creator_user_id: string | null; actor_id: string | null; role_key: string | null }>(
    `SELECT cp.user_id AS creator_user_id, current_user_id() AS actor_id, r.key AS role_key
       FROM creator_profile cp
       LEFT JOIN membership m ON m.workspace_id = current_workspace_id() AND m.user_id = current_user_id()
       LEFT JOIN role r ON r.id = m.role_id
      WHERE cp.id = $1`,
    [creatorId],
  );
  const r = rows[0];
  const out: ConnectionDelegation = { onBehalfOf: { creatorId } };
  if (r?.actor_id && r.actor_id !== r.creator_user_id) out.actedBy = { userId: r.actor_id, roleKey: r.role_key ?? 'sin_membresia' };
  return out;
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

/** Lo que la bitácora necesita saber de una fila antes de tocarla. */
interface PriorConnection {
  id: string;
  access_mode: string;
  status: ConnectionStatus;
  deleted: boolean;
}

/**
 * La fila de esa cuenta en este workspace (viva o no), bloqueada, ANTES
 * del upsert: el ON CONFLICT no devuelve el estado anterior, y sin él la
 * bitácora no distingue un alta, una reconexión o una cuenta por @ que
 * pasa a autorizada (ACC-2).
 */
async function lockPriorConnection(tx: WorkspaceTx, platformId: ConnectionPlatformId, externalAccountId: string): Promise<PriorConnection | null> {
  const { rows } = await tx.query<PriorConnection>(
    `SELECT id, access_mode, status, deleted_at IS NOT NULL AS deleted
       FROM social_connection WHERE platform_id = $1 AND external_account_id = $2 FOR UPDATE`,
    [platformId, externalAccountId],
  );
  return rows[0] ?? null;
}

function priorState(p: PriorConnection): Record<string, unknown> {
  return { accessMode: p.access_mode, status: p.status, deleted: p.deleted };
}

/** Una fila 'consent.revoked' por consentimiento que dejó de estar vigente. */
async function auditRevokedConsents(tx: WorkspaceTx, revoked: readonly { id: string; purpose: string }[], reason: 'replaced' | 'disconnected', delegation: ConnectionDelegation): Promise<void> {
  for (const c of revoked) {
    await audit(tx, { action: 'consent.revoked', entityType: 'data_consent', entityId: c.id, before: { purpose: c.purpose, revoked: false }, after: { purpose: c.purpose, revoked: true, reason, ...delegation } });
  }
}

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
  const prior = await lockPriorConnection(tx, input.platformId, input.externalAccountId);
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
  const created = r.created === true;
  // Sin secretRef: la bitácora recuerda qué cuenta y con qué permisos, nunca dónde está el token.
  // Si la fila era una cuenta por @, esto la convierte en autorizada: se dice así.
  await audit(tx, {
    action: created || !prior ? 'connection.added' : prior.access_mode === 'public_profile' ? 'connection.authorized' : 'connection.reconnected',
    entityType: 'social_connection',
    entityId: r.id,
    before: prior && !created ? priorState(prior) : null,
    after: {
      platformId: input.platformId, externalAccountId: input.externalAccountId, handle: input.handle, accountType: input.accountType,
      accessMode: 'direct_oauth', scopes: [...input.scopes], accessExpiresAt: input.accessExpiresAt,
      ...(await delegationFor(tx, input.creatorId)),
    },
  });
  return { id: r.id, created };
}

/**
 * Una fila de consentimiento por finalidad. Si había una vigente para la
 * misma conexión y finalidad, se revoca primero: queda el historial y
 * una sola activa.
 */
export async function recordConsent(tx: WorkspaceTx, input: RecordConsentInput): Promise<string> {
  const revoked = await tx.query<{ id: string; purpose: string }>(
    `UPDATE data_consent SET revoked_at = now() WHERE connection_id = $1 AND purpose = $2 AND revoked_at IS NULL RETURNING id, purpose`,
    [input.connectionId, input.purpose],
  );
  const delegation = await delegationFor(tx, input.creatorId);
  await auditRevokedConsents(tx, revoked.rows, 'replaced', delegation);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO data_consent (workspace_id, creator_id, connection_id, purpose, granted, policy_version, evidence)
     VALUES (current_workspace_id(), $1, $2, $3, true, $4, $5::jsonb) RETURNING id`,
    [input.creatorId, input.connectionId, input.purpose, input.policyVersion, JSON.stringify(input.evidence)],
  );
  const id = rows[0]!.id;
  // La evidencia (ip, user agent, texto mostrado) vive en data_consent; la bitácora solo dice qué se consintió.
  await audit(tx, {
    action: 'consent.recorded',
    entityType: 'data_consent',
    entityId: id,
    before: null,
    after: { connectionId: input.connectionId, purpose: input.purpose, policyVersion: input.policyVersion, ...delegation },
  });
  return id;
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
  // El estado anterior se lee en la misma fila que se bloquea: la bitácora dice de dónde venía.
  const previous = await tx.query<{ status: ConnectionStatus; platform_id: ConnectionPlatformId; access_mode: string; handle: string | null; creator_id: string }>(
    `SELECT status, platform_id, access_mode, handle, creator_id FROM social_connection WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [id],
  );
  const before = previous.rows[0];
  if (!before) throw new ConnectionNotFound(id);
  const { rows } = await tx.query<{ secret_ref: string }>(
    `UPDATE social_connection
        SET deleted_at = now(), status = 'disabled', status_detail = $2
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING secret_ref, platform_id, handle, access_mode, creator_id`,
    [id, DISCONNECTED_DETAIL_ES],
  );
  const secretRef = rows[0]?.secret_ref;
  if (!secretRef) throw new ConnectionNotFound(id);
  // La revocación (quién, cuándo, a nombre de quién) se anexa como evidence.revocation; el otorgamiento no se toca.
  const revoked = await tx.query<{ id: string; purpose: string }>(
    `UPDATE data_consent
        SET revoked_at = now(),
            evidence = CASE WHEN $2::jsonb IS NULL THEN evidence ELSE evidence || jsonb_build_object('revocation', $2::jsonb) END
      WHERE connection_id = $1 AND revoked_at IS NULL
      RETURNING id, purpose`,
    [id, revocation ? JSON.stringify(revocation) : null],
  );
  await tx.query(`DELETE FROM connection_secret WHERE secret_ref = $1`, [secretRef]);
  const delegation = await delegationFor(tx, before.creator_id);
  await auditRevokedConsents(tx, revoked.rows, 'disconnected', delegation);
  await audit(tx, {
    action: 'connection.disconnected',
    entityType: 'social_connection',
    entityId: id,
    before: { status: before.status, platformId: before.platform_id, accessMode: before.access_mode },
    after: { status: 'disabled', platformId: before.platform_id, accessMode: before.access_mode, ...delegation },
  });
  return { id, secretRef, platformId: before.platform_id, handle: before.handle, accessMode: before.access_mode, creatorId: before.creator_id };
}

// ---------------------------------------------------------------------
// Consentimiento delegado (ACC-8): el aviso al titular
// ---------------------------------------------------------------------

export interface NotifyConnectionAddedInput {
  /** app_user del titular (creator_profile.user_id). */
  userId: string;
  connectionId: string;
  titleEs: string;
  bodyEs: string;
}

/**
 * Aviso 'connection_added' (0038) al titular: alguien conectó una cuenta
 * en su nombre. `user_id` tiene que ser visible para la transacción
 * (0025 §3): el titular es miembro del workspace, así que lo es. No se
 * duplica mientras haya uno sin leer ni descartar para la misma
 * conexión y persona: «Agregar» dos veces la misma cuenta deja UN
 * aviso. Devuelve true si se creó. No audita: el hecho (connection.added
 * con actedBy) ya dejó su fila; el aviso es su consecuencia.
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

// ---------------------------------------------------------------------
// Cuentas por @ con datos públicos (CON-10)
// ---------------------------------------------------------------------

export const PUBLIC_SNAPSHOT_SOURCE = 'public_profile';
/** Lectura hecha con el token del dueño (cuenta autorizada): la misma que escribe el worker. */
export const API_SNAPSHOT_SOURCE = 'api';
/** Lectura comprada a un proveedor de datos (CON-12: TikTok por @). */
export const AGGREGATOR_SNAPSHOT_SOURCE = 'aggregator';
/** Las fuentes que la pantalla considera «la última lectura» de la cuenta. */
export const ACCOUNT_SNAPSHOT_SOURCES: readonly string[] = [PUBLIC_SNAPSHOT_SOURCE, AGGREGATOR_SNAPSHOT_SOURCE, API_SNAPSHOT_SOURCE];

/**
 * Cómo se leen las cifras de una cuenta dada de alta por @. Es también
 * el `source` de sus snapshots: las dos columnas dicen de dónde salió la
 * cifra, y mantenerlas iguales evita una tabla de equivalencias.
 */
export type PublicAccessMode = typeof PUBLIC_SNAPSHOT_SOURCE | typeof AGGREGATOR_SNAPSHOT_SOURCE;

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
  /** Por defecto 'public_profile' (fuente oficial de la plataforma). 'aggregator' = proveedor de pago (CON-12). */
  accessMode?: PublicAccessMode;
}

/** La ref de una cuenta pública no apunta a ningún secreto; la columna es NOT NULL. */
export function publicSecretRef(platformId: ConnectionPlatformId, handle: string): string {
  return `public:${platformId}:${handle.toLowerCase()}`;
}

/**
 * Alta o reactivación de una cuenta por @: misma clave natural que una
 * conexión autorizada (plataforma + id externo + workspace), con el
 * access_mode de su fuente ('public_profile' o 'aggregator') y sin
 * tokens. Una cuenta que ya está autorizada por su dueño NO se degrada:
 * el token del creador siempre manda sobre una lectura por @.
 */
export async function addPublicAccount(tx: WorkspaceTx, input: AddPublicAccountInput): Promise<UpsertConnectionResult> {
  const creator = await tx.query<{ id: string }>(`SELECT id FROM creator_profile WHERE id = $1`, [input.creatorId]);
  if (creator.rows.length === 0) throw new CreatorNotInWorkspace(input.creatorId);
  const prior = await lockPriorConnection(tx, input.platformId, input.externalAccountId);
  const { rows } = await tx.query<{ id: string; created: boolean; access_mode: string }>(
    `INSERT INTO social_connection
       (workspace_id, creator_id, platform_id, external_account_id, handle, display_name, avatar_url, profile_url,
        account_type, secret_ref, scopes, access_mode, status, connected_at)
     VALUES (current_workspace_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, '{}', $10, 'active', now())
     ON CONFLICT (platform_id, external_account_id, workspace_id) DO UPDATE
       SET handle = EXCLUDED.handle,
           access_mode = CASE WHEN social_connection.access_mode = 'direct_oauth' THEN social_connection.access_mode ELSE EXCLUDED.access_mode END,
           display_name = COALESCE(EXCLUDED.display_name, social_connection.display_name),
           avatar_url = COALESCE(EXCLUDED.avatar_url, social_connection.avatar_url),
           profile_url = COALESCE(EXCLUDED.profile_url, social_connection.profile_url),
           account_type = EXCLUDED.account_type,
           status = 'active', status_detail = NULL, deleted_at = NULL, last_error_at = NULL, consecutive_failures = 0,
           connected_at = CASE WHEN social_connection.deleted_at IS NULL THEN social_connection.connected_at ELSE now() END
     RETURNING id, (xmax = 0) AS created, access_mode`,
    [input.creatorId, input.platformId, input.externalAccountId, input.handle, input.displayName, input.avatarUrl, input.profileUrl, input.accountType, publicSecretRef(input.platformId, input.handle), input.accessMode ?? PUBLIC_SNAPSHOT_SOURCE],
  );
  const r = rows[0]!;
  const created = r.created === true;
  // El ON CONFLICT sí mueve el access_mode entre fuentes públicas (CON-12), pero NUNCA degrada una cuenta ya autorizada: se vuelve a agregar por @ y sigue autorizada. La bitácora dice la de la fila.
  await audit(tx, {
    action: created || !prior ? 'connection.added' : 'connection.reconnected',
    entityType: 'social_connection',
    entityId: r.id,
    before: prior && !created ? priorState(prior) : null,
    after: {
      platformId: input.platformId, externalAccountId: input.externalAccountId, handle: input.handle, accountType: input.accountType, accessMode: r.access_mode,
      ...(await delegationFor(tx, input.creatorId)),
    },
  });
  return { id: r.id, created };
}

/**
 * Mueve una cuenta por @ entre fuentes públicas conservando su id, su
 * consentimiento y su historia: pasa a 'aggregator' el día que se
 * contrata el proveedor (CON-12) y vuelve a 'public_profile' si se da de
 * baja. Nunca toca una cuenta autorizada por su dueño.
 */
export async function setAccountAccessMode(tx: WorkspaceTx, id: string, accessMode: PublicAccessMode): Promise<boolean> {
  const { rows } = await tx.query<{ access_mode: PublicAccessMode }>(
    `UPDATE social_connection SET access_mode = $2
      WHERE id = $1 AND deleted_at IS NULL AND access_mode <> $2
        AND access_mode IN ('public_profile', 'aggregator')
      RETURNING (SELECT c.access_mode FROM social_connection c WHERE c.id = $1) AS access_mode`,
    [id, accessMode],
  );
  const antes = rows[0];
  if (!antes) return false;
  // De dónde salen las cifras de una cuenta conectada —y si se pagan— es
  // un hecho del negocio, no salud técnica de la lectura (ACC-2).
  await audit(tx, {
    action: 'connection.source_changed',
    entityType: 'social_connection',
    entityId: id,
    before: { accessMode: antes.access_mode },
    after: { accessMode },
  });
  return true;
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
  /**
   * Publicaciones de esta cuenta que el recolector conoce y que siguen
   * vivas en la plataforma (CON-5). Es distinto de `latest.mediaCount`,
   * que es lo que la plataforma DICE que tiene: esto es de lo que
   * tenemos medidas.
   */
  postsCount: number;
  /** ISO de la última lectura de contenido, o null si todavía no se ha medido ninguna. */
  lastPostSnapshotAt: string | null;
}

/** Cuentas vivas con su último snapshot público, el de hace una semana y sus publicaciones medidas. */
export async function listAccounts(tx: WorkspaceTx): Promise<AccountRow[]> {
  const base = await listConnections(tx);
  if (base.length === 0) return [];
  const { rows } = await tx.query<{
    id: string; access_mode: AccountRow['accessMode']; day: string | null; followers: string | number | null; following: string | number | null;
    media_count: string | number | null; views: string | number | null; followers_week_ago: string | number | null;
    acted_by_user_id: string | null; acted_by_email: string | null; acted_by_name: string | null; acted_at: string | Date | null;
    posts_count: string | number; last_post_snapshot_at: string | Date | null;
  }>(
    `SELECT c.id, c.access_mode,
            to_char(l.day, 'YYYY-MM-DD') AS day, l.followers, l.following, l.media_count, l.views,
            (SELECT w.followers FROM account_metric_snapshot w
              WHERE w.connection_id = c.id AND w.source = ANY($1::text[]) AND w.day <= l.day - 7
              ORDER BY w.day DESC LIMIT 1) AS followers_week_ago,
            a.acted_by_user_id, a.acted_by_email, u.name AS acted_by_name, a.acted_at,
            contenido.posts_count, contenido.last_post_snapshot_at
       FROM social_connection c
       LEFT JOIN LATERAL (
         SELECT s.day, s.followers, s.following, s.media_count, s.views
           FROM account_metric_snapshot s
          WHERE s.connection_id = c.id AND s.source = ANY($1::text[])
          ORDER BY s.day DESC, s.captured_at DESC LIMIT 1
       ) l ON true
       -- El consentimiento vigente MÁS RECIENTE, tenga o no actedBy: si el titular
       -- reconectó después del mánager, la cuenta ya no está «conectada por» él.
       LEFT JOIN LATERAL (
         SELECT (d.evidence->'actedBy'->>'userId')::uuid AS acted_by_user_id,
                d.evidence->'actedBy'->>'email' AS acted_by_email,
                d.granted_at AS acted_at
           FROM data_consent d
          WHERE d.connection_id = c.id AND d.revoked_at IS NULL
          ORDER BY d.granted_at DESC, d.id DESC LIMIT 1
       ) a ON true
       LEFT JOIN app_user u ON u.id = a.acted_by_user_id
       CROSS JOIN LATERAL (
         -- Publicaciones vivas y hasta cuándo llegan sus lecturas
         -- (CON-5). Cuenta cualquier fuente de lectura: la del
         -- recolector y la del archivo importado. Es distinto de
         -- connection_health.posts_tracked, que cuenta también las que
         -- ya no están en la plataforma. El LEFT JOIN multiplica filas
         -- por lectura, así que el conteo va con DISTINCT.
         SELECT count(DISTINCT p.id)::int AS posts_count, max(s.captured_at) AS last_post_snapshot_at
           FROM post p
           LEFT JOIN post_metric_snapshot s ON s.post_id = p.id AND s.workspace_id = p.workspace_id
          WHERE p.connection_id = c.id AND p.deleted_on_platform = false
       ) contenido
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
      postsCount: Number(e?.posts_count ?? 0),
      lastPostSnapshotAt: iso(e?.last_post_snapshot_at ?? null),
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
 * La fila leída por @ de esa red con ese handle —por la fuente oficial o
 * por el proveedor de pago (CON-12)—, si existe y está viva: es la que
 * «Autorizar» debe convertir, para conservar id e historial. Si dejara
 * fuera a las de proveedor, autorizar crearía una cuenta duplicada y la
 * vieja seguiría gastando unidades.
 */
export async function findPublicAccountByHandle(tx: WorkspaceTx, platformId: ConnectionPlatformId, handle: string): Promise<ExistingConnection | null> {
  const { rows } = await tx.query<{ id: string; secret_ref: string; deleted_at: string | Date | null; status: ConnectionStatus }>(
    `SELECT id, secret_ref, deleted_at, status FROM social_connection
      WHERE platform_id = $1 AND access_mode IN ('public_profile', 'aggregator') AND deleted_at IS NULL AND lower(handle) = lower($2)`,
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
  // El modo de antes se lee de la fila (bloqueada), no se supone: la bitácora dice lo que había.
  const own = await tx.query<{ access_mode: string; creator_id: string }>(
    `SELECT access_mode, creator_id FROM social_connection WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [id],
  );
  const ownBefore = own.rows[0];
  if (!ownBefore) throw new ConnectionNotFound(id);
  // El UNIQUE (platform_id, external_account_id, workspace_id) cuenta también
  // las filas con deleted_at: la fila anterior con ese open_id se retira y su
  // id externo se marca como sustituido para liberar la clave.
  // RETURNING con el estado de antes (subconsulta sobre la fila previa a este UPDATE): la retirada deja su propia fila en la bitácora.
  const retired = await tx.query<{ id: string; prev_status: ConnectionStatus; prev_access_mode: string; was_deleted: boolean }>(
    `WITH prev AS (
       SELECT id, status, access_mode, deleted_at IS NOT NULL AS was_deleted FROM social_connection
        WHERE platform_id = (SELECT platform_id FROM social_connection WHERE id = $1) AND external_account_id = $2 AND id <> $1
        FOR UPDATE
     )
     UPDATE social_connection s
        SET deleted_at = COALESCE(s.deleted_at, now()), status = 'disabled',
            status_detail = 'Reemplazada por la cuenta agregada por @ al autorizarla.',
            external_account_id = s.external_account_id || '~sustituida~' || left(s.id::text, 8)
       FROM prev WHERE s.id = prev.id
     RETURNING s.id, prev.status AS prev_status, prev.access_mode AS prev_access_mode, prev.was_deleted`,
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
  const delegation = await delegationFor(tx, ownBefore.creator_id);
  for (const old of retired.rows) {
    await audit(tx, {
      action: 'connection.disconnected',
      entityType: 'social_connection',
      entityId: old.id,
      before: { status: old.prev_status, accessMode: old.prev_access_mode, deleted: old.was_deleted },
      after: { status: 'disabled', accessMode: old.prev_access_mode, deleted: true, replacedBy: id, ...delegation },
    });
  }
  await audit(tx, {
    action: 'connection.authorized',
    entityType: 'social_connection',
    entityId: id,
    before: { accessMode: ownBefore.access_mode },
    after: { accessMode: 'direct_oauth', externalAccountId: input.externalAccountId, handle: input.handle, accountType: input.accountType, scopes: [...input.scopes], accessExpiresAt: input.accessExpiresAt, ...delegation },
  });
}


// ---------------------------------------------------------------------
// Demografía de audiencia (CON-7) · el contrato de lectura para RES-4
// ---------------------------------------------------------------------

/** `audience_breakdown.population` (CHECK de 0003). */
export type AudiencePopulation = 'followers' | 'reached' | 'engaged' | 'viewers';
/** `audience_breakdown.dimension` (CHECK de 0003, ampliado en 0011). */
export type AudienceDimensionId =
  | 'age' | 'gender' | 'country' | 'city' | 'language' | 'device' | 'follow_type' | 'age_gender' | 'viewer_type';

export interface AudienceBucket {
  /** '25-34' | 'F' | 'CO' | 'Bogotá, Bogota' | '25-34|F'. */
  bucket: string;
  /**
   * 0..1 TAL COMO lo dio la plataforma, o null si dio absolutos. Los
   * `share` de una dimensión no tienen por qué sumar 1: YouTube omite
   * los tramos con pocas vistas y TikTok redondea. Normalizarlos sería
   * inventar, así que quien los pinte dice sobre qué total lo hace.
   */
  share: number | null;
  /** Personas, o null si la plataforma dio porcentajes. Un nulo no es un cero. */
  absolute: number | null;
}

export interface AudienceDimension {
  population: AudiencePopulation;
  dimension: AudienceDimensionId;
  /**
   * 'YYYY-MM-DD' del último día con datos DE ESTA dimensión. No tiene
   * por qué ser el mismo de las demás: si hoy la plataforma entregó la
   * edad pero no el país, el país sigue siendo el de la última vez que
   * llegó, y la pantalla lo dice con su propio «datos hasta».
   */
  day: string;
  /** Por tamaño, salvo edad y edad×género, que van en su orden natural. */
  buckets: AudienceBucket[];
}

/** Por qué NO hay un dato, con el texto que la persona lee (metric_requirement, 0011 y 0039). */
export interface AudienceGap {
  /** 'demografia_de_cuenta', 'retencion_y_audiencia'… */
  metricGroup: string;
  requirementId: string;
  /** 'min_followers_100' | 'business_account' | 'owner_authorization' | … */
  requirement: string;
  /** La frase que va en pantalla. Sale de la migración, no del JSX. */
  messageEs: string;
  fixUrl: string | null;
  /** 'YYYY-MM-DD' de la corrida que lo detectó. */
  day: string;
  detectedAt: string;
}

/**
 * La última demografía de una cuenta, o la razón de que no haya. Las dos
 * cosas a la vez: una cuenta puede tener la edad de sus seguidores y no
 * tener su país, y la pantalla tiene que poder decir las dos.
 */
export interface AccountAudience {
  connectionId: string;
  platformId: ConnectionPlatformId;
  handle: string | null;
  /** El más reciente de los `day` de `dimensions`, o null si nunca hubo demografía. */
  day: string | null;
  dimensions: AudienceDimension[];
  /** Vacío si no falta nada. */
  gaps: AudienceGap[];
}

interface AudienceRow {
  connection_id: string;
  day: string;
  population: AudiencePopulation;
  dimension: AudienceDimensionId;
  bucket: string;
  /** numeric y bigint se piden ::text y se convierten aquí, en un solo sitio. */
  share: string | null;
  absolute: string | null;
}

interface GapRow {
  connection_id: string;
  metric_group: string;
  requirement_id: string;
  requirement: string;
  message_es: string;
  fix_url: string | null;
  day: string;
  detected_at: string | Date;
}

interface AudienceOwnerRow {
  id: string;
  platform_id: ConnectionPlatformId;
  handle: string | null;
}

function decimalOrNull(v: string | null): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * El grueso de las dos funciones públicas. `ids` acota a una conexión o
 * a todas las vivas; RLS ya filtró el workspace en las tres consultas.
 */
async function readAudience(tx: WorkspaceTx, owners: AudienceOwnerRow[]): Promise<AccountAudience[]> {
  if (owners.length === 0) return [];
  const ids = owners.map((o) => o.id);

  // El último día se busca POR DIMENSIÓN y población, no por cuenta: una
  // corrida en la que la plataforma entrega menos cortes que la anterior
  // —el país de YouTube volviendo vacío— no puede borrar de la pantalla
  // el corte que sí se leyó ayer.
  const breakdown = await tx.query<AudienceRow>(
    `WITH ultimo AS (
       SELECT connection_id, population, dimension, max(day) AS day
         FROM audience_breakdown
        WHERE scope = 'account' AND connection_id = ANY($1::uuid[])
        GROUP BY connection_id, population, dimension
     )
     SELECT a.connection_id, to_char(a.day, 'YYYY-MM-DD') AS day, a.population, a.dimension, a.bucket,
            a.share::text AS share, a.absolute::text AS absolute
       FROM audience_breakdown a
       JOIN ultimo u ON u.connection_id = a.connection_id AND u.population = a.population
                    AND u.dimension = a.dimension AND u.day = a.day
      WHERE a.scope = 'account'
      ORDER BY a.connection_id, a.dimension, a.population,
               CASE WHEN a.dimension IN ('age', 'age_gender') THEN a.bucket END ASC NULLS LAST,
               COALESCE(a.absolute::numeric, a.share) DESC NULLS LAST,
               a.bucket`,
    [ids],
  );

  const gaps = await tx.query<GapRow>(
    `SELECT g.connection_id, g.metric_group, g.requirement_id, r.requirement, r.message_es, r.fix_url,
            to_char(g.day, 'YYYY-MM-DD') AS day, g.detected_at
       FROM metric_gap g
       JOIN metric_requirement r ON r.id = g.requirement_id
      WHERE g.connection_id = ANY($1::uuid[])
      ORDER BY g.connection_id, g.metric_group`,
    [ids],
  );

  const porConexion = new Map<string, { day: string | null; dimensions: AudienceDimension[]; gaps: AudienceGap[] }>();
  for (const o of owners) porConexion.set(o.id, { day: null, dimensions: [], gaps: [] });

  for (const r of breakdown.rows) {
    const acc = porConexion.get(r.connection_id);
    if (!acc) continue;
    // El día de la cuenta es el más reciente de sus dimensiones.
    if (acc.day === null || r.day > acc.day) acc.day = r.day;
    let dim = acc.dimensions.find((d) => d.dimension === r.dimension && d.population === r.population);
    if (!dim) {
      dim = { population: r.population, dimension: r.dimension, day: r.day, buckets: [] };
      acc.dimensions.push(dim);
    }
    dim.buckets.push({ bucket: r.bucket, share: decimalOrNull(r.share), absolute: decimalOrNull(r.absolute) });
  }

  for (const g of gaps.rows) {
    const acc = porConexion.get(g.connection_id);
    if (!acc) continue;
    acc.gaps.push({
      metricGroup: g.metric_group,
      requirementId: g.requirement_id,
      requirement: g.requirement,
      messageEs: g.message_es,
      fixUrl: g.fix_url,
      day: g.day,
      detectedAt: iso(g.detected_at)!,
    });
  }

  return owners.map((o) => {
    const acc = porConexion.get(o.id)!;
    return { connectionId: o.id, platformId: o.platform_id, handle: o.handle, day: acc.day, dimensions: acc.dimensions, gaps: acc.gaps };
  });
}

/** La audiencia de una cuenta viva, o null si ese id no es de este workspace. */
export async function getAccountAudience(tx: WorkspaceTx, connectionId: string): Promise<AccountAudience | null> {
  const { rows } = await tx.query<AudienceOwnerRow>(
    `SELECT id, platform_id, handle FROM social_connection WHERE id = $1 AND deleted_at IS NULL`,
    [connectionId],
  );
  if (rows.length === 0) return null;
  const [audiencia] = await readAudience(tx, rows);
  return audiencia ?? null;
}

/** Lo mismo para todas las cuentas vivas del workspace, en el orden de la lista de Conexiones. */
export async function listAccountAudience(tx: WorkspaceTx): Promise<AccountAudience[]> {
  const { rows } = await tx.query<AudienceOwnerRow>(
    `SELECT id, platform_id, handle FROM social_connection
      WHERE deleted_at IS NULL ORDER BY platform_id, connected_at DESC`,
  );
  return readAudience(tx, rows);
}
