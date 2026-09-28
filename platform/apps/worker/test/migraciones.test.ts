/**
 * CON-2b · el Postgres embebido del worker se migra con el runner de
 * @mc/db (db/lib/aplicar.mjs), el mismo que usan openTestDb y
 * `make db.migrate`, y no con un bucle propio.
 *
 * Lo que se demuestra:
 *   - schema_migrations del worker lista CADA archivo de db/migrations,
 *     con su checksum: una migración nueva que el worker no aplicara
 *     rompe esta prueba.
 *   - El worker y openTestDb terminan con la misma schema_migrations.
 *   - Una migración que se agrega al directorio se aplica al abrir.
 *   - Dos migraciones con el mismo número detienen el arranque, como en
 *     `make db.check`: el bucle viejo las aplicaba a las dos sin decir nada.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmbeddedDb, MIGRATIONS_DIR as DB_MIGRATIONS_DIR } from '@mc/db/embedded';
import { checksumOf, DuplicateMigrationNumberError, listSql } from '../../../db/lib/aplicar.mjs';
import { MIGRATIONS_DIR, PgliteDatabase } from '../src/runner/db-pglite.ts';
import { openTestDatabase } from './helpers/harness.ts';

interface Registrada extends Record<string, unknown> {
  filename: string;
  checksum: string;
}

const REGISTRADAS = 'SELECT filename, checksum FROM schema_migrations ORDER BY filename';

let db: PgliteDatabase;
const temporales: string[] = [];

before(async () => {
  db = await openTestDatabase();
}, { timeout: 300_000 });

after(async () => {
  await db.close();
  for (const dir of temporales) await rm(dir, { recursive: true, force: true });
});

async function dirTemporal(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mc-worker-migraciones-'));
  temporales.push(dir);
  return dir;
}

test('el worker lee las migraciones del mismo directorio que @mc/db', () => {
  assert.equal(MIGRATIONS_DIR, DB_MIGRATIONS_DIR);
});

test('cada migración del repositorio queda registrada en el worker, con su checksum', async () => {
  const archivos = await listSql(MIGRATIONS_DIR);
  // 0023 es un hueco declarado: 0001 a 0039 son 38 archivos. Que haya al menos esos.
  assert.ok(archivos.length >= 38 && archivos.includes('0039_demografia_de_cuenta.sql'), `hay ${archivos.length} migraciones`);
  const esperado = await Promise.all(
    archivos.map(async (filename) => ({ filename, checksum: checksumOf(await readFile(join(MIGRATIONS_DIR, filename), 'utf8')) })),
  );
  const { rows } = await db.raw.query<Registrada>(REGISTRADAS);
  assert.deepEqual(rows.map((r) => ({ filename: r.filename, checksum: r.checksum })), esperado);
});

test('el worker y openTestDb terminan con la misma schema_migrations', { timeout: 300_000 }, async () => {
  const embebida = await createEmbeddedDb({ seeds: false });
  try {
    const deDb = await embebida.queryAsSuperuser<Registrada>(REGISTRADAS);
    const delWorker = await db.raw.query<Registrada>(REGISTRADAS);
    assert.deepEqual(delWorker.rows.map((r) => [r.filename, r.checksum]), deDb.rows.map((r) => [r.filename, r.checksum]));
  } finally {
    await embebida.close();
  }
});

test('una migración nueva en el directorio se aplica al abrir', { timeout: 300_000 }, async () => {
  const dir = await dirTemporal();
  for (const f of await listSql(MIGRATIONS_DIR)) await copyFile(join(MIGRATIONS_DIR, f), join(dir, f));
  await writeFile(join(dir, '9999_con2b_prueba.sql'), 'CREATE TABLE con2b_prueba (id int PRIMARY KEY);\n');

  const conNueva = await PgliteDatabase.open({ setRole: 'mc_worker', migrationsDir: dir });
  try {
    const tabla = await conNueva.raw.query<{ existe: string | null }>(`SELECT to_regclass('public.con2b_prueba')::text AS existe`);
    assert.equal(tabla.rows[0]?.existe, 'con2b_prueba');
    const reg = await conNueva.raw.query<Registrada>(`SELECT filename, checksum FROM schema_migrations WHERE filename = '9999_con2b_prueba.sql'`);
    assert.equal(reg.rows.length, 1, 'queda registrada, como en Supabase');
  } finally {
    await conNueva.close();
  }
});

test('dos migraciones con el mismo número detienen el arranque', async () => {
  const dir = await dirTemporal();
  await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int);\n');
  await writeFile(join(dir, '0001_b.sql'), 'CREATE TABLE b (id int);\n');
  await assert.rejects(PgliteDatabase.open({ setRole: 'mc_worker', migrationsDir: dir }), DuplicateMigrationNumberError);
});
