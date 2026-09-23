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

/**
 * Números que ya tiene otra rama, y que esta todavía no: un hueco
 * declarado. Cuando la rama que los tiene se integre, el archivo llega
 * y la entrada sobra (no rompe nada, pero bórrala). Al integrar el
 * endurecimiento en rasheed/integracion llegaron 0024, 0025, 0026 y 0029,
 * y la 0026 de Cotizar pasó a 0030_public_share.sql; ya no queda más
 * hueco que el de ACC-3.
 */
const NUMEROS_DE_OTRAS_RAMAS: Readonly<Record<string, string>> = {
  '0023':
    'reservada en main para ACC-3 y sin usar: 0024–0033 llegaron antes y ACC-3 se escribió como ' +
    '0034_access_control.sql (cabecera de 0034). Queda como hueco declarado; rellenarlo con un archivo vacío es decisión de Nicolás',
  // ACC-8 trae 0038 antes de que lleguen a main las que ya tienen otras ramas (fetch del 23-sep):
  '0036': 'la tienen dos ramas sin fusionar: CON-7 (0036_demografia_de_cuenta) y FIN-7 (0036_platform_payout_unico); el integrador renumera una',
  '0037': 'la tiene la rama CAM-6 (0037_reporte_publico), sin fusionar',
};

let dir = '';

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-migraciones-'));
}, { timeout: 120_000 });

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
    // alguien borró o renumeró después de aplicarla. Salvo los números
    // que otra rama ya tomó y esta todavía no tiene: esos se declaran,
    // con quién los tiene, para que el hueco sea una decisión y no un
    // olvido.
    const numeros = new Set(files.map((f) => Number(f.slice(0, 4))));
    const ultimo = Math.max(...numeros);
    const huecos: string[] = [];
    for (let n = 1; n <= ultimo; n++) {
      const nn = String(n).padStart(4, '0');
      if (!numeros.has(n) && !(nn in NUMEROS_DE_OTRAS_RAMAS)) huecos.push(nn);
    }
    assert.deepEqual(huecos, [], `huecos sin declarar en db/migrations: ${huecos.join(', ')}`);
  });
});
