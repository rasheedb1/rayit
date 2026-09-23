/**
 * CON-10 · collect.account_metrics: cuentas por @ leídas con las fuentes
 * públicas sobre fixtures. Instagram y YouTube dejan snapshot; TikTok
 * queda anotada sin métricas; una cuenta que ya no existe pasa a error;
 * la plataforma sin credencial se salta. Ni el token casa ni la API key
 * aparecen en ninguna tabla ni en el log.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { dumpTextColumns, findSecretInDump, FixtureFetch, loadFixtures, withoutNetwork, type Fixture, type NetworkGuard } from '@mc/connectors';
import { allJobs } from '../src/jobs/index.ts';
import { jobRuns, startHarness, waitFor, type Harness } from './helpers/harness.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';

const NOW = new Date('2026-09-22T05:10:00Z');
const WORKSPACE = '00000002-0000-4000-8000-000000000001';
const CREATOR = '00000002-0000-4000-8000-000000000003';
const ENV = { INSTAGRAM_HOUSE_TOKEN: 'IGAA-house-worker-SECRETO', GOOGLE_API_KEY: 'AIza-worker-key-SECRETO' };

let h: Harness;
let guard: NetworkGuard;
let fetch: FixtureFetch;
let ids: { ig: string; yt: string; tt: string; gone: string; auth: string };
const AUTH_TOKENS = { accessToken: 'act.demo-access-tiktok-AUTH-SECRETO', refreshToken: 'rft.demo-refresh-AUTH-SECRETO', accessExpiresAt: new Date('2026-09-23T05:00:00Z'), scopes: ['user.info.basic', 'user.info.stats'] };

async function seed(db: PgliteDatabase): Promise<void> {
  const raw = db.raw;
  await raw.exec(`
    SELECT set_config('app.workspace_id', '${WORKSPACE}', false);
    INSERT INTO workspace (id, slug, name) VALUES ('${WORKSPACE}', 'laura', 'Laura');
    INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${CREATOR}', '${WORKSPACE}', 'Laura');
  `);
  const add = async (platform: string, handle: string, ext: string) => {
    const r = await raw.query<{ id: string }>(
      `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_mode)
       VALUES ($1, $2, $3, $4, $5, $6, '{}', 'public_profile') RETURNING id`,
      [WORKSPACE, CREATOR, platform, ext, handle, `public:${platform}:${handle}`],
    );
    return r.rows[0]!.id;
  };
  const authRow = await raw.query<{ id: string }>(
    `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_mode, access_expires_at)
     VALUES ($1, $2, 'tiktok', 'open_id_demo_laura', 'laura.cocinafacil.auth', 'vault:tt-auth', '{user.info.basic}', 'direct_oauth', $3) RETURNING id`,
    [WORKSPACE, CREATOR, AUTH_TOKENS.accessExpiresAt],
  );
  ids = { ig: await add('instagram', 'cafealma', '17841400000000e01'), yt: await add('youtube', 'NutriveOficial', 'UCnutrive00000000000000e4'), tt: await add('tiktok', 'laura.cocinafacil', 'laura.cocinafacil'), gone: await add('tiktok', 'noexiste.zz9', 'noexiste.zz9'), auth: authRow.rows[0]!.id };
  await raw.exec("SELECT set_config('app.workspace_id', '', false)");
}

before(async () => {
  guard = withoutNetwork();
  fetch = new FixtureFetch([
    ...(await loadFixtures('instagram', [['business_discovery', 'ok']])),
    ...(await loadFixtures('youtube', [['channels.list', 'handle.ok']])),
    // El oEmbed casa por handle: la cuenta buena tiene su fixture; cualquier otra cae en not_found.
    ...(await loadFixtures('tiktok', [['oembed.profile', 'ok'], ['oembed.profile', 'not_found'], ['user.info', 'ok']])),
  ]);
  h = await startHarness({ jobs: allJobs, now: () => NOW, seed, env: ENV, http: { fetch: fetch.fetch } });
  await h.secrets.set('vault:tt-auth', AUTH_TOKENS);
});
after(async () => { await h.stop(); guard.restore(); });

test('snapshots de Instagram y YouTube, TikTok anotada sin métricas, la cuenta inexistente en error; sin credenciales en tablas ni log', async () => {
  await h.worker.boss.send('collect.account_metrics', { source: 'test' });
  const run = await waitFor(async () => (await jobRuns(h.db, 'collect.account_metrics')).find((r) => r.status !== 'running'), { label: 'collect.account_metrics', timeoutMs: 30_000 });
  assert.equal(run.status, 'ok', run.error ?? '');
  const md = run.metadata as { snapshots: string[]; noMetrics: string[]; errored: string[]; transient: string[]; skipped: Record<string, string> };
  assert.deepEqual([...md.snapshots].sort(), [ids.ig, ids.yt, ids.auth].sort(), 'la autorizada se lee con su token (userInfo)');
  assert.deepEqual(md.noMetrics, [ids.tt]);
  assert.deepEqual(md.errored, [ids.gone]);
  assert.deepEqual(md.transient, []);
  assert.deepEqual(md.skipped, {});

  const snaps = await h.db.query<{ connection_id: string; day: string; followers: string | number | null; media_count: string | number | null; views: string | number | null; source: string }>(
    `SELECT connection_id, day::text AS day, followers, media_count, views, source FROM account_metric_snapshot ORDER BY connection_id`,
  );
  assert.equal(snaps.rows.length, 3);
  const auth = snaps.rows.find((s) => s.connection_id === ids.auth)!;
  assert.equal(Number(auth.followers), 412000);
  assert.equal(auth.source, 'api');
  const ig = snaps.rows.find((s) => s.connection_id === ids.ig)!;
  assert.equal(Number(ig.followers), 267793);
  assert.equal(Number(ig.media_count), 1205);
  assert.equal(ig.views, null, 'Instagram no publica vistas: null, no cero');
  assert.equal(ig.day, '2026-09-22');
  assert.equal(ig.source, 'public_profile');
  const yt = snaps.rows.find((s) => s.connection_id === ids.yt)!;
  assert.equal(Number(yt.followers), 38400);
  assert.ok(yt.views !== null);

  const conns = await h.db.query<{ id: string; status: string; status_detail: string | null; last_synced_at: Date | string | null }>(`SELECT id, status, status_detail, last_synced_at FROM social_connection`);
  const by = new Map(conns.rows.map((c) => [c.id, c]));
  assert.ok(by.get(ids.ig)!.last_synced_at && by.get(ids.yt)!.last_synced_at);
  assert.equal(by.get(ids.tt)!.status, 'active');
  assert.match(by.get(ids.tt)!.status_detail!, /no publica seguidores/);
  assert.equal(by.get(ids.tt)!.last_synced_at, null, 'sin métricas no hay «datos hasta»');
  assert.equal(by.get(ids.gone)!.status, 'error');
  assert.match(by.get(ids.gone)!.status_detail!, /No encontramos @noexiste.zz9/);

  const log = await h.db.query<{ endpoint: string; ok: boolean }>(`SELECT endpoint, ok FROM api_call_log ORDER BY id`);
  assert.deepEqual(log.rows.map((r) => r.endpoint).sort(), ['instagram.business_discovery', 'tiktok.oembed', 'tiktok.oembed', 'tiktok.user.info', 'youtube.channels.list']);
  assert.equal(guard.attempts, 0);

  const raw = { query: (text: string, params?: readonly unknown[]) => h.db.raw.query(text, params as unknown[]) };
  const dump = await dumpTextColumns(raw, 'public');
  assert.equal(findSecretInDump(dump, [ENV.INSTAGRAM_HOUSE_TOKEN, ENV.GOOGLE_API_KEY, AUTH_TOKENS.accessToken, AUTH_TOKENS.refreshToken]), null);
  const text = h.sink.text();
  for (const s of [ENV.INSTAGRAM_HOUSE_TOKEN, ENV.GOOGLE_API_KEY, AUTH_TOKENS.accessToken, AUTH_TOKENS.refreshToken]) assert.ok(!text.includes(s));
});

test('sin credenciales, la plataforma se salta y se avisa; nada falla', async () => {
  const h2 = await startHarness({ jobs: allJobs, now: () => NOW, seed, env: {}, http: { fetch: fetch.fetch } });
  await h2.secrets.set('vault:tt-auth', AUTH_TOKENS);
  try {
    await h2.worker.boss.send('collect.account_metrics', { source: 'test' });
    const run = await waitFor(async () => (await jobRuns(h2.db, 'collect.account_metrics')).find((r) => r.status !== 'running'), { label: 'sin credenciales', timeoutMs: 30_000 });
    assert.equal(run.status, 'ok', run.error ?? '');
    const md = run.metadata as { snapshots: string[]; skipped: Record<string, string> };
    assert.deepEqual(md.snapshots, [ids.auth], 'la autorizada no depende de las credenciales de la casa: se lee con su propio token');
    assert.match(md.skipped['instagram']!, /INSTAGRAM_HOUSE_TOKEN/);
    assert.match(md.skipped['youtube']!, /GOOGLE_API_KEY/);
    assert.equal(md.skipped['tiktok'], undefined, 'TikTok no necesita credencial');
  } finally {
    await h2.stop();
  }
});

test('CON-12 · con ENSEMBLEDATA_TOKEN, TikTok deja seguidores y vistas, la fila pasa a aggregator y el token no queda en ningún lado', async () => {
  const ED_TOKEN = 'ed-token-worker-SECRETO';
  // El proveedor responde en la misma URL para cualquier @: aquí se acota
  // el patrón por username para que cada cuenta reciba lo suyo.
  const porUsuario = (fixture: Fixture, username: string): Fixture => ({ ...fixture, request: { ...fixture.request, urlPattern: `${fixture.request.urlPattern}(?=.*username=${username}(&|$))` } });
  const [ok, posts, noExiste] = await loadFixtures('ensembledata', [['user.info', 'ok'], ['user.posts', 'ok'], ['user.info', 'user_not_found']]);
  const edFetch = new FixtureFetch([
    porUsuario(ok!, 'laura\\.cocinafacil'),
    porUsuario(posts!, 'laura\\.cocinafacil'),
    porUsuario(noExiste!, 'noexiste\\.zz9'),
    ...(await loadFixtures('instagram', [['business_discovery', 'ok']])),
    ...(await loadFixtures('youtube', [['channels.list', 'handle.ok']])),
    ...(await loadFixtures('tiktok', [['user.info', 'ok']])),
  ]);
  const h3 = await startHarness({ jobs: allJobs, now: () => NOW, seed, env: { ...ENV, ENSEMBLEDATA_TOKEN: ED_TOKEN }, http: { fetch: edFetch.fetch } });
  await h3.secrets.set('vault:tt-auth', AUTH_TOKENS);
  try {
    await h3.worker.boss.send('collect.account_metrics', { source: 'test' });
    const run = await waitFor(async () => (await jobRuns(h3.db, 'collect.account_metrics')).find((r) => r.status !== 'running'), { label: 'con proveedor', timeoutMs: 30_000 });
    assert.equal(run.status, 'ok', run.error ?? '');
    const md = run.metadata as { snapshots: string[]; noMetrics: string[]; errored: string[] };
    assert.ok(md.snapshots.includes(ids.tt), 'la cuenta de TikTok ya deja snapshot');
    assert.deepEqual(md.noMetrics, [], 'ya no hay cuentas sin métricas');
    assert.deepEqual(md.errored, [ids.gone], 'la que no existe sigue en error, con el mensaje del proveedor');

    const tt = await h3.db.query<{ followers: string | number | null; views: string | number | null; media_count: string | number | null; source: string; day: string }>(
      `SELECT followers, views, media_count, source, day::text AS day FROM account_metric_snapshot WHERE connection_id = $1`, [ids.tt]);
    assert.equal(tt.rows.length, 1);
    assert.equal(Number(tt.rows[0]!.followers), 128400);
    assert.equal(Number(tt.rows[0]!.views), 65401);
    assert.equal(Number(tt.rows[0]!.media_count), 3);
    assert.equal(tt.rows[0]!.source, 'aggregator');
    assert.equal(tt.rows[0]!.day, '2026-09-22');

    const bitacora = await h3.db.query<{ actor_kind: string; action: string; before: unknown; after: unknown }>(
      `SELECT actor_kind, action, before, after FROM audit_log WHERE entity_id = $1 AND action = 'connection.source_changed'`, [ids.tt]);
    assert.equal(bitacora.rows.length, 1, 'el cambio de fuente queda en la bitácora, como job');
    assert.equal(bitacora.rows[0]!.actor_kind, 'job');
    assert.deepEqual(bitacora.rows[0]!.before, { accessMode: 'public_profile' });
    assert.equal((bitacora.rows[0]!.after as { accessMode: string }).accessMode, 'aggregator');

    const conn = await h3.db.query<{ access_mode: string; status: string; last_synced_at: Date | string | null }>(`SELECT access_mode, status, last_synced_at FROM social_connection WHERE id = $1`, [ids.tt]);
    assert.equal(conn.rows[0]!.access_mode, 'aggregator', 'la fila cambió de fuente sin perder su id');
    assert.equal(conn.rows[0]!.status, 'active');
    assert.ok(conn.rows[0]!.last_synced_at, 'ya hay «datos hasta»');

    const gone = await h3.db.query<{ status: string; status_detail: string | null }>(`SELECT status, status_detail FROM social_connection WHERE id = $1`, [ids.gone]);
    assert.equal(gone.rows[0]!.status, 'error');
    assert.match(gone.rows[0]!.status_detail!, /No encontramos @noexiste\.zz9/);

    // R4: el token del proveedor viaja en la query; no puede quedar en ninguna
    // columna de texto, ni en api_call_log, ni en los logs del worker.
    const raw = { query: (text: string, params?: readonly unknown[]) => h3.db.raw.query(text, params as unknown[]) };
    assert.equal(findSecretInDump(await dumpTextColumns(raw, 'public'), [ED_TOKEN]), null);
    assert.ok(!h3.sink.text().includes(ED_TOKEN));
    assert.ok(!JSON.stringify(edFetch.calls).includes(ED_TOKEN));
    assert.equal(guard.attempts, 0);
  } finally {
    await h3.stop();
  }
});
