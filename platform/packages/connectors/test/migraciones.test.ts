/**
 * CON-2b · el embebido de las pruebas de connectors se migra con el
 * runner compartido (db/lib/aplicar.mjs): si vuelve un bucle propio, o
 * una migración nueva no se aplica aquí, esta prueba falla.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listSql } from '../../../db/lib/aplicar.mjs';
import { MIGRATIONS_DIR, openMigratedPglite } from './helpers/pglite.ts';

test('cada migración del repositorio queda registrada en schema_migrations', { timeout: 300_000 }, async () => {
  const db = await openMigratedPglite();
  try {
    const { rows } = await db.query<{ filename: string }>('SELECT filename FROM schema_migrations ORDER BY filename');
    assert.deepEqual(rows.map((r) => r.filename), await listSql(MIGRATIONS_DIR));
  } finally {
    await db.close();
  }
});
