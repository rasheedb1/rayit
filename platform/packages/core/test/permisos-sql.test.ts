/**
 * El script que imprime la semilla: determinista y con N filas exactas.
 * Que el SQL corra de verdad en Postgres se prueba en @mc/db
 * (packages/db/test/permisos-semilla.test.ts), que ya tiene PGlite; core
 * sigue sin base y sus pruebas en milisegundos.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contarFilas, generarSemillaSql } from '../scripts/permisos-sql.ts';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(AQUI, 'snapshots', 'permisos.sql');

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
  assert.deepEqual(n, { permission: 43, role: 10, rolePermission: 220 });
  const sql = generarSemillaSql();
  // Cada tupla de permission empieza por la clave; cada rol, por NULL; cada fila de la matriz, por la clave del rol.
  assert.equal((sql.match(/^  \('[a-z]+\.[a-z]+\.[a-z]+', '[a-z]+', /gm) ?? []).length, n.permission);
  assert.equal((sql.match(/^  \(NULL, /gm) ?? []).length, n.role);
  assert.equal((sql.match(/^  \('(owner|admin|manager|editor|finance|viewer)', '(creator|agency)', '/gm) ?? []).length, n.rolePermission);
  assert.equal((sql.match(/ON CONFLICT/g) ?? []).length, 3);
});
