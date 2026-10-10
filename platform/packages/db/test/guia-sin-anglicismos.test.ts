/**
 * 0086 · La guía de cada paso de una cadencia habla de «visualizaciones»,
 * no de «views» (pulido final de VEN-13): ni en las plantillas de
 * fábrica ni en las cadencias instanciadas del seed. Una plantilla nueva
 * que vuelva al anglicismo cae aquí.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb, SETUP_TIMEOUT, type TestDb } from './pglite.ts';

let t: TestDb;
before(async () => {
  t = await openTestDb();
}, SETUP_TIMEOUT);
after(() => t?.close());

test('ninguna guía (plantillas ni pasos) dice «views»', async () => {
  const plantillas = await t.db.withCatalogs((tx) =>
    tx.query<{ slug: string; guia: string }>(
      `SELECT tpl.slug, p.paso->>'guidance_es' AS guia
         FROM outbound_sequence_template tpl
        CROSS JOIN LATERAL jsonb_array_elements(tpl.steps) AS p(paso)
        WHERE (p.paso->>'guidance_es') ~* '\\mviews\\M'`,
    ),
  );
  assert.deepEqual(plantillas.rows, []);
  // Las cadencias instanciadas (las del seed), leídas como el worker: sin RLS, todos los espacios.
  const pasos = await t.db.asWorker((tx) => tx.query<{ id: string }>(`SELECT id::text FROM outbound_step WHERE guidance_es ~* '\\mviews\\M'`));
  assert.deepEqual(pasos.rows, []);
  // Y la guía que el pulido vio, en su sitio y en español.
  const campana = await t.db.withCatalogs((tx) =>
    tx.query<{ guia: string }>(
      `SELECT p.paso->>'guidance_es' AS guia FROM outbound_sequence_template tpl
        CROSS JOIN LATERAL jsonb_array_elements(tpl.steps) AS p(paso)
        WHERE tpl.slug = 'marca-con-campana-activa' AND p.paso->>'angle_key' = 'prueba_desempeno'`,
    ),
  );
  assert.match(campana.rows[0]?.guia ?? '', /visualizaciones frente a tu/);
});
