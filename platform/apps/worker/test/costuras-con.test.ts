/**
 * Costuras de CON-6 con sus vecinos (cierre del módulo CON, parte A).
 *
 *   1. Encadenamiento (JobOptions.after): el registro valida la cadena y
 *      el runner encola lo de abajo solo cuando lo de arriba trae datos.
 *   2. CON-5 → CON-6: tras cada collect.post_metrics REAL (sobre las
 *      respuestas grabadas de YouTube), compute.baseline y
 *      compute.post_score corren solos, en ese orden, y cada video queda
 *      puntuado en el MAYOR corte que alcanzó; con menos de ocho videos
 *      el múltiplo es null, nunca cero.
 *   3. CON-6 → CAM-5: sobre el seed de la demo, sin línea base
 *      campaign.compute deja views_vs_median en null y dice 'baseline';
 *      con la que escribe compute.baseline da la cifra exacta (4,496× en
 *      Café Alma), y las 16 líneas base y los 59 puntajes salen iguales
 *      a los que calcula db/seed/0002 en SQL.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FixtureFetch, loadFixtures, withoutNetwork, type NetworkGuard } from '@mc/connectors';
import { MIN_SAMPLE_FOR_BASELINE } from '@mc/core';
import { allJobs } from '../src/jobs/index.ts';
import { defineJob, JobRegistry } from '../src/runner/registry.ts';
import { chainedAfter, CHAIN_SOURCE } from '../src/runner/run.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { applyRepoSeeds, jobRuns, seedTestDefinitions, startHarness, waitFor, type Harness, type JobRunRow } from './helpers/harness.ts';

const noop = async () => ({ processed: 0, failed: 0 });

/** Espera a que `jobId` tenga `n` corridas terminadas y devuelve la n-ésima. */
async function corrida(h: Harness, jobId: string, n: number): Promise<JobRunRow> {
  const runs = await waitFor(async () => {
    const hechas = (await jobRuns(h.db, jobId)).filter((r) => r.status !== 'running');
    return hechas.length >= n ? hechas : null;
  }, { label: `${jobId} #${n}`, timeoutMs: 60_000 });
  return runs[n - 1]!;
}

// ---------------------------------------------------------------------
// 1 · El registro de la cadena
// ---------------------------------------------------------------------

describe('encadenamiento en el registro', () => {
  test('compute.baseline corre tras collect.post_metrics y compute.post_score tras compute.baseline', () => {
    const registry = new JobRegistry(allJobs);
    assert.deepEqual(registry.next('collect.post_metrics'), ['compute.baseline']);
    assert.deepEqual(registry.next('compute.baseline'), ['compute.post_score']);
    assert.deepEqual(registry.next('compute.post_score'), [], 'post_score es el final de la cadena de CON-6');
  });

  test('un job que dice correr tras uno que no existe no arranca', () => {
    assert.throws(() => new JobRegistry([defineJob('test.b', noop, { after: ['test.fantasma'] })]), /no está registrado/);
  });

  test('un ciclo no arranca: encadenaría corridas sin fin', () => {
    const a = defineJob('test.a', noop, { after: ['test.b'] });
    const b = defineJob('test.b', noop, { after: ['test.a'] });
    assert.throws(() => new JobRegistry([a, b]), /ciclo/);
    assert.throws(() => new JobRegistry([defineJob('test.c', noop, { after: ['test.c'] })]), /ciclo/);
  });

  test('solo el payload del encadenamiento se lee como «tras»', () => {
    assert.equal(chainedAfter({ source: CHAIN_SOURCE, after: 'collect.post_metrics' }), 'collect.post_metrics');
    assert.equal(chainedAfter({ source: 'cron', after: 'collect.post_metrics' }), null);
    assert.equal(chainedAfter({ source: CHAIN_SOURCE, after: 'no es un id; DROP TABLE' }), null);
    assert.equal(chainedAfter(null), null);
  });
});

// ---------------------------------------------------------------------
// 2 · CON-5 → CON-6, con el recolector de verdad
// ---------------------------------------------------------------------

describe('CON-5 → CON-6: tras collect.post_metrics, la línea base y el puntaje', () => {
  const W = '00000031-0000-4000-8000-000000000001';
  const C = '00000031-0000-4000-8000-000000000011';
  const ENV = { INSTAGRAM_HOUSE_TOKEN: 'IGAA-costura-SECRETO', GOOGLE_API_KEY: 'AIza-costura-SECRETO' };
  // Las fechas de publicación son las de la respuesta grabada. Con la
  // primera lectura a las 15:00 del 3-sep, los tres videos tienen 48, 24
  // y 0 horas; un día después, 72, 48 y 24: cada uno llega a un corte y
  // lo tiene MEDIDO (una lectura dentro de su banda).
  const DIA_1 = new Date('2026-09-03T15:00:00Z');
  const DIA_2 = new Date('2026-09-04T15:00:00Z');
  const PUBLICADOS = { vid00000001: '2026-09-01T15:00:00Z', vid00000002: '2026-09-02T15:00:00Z', vid00000003: '2026-09-03T15:00:00Z' };

  let guard: NetworkGuard;
  let h: Harness;
  let reloj = DIA_1;

  before(async () => {
    guard = withoutNetwork();
    const fetch = new FixtureFetch(await loadFixtures('youtube', [['videos.list', 'crecimiento']]));
    const pruebas = [
      defineJob('test.fail', async () => { throw new Error('falla a propósito'); }),
      defineJob('test.items', async () => ({ processed: 1, failed: 1, retry: false })),
      defineJob('test.echo', noop, { after: ['test.fail', 'test.items'] }),
    ];
    h = await startHarness({
      jobs: [...allJobs, ...pruebas], now: () => reloj, env: ENV, http: { fetch: fetch.fetch },
      seed: async (db: PgliteDatabase) => {
        await seedTestDefinitions(db);
        await db.raw.exec(`
          INSERT INTO workspace (id, slug, name) VALUES ('${W}', 'costura-con', 'Costura CON');
          INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${C}', '${W}', 'Laura');
        `);
        const conn = await db.raw.query<{ id: string }>(
          `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_mode)
           VALUES ($1, $2, 'youtube', 'UCNutriveOficial', 'NutriveOficial', 'public:youtube:NutriveOficial', '{}', 'public_profile') RETURNING id`,
          [W, C],
        );
        for (const [externo, publicado] of Object.entries(PUBLICADOS)) {
          await db.raw.query(
            `INSERT INTO post (workspace_id, creator_id, connection_id, platform_id, external_post_id, media_type, published_at)
             VALUES ($1, $2, $3, 'youtube', $4, 'video', $5::timestamptz)`,
            [W, C, conn.rows[0]!.id, externo, publicado],
          );
        }
      },
    });
  });
  after(async () => {
    await h.stop();
    guard.restore();
  });

  test('cada recolección dispara compute.baseline y luego compute.post_score, en ese orden', async () => {
    await h.worker.boss.send('collect.post_metrics', { workspaceId: W, source: 'test' });
    const collect1 = await corrida(h, 'collect.post_metrics', 1);
    assert.equal(collect1.status, 'ok', collect1.error ?? '');
    const base1 = await corrida(h, 'compute.baseline', 1);
    const score1 = await corrida(h, 'compute.post_score', 1);

    reloj = DIA_2;
    await h.worker.boss.send('collect.post_metrics', { workspaceId: W, source: 'test' });
    const collect2 = await corrida(h, 'collect.post_metrics', 2);
    assert.equal(collect2.status, 'ok', collect2.error ?? '');
    const base2 = await corrida(h, 'compute.baseline', 2);
    const score2 = await corrida(h, 'compute.post_score', 2);

    const orden = [collect1, base1, score1, collect2, base2, score2].map((r) => Number(r.id));
    assert.deepEqual(orden, [...orden].sort((a, b) => a - b), 'collect → baseline → post_score, y el día 2 después del día 1');
    for (const r of [base1, base2]) {
      assert.equal(r.status, 'ok', r.error ?? '');
      assert.equal(r.metadata['tras'], 'collect.post_metrics');
      assert.equal(r.workspace_id, W, 'el encadenado lleva el workspace del de arriba');
    }
    for (const r of [score1, score2]) {
      assert.equal(r.status, 'ok', r.error ?? '');
      assert.equal(r.metadata['tras'], 'compute.baseline');
      assert.equal(r.workspace_id, W);
    }
  });

  test('cada video queda puntuado en el mayor corte que alcanzó, y con menos de ocho videos el múltiplo es null', async () => {
    const { rows } = await h.db.query<{ external_post_id: string; age_hours_cut: number; views_at_cut: string; views_vs_median: string | null; outlier_tier: string | null; is_outlier: boolean; baseline_id: string | null }>(
      `SELECT p.external_post_id, s.age_hours_cut, s.views_at_cut::text AS views_at_cut, s.views_vs_median::text AS views_vs_median,
              s.outlier_tier, s.is_outlier, s.baseline_id
         FROM post_score s JOIN post p ON p.id = s.post_id
        WHERE s.workspace_id = $1 ORDER BY p.external_post_id`,
      [W],
    );
    assert.deepEqual(rows.map((r) => [r.external_post_id, r.age_hours_cut]), [
      ['vid00000001', 72], // 72 h el día 2
      ['vid00000002', 24], // 48 h: todavía no llega a 72
      ['vid00000003', 24], // 24 h justas
    ]);
    // views_at_cut es la lectura que cae en ese corte, no la última.
    const lecturas = await h.db.query<{ external_post_id: string; age_hours: string; views: string }>(
      `SELECT p.external_post_id, s.age_hours::text AS age_hours, s.views::text AS views
         FROM post_metric_snapshot s JOIN post p ON p.id = s.post_id WHERE s.workspace_id = $1`,
      [W],
    );
    const vistas = (id: string, edad: string) => lecturas.rows.find((l) => l.external_post_id === id && l.age_hours === edad)?.views;
    assert.equal(rows[0]!.views_at_cut, vistas('vid00000001', '72.00'));
    assert.equal(rows[1]!.views_at_cut, vistas('vid00000002', '24.00'), 'la lectura del día 1, no la de 48 h');
    assert.equal(rows[2]!.views_at_cut, vistas('vid00000003', '24.00'));

    for (const r of rows) {
      assert.equal(r.views_vs_median, null, `${r.external_post_id}: con menos de ${MIN_SAMPLE_FOR_BASELINE} videos no se inventa un múltiplo`);
      assert.equal(r.outlier_tier, null);
      assert.equal(r.is_outlier, false);
      assert.notEqual(r.baseline_id, null, 'apunta a la línea base contra la que se comparó');
    }

    const bases = await h.db.query<{ age_hours_cut: number; sample_size: number; is_reliable: boolean; median_views: string | null }>(
      `SELECT DISTINCT ON (age_hours_cut) age_hours_cut, sample_size, is_reliable, median_views::text AS median_views
         FROM creator_baseline WHERE workspace_id = $1 AND platform_id = 'youtube' ORDER BY age_hours_cut, computed_at DESC`,
      [W],
    );
    assert.ok(bases.rows.length > 0);
    for (const b of bases.rows) {
      assert.ok(b.sample_size < MIN_SAMPLE_FOR_BASELINE);
      assert.equal(b.is_reliable, false);
      assert.notEqual(b.median_views, null, 'la mediana se calcula igual: lo que no se publica es el múltiplo');
    }
  });

  test('un job que falla entero no encadena; uno parcial sí', async () => {
    // Jobs de prueba sobre las definiciones test.* del arnés: test.fail
    // lanza siempre, test.items termina parcial sin reintento, y test.echo
    // corre después de cualquiera de los dos.
    await h.worker.boss.send('test.fail', { workspaceId: W });
    await waitFor(async () => (await jobRuns(h.db, 'test.fail')).filter((r) => r.status === 'failed').length >= 3, { label: 'test.fail agota sus intentos', timeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 1_500));
    assert.equal((await jobRuns(h.db, 'test.echo')).length, 0, 'failed no encadena');

    await h.worker.boss.send('test.items', { workspaceId: W });
    const parcial = await corrida(h, 'test.items', 1);
    assert.equal(parcial.status, 'partial');
    const eco = await corrida(h, 'test.echo', 1);
    assert.equal(eco.metadata['tras'], 'test.items');
    assert.equal(eco.workspace_id, W);
  });
});

// ---------------------------------------------------------------------
// 3 · CON-6 → CAM-5, sobre el seed de la demo
// ---------------------------------------------------------------------

describe('CON-6 → CAM-5: views_vs_median de campaign.compute lee la línea base de CON-6', () => {
  const LAURA = '00000002-0000-4000-8000-000000000001';
  const CAFE_ALMA = '00000003-0000-4000-8000-000000ca0001';
  let h: Harness;
  /** Un segundo después del computed_at con el que el seed calculó su línea base (docs/propuestas/CON-6.md §4). */
  let reloj = new Date();

  interface BaseSeed extends Record<string, unknown> {
    clave: string; sample_size: number; median_views: string | null; p25_views: string | null; p75_views: string | null;
    median_engagement: string | null; median_saves_per_1k: string | null; median_completion: string | null; median_skip_3s: string | null; is_reliable: boolean;
  }
  interface ScoreSeed extends Record<string, unknown> {
    post_id: string; age_hours_cut: number; views_at_cut: string; views_vs_median: string | null; outlier_tier: string | null; is_outlier: boolean;
  }
  let basesDelSeed: BaseSeed[] = [];
  let puntajesDelSeed: ScoreSeed[] = [];

  const BASES = `SELECT DISTINCT ON (platform_id, age_hours_cut) platform_id || ':' || age_hours_cut AS clave, sample_size,
                        median_views::text AS median_views, p25_views::text AS p25_views, p75_views::text AS p75_views,
                        median_engagement::text AS median_engagement, median_saves_per_1k::text AS median_saves_per_1k,
                        median_completion::text AS median_completion, median_skip_3s::text AS median_skip_3s, is_reliable
                   FROM creator_baseline WHERE workspace_id = '${LAURA}'
                  ORDER BY platform_id, age_hours_cut, computed_at DESC`;
  const PUNTAJES = `SELECT post_id, age_hours_cut, views_at_cut::text AS views_at_cut, views_vs_median::text AS views_vs_median, outlier_tier, is_outlier
                      FROM post_score WHERE workspace_id = '${LAURA}' ORDER BY post_id`;

  async function resultado(): Promise<{ views_vs_median: string | null; missing_inputs: string[] }> {
    const { rows } = await h.db.query<{ views_vs_median: string | null; missing_inputs: string[] }>(
      `SELECT views_vs_median::text AS views_vs_median, missing_inputs FROM campaign_result WHERE campaign_id = $1`,
      [CAFE_ALMA],
    );
    return rows[0]!;
  }

  before(async () => {
    h = await startHarness({
      jobs: allJobs, now: () => reloj,
      seed: async (db: PgliteDatabase) => {
        await applyRepoSeeds(db);
        const r = await db.raw.query<{ computed_at: Date }>(`SELECT max(computed_at) AS computed_at FROM creator_baseline WHERE workspace_id = '${LAURA}'`);
        reloj = new Date(new Date(r.rows[0]!.computed_at).getTime() + 1_000);
        basesDelSeed = (await db.raw.query<BaseSeed>(BASES)).rows;
        puntajesDelSeed = (await db.raw.query<ScoreSeed>(PUNTAJES)).rows;
        // Se borra lo que calculó el seed: lo que haya después lo escribió CON-6.
        await db.raw.exec(`
          DELETE FROM post_score WHERE workspace_id = '${LAURA}';
          DELETE FROM creator_baseline WHERE workspace_id = '${LAURA}';
          DELETE FROM notification WHERE workspace_id = '${LAURA}' AND kind IN ('outlier', 'breakout');
        `);
      },
    });
  });
  after(async () => { await h.stop(); });

  test('sin línea base, campaign.compute no inventa el múltiplo y dice que falta', async () => {
    await h.worker.boss.send('campaign.compute', { workspaceId: LAURA, campaignId: CAFE_ALMA, source: 'test' });
    const run = await corrida(h, 'campaign.compute', 1);
    assert.equal(run.status, 'ok', run.error ?? '');
    const r = await resultado();
    assert.equal(r.views_vs_median, null);
    assert.ok(r.missing_inputs.includes('baseline'), `missing_inputs: ${r.missing_inputs.join(', ')}`);
  });

  test('con la línea base de compute.baseline, la cifra exacta', async () => {
    await h.worker.boss.send('compute.baseline', { workspaceId: LAURA, source: 'test' });
    const base = await corrida(h, 'compute.baseline', 1);
    assert.equal(base.status, 'ok', base.error ?? '');
    const score = await corrida(h, 'compute.post_score', 1);
    assert.equal(score.status, 'ok', score.error ?? '');
    assert.equal(score.metadata['tras'], 'compute.baseline');

    await h.worker.boss.send('campaign.compute', { workspaceId: LAURA, campaignId: CAFE_ALMA, source: 'test' });
    const run = await corrida(h, 'campaign.compute', 2);
    assert.equal(run.status, 'ok', run.error ?? '');
    const r = await resultado();
    assert.equal(r.views_vs_median, '4.496', 'Café Alma: 4,496× la mediana del creador');
    assert.ok(!r.missing_inputs.includes('baseline'));
  });

  test('las 16 líneas base y los 59 puntajes son los mismos que calcula db/seed/0002', async () => {
    assert.equal(basesDelSeed.length, 16);
    assert.equal(puntajesDelSeed.length, 59);
    assert.deepEqual((await h.db.query<BaseSeed>(BASES)).rows, basesDelSeed);
    assert.deepEqual((await h.db.query<ScoreSeed>(PUNTAJES)).rows, puntajesDelSeed);
  });
});
