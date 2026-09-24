/**
 * 0042 · post_metrics_at_cut desempata SIEMPRE igual: con dos lecturas de
 * la misma edad gana la que se tomó antes (captured_at ASC, luego id).
 *
 * Antes de 0042 el DISTINCT ON solo ordenaba por age_hours DESC y
 * Postgres devolvía cualquiera de las dos según el plan: el 24-sep-2026
 * el seed y compute.baseline leyeron lecturas distintas del post d02 de
 * Café Alma y la mediana de completion a 30 días salió 0,085 en uno y
 * 0,09 en el otro (apps/worker/test/costuras-con.test.ts, rojo en main).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb, POST_D02_TIKTOK_CAFE_ALMA, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

let t: TestDb;
const POST = '0000000c-0000-4000-8000-0000000042d1';

before(async () => {
  t = await openTestDb();
  // Un post nuevo con dos lecturas de 720 h: la MÁS TARDÍA se inserta primero
  // (id menor), para que ni el orden de inserción ni el id decidan por ella.
  await t.admin(`
    INSERT INTO post (id, workspace_id, creator_id, connection_id, platform_id, external_post_id, media_type, published_at, first_seen_at)
    SELECT '${POST}', workspace_id, creator_id, connection_id, platform_id, 'desempate-0042', 'video', '2026-08-01T12:00:00Z', '2026-08-01T12:00:00Z'
      FROM post WHERE id = '${POST_D02_TIKTOK_CAFE_ALMA}';
    INSERT INTO post_metric_snapshot (post_id, workspace_id, captured_at, age_hours, views, completion_rate, source)
    VALUES ('${POST}', '${WORKSPACE_LAURA}', '2026-08-31T20:00:00Z', 720, 900, NULL, 'manual');
    INSERT INTO post_metric_snapshot (post_id, workspace_id, captured_at, age_hours, views, completion_rate, source)
    VALUES ('${POST}', '${WORKSPACE_LAURA}', '2026-08-31T12:00:00Z', 720, 1000, 0.07, 'api');
  `);
}, { timeout: 300_000 });
after(async () => { await t?.close(); });

async function alCorte(postId: string): Promise<{ views: string; completion_rate: string | null }> {
  const rows = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) =>
    (await tx.query<{ views: string; completion_rate: string | null }>(
      `SELECT views::text AS views, completion_rate::text AS completion_rate FROM post_metrics_at_cut WHERE post_id = $1 AND cut_hours = 720`,
      [postId],
    )).rows,
  );
  assert.equal(rows.length, 1);
  return rows[0]!;
}

test('dos lecturas de la misma edad: gana la que se tomó antes, sin importar cuál se insertó primero', async () => {
  assert.deepEqual(await alCorte(POST), { views: '1000', completion_rate: '0.07000' });
});

test('el caso real: el post d02 de Café Alma lee la lectura de la API a las 720 h (0,06), no la manual sin completion', async () => {
  const empates = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) =>
    (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM post_metric_snapshot WHERE post_id = $1 AND age_hours = 720`, [POST_D02_TIKTOK_CAFE_ALMA])).rows[0]!.n,
  );
  assert.equal(empates, 2, 'el seed trae el empate que destapó el problema');
  assert.equal((await alCorte(POST_D02_TIKTOK_CAFE_ALMA)).completion_rate, '0.06000');
});

test('la vista sigue con security_invoker (0024 §8): CREATE OR REPLACE no se lo quitó', async () => {
  const rows = await t.raw<{ opts: string[] | null }>(`SELECT reloptions AS opts FROM pg_class WHERE relname = 'post_metrics_at_cut'`);
  assert.ok((rows[0]?.opts ?? []).includes('security_invoker=on'), JSON.stringify(rows));
});
