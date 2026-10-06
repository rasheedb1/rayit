/**
 * La demo anclada a un día fijo: las cifras de CON-6 y CAM-5 con su número
 * escrito (CIM-12).
 *
 * Las pruebas que corren sobre la demo de hoy comparan contra el oráculo
 * de test/demo.ts, porque la mediana de la parrilla cambia con el día.
 * Eso deja de ver un error que compartan el seed y el cálculo. Aquí no:
 * se siembra como si hoy fuera ANCLA_DEMO (desplazarReloj sobre los
 * seeds) y las cifras tienen que ser las que eran ese día, escritas a mano.
 *
 * Abre siempre el Postgres embebido, también con TEST_DATABASE_URL: mover
 * el reloj de los seeds solo se puede al sembrar, y la base de Postgres
 * real ya viene sembrada con el reloj de quien la sembró.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCampaignResult, getCampaignResult } from '../src/index.ts';
import { createEmbeddedDb, type EmbeddedDb } from '../src/embedded.ts';
import { ANCLA_DEMO, diasHasta, medianasVigentesSql, multiploPonderado, POSTS_CAFE_ALMA_A_30_DIAS, type MedianaVigente } from './demo.ts';
import { CAMPAIGN_CAFE_ALMA, SETUP_TIMEOUT, WORKSPACE_LAURA } from './pglite.ts';

let db: EmbeddedDb;

before(async () => {
  db = await createEmbeddedDb({ snapshot: true, relojDias: diasHasta(ANCLA_DEMO), authDisabled: true });
}, SETUP_TIMEOUT);

after(async () => {
  await db?.close();
});

const post = (n: string) => `00000002-0000-4000-8000-000000000${n}`;

test(`sembrada el ${ANCLA_DEMO}, Café Alma a 30 días rinde 4,496× la mediana de la creadora`, async () => {
  await db.withWorkspace(WORKSPACE_LAURA, (tx) => computeCampaignResult(tx, CAMPAIGN_CAFE_ALMA));
  const r = await db.withWorkspace(WORKSPACE_LAURA, (tx) => getCampaignResult(tx, CAMPAIGN_CAFE_ALMA));
  assert.deepEqual([r?.cutHours, r?.views, r?.viewsVsMedian], [720, 712000, '4.496']);
  // Y el oráculo de las pruebas de cada día da lo mismo ese día.
  const medianas = (await db.queryAsSuperuser<MedianaVigente>(medianasVigentesSql())).rows;
  assert.equal(multiploPonderado(POSTS_CAFE_ALMA_A_30_DIAS, medianas), '4.496');
});

test(`sembrada el ${ANCLA_DEMO}, los cinco mejores videos del tablero de la creadora`, async () => {
  const { rows } = await db.queryAsSuperuser<{ post_id: string; views_vs_median: string; outlier_tier: string; is_outlier: boolean }>(
    `SELECT post_id, views_vs_median::text AS views_vs_median, outlier_tier, is_outlier
       FROM creator_post_board
      WHERE workspace_id = '${WORKSPACE_LAURA}' AND views_vs_median IS NOT NULL
      ORDER BY views_vs_median DESC
      LIMIT 5`,
  );
  assert.deepEqual(rows.map((r) => [r.post_id, r.views_vs_median, r.outlier_tier, r.is_outlier]), [
    [post('d01'), '5.971', 'breakout', true],
    [post('d06'), '3.710', 'outlier', true],
    [post('d18'), '2.662', 'outlier', true],
    [post('d02'), '2.469', 'outlier', true],
    [post('d28'), '2.359', 'outlier', true],
  ]);
});
