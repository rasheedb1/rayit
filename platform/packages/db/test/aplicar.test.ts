/**
 * El runner de migraciones (db/lib/aplicar.mjs) es el mismo para
 * Supabase, `make db.check` y el Postgres embebido de las pruebas. Aquí
 * lo que no necesita una base: la lista de archivos.
 *
 * Dos ramas que crean una migración a la vez producen dos 00NN iguales
 * (pasó con 0015 en CON-3, CAM-2 y CIM-2). El runner los aplicaría a
 * ambos sin quejarse; desde CIM-2 se niega, y `make db.check` y el job
 * «esquema» del CI fallan antes de que llegue a Supabase.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DuplicateMigrationNumberError, listSql, MIGRATIONS_DIR } from '../../../db/lib/aplicar.mjs';

let dir = '';

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-migraciones-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('listSql', () => {
  test('ordena por nombre y deja fuera lo que no es .sql', async () => {
    await writeFile(join(dir, '0002_b.sql'), 'select 2;');
    await writeFile(join(dir, '0001_a.sql'), 'select 1;');
    await writeFile(join(dir, 'README.md'), 'no soy sql');
    assert.deepEqual(await listSql(dir), ['0001_a.sql', '0002_b.sql']);
  });

  test('dos archivos con el mismo número detienen el runner y dicen cuáles son', async () => {
    await writeFile(join(dir, '0002_c.sql'), 'select 3;');
    await assert.rejects(listSql(dir), (err: unknown) => {
      assert.ok(err instanceof DuplicateMigrationNumberError);
      assert.deepEqual(err.files, ['0002_b.sql', '0002_c.sql']);
      assert.match(err.message, /0002/);
      return true;
    });
    await rm(join(dir, '0002_c.sql'));
  });

  test('un nombre que no cabe en SQL se rechaza', async () => {
    await writeFile(join(dir, "0003_x'y.sql"), 'select 4;');
    await assert.rejects(listSql(dir), /no admitido/);
    await rm(join(dir, "0003_x'y.sql"));
  });

  test('db/migrations del repositorio no repite ningún número', async () => {
    const files = await listSql(MIGRATIONS_DIR);
    assert.ok(files.length >= 18, `hay ${files.length} migraciones; se esperaban al menos 18`);
    // Y son consecutivas desde 0001: un hueco sería una migración que
    // alguien borró o renumeró después de aplicarla.
    files.forEach((f, i) => assert.equal(f.slice(0, 4), String(i + 1).padStart(4, '0'), `hueco antes de ${f}`));
  });
});
