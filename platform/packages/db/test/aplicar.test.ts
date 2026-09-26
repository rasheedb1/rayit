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
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DuplicateMigrationNumberError, listSql, MIGRATIONS_DIR } from '../../../db/lib/aplicar.mjs';
import { SETUP_TIMEOUT } from './pglite.ts';

/**
 * Lo que main ya aplicó en Supabase y esta rama todavía no tiene
 * (schema_migrations, 24-sep-2026: «make db.guardia verde, 41
 * migraciones, la última 0042», docs/propuestas/CIERRE-E2E.md en main).
 * La serie de integración va entera DETRÁS, de 0043 en adelante; ninguna
 * está aplicada en ningún sitio. Al mezclar main, estos archivos llegan
 * con el mismo nombre y la lista sobra (no rompe nada, pero bórrala).
 */
const MIGRACIONES_DE_MAIN: readonly string[] = [
  '0034_access_control.sql',
  '0035_brand_snapshot_por_campana.sql',
  '0036_platform_payout_unico.sql',
  '0037_reporte_publico.sql',
  '0038_notification_connection_added.sql',
  '0039_demografia_de_cuenta.sql',
  '0040_scope_allows.sql',
  '0041_campaign_result_escritura_web.sql',
  '0042_metricas_al_corte_desempate.sql',
];

/**
 * Números que ya tiene otra rama, y que esta todavía no: un hueco
 * declarado. Cuando la rama que los tiene se integre, el archivo llega
 * y la entrada sobra (no rompe nada, pero bórrala).
 */
const NUMEROS_DE_OTRAS_RAMAS: Readonly<Record<string, string>> = {
  '0023': 'reservada en main para ACC-3 (accesos y roles)',
  ...Object.fromEntries(MIGRACIONES_DE_MAIN.map((f) => [f.slice(0, 4), `main (${f}, aplicada en Supabase)`])),
};

/**
 * Las migraciones de origin/main, si este clon las tiene (git y el
 * remoto); si no, ninguna, y la prueba se queda con MIGRACIONES_DE_MAIN.
 * Así, en cuanto main suma una migración nueva, `pnpm verificar` la ve
 * sin esperar a que alguien actualice la lista.
 */
function migracionesDeOriginMain(): string[] {
  try {
    const out = execFileSync('git', ['-C', MIGRATIONS_DIR, 'ls-tree', '--name-only', 'origin/main', '--', '.'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .map((l) => basename(l.trim()))
      .filter((f) => f.endsWith('.sql'));
  } catch {
    return [];
  }
}

let dir = '';

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-migraciones-'));
}, SETUP_TIMEOUT);

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

  test('esta rama mezclada con main no repite número: la serie de integración va detrás de la última de main', async () => {
    // Lo que verá el integrador al mezclar: db/migrations más lo que main
    // ya tiene (la lista declarada y, si el clon la tiene, origin/main).
    // Pasó en el pulido r2: la rama llevaba doce archivos en 0034–0045 y
    // main ya había aplicado su 0034–0042; listSql lo rechazaba al mezclar.
    const deMain = new Set([...MIGRACIONES_DE_MAIN, ...migracionesDeOriginMain()]);
    const propias = await listSql(MIGRATIONS_DIR);
    const union = await mkdtemp(join(tmpdir(), 'mc-union-main-'));
    try {
      for (const f of new Set([...propias, ...deMain])) await writeFile(join(union, f), '');
      await assert.doesNotReject(listSql(union));
    } finally {
      await rm(union, { recursive: true, force: true });
    }
    // Y ninguna propia que main no tenga cae dentro del rango de main:
    // lo aplicado en Supabase es inmutable, así que lo nuevo va detrás.
    const ultimaDeMain = Math.max(...[...deMain].map((f) => Number(f.slice(0, 4))));
    const dentro = propias.filter((f) => !deMain.has(f) && Number(f.slice(0, 4)) <= ultimaDeMain);
    assert.deepEqual(dentro, [], `migraciones de esta rama dentro de la serie de main (hasta ${ultimaDeMain}): ${dentro.join(', ')}`);
  });
});
