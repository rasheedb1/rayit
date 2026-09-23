/**
 * CAM-5 · campaign.compute en el arnés, con las migraciones y los seeds
 * reales: las tres campañas en curso del seed quedan con su resultado
 * recalculado (Café Alma con el CPM de 4 353,93, no los 11 800 del mock),
 * la segunda corrida reemplaza sin duplicar, la cerrada no se toca y dos
 * workspaces no se cruzan. metadata solo lleva conteos e ids.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { allJobs } from '../src/jobs/index.ts';
import { jobRuns, startHarness, waitFor, type Harness, type JobRunRow } from './helpers/harness.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';

const NOW = new Date('2026-09-23T07:30:00Z');
const LAURA = '00000002-0000-4000-8000-000000000001';
const CAFE_ALMA = '00000003-0000-4000-8000-000000ca0001';
const FRESKO = '00000003-0000-4000-8000-000000ca0002';
const NUTRIVE = '00000003-0000-4000-8000-000000ca0003';
const HOGAR = '00000003-0000-4000-8000-000000ca0004';
/** Otro workspace con una campaña en curso de su propia marca. */
const OTRO = '00000009-0000-4000-8000-000000000c05';
const OTRA_MARCA = '00000009-0000-4000-8000-0000000c05e1';
const OTRA_CAMPANA = '00000009-0000-4000-8000-00000c05ca01';
const SEED_DIR = join(import.meta.dirname, '../../../db/seed');

async function seed(db: PgliteDatabase): Promise<void> {
  for (const f of (await readdir(SEED_DIR)).filter((n) => n.endsWith('.sql')).sort()) {
    await db.raw.exec(await readFile(join(SEED_DIR, f), 'utf8'));
  }
  await db.raw.exec(`
    INSERT INTO workspace (id, slug, name, kind, currency) VALUES ('${OTRO}', 'otro-cam5', 'Otro', 'creator', 'USD');
    INSERT INTO company (id, name, domain, owner_workspace_id) VALUES ('${OTRA_MARCA}', 'Otra marca', 'otra.example', '${OTRO}');
    INSERT INTO campaign (id, workspace_id, company_id, name, status, starts_on, ends_on, amount, currency)
    VALUES ('${OTRA_CAMPANA}', '${OTRO}', '${OTRA_MARCA}', 'Campaña de otro', 'live', DATE '2026-09-01', DATE '2026-09-10', 900.00, 'USD');
  `);
}

interface ResultRow extends Record<string, unknown> {
  campaign_id: string;
  workspace_id: string;
  computed_at: string;
  cut_hours: number;
  views: string | null;
  reach: string | null;
  cpm: string | null;
  cpa: string | null;
  cost_per_follower: string | null;
  views_vs_median: string | null;
  missing_inputs: string[];
}

async function results(db: PgliteDatabase): Promise<Map<string, ResultRow>> {
  const { rows } = await db.query<ResultRow>(
    `SELECT campaign_id, workspace_id, to_char(computed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS computed_at, cut_hours,
            views::text AS views, reach::text AS reach, cpm::text AS cpm, cpa::text AS cpa, cost_per_follower::text AS cost_per_follower,
            views_vs_median::text AS views_vs_median, missing_inputs
       FROM campaign_result ORDER BY campaign_id`,
  );
  return new Map(rows.map((r) => [r.campaign_id, r]));
}

async function runOnce(h: Harness, payload: Record<string, unknown> = {}): Promise<JobRunRow> {
  const before = (await jobRuns(h.db, 'campaign.compute')).length;
  await h.worker.boss.send('campaign.compute', { source: 'test', ...payload });
  return waitFor(async () => (await jobRuns(h.db, 'campaign.compute')).slice(before).find((r) => r.status !== 'running'), {
    label: 'campaign.compute',
    timeoutMs: 60_000,
  });
}

let h: Harness;
before(async () => {
  h = await startHarness({ jobs: allJobs, now: () => NOW, seed });
}, { timeout: 600_000 });
after(async () => { await h.stop(); });

test('las campañas en curso quedan con el resultado recalculado; la cerrada no se toca', async () => {
  const nutriveAntes = (await results(h.db)).get(NUTRIVE);
  const run = await runOnce(h);
  assert.equal(run.status, 'ok', run.error ?? '');
  const md = run.metadata as { campaigns: number; computed: string[]; partial: string[]; failed: string[] };
  assert.deepEqual([...md.computed].sort(), [CAFE_ALMA, FRESKO, HOGAR, OTRA_CAMPANA].sort());
  assert.deepEqual(md.partial, [FRESKO], 'Fresko aún no llega a 30 días');
  assert.deepEqual(md.failed, []);
  assert.deepEqual(Object.keys(md).filter((k) => k !== 'bossJobId').sort(), ['campaigns', 'computed', 'failed', 'partial'], 'solo conteos e ids (bossJobId lo pone el runner)');

  const r = await results(h.db);
  const cafe = r.get(CAFE_ALMA);
  assert.deepEqual(
    [cafe?.cut_hours, cafe?.views, cafe?.reach, cafe?.cpm, cafe?.cost_per_follower, cafe?.cpa, cafe?.views_vs_median, cafe?.missing_inputs],
    [720, '712000', '486000', '4353.93', '2500.00', '9748.43', '4.496', ['brand_csv_sales']],
  );
  assert.equal(cafe?.computed_at, NOW.toISOString().replace('.000Z', 'Z'), 'computed_at es ctx.now()');
  assert.equal(r.get(FRESKO)?.cut_hours, 168);
  assert.deepEqual(r.get(FRESKO)?.missing_inputs, ['brand_followers', 'brand_inputs']);
  assert.deepEqual([r.get(HOGAR)?.views, r.get(HOGAR)?.cpa], [null, '26190.48'], 'sin posts: null, no cero');
  assert.deepEqual(r.get(NUTRIVE), nutriveAntes, 'closed conserva su resultado');
});

test('la segunda corrida reemplaza sin duplicar', async () => {
  const antes = await results(h.db);
  const run = await runOnce(h);
  assert.equal(run.status, 'ok', run.error ?? '');
  const despues = await results(h.db);
  assert.deepEqual([...despues.keys()], [...antes.keys()], 'las mismas filas');
  assert.deepEqual(despues.get(CAFE_ALMA), antes.get(CAFE_ALMA));
});

test('dos workspaces sin cruce: cada fila con su workspace y sin los posts del otro', async () => {
  const r = await results(h.db);
  const otra = r.get(OTRA_CAMPANA);
  assert.equal(otra?.workspace_id, OTRO);
  assert.equal(otra?.views, null, 'no ve los posts de Laura');
  assert.deepEqual(otra?.missing_inputs, ['posts', 'brand_followers', 'brand_inputs']);
  for (const id of [CAFE_ALMA, FRESKO, HOGAR, NUTRIVE]) assert.equal(r.get(id)?.workspace_id, LAURA, id);

  const soloOtro = await runOnce(h, { workspaceId: OTRO });
  assert.deepEqual((soloOtro.metadata as { computed: string[] }).computed, [OTRA_CAMPANA], 'con workspaceId solo toca ese workspace');
  assert.equal(soloOtro.workspace_id, OTRO);
  const una = await runOnce(h, { workspaceId: LAURA, campaignId: CAFE_ALMA });
  assert.deepEqual((una.metadata as { computed: string[] }).computed, [CAFE_ALMA]);
});
