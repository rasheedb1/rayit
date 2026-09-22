import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { HttpCore } from '../src/http/client.ts';
import type { PlatformApiError } from '../src/http/errors.ts';
import { InMemoryCallLogSink } from '../src/log/memory.ts';
import { QuotaManager } from '../src/quota/manager.ts';
import { InstagramClient } from '../src/platforms/instagram-api.ts';
import { FixtureFetch, loadFixtures, withoutNetwork, type NetworkGuard } from '../src/testing/fixture-fetch.ts';
import type { OAuthTokens } from '../src/types.ts';
import { FakeClock } from './helpers/fake-clock.ts';

let guard: NetworkGuard;
before(() => { guard = withoutNetwork(); });
after(() => { guard.restore(); });

const TOKENS: OAuthTokens = { accessToken: 'IGQVJ-SECRETO-0987654321', accessExpiresAt: new Date('2026-11-20T00:00:00Z'), scopes: ['instagram_business_basic', 'instagram_business_manage_insights'] };
const CONN = '00000002-0000-4000-8000-0000000000c1';

async function client(names: ReadonlyArray<[string, string?]>) {
  const clock = new FakeClock();
  const log = new InMemoryCallLogSink();
  const fetch = new FixtureFetch(await loadFixtures('instagram', names));
  const core = new HttpCore({ callLog: log, quota: new QuotaManager({ now: clock.now, sleep: clock.sleep }), fetch: fetch.fetch, now: clock.now, sleep: clock.sleep, random: () => 1 });
  return { clock, log, fetch, api: new InstagramClient(core, { connectionId: CONN, tokens: TOKENS }) };
}

async function failure(p: Promise<unknown>): Promise<PlatformApiError> {
  return p.then(() => { throw new Error('esperaba un error'); }, (e: unknown) => e as PlatformApiError);
}

test('me ok y nulls: el token va en Authorization y nunca en la URL', async () => {
  const a = await client([['me', 'ok']]);
  const { data } = await a.api.me();
  assert.equal(data.profile.external_account_id, '17841400000000123');
  assert.equal(data.profile.account_type, 'creator');
  assert.equal(data.profile.profile_url, 'https://www.instagram.com/laura.cocinafacil/');
  assert.equal(data.metrics.followers, 412000);
  assert.equal(data.metrics.media_count, 1205);
  assert.ok(!a.fetch.calls[0]!.url.includes('access_token'));
  assert.ok(!a.fetch.calls[0]!.url.includes(TOKENS.accessToken));
  assert.equal(a.fetch.calls[0]!.headers['Authorization'], '[REDACTADO]');
  const b = await client([['me', 'nulls']]);
  const r = await b.api.me();
  assert.equal(r.data.metrics.followers, null);
  assert.equal(r.data.profile.account_type, 'unknown');
});

test('media.list ok: reel, foto e historia con media_type y surface de la tabla post', async () => {
  const { api, log } = await client([['media.list', 'ok']]);
  const { data } = await api.media();
  assert.equal(data.items.length, 3);
  const [reel, photo, story] = data.items;
  assert.equal(reel!.post.media_type, 'video');
  assert.equal(reel!.post.surface, 'reels');
  assert.equal(reel!.post.published_at?.toISOString(), '2026-08-21T17:00:00.000Z');
  assert.deepEqual(reel!.post.hashtags, ['coldbrew', 'ad']);
  assert.deepEqual(reel!.post.mentions, ['cafealma']);
  assert.equal(reel!.metrics.likes, 3201);
  assert.equal(reel!.metrics.comments, 121);
  assert.equal(reel!.metrics.views, null, 'views sale de insights, no del listado');
  assert.equal(photo!.post.media_type, 'image');
  assert.equal(photo!.post.surface, 'feed');
  assert.equal(photo!.post.cover_url, 'https://scontent.cdninstagram.com/demo/d02.jpg');
  assert.equal(story!.post.media_type, 'story');
  assert.equal(story!.post.surface, 'story');
  assert.equal(data.hasMore, false, 'sin paging.next no hay más páginas');
  assert.equal(log.entries[0]!.endpoint, 'instagram.media.list');
});

test('media.list empty, paginated y maxPages', async () => {
  const a = await client([['media.list', 'empty']]);
  assert.deepEqual((await a.api.media()).data, { items: [], cursor: null, hasMore: false });
  const b = await client([['media.list', 'paginated']]);
  const pages = [];
  for await (const p of b.api.iterateMedia()) pages.push(p.data);
  assert.equal(pages.length, 2);
  assert.equal(pages[0]!.cursor, 'QVFIU_after_1');
  assert.ok(b.fetch.calls[1]!.url.includes('after=QVFIU_after_1'));
  const c = await client([['media.list', 'paginated']]);
  let n = 0;
  for await (const _p of c.api.iterateMedia({ maxPages: 1 })) n++;
  assert.equal(n, 1);
});

test('media.list rate_limited: Meta responde 400 code 17 → kind quota, sin reintento y sin Retry-After', async () => {
  const { api, fetch, log } = await client([['media.list', 'rate_limited']]);
  const err = await failure(api.media());
  assert.equal(err.kind, 'quota');
  assert.equal(err.code, '17');
  assert.equal(fetch.calls.length, 1);
  assert.equal(log.entries[0]!.error_code, '17');
  assert.equal(log.entries[0]!.retry_after_s, null);
});

test('media.list server_error_then_ok e invalid_token', async () => {
  const a = await client([['media.list', 'server_error_then_ok']]);
  assert.equal((await a.api.media()).data.items.length, 1);
  assert.deepEqual(a.log.entries.map((e) => e.http_status), [500, 200]);
  const b = await client([['media.list', 'invalid_token']]);
  const err = await failure(b.api.media());
  assert.equal(err.kind, 'auth');
  assert.equal(err.code, '190');
  assert.ok(err.messageEs.includes('190'));
  assert.ok(b.log.entries[0]!.error_message!.includes('subcódigo 463'), 'el subcódigo queda en api_call_log');
  assert.equal(b.fetch.calls.length, 1);
});

test('media.list nulls: like_count y media_url omitidos quedan en null; comments_count 0 se conserva', async () => {
  const { api } = await client([['media.list', 'nulls']]);
  const v = (await api.media()).data.items[0]!;
  assert.equal(v.metrics.likes, null);
  assert.equal(v.metrics.comments, 0);
  assert.equal(v.post.url, null);
  assert.equal(v.post.cover_url, null);
  assert.equal(v.post.caption, null);
});

test('media.insights reels: nombres de post_metric_snapshot, milisegundos a segundos', async () => {
  const { api, fetch } = await client([['media.insights', 'reels.ok']]);
  const { data } = await api.mediaInsights('1800000000000000d01', 'REELS');
  assert.ok(fetch.calls[0]!.url.includes('metric=views%2Creach%2Clikes'));
  assert.equal(data.views, 88000);
  assert.equal(data.reach, 61000);
  assert.equal(data.saves, 950);
  assert.equal(data.shares, 410);
  assert.equal(data.reposts, 12);
  assert.equal(data.total_interactions, 4694);
  assert.equal(data.avg_watch_time_s, 8.42);
  assert.equal(data.total_watch_time_s, 741000);
  assert.equal(data.skip_rate_3s, 0.275);
  assert.equal(data.follows_from_post, 140);
  assert.equal(data.profile_visits, 900);
  assert.equal(data.link_clicks, null);
});

test('media.insights feed, nulls y unsupported', async () => {
  const a = await client([['media.insights', 'feed.ok']]);
  const feed = (await a.api.mediaInsights('1800000000000000d02', 'FEED')).data;
  assert.equal(feed.views, null, 'FEED no pide views');
  assert.equal(feed.link_clicks, 4);
  assert.equal(feed.reposts, 0, 'un cero explícito se conserva');
  const b = await client([['media.insights', 'nulls']]);
  const few = (await b.api.mediaInsights('1800000000000000d09', 'REELS')).data;
  assert.equal(few.views, 10);
  assert.equal(few.likes, null);
  assert.equal(few.avg_watch_time_s, null);
  const c = await client([['media.insights', 'unsupported']]);
  const err = await failure(c.api.mediaInsights('1800000000000000d02', 'REELS'));
  assert.equal(err.kind, 'permanent');
  assert.equal(err.code, '100');
});

test('account.insights ok y nulls; follower_count como serie por día', async () => {
  const a = await client([['account.insights', 'ok']]);
  const { data } = await a.api.accountInsights('2026-09-21');
  assert.equal(data.day, '2026-09-21');
  assert.equal(data.reach, 152000);
  assert.equal(data.views, 310000);
  assert.equal(data.accounts_engaged, 9800);
  assert.equal(data.follows, 320);
  assert.equal(data.website_clicks, 41);
  assert.equal(data.followers, null, 'followers sale de me o de follower_count');
  assert.ok(a.fetch.calls[0]!.url.includes('since=1789948800&until=1790035199'));
  const b = await client([['account.insights', 'nulls']]);
  const few = (await b.api.accountInsights('2026-09-21')).data;
  assert.equal(few.reach, 3);
  assert.equal(few.views, null);
  const c = await client([['account.follower_count', 'ok']]);
  const series = (await c.api.followerCountSeries('2026-09-20', '2026-09-21')).data;
  assert.deepEqual(series, [{ day: '2026-09-20', followers: 411900 }, { day: '2026-09-21', followers: 412000 }]);
  await assert.rejects(() => c.api.accountInsights('21/09/2026'), /YYYY-MM-DD/);
});

test('audienceDemographics: age, gender y country como filas de audience_breakdown; insuficiente → permanent', async () => {
  const a = await client([['account.demographics', 'age.ok']]);
  const age = (await a.api.audienceDemographics('followers', 'age')).data;
  assert.equal(age.length, 7);
  assert.deepEqual(age[2], { population: 'followers', dimension: 'age', bucket: '25-34', share: null, absolute: 164000 });
  assert.ok(a.fetch.calls[0]!.url.includes('breakdown=age') && a.fetch.calls[0]!.url.includes('timeframe=this_month'));
  const b = await client([['account.demographics', 'gender.ok']]);
  const gender = (await b.api.audienceDemographics('followers', 'gender', { timeframe: 'last_90_days' })).data;
  assert.deepEqual(gender.map((r) => r.bucket), ['F', 'M', 'U']);
  const c = await client([['account.demographics', 'country.ok']]);
  assert.equal((await c.api.audienceDemographics('followers', 'country')).data[0]!.bucket, 'CO');
  const d = await client([['account.demographics', 'insufficient']]);
  const err = await failure(d.api.audienceDemographics('followers', 'age'));
  assert.equal(err.kind, 'permanent');
  assert.ok(err.messageEs.includes('100'));
});

test('businessDiscovery: seguidores y medios de la marca; no encontrado → permanent; usuario inválido no llama', async () => {
  const a = await client([['business_discovery', 'ok']]);
  const { data } = await a.api.businessDiscovery('cafealma');
  assert.deepEqual(data, { platform_id: 'instagram', external_account_id: '17841400000000e01', handle: 'cafealma', followers_count: 267793, media_count: 1205 });
  assert.ok(a.fetch.calls[0]!.url.includes('business_discovery.username%28cafealma%29'));
  const b = await client([['business_discovery', 'not_found']]);
  const err = await failure(b.api.businessDiscovery('nadie'));
  assert.equal(err.kind, 'permanent');
  assert.equal(err.code, '110');
  await assert.rejects(() => b.api.businessDiscovery('con espacios'), /inválido/);
  assert.equal(b.fetch.calls.length, 1);
  assert.equal(guard.attempts, 0);
});
