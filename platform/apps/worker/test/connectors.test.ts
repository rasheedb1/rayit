/**
 * CON-1 · Fase 4: un job que llama a tiktok.listVideos con FixtureFetch
 * deja su fila en api_call_log con connection_id y duration_ms > 0, y
 * la cuota del día queda en api_quota_usage. Sin red: el guard lo demuestra.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FixtureFetch, loadFixtures, withoutNetwork, type NetworkGuard, type OAuthTokens } from '@mc/connectors';
import { defineJob } from '../src/runner/registry.ts';
import { jobRuns, startHarness, waitFor, type Harness } from './helpers/harness.ts';

const WORKSPACE = '00000002-0000-4000-8000-000000000001';
const CONNECTION = '00000002-0000-4000-8000-0000000000c2';
const TOKENS: OAuthTokens = { accessToken: 'ACCESS-WORKER-SECRETO-777', refreshToken: 'REFRESH-WORKER-SECRETO-888', accessExpiresAt: new Date(Date.now() + 3_600_000), scopes: ['video.list'] };

let guard: NetworkGuard;
let h: Harness;
let fetch: FixtureFetch;

const collectJob = defineJob('test.connectors', async (_payload, ctx) => {
  const tiktok = ctx.connectors.tiktokDisplay({ connectionId: CONNECTION, tokens: TOKENS });
  let posts = 0;
  for await (const page of tiktok.iterateVideos()) posts += page.data.items.length;
  const youtube = ctx.connectors.youtube({ connectionId: null, tokens: TOKENS });
  const brand = await youtube.channelByHandle('NutriveOficial');
  return { processed: posts, failed: 0, metadata: { posts, brandFollowers: brand.data?.followers_count ?? null } };
});

before(async () => {
  guard = withoutNetwork();
  fetch = new FixtureFetch([...(await loadFixtures('tiktok', [['video.list', 'paginated']])), ...(await loadFixtures('youtube', [['channels.list', 'handle.ok']]))]);
  h = await startHarness({
    jobs: [collectJob],
    http: { fetch: fetch.fetch },
    seed: async (db) => {
      await db.raw.exec(`
        INSERT INTO job_definition (id, label_es, queue, default_cron, timeout_s, max_attempts, max_concurrency)
          VALUES ('test.connectors', 'Prueba: conector con fixture', 'test', NULL, 10, 1, 1);
        SELECT set_config('app.workspace_id', '${WORKSPACE}', false);
        INSERT INTO workspace (id, slug, name, kind, country, currency, timezone, locale, plan)
          VALUES ('${WORKSPACE}', 'laura', 'Laura', 'creator', 'CO', 'COP', 'America/Bogota', 'es-CO', 'creator');
        INSERT INTO app_user (id, email, name, locale) VALUES ('00000002-0000-4000-8000-000000000002', 'laura@ejemplo.com', 'Laura', 'es-CO');
        INSERT INTO creator_profile (id, workspace_id, user_id, display_name, handle)
          VALUES ('00000002-0000-4000-8000-000000000003', '${WORKSPACE}', '00000002-0000-4000-8000-000000000002', 'Laura', 'laura');
        INSERT INTO social_connection (id, workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes)
          VALUES ('${CONNECTION}', '${WORKSPACE}', '00000002-0000-4000-8000-000000000003', 'tiktok', 'open_id_demo_laura', 'laura', 'vault:demo', '{video.list}');
      `);
    },
  });
});

after(async () => {
  await h.stop();
  guard.restore();
});

test('el job usa ctx.connectors y cada llamada deja su fila en api_call_log', async () => {
  await h.worker.boss.send('test.connectors', { workspaceId: WORKSPACE, entityType: 'social_connection', entityId: CONNECTION });
  const run = await waitFor(async () => (await jobRuns(h.db, 'test.connectors')).find((r) => r.status !== 'running'), { label: 'test.connectors' });
  assert.equal(run.status, 'ok', run.error ?? '');
  assert.equal(run.items_processed, 3, 'dos páginas: 2 + 1 videos');
  assert.equal(run.metadata['brandFollowers'], 38400);
  assert.equal(fetch.calls.length, 3);
  assert.equal(guard.attempts, 0, 'nada salió por globalThis.fetch');

  const { rows } = await h.db.query<{ connection_id: string | null; platform_id: string; endpoint: string; http_status: number; ok: boolean; duration_ms: number; request_units: number }>(
    'SELECT connection_id, platform_id, endpoint, http_status, ok, duration_ms, request_units FROM api_call_log ORDER BY id',
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.endpoint), ['tiktok.video.list', 'tiktok.video.list', 'youtube.channels.list']);
  assert.ok(rows.slice(0, 2).every((r) => r.connection_id === CONNECTION && r.ok && r.http_status === 200 && r.duration_ms > 0), JSON.stringify(rows));
  assert.equal(rows[2]!.connection_id, null, 'la llamada pública del canal de la marca no tiene conexión');
  assert.equal(rows[2]!.request_units, 1);

  const usage = await h.db.query<{ platform_id: string; connection_id: string | null; units_used: number | string; calls: number | string; units_limit: number | string | null }>(
    'SELECT platform_id, connection_id, units_used, calls, units_limit FROM api_quota_usage ORDER BY platform_id',
  );
  assert.equal(usage.rows.length, 1, 'solo YouTube tiene presupuesto diario: TikTok no persiste');
  assert.equal(usage.rows[0]!.platform_id, 'youtube');
  assert.equal(usage.rows[0]!.connection_id, null);
  assert.equal(Number(usage.rows[0]!.units_used), 1);
  assert.equal(Number(usage.rows[0]!.units_limit), 10_000);

  // Ni el token ni nada parecido en job_run, api_call_log ni en los logs.
  const everything = JSON.stringify(run) + JSON.stringify(rows) + h.sink.text();
  assert.ok(!everything.includes(TOKENS.accessToken));
  assert.ok(!everything.includes(TOKENS.refreshToken!));
});
