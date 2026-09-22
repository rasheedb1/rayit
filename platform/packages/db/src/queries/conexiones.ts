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
