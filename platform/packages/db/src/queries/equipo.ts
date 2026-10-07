/**
 * Equipo (ACC-4): quién está en el espacio, a quién se invitó, y
 * cambiar el rol, quitar, invitar, revocar y aceptar. Dueño: Rasheed.
 *
 * Lo que decide la BASE (0078_equipo.sql, 0079_equipo_cerrojos.sql y
 * 0080_equipo_quien_invito.sql), no este archivo:
 *   - el permiso de cada escritura (equipo.miembro.invitar,
 *     equipo.rol.editar, equipo.miembro.revocar), por política;
 *   - «nadie otorga lo que no tiene» (session_can_grant), por política,
 *     también al revocar una invitación (0079 §2);
 *   - el último dueño (membership_keeps_an_owner), por disparador;
 *   - las casillas solo con el Mánager de creador, por disparador (0079 §4);
 *   - quien tiene alcance (ACC-6) no administra el equipo (0079 §6);
 *   - el rol, del tipo del espacio, por disparador (role_fits_workspace, 0034 §5);
 *   - como mucho INVITACIONES_POR_DIA invitaciones por espacio en 24
 *     horas, por disparador (0079 §7);
 *   - aceptar: invitation_accept(), SECURITY DEFINER, un solo uso, y
 *     solo si quien invitó todavía podría darlo (0080 §3);
 *   - leer las invitaciones, solo con equipo.miembro.ver o
 *     equipo.miembro.invitar (0080 §1);
 *   - si a alguien lo esperan en un espacio, para no crearle uno propio
 *     al entrar (has_pending_invitation_for_session_email, 0079 §1).
 * Aquí se traduce lo que la base rechaza a un código que la pantalla
 * sabe decir, y se deja la fila de bitácora (ACC-2) en la misma
 * transacción que la escritura.
 *
 * El token del enlace nace aquí y no sale de aquí más que una vez: la
 * base solo guarda su SHA-256 (0034 §7) y nadie puede volver a leerlo.
 */
import { createHash, randomBytes } from 'node:crypto';
import { admiteCasillas, isExtraPermiso, ROLE_KEYS, UltimoDuenoError } from '@mc/core';
import type { BaseTx, IdentityTx, WorkspaceTx } from '../client.ts';
import { audit } from '../audit.ts';
import { findPgError } from '../pg-error.ts';

// ---------------------------------------------------------------------
// El token
// ---------------------------------------------------------------------

/** 32 bytes al azar en base64url: 43 caracteres, sin relleno. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Un token nuevo para el enlace de una invitación. Solo viaja en el enlace; la base guarda su hash. */
export function newInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

/** ¿Tiene forma de token? Un enlace cortado o inventado no llega a la base. */
export function isInvitationToken(value: string): boolean {
  return TOKEN_RE.test(value);
}

/** Lo que guarda la base y lo único con lo que se busca: SHA-256 en hexadecimal (CHECK de 0034 §7). */
export function invitationTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------
// Errores de la base que la pantalla sabe decir
// ---------------------------------------------------------------------

// El error de Postgres con su código y su restricción, buscado en la
// cadena `cause` (findPgError, ../pg-error.ts): por el nombre de la
// restricción, nunca por el texto del mensaje.

/** El disparador del último dueño (0078 §3): CONSTRAINT membership_last_owner. */
export function isLastOwnerError(err: unknown): boolean {
  return findPgError(err, '23514', 'membership_last_owner') !== null;
}

/**
 * Dos invitaciones pendientes al mismo correo a la vez: el índice único
 * parcial invitation_pending_uk (0034 §7) para la segunda.
 */
export function isPendingExistsError(err: unknown): boolean {
  return findPgError(err, '23505', 'invitation_pending_uk') !== null;
}

/** El techo de invitaciones por espacio y día (invitation_daily_cap, 0079 §7). */
export function isDailyCapError(err: unknown): boolean {
  return findPgError(err, '23514', 'invitation_daily_cap') !== null;
}

/**
 * Dueño y Administrador no llevan alcance (membership_full_role_unscoped,
 * 0082 §2, ACC-7): pasar a uno de esos roles a quien tiene filas en
 * membership_scope lo para la base.
 */
export function isFullRoleUnscopedError(err: unknown): boolean {
  return findPgError(err, '23514', 'membership_full_role_unscoped') !== null;
}

// ---------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------

/** Un rol que se puede ver desde este espacio: los de fábrica de su tipo y los a medida suyos (ACC-9). */
export interface TeamRole {
  id: string;
  key: string;
  label: string;
  description: string | null;
  isSystem: boolean;
  /** Los permisos del rol, como los guarda la base. */
  permissions: string[];
}

/** El orden de los roles de fábrica en la pantalla, de más a menos: ROLE_KEYS de @mc/core, el único. */
const ORDEN_DE_ROLES: readonly string[] = ROLE_KEYS;

/**
 * Los roles que se pueden asignar en ESTE espacio, con sus permisos:
 * los de fábrica del tipo del workspace (creador o agencia) y, cuando
 * existan, los a medida del propio espacio. Qué puede dar cada persona
 * lo decide quien llama con sus permisos (permisosQueFaltan de core); la
 * base lo vuelve a decidir al escribir.
 */
export async function listTeamRoles(tx: WorkspaceTx): Promise<TeamRole[]> {
  const { rows } = await tx.query<{
    id: string;
    key: string;
    label_es: string;
    description_es: string | null;
    is_system: boolean;
    permissions: string[] | null;
  }>(
    `SELECT r.id, r.key, r.label_es, r.description_es, r.is_system,
            array_agg(rp.permission_key ORDER BY rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL) AS permissions
       FROM role r
       JOIN workspace w ON w.id = current_workspace_id() AND r.workspace_kind = w.kind
       LEFT JOIN role_permission rp ON rp.role_id = r.id
      WHERE r.workspace_id IS NULL OR r.workspace_id = current_workspace_id()
      GROUP BY r.id
      ORDER BY r.is_system DESC, coalesce(array_position($1::text[], r.key), 99), r.label_es`,
    [ORDEN_DE_ROLES],
  );
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    label: r.label_es,
    description: r.description_es,
    isSystem: r.is_system,
    permissions: r.permissions ?? [],
  }));
}

/** El tipo del espacio de la transacción: decide qué roles de fábrica hay. */
export async function getTeamWorkspaceKind(tx: WorkspaceTx): Promise<'creator' | 'agency'> {
  const { rows } = await tx.query<{ kind: 'creator' | 'agency' }>(
    'SELECT kind FROM workspace WHERE id = current_workspace_id()',
  );
  const kind = rows[0]?.kind;
  if (!kind) throw new Error('El workspace de la transacción no existe o no se ve.');
  return kind;
}

/**
 * Lo que dice el correo de una invitación: el nombre del espacio y el de
 * quien invita (la persona de la sesión; null en la demo sin sesión o si
 * no puso nombre).
 */
export async function getInvitationSender(
  tx: WorkspaceTx,
): Promise<{ workspaceName: string; inviterId: string | null; inviterName: string | null }> {
  const { rows } = await tx.query<{ workspace_name: string; inviter_id: string | null; inviter_name: string | null }>(
    `SELECT w.name AS workspace_name,
            current_user_id() AS inviter_id,
            (SELECT nullif(btrim(u.name), '') FROM app_user u WHERE u.id = current_user_id()) AS inviter_name
       FROM workspace w WHERE w.id = current_workspace_id()`,
  );
  const r = rows[0];
  if (!r) throw new Error('El workspace de la transacción no existe o no se ve.');
  return { workspaceName: r.workspace_name, inviterId: r.inviter_id, inviterName: r.inviter_name };
}

/** Una persona del espacio, con su rol y sus casillas. */
export interface TeamMember {
  userId: string;
  name: string | null;
  email: string;
  roleId: string;
  roleKey: string;
  roleLabel: string;
  extraPermissions: string[];
  /** Desde cuándo es miembro (ISO). */
  joinedAt: string;
  /** Es quien mira. */
  isMe: boolean;
}

/** Quién está en el espacio: los dueños primero, después por antigüedad. */
export async function listMembers(tx: WorkspaceTx): Promise<TeamMember[]> {
  const { rows } = await tx.query<{
    user_id: string;
    name: string | null;
    email: string;
    role_id: string;
    role_key: string;
    role_label: string;
    extra_permissions: string[];
    created_at: Date | string;
    is_me: boolean | null;
  }>(
    `SELECT m.user_id, u.name, u.email::text AS email, m.role_id, r.key AS role_key, r.label_es AS role_label,
            m.extra_permissions, m.created_at, (m.user_id = current_user_id()) AS is_me
       FROM membership m
       JOIN app_user u ON u.id = m.user_id
       JOIN role r ON r.id = m.role_id
      WHERE m.workspace_id = current_workspace_id()
      ORDER BY coalesce(array_position($1::text[], r.key), 99), m.created_at, u.email`,
    [ORDEN_DE_ROLES],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name?.trim() ? r.name.trim() : null,
    email: r.email,
    roleId: r.role_id,
    roleKey: r.role_key,
    roleLabel: r.role_label,
    extraPermissions: r.extra_permissions ?? [],
    joinedAt: new Date(r.created_at).toISOString(),
    isMe: r.is_me === true,
  }));
}

/** Una invitación sin aceptar ni revocar. Vencida o no: una vencida también se muestra, para revocarla o renovarla. */
export interface PendingInvitation {
  id: string;
  email: string;
  roleId: string;
  roleKey: string;
  roleLabel: string;
  extraPermissions: string[];
  expiresAt: string;
  createdAt: string;
  invitedByName: string | null;
  expired: boolean;
}

export async function listPendingInvitations(tx: WorkspaceTx): Promise<PendingInvitation[]> {
  const { rows } = await tx.query<{
    id: string;
    email: string;
    role_id: string;
    role_key: string;
    role_label: string;
    extra_permissions: string[];
    expires_at: Date | string;
    created_at: Date | string;
    invited_by_name: string | null;
    expired: boolean;
  }>(
    `SELECT i.id, i.email::text AS email, i.role_id, r.key AS role_key, r.label_es AS role_label, i.extra_permissions,
            i.expires_at, i.created_at, nullif(btrim(u.name), '') AS invited_by_name, (i.expires_at <= now()) AS expired
       FROM invitation i
       JOIN role r ON r.id = i.role_id
       LEFT JOIN app_user u ON u.id = i.invited_by
      WHERE i.workspace_id = current_workspace_id() AND i.accepted_at IS NULL AND i.revoked_at IS NULL
      ORDER BY i.created_at DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    roleId: r.role_id,
    roleKey: r.role_key,
    roleLabel: r.role_label,
    extraPermissions: r.extra_permissions ?? [],
    expiresAt: new Date(r.expires_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
    invitedByName: r.invited_by_name,
    expired: r.expired,
  }));
}

// ---------------------------------------------------------------------
// Escrituras
// ---------------------------------------------------------------------

/**
 * Por qué no se pudo. La pantalla tiene una frase para cada uno
 * (apps/web/app/(app)/accesos/_lib/messages.ts).
 *
 *   forbidden           falta el permiso de la acción (invitar, cambiar el rol, quitar)
 *   cannot_grant        se pidió dar un rol o una casilla que quien actúa no tiene,
 *                       o tocar a alguien que tiene algo que quien actúa no tiene
 *   role_not_found      el rol no es de este espacio
 *   extras_not_allowed  casillas en un rol que no las admite (solo el Mánager de creador)
 *   already_member      ese correo ya es de alguien del espacio
 *   not_found           la persona o la invitación no está (o ya no está pendiente)
 *   last_owner          sería dejar el espacio sin dueño
 *   pending_exists      otra persona acaba de invitar a ese correo (dos a la vez)
 *   rate_limited        el espacio ya creó INVITACIONES_POR_DIA invitaciones en 24 horas (0079 §7)
 *   scoped              quien actúa tiene alcance limitado (ACC-6) y no administra el equipo (0079 §6)
 *   scoped_member       la persona a la que se le cambia el rol lleva alcance, y Dueño y
 *                       Administrador no lo llevan (0082 §2): antes hay que quitárselo
 */
export type TeamErrorCode =
  | 'forbidden'
  | 'cannot_grant'
  | 'role_not_found'
  | 'extras_not_allowed'
  | 'already_member'
  | 'not_found'
  | 'last_owner'
  | 'pending_exists'
  | 'rate_limited'
  | 'scoped'
  | 'scoped_member';

export type TeamResult<T = object> = ({ ok: true } & T) | { ok: false; code: TeamErrorCode };

/** El rol tiene que ser de este espacio, y las casillas, de la lista y de un rol que las admita. */
async function validarRolYCasillas(
  tx: WorkspaceTx,
  roleId: string,
  extras: readonly string[],
): Promise<{ ok: true; role: TeamRole } | { ok: false; code: TeamErrorCode }> {
  const role = (await listTeamRoles(tx)).find((r) => r.id === roleId);
  if (!role) return { ok: false, code: 'role_not_found' };
  if (extras.some((p) => !isExtraPermiso(p))) return { ok: false, code: 'extras_not_allowed' };
  if (extras.length > 0 && !admiteCasillas(await getTeamWorkspaceKind(tx), role.key)) {
    return { ok: false, code: 'extras_not_allowed' };
  }
  return { ok: true, role };
}

/**
 * Lo que la base va a decidir, preguntado antes para dar el motivo y no
 * un 42501. `acotada`: la sesión tiene alcance (0079 §6), y entonces
 * session_can_grant es falso para cualquier rol; se dice aparte para
 * no culpar al rol elegido.
 */
async function puedeYOtorga(
  tx: WorkspaceTx,
  permiso: string,
  roleId: string,
  extras: readonly string[],
): Promise<{ puede: boolean; otorga: boolean; acotada: boolean }> {
  const { rows } = await tx.query<{ puede: boolean; otorga: boolean; acotada: boolean }>(
    'SELECT session_can($1) AS puede, session_can_grant($2::uuid, $3::text[]) AS otorga, session_has_scope() AS acotada',
    [permiso, roleId, [...extras]],
  );
  return { puede: rows[0]?.puede === true, otorga: rows[0]?.otorga === true, acotada: rows[0]?.acotada === true };
}

/**
 * ¿La persona de la sesión tiene alcance limitado en este espacio
 * (membership_scope, ACC-6)? Si sí, no administra el equipo (0079 §6):
 * la pantalla no le ofrece invitar, cambiar ni quitar.
 */
export async function sessionHasScope(tx: WorkspaceTx): Promise<boolean> {
  const { rows } = await tx.query<{ acotada: boolean }>('SELECT session_has_scope() AS acotada');
  return rows[0]?.acotada === true;
}

export interface CreateInvitationInput {
  /** Ya normalizado (normalizarCorreo de @mc/core). */
  email: string;
  roleId: string;
  extraPermissions: readonly string[];
  expiresAt: Date;
  /** El token del enlace (newInvitationToken). Se guarda su hash, nunca él. */
  token: string;
}

/**
 * Invita a un correo con un rol y, si es Mánager de creador, sus
 * casillas. Si ese correo ya tenía una invitación pendiente (vencida o
 * no) se revoca en la misma transacción: el índice invitation_pending_uk
 * admite una sola, y el enlace viejo deja de servir.
 */
export async function createInvitation(
  tx: WorkspaceTx,
  input: CreateInvitationInput,
): Promise<TeamResult<{ invitationId: string; replaced: number; roleLabel: string }>> {
  if (!isInvitationToken(input.token)) throw new Error('createInvitation: el token no tiene la forma de newInvitationToken().');
  const extras = [...new Set(input.extraPermissions)];
  const v = await validarRolYCasillas(tx, input.roleId, extras);
  if (!v.ok) return v;
  const { puede, otorga, acotada } = await puedeYOtorga(tx, 'equipo.miembro.invitar', input.roleId, extras);
  if (!puede) return { ok: false, code: 'forbidden' };
  if (acotada) return { ok: false, code: 'scoped' };
  if (!otorga) return { ok: false, code: 'cannot_grant' };

  const { rows: ya } = await tx.query<{ ya: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM membership m JOIN app_user u ON u.id = m.user_id
        WHERE m.workspace_id = current_workspace_id() AND u.email = $1::citext
     ) AS ya`,
    [input.email],
  );
  if (ya[0]?.ya) return { ok: false, code: 'already_member' };

  // Invitar de nuevo revoca la pendiente, y revocar pide lo mismo que
  // dar (0079 §2): una Administradora no reemplaza por un Editor la
  // invitación de Dueño que hizo la Dueña.
  const { rows: ajenas } = await tx.query<{ ajena: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM invitation
        WHERE workspace_id = current_workspace_id() AND email = $1::citext AND accepted_at IS NULL AND revoked_at IS NULL
          AND NOT session_can_grant(role_id, extra_permissions)
     ) AS ajena`,
    [input.email],
  );
  if (ajenas[0]?.ajena) return { ok: false, code: 'cannot_grant' };

  // Un punto de vuelta antes de tocar nada: si otra persona invita al
  // mismo correo a la vez, el índice invitation_pending_uk para la
  // segunda (23505), y si el espacio ya llegó a su techo del día, el
  // disparador invitation_daily_cap (0079 §7) para esta. En los dos
  // casos se deshace solo lo de esta —también la revocación de la
  // pendiente vieja—, sin abortar la transacción de quien llama.
  await tx.query('SAVEPOINT crear_invitacion');
  let viejas: { id: string }[];
  let invitationId: string;
  try {
    ({ rows: viejas } = await tx.query<{ id: string }>(
      `UPDATE invitation SET revoked_at = now()
        WHERE workspace_id = current_workspace_id() AND email = $1::citext AND accepted_at IS NULL AND revoked_at IS NULL
        RETURNING id`,
      [input.email],
    ));
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO invitation (workspace_id, email, role_id, extra_permissions, token_hash, invited_by, expires_at)
       VALUES (current_workspace_id(), $1::citext, $2::uuid, $3::text[], $4, current_user_id(), $5)
       RETURNING id`,
      [input.email, input.roleId, extras, invitationTokenHash(input.token), input.expiresAt.toISOString()],
    );
    invitationId = rows[0]!.id;
  } catch (err) {
    const code = isPendingExistsError(err) ? 'pending_exists' : isDailyCapError(err) ? 'rate_limited' : null;
    if (!code) throw err;
    await tx.query('ROLLBACK TO SAVEPOINT crear_invitacion');
    return { ok: false, code };
  }
  await tx.query('RELEASE SAVEPOINT crear_invitacion');
  for (const vieja of viejas) {
    await audit(tx, { action: 'invitation.revoked', entityType: 'invitation', entityId: vieja.id, after: { reason: 'replaced' } });
  }
  await audit(tx, {
    action: 'invitation.created',
    entityType: 'invitation',
    entityId: invitationId,
    after: { roleKey: v.role.key, extraPermissions: extras, expiresAt: input.expiresAt.toISOString() },
  });
  return { ok: true, invitationId, replaced: viejas.length, roleLabel: v.role.label };
}

/** Revoca una invitación pendiente. El enlace deja de servir; la fila se queda (nadie borra el rastro). */
export async function revokeInvitation(tx: WorkspaceTx, invitationId: string): Promise<TeamResult> {
  const { rows: p } = await tx.query<{ puede: boolean; acotada: boolean; otorga: boolean | null }>(
    `SELECT session_can('equipo.miembro.invitar') AS puede, session_has_scope() AS acotada,
            (SELECT session_can_grant(i.role_id, i.extra_permissions) FROM invitation i
              WHERE i.id = $1::uuid AND i.workspace_id = current_workspace_id()) AS otorga`,
    [invitationId],
  );
  if (p[0]?.puede !== true) return { ok: false, code: 'forbidden' };
  if (p[0]?.acotada === true) return { ok: false, code: 'scoped' };
  // Revocar pide lo mismo que dar (0079 §2). Sin fila (null), not_found abajo.
  if (p[0]?.otorga === false) return { ok: false, code: 'cannot_grant' };
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE invitation SET revoked_at = now()
      WHERE id = $1::uuid AND workspace_id = current_workspace_id() AND accepted_at IS NULL AND revoked_at IS NULL
      RETURNING id`,
    [invitationId],
  );
  if (!rows[0]) return { ok: false, code: 'not_found' };
  await audit(tx, { action: 'invitation.revoked', entityType: 'invitation', entityId: invitationId, after: { reason: 'revoked' } });
  return { ok: true };
}

/** La membresía de una persona en el espacio de la transacción, o null. */
async function miembro(
  tx: WorkspaceTx,
  userId: string,
): Promise<{ roleId: string; roleKey: string; extraPermissions: string[] } | null> {
  const { rows } = await tx.query<{ role_id: string; role_key: string; extra_permissions: string[] }>(
    `SELECT m.role_id, r.key AS role_key, m.extra_permissions
       FROM membership m JOIN role r ON r.id = m.role_id
      WHERE m.workspace_id = current_workspace_id() AND m.user_id = $1::uuid`,
    [userId],
  );
  const r = rows[0];
  return r ? { roleId: r.role_id, roleKey: r.role_key, extraPermissions: r.extra_permissions ?? [] } : null;
}

/**
 * Las invitaciones pendientes que `userId` firmó y que ya no podría dar,
 * revocadas en la misma transacción que lo degrada o lo quita (0080 §2):
 * invitation_inviter_can_grant() dice que no sigue en el espacio, que
 * ahora tiene alcance, o que le falta algo de lo que dio. La barrera es
 * la base —invitation_lookup e invitation_accept ya dicen 'revoked' de
 * esas invitaciones—; esto deja la lista de pendientes diciendo la
 * verdad y cada revocación en la bitácora. Solo toca las que quien actúa
 * podría revocar (invitation_update, 0079 §2): las demás siguen en la
 * lista, con el enlace ya muerto.
 */
async function revocarLasQueYaNoPuedeDar(tx: WorkspaceTx, userId: string): Promise<number> {
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE invitation SET revoked_at = now()
      WHERE workspace_id = current_workspace_id() AND invited_by = $1::uuid
        AND accepted_at IS NULL AND revoked_at IS NULL
        AND NOT invitation_inviter_can_grant(workspace_id, invited_by, role_id, extra_permissions)
      RETURNING id`,
    [userId],
  );
  for (const r of rows) {
    await audit(tx, { action: 'invitation.revoked', entityType: 'invitation', entityId: r.id, after: { reason: 'inviter_lost_access' } });
  }
  return rows.length;
}

/**
 * Lo que la base lanza al quitar o degradar al último dueño
 * (membership_keeps_an_owner, 0078 §3), traducido al error de core.
 * Lanza —no devuelve un código— a propósito: la transacción ya quedó
 * abortada y tiene que deshacerse entera; la Server Action lo convierte
 * en el mensaje.
 */
async function conUltimoDueno<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isLastOwnerError(err)) throw new UltimoDuenoError();
    throw err;
  }
}

/**
 * ¿La persona lleva alcance (cualquier fila de membership_scope en este
 * espacio) y el rol nuevo es Dueño o Administrador de sistema? Es la
 * regla del disparador membership_full_role_unscoped (0082 §2),
 * preguntada antes para decir «quítale antes el alcance» con la
 * transacción viva, en vez de un 23514.
 */
async function llevaAlcanceYPasaARolCompleto(tx: WorkspaceTx, userId: string, roleId: string): Promise<boolean> {
  const { rows } = await tx.query<{ v: boolean }>(
    `SELECT r.workspace_id IS NULL AND r.key IN ('owner', 'admin')
            AND EXISTS (SELECT 1 FROM membership_scope s
                         WHERE s.workspace_id = current_workspace_id() AND s.user_id = $1::uuid) AS v
       FROM role r WHERE r.id = $2::uuid`,
    [userId, roleId],
  );
  return rows[0]?.v === true;
}

/**
 * Cambia el rol de una persona y sus casillas. Quien actúa necesita
 * equipo.rol.editar, tener todo lo que la persona tiene HOY (no se toca
 * a quien está por encima) y todo lo que se le da. Degradar al último
 * dueño lanza UltimoDuenoError. Hacer Dueño o Administrador a quien
 * lleva alcance es 'scoped_member' (0082 §2). Las invitaciones que la
 * persona firmó y ya no podría dar quedan revocadas en la misma
 * transacción.
 */
export async function changeMemberRole(
  tx: WorkspaceTx,
  userId: string,
  roleId: string,
  extraPermissions: readonly string[],
): Promise<TeamResult<{ changed: boolean }>> {
  const extras = [...new Set(extraPermissions)];
  const v = await validarRolYCasillas(tx, roleId, extras);
  if (!v.ok) return v;
  const antes = await miembro(tx, userId);
  if (!antes) return { ok: false, code: 'not_found' };

  const nuevo = await puedeYOtorga(tx, 'equipo.rol.editar', roleId, extras);
  if (!nuevo.puede) return { ok: false, code: 'forbidden' };
  if (nuevo.acotada) return { ok: false, code: 'scoped' };
  const viejo = await puedeYOtorga(tx, 'equipo.rol.editar', antes.roleId, antes.extraPermissions);
  if (!nuevo.otorga || !viejo.otorga) return { ok: false, code: 'cannot_grant' };

  const mismas = [...extras].sort().join() === [...antes.extraPermissions].sort().join();
  if (antes.roleId === roleId && mismas) return { ok: true, changed: false };
  if (await llevaAlcanceYPasaARolCompleto(tx, userId, roleId)) return { ok: false, code: 'scoped_member' };

  // En un SAVEPOINT: si el alcance llegó entre la pregunta y el UPDATE,
  // el disparador lo para (23514) y se devuelve el mismo código con la
  // transacción todavía usable.
  let rows: { user_id: string }[];
  await tx.query('SAVEPOINT cambio_de_rol');
  try {
    ({ rows } = await conUltimoDueno(() =>
      tx.query<{ user_id: string }>(
        `UPDATE membership SET role_id = $2::uuid, extra_permissions = $3::text[]
          WHERE workspace_id = current_workspace_id() AND user_id = $1::uuid
          RETURNING user_id`,
        [userId, roleId, extras],
      ),
    ));
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT cambio_de_rol');
    if (isFullRoleUnscopedError(err)) return { ok: false, code: 'scoped_member' };
    throw err;
  }
  await tx.query('RELEASE SAVEPOINT cambio_de_rol');
  if (!rows[0]) return { ok: false, code: 'cannot_grant' };
  await audit(tx, {
    action: 'membership.role_changed',
    entityType: 'membership',
    entityId: userId,
    before: { roleKey: antes.roleKey, extraPermissions: antes.extraPermissions },
    after: { roleKey: v.role.key, extraPermissions: extras },
  });
  await revocarLasQueYaNoPuedeDar(tx, userId);
  return { ok: true, changed: true };
}

/**
 * Quita a una persona del espacio. Necesita equipo.miembro.revocar y
 * tener todo lo que la persona tiene. Quitar al último dueño lanza
 * UltimoDuenoError. Su alcance (membership_scope) se va con ella por la
 * cascada de 0034 §6, y sus invitaciones pendientes quedan revocadas.
 */
export async function removeMember(tx: WorkspaceTx, userId: string): Promise<TeamResult> {
  const antes = await miembro(tx, userId);
  if (!antes) return { ok: false, code: 'not_found' };
  const { puede, otorga, acotada } = await puedeYOtorga(tx, 'equipo.miembro.revocar', antes.roleId, antes.extraPermissions);
  if (!puede) return { ok: false, code: 'forbidden' };
  if (acotada) return { ok: false, code: 'scoped' };
  if (!otorga) return { ok: false, code: 'cannot_grant' };

  const { rows } = await conUltimoDueno(() =>
    tx.query<{ user_id: string }>(
      `DELETE FROM membership WHERE workspace_id = current_workspace_id() AND user_id = $1::uuid RETURNING user_id`,
      [userId],
    ),
  );
  if (!rows[0]) return { ok: false, code: 'cannot_grant' };
  await audit(tx, {
    action: 'membership.removed',
    entityType: 'membership',
    entityId: userId,
    before: { roleKey: antes.roleKey, extraPermissions: antes.extraPermissions },
  });
  await revocarLasQueYaNoPuedeDar(tx, userId);
  return { ok: true };
}

// ---------------------------------------------------------------------
// El enlace: ver y aceptar
// ---------------------------------------------------------------------

/** Lo que dice un enlace que ya no sirve, o que nunca sirvió. */
export type InvitationClosedStatus = 'not_found' | 'revoked' | 'used' | 'expired';

export type InvitationPreview =
  | { status: InvitationClosedStatus }
  | {
      status: 'pending';
      workspaceName: string;
      roleKey: string;
      roleLabel: string;
      extraPermissions: string[];
      expiresAt: string;
      invitedByName: string | null;
      /** El correo invitado, enmascarado («a•••@ejemplo.com»). */
      invitedEmailMasked: string;
      /** ¿La sesión es ese correo? null sin sesión. */
      emailMatches: boolean | null;
      /** El locale y la zona del espacio que invita, para pintar el vencimiento (0079 §5). */
      locale: string | null;
      timezone: string | null;
    };

/**
 * Qué dice el enlace, sin tocar nada (invitation_lookup, 0078 §5). Sirve
 * con o sin workspace fijado: la función busca solo por el hash.
 */
export async function lookupInvitation(tx: BaseTx, token: string): Promise<InvitationPreview> {
  if (!isInvitationToken(token)) return { status: 'not_found' };
  const { rows } = await tx.query<{ r: unknown }>('SELECT invitation_lookup($1) AS r', [invitationTokenHash(token)]);
  return aVistaDeInvitacion(rows[0]?.r);
}

const ESTADOS_CERRADOS: readonly InvitationClosedStatus[] = ['not_found', 'revoked', 'used', 'expired'];

const esTexto = (v: unknown): v is string => typeof v === 'string';
/** null o ausente: la función puede omitir la clave o mandarla en null. */
const vacio = (v: unknown): v is null | undefined => v === null || v === undefined;

/**
 * El jsonb de invitation_lookup, comprobado campo a campo en vez de
 * creído con un cast: si la función cambia de forma (o devuelve algo
 * raro), el enlace se pinta como «no es válido» y no como una pantalla
 * con huecos. Exportada para probarla sin base.
 */
export function aVistaDeInvitacion(r: unknown): InvitationPreview {
  if (typeof r !== 'object' || r === null) return { status: 'not_found' };
  const o = r as Record<string, unknown>;
  if ((ESTADOS_CERRADOS as readonly unknown[]).includes(o.status)) return { status: o.status as InvitationClosedStatus };
  if (o.status !== 'pending') return { status: 'not_found' };
  const vence = esTexto(o.expiresAt) ? new Date(o.expiresAt) : null;
  const extras = Array.isArray(o.extraPermissions) ? o.extraPermissions : vacio(o.extraPermissions) ? [] : null;
  if (
    !esTexto(o.workspaceName) || !esTexto(o.roleKey) || !esTexto(o.roleLabel) || !esTexto(o.invitedEmailMasked) ||
    !vence || Number.isNaN(vence.getTime()) || !extras || !extras.every(esTexto) ||
    !(vacio(o.invitedByName) || esTexto(o.invitedByName)) ||
    !(vacio(o.emailMatches) || typeof o.emailMatches === 'boolean') ||
    !(vacio(o.locale) || esTexto(o.locale)) ||
    !(vacio(o.timezone) || esTexto(o.timezone))
  ) {
    return { status: 'not_found' };
  }
  return {
    status: 'pending',
    workspaceName: o.workspaceName,
    roleKey: o.roleKey,
    roleLabel: o.roleLabel,
    extraPermissions: extras,
    expiresAt: vence.toISOString(),
    invitedByName: (o.invitedByName as string | null | undefined) ?? null,
    invitedEmailMasked: o.invitedEmailMasked,
    emailMatches: (o.emailMatches as boolean | null | undefined) ?? null,
    locale: (o.locale as string | null | undefined) ?? null,
    timezone: (o.timezone as string | null | undefined) ?? null,
  };
}

/**
 * ¿A la persona de la sesión la esperan en algún espacio? Su correo
 * verificado tiene una invitación pendiente y vigente
 * (has_pending_invitation_for_session_email, 0079 §1). Lo pregunta el
 * primer inicio de sesión para no crearle un espacio propio a quien
 * viene invitado. Solo un sí o un no: el resto lo dice el enlace.
 */
export async function hasPendingInvitationForSessionEmail(tx: IdentityTx): Promise<boolean> {
  const { rows } = await tx.query<{ hay: boolean }>('SELECT has_pending_invitation_for_session_email() AS hay');
  return rows[0]?.hay === true;
}

export type AcceptInvitationResult =
  | { status: 'ok'; workspaceId: string; roleKey: string }
  | { status: InvitationClosedStatus | 'wrong_email' | 'already_member' };

/**
 * Acepta la invitación del enlace como la persona de la transacción
 * (invitation_accept, 0078 §5): un solo uso, antes de vencer y solo si
 * su correo es el invitado. La transacción es la de la sesión
 * (withIdentity): quien acepta todavía no es miembro del espacio.
 */
export async function acceptInvitation(tx: IdentityTx, token: string): Promise<AcceptInvitationResult> {
  if (!isInvitationToken(token)) return { status: 'not_found' };
  const { rows } = await tx.query<{ r: unknown }>('SELECT invitation_accept($1) AS r', [invitationTokenHash(token)]);
  return aResultadoDeAceptar(rows[0]?.r);
}

const ESTADOS_DE_ACEPTAR: readonly string[] = [...ESTADOS_CERRADOS, 'wrong_email', 'already_member'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * El jsonb de invitation_accept, comprobado como aVistaDeInvitacion: solo
 * 'ok' con un workspaceId uuid y un roleKey, o uno de los estados que la
 * pantalla sabe decir. Cualquier otra forma es not_found («el enlace no
 * es válido»), nunca un estado que la pantalla no tiene. Exportada para
 * probarla sin base.
 */
export function aResultadoDeAceptar(r: unknown): AcceptInvitationResult {
  if (typeof r !== 'object' || r === null) return { status: 'not_found' };
  const o = r as Record<string, unknown>;
  if (o.status === 'ok') {
    return esTexto(o.workspaceId) && UUID.test(o.workspaceId) && esTexto(o.roleKey) && o.roleKey !== ''
      ? { status: 'ok', workspaceId: o.workspaceId, roleKey: o.roleKey }
      : { status: 'not_found' };
  }
  return ESTADOS_DE_ACEPTAR.includes(o.status as string)
    ? { status: o.status as Exclude<AcceptInvitationResult['status'], 'ok'> }
    : { status: 'not_found' };
}
