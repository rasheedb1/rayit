import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { HttpCore } from '../src/http/client.ts';
import type { PlatformApiError } from '../src/http/errors.ts';
import { InMemoryCallLogSink } from '../src/log/memory.ts';
import { QuotaManager } from '../src/quota/manager.ts';
import { TikTokAccountsClient } from '../src/platforms/tiktok-accounts.ts';
import { FixtureFetch, loadFixtures, withoutNetwork, type NetworkGuard } from '../src/testing/fixture-fetch.ts';
import type { OAuthTokens } from '../src/types.ts';
import { FakeClock } from './helpers/fake-clock.ts';

let guard: NetworkGuard;
before(() => { guard = withoutNetwork(); });
after(() => { guard.restore(); });

const TOKENS: OAuthTokens = { accessToken: 'act.BUSINESS-SECRETO-2468', accessExpiresAt: new Date('2026-09-23T00:00:00Z'), scopes: ['user.info.basic', 'video.list', 'video.insights'] };
const CONN = '00000002-0000-4000-8000-0000000000c4';

async function client(names: ReadonlyArray<[string, string?]>) {
  const clock = new FakeClock();
  const log = new InMemoryCallLogSink();
  const fetch = new FixtureFetch(await loadFixtures('tiktok-accounts', names));
  const core = new HttpCore({ callLog: log, quota: new QuotaManager({ now: clock.now, sleep: clock.sleep }), fetch: fetch.fetch, now: clock.now, sleep: clock.sleep, random: () => 1 });
  return { clock, log, fetch, api: new TikTokAccountsClient(core, { connectionId: CONN, tokens: TOKENS }, 'open_id_business_laura') };
}

async function failure(p: Promise<unknown>): Promise<PlatformApiError> {
  return p.then(() => { throw new Error('esperaba un error'); }, (e: unknown) => e as PlatformApiError);
}

test('accountInfo ok: la credencial va en Access-Token, y la demografía sale como filas de audience_breakdown', async () => {
  const { api, fetch, log } = await client([['business.get', 'ok']]);
  const { data } = await api.accountInfo({ startDate: '2026-09-14', endDate: '2026-09-21' });
  assert.equal(fetch.calls[0]!.headers['Access-Token'], '[REDACTADO]');
  assert.equal(fetch.calls[0]!.headers['Authorization'], undefined);
  assert.ok(!fetch.calls[0]!.url.includes(TOKENS.accessToken));
  assert.ok(fetch.calls[0]!.url.includes('start_date=2026-09-14&end_date=2026-09-21'));
  assert.equal(data.profile.external_account_id, 'open_id_business_laura');
  assert.equal(data.profile.account_type, 'business');
  assert.equal(data.metrics.day, '2026-09-21');
  assert.equal(data.metrics.followers, 412000);
  assert.equal(data.metrics.profile_views, 5300);
  assert.equal(data.metrics.views, 2100000);
  assert.equal(data.metrics.total_interactions, null, 'no se suman likes+comments+shares: sin aritmética');
  assert.equal(data.demographics.length, 3 + 3 + 5);
  assert.deepEqual(data.demographics[0], { population: 'followers', dimension: 'country', bucket: 'CO', share: 0.82, absolute: null });
  assert.deepEqual(data.demographics[3], { population: 'followers', dimension: 'gender', bucket: 'F', share: 0.7, absolute: null });
  assert.deepEqual(data.demographics[7], { population: 'followers', dimension: 'age', bucket: '25-34', share: 0.41, absolute: null });
  assert.equal(log.entries[0]!.endpoint, 'tiktok.business.get');
});

test('accountInfo nulls: cuenta personal sin demografía', async () => {
  const { api } = await client([['business.get', 'nulls']]);
  const { data } = await api.accountInfo();
  assert.equal(data.profile.account_type, 'creator');
  assert.equal(data.metrics.followers, null);
  assert.deepEqual(data.demographics, []);
});

test('video.list ok: reach, retención y fuentes de impresión normalizados', async () => {
  const { api } = await client([['business.video.list', 'ok']]);
  const { data } = await api.listVideos();
  assert.equal(data.items.length, 2);
  const v = data.items[0]!;
  assert.equal(v.post.external_post_id, '7400000000000000d01');
  assert.equal(v.post.duration_s, 31.5);
  assert.equal(v.metrics.views, 50001);
  assert.equal(v.metrics.reach, 38001);
  assert.equal(v.metrics.completion_rate, 0.31);
  assert.equal(v.metrics.total_watch_time_s, 410001);
  assert.equal(v.metrics.avg_watch_time_s, 8.2);
  assert.deepEqual(v.insights.impression_sources[0], { source: 'For You', share: 0.71 });
  assert.deepEqual(v.insights.audience_countries[0], { country: 'CO', share: 0.82 });
  assert.equal(v.insights.retention_curve, null, 'sin video.insights no hay curva');
  assert.equal(v.insights.likes_curve, null);
});

test('video.list empty, paginated, rate_limited, server_error_then_ok (HTTP 200 con code 50002) e invalid_token (code 40104)', async () => {
  const a = await client([['business.video.list', 'empty']]);
  assert.deepEqual((await a.api.listVideos()).data, { items: [], cursor: null, hasMore: false });
  const b = await client([['business.video.list', 'paginated']]);
  const pages = [];
  for await (const p of b.api.iterateVideos()) pages.push(p.data);
  assert.equal(pages.length, 2);
  assert.ok(b.fetch.calls[1]!.url.includes('cursor=1787932800'));
  const c = await client([['business.video.list', 'rate_limited']]);
  assert.equal((await c.api.listVideos()).data.items.length, 1);
  assert.deepEqual(c.clock.sleeps, [3000]);
  const d = await client([['business.video.list', 'server_error_then_ok']]);
  assert.equal((await d.api.listVideos()).data.items.length, 1);
  assert.equal(d.log.entries[0]!.error_code, '50002');
  assert.equal(d.log.entries[0]!.http_status, 200, 'el fallo vino con HTTP 200');
  assert.equal(d.log.entries[0]!.ok, false);
  const e = await client([['business.video.list', 'invalid_token']]);
  const err = await failure(e.api.listVideos());
  assert.equal(err.kind, 'auth');
  assert.equal(err.code, '40104');
  assert.equal(e.fetch.calls.length, 1);
});

test('video.list nulls: video reciente sin reach ni retención; ceros explícitos se conservan', async () => {
  const { api } = await client([['business.video.list', 'nulls']]);
  const v = (await api.listVideos()).data.items[0]!;
  assert.equal(v.metrics.views, 120);
  assert.equal(v.metrics.likes, 0);
  assert.equal(v.metrics.reach, null);
  assert.equal(v.metrics.completion_rate, null);
  assert.equal(v.metrics.avg_watch_time_s, null);
  assert.equal(v.post.caption, null);
  assert.deepEqual(v.insights.impression_sources, []);
});

test('videoInsights (pendiente de CON-9): acepta las curvas si llegan', async () => {
  const { api, fetch } = await client([['business.video.insights', 'ok']]);
  const { data } = await api.videoInsights(['7400000000000000d01']);
  assert.equal(data.length, 1);
  assert.equal(data[0]!.insights.retention_curve?.length, 10);
  assert.equal(data[0]!.insights.retention_curve?.[4], 0.69);
  assert.deepEqual(data[0]!.insights.likes_curve?.slice(0, 3), [0, 3, 9]);
  assert.ok(fetch.calls[0]!.url.includes('video_view_retention'));
  await assert.rejects(() => api.videoInsights([]), /entre 1 y 20/);
  assert.equal(guard.attempts, 0);
});
