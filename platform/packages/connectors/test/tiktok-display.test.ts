import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { HttpCore } from '../src/http/client.ts';
import type { PlatformApiError } from '../src/http/errors.ts';
import { InMemoryCallLogSink } from '../src/log/memory.ts';
import { QuotaManager } from '../src/quota/manager.ts';
import { TikTokDisplayClient, normalizeTikTokVideo } from '../src/platforms/tiktok-display.ts';
import { FixtureFetch, loadFixtures, withoutNetwork, type NetworkGuard } from '../src/testing/fixture-fetch.ts';
import type { OAuthTokens } from '../src/types.ts';
import { FakeClock } from './helpers/fake-clock.ts';

let guard: NetworkGuard;
before(() => { guard = withoutNetwork(); });
after(() => { guard.restore(); });

const TOKENS: OAuthTokens = { accessToken: 'ACCESS-TT-SECRETO-1234', accessExpiresAt: new Date('2027-01-01T00:00:00Z'), scopes: ['video.list'] };
const CONN = '00000002-0000-4000-8000-0000000000c2';

async function client(names: ReadonlyArray<[string, string?]>) {
  const clock = new FakeClock();
  const log = new InMemoryCallLogSink();
  const fetch = new FixtureFetch(await loadFixtures('tiktok', names));
  const core = new HttpCore({ callLog: log, quota: new QuotaManager({ now: clock.now, sleep: clock.sleep }), fetch: fetch.fetch, now: clock.now, sleep: clock.sleep, random: () => 1 });
  return { clock, log, fetch, api: new TikTokDisplayClient(core, { connectionId: CONN, tokens: TOKENS }) };
}

test('video.list ok: tres videos normalizados con los nombres de post y post_metric_snapshot', async () => {
  const { api, log, fetch } = await client([['video.list', 'ok']]);
  const { data, raw } = await api.listVideos();
  assert.equal(data.items.length, 3);
  assert.equal(data.hasMore, false);
  assert.equal(data.cursor, null);
  const first = data.items[0]!;
  assert.equal(first.post.external_post_id, '7400000000000000d01');
  assert.equal(first.post.media_type, 'video');
  assert.equal(first.post.surface, 'feed');
  assert.equal(first.post.duration_s, 31);
  assert.deepEqual(first.post.hashtags, ['recetafacil', 'ad']);
  assert.deepEqual(first.post.mentions, ['cafealma.co']);
  assert.equal(first.post.published_at?.toISOString(), '2026-08-28T16:00:00.000Z');
  assert.equal(first.post.is_ai_generated, false);
  assert.equal(first.metrics.views, 50001);
  assert.equal(first.metrics.likes, 1201);
  assert.equal(first.metrics.comments, 41);
  assert.equal(first.metrics.shares, 11);
  assert.equal(first.metrics.saves, null, 'Display API no da saves');
  assert.equal((raw as { error: { code: string } }).error.code, 'ok');
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0]!.endpoint, 'tiktok.video.list');
  assert.equal(log.entries[0]!.connection_id, CONN);
  assert.equal(fetch.calls[0]!.headers['Authorization'], '[REDACTADO]');
  assert.ok(!fetch.calls[0]!.url.includes(TOKENS.accessToken));
  assert.equal(fetch.calls[0]!.url, 'https://open.tiktokapis.com/v2/video/list/?fields=id%2Ccreate_time%2Ccover_image_url%2Cshare_url%2Cvideo_description%2Cduration%2Cheight%2Cwidth%2Ctitle%2Cembed_html%2Cembed_link%2Clike_count%2Ccomment_count%2Cshare_count%2Cview_count%2Cis_aigc');
});

test('video.list empty', async () => {
  const { api } = await client([['video.list', 'empty']]);
  const { data } = await api.listVideos();
  assert.deepEqual(data, { items: [], cursor: null, hasMore: false });
});

test('video.list paginated: iterateVideos recorre dos páginas y pasa el cursor', async () => {
  const { api, fetch } = await client([['video.list', 'paginated']]);
  const pages = [];
  for await (const page of api.iterateVideos()) pages.push(page.data);
  assert.equal(pages.length, 2);
  assert.equal(pages[0]!.cursor, '1787932800000');
  assert.equal(pages[1]!.hasMore, false);
  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(fetch.calls[1]!.body, { max_count: 20, cursor: 1787932800000 });
});

test('video.list paginated: maxPages corta', async () => {
  const { api, fetch } = await client([['video.list', 'paginated']]);
  let n = 0;
  for await (const _page of api.iterateVideos({ maxPages: 1 })) n++;
  assert.equal(n, 1);
  assert.equal(fetch.calls.length, 1);
});

test('video.list rate_limited: 429 con Retry-After 7 → espera 7 s falsos y luego ok', async () => {
  const { api, clock, log } = await client([['video.list', 'rate_limited']]);
  const { data } = await api.listVideos();
  assert.equal(data.items.length, 1);
  assert.deepEqual(clock.sleeps, [7000]);
  assert.equal(log.entries.length, 2);
  assert.equal(log.entries[0]!.rate_limited, true);
});

test('video.list server_error_then_ok', async () => {
  const { api, log } = await client([['video.list', 'server_error_then_ok']]);
  const { data } = await api.listVideos();
  assert.equal(data.items.length, 1);
  assert.deepEqual(log.entries.map((e) => e.http_status), [500, 200]);
});

test('video.list invalid_token → kind auth sin reintento', async () => {
  const { api, fetch, log } = await client([['video.list', 'invalid_token']]);
  const err = await api.listVideos().then(() => null, (e: unknown) => e as PlatformApiError);
  assert.equal(err?.kind, 'auth');
  assert.equal(err?.code, 'access_token_invalid');
  assert.equal(fetch.calls.length, 1);
  assert.equal(log.entries[0]!.error_code, 'access_token_invalid');
});

test('video.list nulls: el normalizador respeta los nulos', async () => {
  const { api } = await client([['video.list', 'nulls']]);
  const { data } = await api.listVideos();
  const v = data.items[0]!;
  assert.equal(v.metrics.views, null);
  assert.equal(v.metrics.likes, null);
  assert.equal(v.metrics.comments, null);
  assert.equal(v.metrics.shares, null);
  assert.equal(v.post.caption, null);
  assert.equal(v.post.title, null);
  assert.equal(v.post.width, null);
  assert.equal(v.post.is_ai_generated, null);
  assert.deepEqual(v.post.hashtags, []);
  // Un cero explícito sí se conserva.
  assert.equal(normalizeTikTokVideo({ id: 'x', view_count: 0 }).metrics.views, 0);
});

test('user.info ok y nulls', async () => {
  const a = await client([['user.info', 'ok']]);
  const { data } = await a.api.userInfo();
  assert.equal(data.profile.external_account_id, 'open_id_demo_laura');
  assert.equal(data.profile.handle, 'laura.cocinafacil');
  assert.equal(data.metrics.followers, 412000);
  assert.equal(data.metrics.media_count, 214);
  const b = await client([['user.info', 'nulls']]);
  const r = await b.api.userInfo();
  assert.equal(r.data.metrics.followers, null);
  assert.equal(r.data.profile.handle, null);
});

test('video.query ok y empty; más de 20 ids se rechaza sin llamar', async () => {
  const a = await client([['video.query', 'ok']]);
  const { data } = await a.api.queryVideos(['7400000000000000d01', '7400000000000000d02']);
  assert.equal(data.length, 2);
  assert.equal(data[0]!.metrics.views, 51000);
  const b = await client([['video.query', 'empty']]);
  assert.deepEqual((await b.api.queryVideos(['nada'])).data, []);
  await assert.rejects(() => b.api.queryVideos(Array.from({ length: 21 }, (_, i) => String(i))), /entre 1 y 20/);
  assert.equal(b.fetch.calls.length, 1);
});

test('una llamada no prevista falla con un mensaje claro', async () => {
  const { api } = await client([['user.info', 'ok']]);
  await assert.rejects(() => api.listVideos(), /llamada no prevista POST https:\/\/open\.tiktokapis\.com\/v2\/video\/list/);
  assert.equal(guard.attempts, 0);
});
