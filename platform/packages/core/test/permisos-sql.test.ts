import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { contarFilas, generarSemillaSql } from '../scripts/permisos-sql.ts';
import { PERMISOS, ROLES_SISTEMA, permisosDeRol } from '../src/permisos.ts';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(AQUI, 'snapshots', 'permisos.sql');

/**
 * Las tres tablas tal como las propone docs/propuestas/ACC-accesos-y-roles.md
 * (fase 4). ACC-3 las crea en su migración; aquí solo hace falta que el
 * SQL generado sea Postgres válido contra ese esquema, incluido el
 * ON CONFLICT sobre el índice único parcial de role.
 */
const ESQUEMA_ACC3 = `
CREATE TABLE workspace (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE permission (
  key text PRIMARY KEY,
  module text NOT NULL,
  label_es text NOT NULL,
  description_es text,
  sensitivity text NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal','sensible')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
  key text NOT NULL,
  workspace_kind text NOT NULL CHECK (workspace_kind IN ('creator','agency')),
  label_es text NOT NULL,
  description_es text,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX role_system_uk ON role (key, workspace_kind) WHERE workspace_id IS NULL;
CREATE UNIQUE INDEX role_ws_uk ON role (workspace_id, key) WHERE workspace_id IS NOT NULL;
CREATE TABLE role_permission (
  role_id uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permission(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);
`;

test('la semilla es determinista: dos llamadas producen el mismo texto y coincide con el snapshot', () => {
  const sql = generarSemillaSql();
  assert.equal(generarSemillaSql(), sql);
  const esperado = readFileSync(SNAPSHOT, 'utf8');
  assert.equal(
    sql,
    esperado,
    'El catálogo o la matriz cambiaron: regenera el snapshot con `pnpm --filter @mc/core permisos:sql > test/snapshots/permisos.sql` y revisa el diff.',
  );
});

test('la semilla trae exactamente N filas: 43 permisos, 10 roles y la suma de la matriz', () => {
  const n = contarFilas();
  assert.deepEqual(n, { permission: 43, role: 10, rolePermission: 222 });
  const sql = generarSemillaSql();
  // Cada tupla de permission empieza por la clave; cada rol, por NULL; cada fila de la matriz, por la clave del rol.
  assert.equal((sql.match(/^  \('[a-z]+\.[a-z]+\.[a-z]+', '[a-z]+', /gm) ?? []).length, n.permission);
  assert.equal((sql.match(/^  \(NULL, /gm) ?? []).length, n.role);
  assert.equal((sql.match(/^  \('(owner|admin|manager|editor|finance|viewer)', '(creator|agency)', '/gm) ?? []).length, n.rolePermission);
  assert.equal((sql.match(/ON CONFLICT/g) ?? []).length, 3);
});

test('la semilla corre en Postgres contra el esquema de ACC-3, dos veces, y deja la matriz de permisosDeRol()', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(ESQUEMA_ACC3);
    const sql = generarSemillaSql();
    await pg.exec(sql);
    await pg.exec(sql); // re-ejecutable: ON CONFLICT DO NOTHING en las tres

    const n = contarFilas();
    const cuenta = async (tabla: string) =>
      Number((await pg.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${tabla}`)).rows[0]!.n);
    assert.equal(await cuenta('permission'), n.permission);
    assert.equal(await cuenta('role'), n.role);
    assert.equal(await cuenta('role_permission'), n.rolePermission);

    // Lo que quedó en la base es exactamente lo que dice core, rol por rol.
    for (const r of ROLES_SISTEMA) {
      const { rows } = await pg.query<{ permission_key: string }>(
        `SELECT rp.permission_key FROM role_permission rp
           JOIN role r ON r.id = rp.role_id
          WHERE r.key = $1 AND r.workspace_kind = $2 AND r.workspace_id IS NULL
          ORDER BY rp.permission_key`,
        [r.key, r.workspaceKind],
      );
      assert.deepEqual(
        rows.map((x) => x.permission_key),
        [...permisosDeRol(r.workspaceKind, r.key)].sort(),
        `${r.workspaceKind}:${r.key}`,
      );
    }

    // Y las etiquetas viajaron enteras (acentos, eñes, comas).
    const { rows } = await pg.query<{ label_es: string; sensitivity: string }>(
      `SELECT label_es, sensitivity FROM permission WHERE key = 'campanas.campana.ver'`,
    );
    assert.deepEqual(rows, [{ label_es: PERMISOS.find((p) => p.key === 'campanas.campana.ver')!.labelEs, sensitivity: 'normal' }]);
  } finally {
    await pg.close();
  }
});
