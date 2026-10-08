/**
 * Toda función que fija su search_path tiene que incluir `extensions`.
 *
 * En Supabase, citext, pgcrypto y pg_trgm viven en el esquema
 * `extensions`, no en `public`. Una función con
 * `SET search_path = public, pg_temp` no ve esos tipos: la 0046 no se
 * podía crear («type citext does not exist») y, dentro de una función, un
 * `citext = citext` caía en `text = text` y distinguía mayúsculas
 * (28-sep). En pglite las extensiones están en `public`, así que ninguna
 * otra prueba lo nota. Esta lee las migraciones como texto.
 *
 * Las anteriores a 0046 están aplicadas e inmutables: se dejan como están.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MIGRATIONS_DIR } from '../../../db/lib/aplicar.mjs';

const DESDE = '0046';
const SET_SEARCH_PATH = /SET\s+search_path\s*(?:=|TO)\s*([^;\n]+)/gi;

describe('search_path de las funciones', () => {
  test(`desde ${DESDE}, todo SET search_path incluye extensions`, async () => {
    const archivos = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql') && f >= DESDE)
      .sort();
    assert.ok(archivos.length > 0, 'no se encontraron migraciones');

    const sinExtensions: string[] = [];
    for (const archivo of archivos) {
      const sql = await readFile(join(MIGRATIONS_DIR, archivo), 'utf8');
      sql.split('\n').forEach((linea, i) => {
        if (linea.trimStart().startsWith('--')) return;
        for (const m of linea.matchAll(SET_SEARCH_PATH)) {
          const camino = m[1]!.toLowerCase();
          if (!/\bextensions\b/.test(camino)) sinExtensions.push(`${archivo}:${i + 1}  ${linea.trim()}`);
        }
      });
    }

    assert.deepEqual(
      sinExtensions,
      [],
      'En Supabase las extensiones viven en el esquema extensions: usa ' +
        '`SET search_path = public, extensions, pg_temp`.\n' +
        sinExtensions.join('\n'),
    );
  });
});
