/**
 * Accesos: permisos, roles, alcance, invitaciones y concesiones.
 * Migración 0034 (ACC-3). Propuesto por Nicolás; dueño: Rasheed
 * (docs/propuestas/ACC-3.md §2).
 *
 * Regla del paquete: la migración manda. Este archivo describe columnas,
 * claves y defaults para que las consultas queden tipadas; índices,
 * CHECKs, políticas y disparadores viven en db/migrations y no se
 * generan desde aquí. test/schema.test.ts lo compara columna a columna
 * con lo que 0034 deja en la base.
 *
 * Lo que la base garantiza y este archivo solo nombra:
 *   - role.workspace_id NULL es un rol de sistema (los diez de fábrica);
 *     con workspace_id, uno a medida de ese workspace (ACC-9).
 *   - invitation.token_hash es SIEMPRE un SHA-256 en hexadecimal (CHECK):
 *     el token del enlace no se guarda nunca.
 *   - membership.role_id (schema/cimientos.ts) apunta a role.id; el
 *     disparador membership_role_fits exige que el rol sea del tipo del
 *     workspace. system_role_id(kind, key) da el id de un rol de sistema.
 */
import { boolean, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { citext, createdAt, timestamptz, uuidPk } from './_tipos.ts';
import { appUser, workspace } from './cimientos.ts';

/** Las claves de los roles de sistema (0034 §4). Coinciden con RoleKey de @mc/core (ACC-1). */
export const ROLE_KEYS = ['owner', 'admin', 'manager', 'editor', 'finance', 'viewer'] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];
export const PERMISSION_SENSITIVITIES = ['normal', 'sensible'] as const;
export const SCOPE_TYPES = ['creator', 'company', 'campaign'] as const;
export const GRANT_STATUSES = ['pending', 'active', 'revoked', 'expired'] as const;

// ---------------------------------------------------------------------
// Catálogo y roles
// ---------------------------------------------------------------------

/** El catálogo de permisos `<módulo>.<recurso>.<acción>`. Lo llena la migración; la web solo lo lee. */
export const permission = pgTable('permission', {
  key: text('key').primaryKey(),
  module: text('module').notNull(),
  labelEs: text('label_es').notNull(),
  descriptionEs: text('description_es'),
  sensitivity: text('sensitivity', { enum: PERMISSION_SENSITIVITIES }).default('normal').notNull(),
  createdAt: createdAt(),
});

/** Roles: workspace_id NULL = de sistema; con workspace_id = a medida de ese workspace. */
export const role = pgTable('role', {
  id: uuidPk(),
  workspaceId: uuid('workspace_id').references(() => workspace.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  workspaceKind: text('workspace_kind', { enum: ['creator', 'agency'] }).notNull(),
  labelEs: text('label_es').notNull(),
  descriptionEs: text('description_es'),
  isSystem: boolean('is_system').default(false).notNull(),
  createdAt: createdAt(),
});

/** La matriz: qué permisos tiene cada rol. */
export const rolePermission = pgTable(
  'role_permission',
  {
    roleId: uuid('role_id').notNull().references(() => role.id, { onDelete: 'cascade' }),
    permissionKey: text('permission_key').notNull().references(() => permission.key, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
);

// ---------------------------------------------------------------------
// Alcance, invitaciones y concesiones
// ---------------------------------------------------------------------

/** A qué creadores, empresas o campañas se limita una persona (ACC-6). Sin filas, ve todo el workspace. */
export const membershipScope = pgTable(
  'membership_scope',
  {
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id').notNull(),
    scopeType: text('scope_type', { enum: SCOPE_TYPES }).notNull(),
    scopeId: uuid('scope_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId, t.scopeType, t.scopeId] })],
);

/** Invitar por correo con un rol. El token solo como SHA-256 (token_hash); revocar es revoked_at. */
export const invitation = pgTable('invitation', {
  id: uuidPk(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspace.id, { onDelete: 'cascade' }),
  email: citext('email').notNull(),
  roleId: uuid('role_id').notNull().references(() => role.id),
  scope: jsonb('scope').default([]).notNull(),
  tokenHash: text('token_hash').notNull(),
  invitedBy: uuid('invited_by').references(() => appUser.id, { onDelete: 'set null' }),
  expiresAt: timestamptz('expires_at').notNull(),
  acceptedAt: timestamptz('accepted_at'),
  revokedAt: timestamptz('revoked_at'),
  createdAt: createdAt(),
});

/** La concesión de un workspace (grantor, el creador) a otro (grantee, la agencia). Fase 2 (AGE-1): la web solo la lee. */
export const workspaceGrant = pgTable('workspace_grant', {
  id: uuidPk(),
  grantorWorkspaceId: uuid('grantor_workspace_id').notNull().references(() => workspace.id, { onDelete: 'cascade' }),
  granteeWorkspaceId: uuid('grantee_workspace_id').notNull().references(() => workspace.id, { onDelete: 'cascade' }),
  roleId: uuid('role_id').notNull().references(() => role.id),
  scope: jsonb('scope').default([]).notNull(),
  status: text('status', { enum: GRANT_STATUSES }).default('pending').notNull(),
  requestedBy: uuid('requested_by').references(() => appUser.id, { onDelete: 'set null' }),
  approvedBy: uuid('approved_by').references(() => appUser.id, { onDelete: 'set null' }),
  expiresAt: timestamptz('expires_at'),
  createdAt: createdAt(),
  revokedAt: timestamptz('revoked_at'),
});
