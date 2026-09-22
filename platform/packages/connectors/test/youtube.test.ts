import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { HttpCore } from '../src/http/client.ts';
import type { PlatformApiError } from '../src/http/errors.ts';
import { InMemoryCallLogSink } from '../src/log/memory.ts';
import { QuotaManager } from '../src/quota/manager.ts';
import { YouTubeClient, iso8601DurationToSeconds } from '../src/platforms/youtube-api.ts';
import { FixtureFetch, loadFixtures, withoutNetwork, type NetworkGuard } from '../src/testing/fixture-fetch.ts';
import type { OAuthTokens } from '../src/types.ts';
import { FakeClock } from './helpers/fake-clock.ts';

let guard: NetworkGuard;
before(() => { guard = withoutNetwork(); });
after(() => { guard.restore(); });

const TOKENS: OAuthTokens = { accessToken: 'ya29.SECRETO-GOOGLE-123456', refreshToken: '1//REFRESH-SECRETO', accessExpiresAt: new Date('2026-09-22T11:00:00Z'), scopes: ['youtube.readonly', 'yt-analytics.readonly'] };
const CONN = '00000002-0000-4000-8000-0000000000c3';

async function client(names: ReadonlyArray<[string, string?]>) {
  const clock = new FakeClock();
  const log = new InMemoryCallLogSink();
  const fetch = new FixtureFetch(await loadFixtures('youtube', names));
  const quota = new QuotaManager({ now: clock.now, sleep: clock.sleep });
  const core = new HttpCore({ callLog: log, quota, fetch: fetch.fetch, now: clock.now, sleep: clock.sleep, random: () => 1 });
  return { clock, log, fetch, quota, api: new YouTubeClient(core, { connectionId: CONN, tokens: TOKENS }) };
}

async function failure(p: Promise<unknown>): Promise<PlatformApiError> {
  return p.then(() => { throw new Error('esperaba un error'); }, (e: unknown) => e as PlatformApiError);
}

test('channelMine ok: perfil, contadores desde cadenas y lista de subidas; cuesta 1 unidad', async () => {
  const { api, log, quota } = await client([['channels.list', 'mine.ok']]);
  const { data } = await api.channelMine();
  assert.equal(data!.profile.external_account_id, 'UCdemo000000000000000001');
  assert.equal(data!.profile.handle, 'lauracocinafacil');
  assert.equal(data!.profile.account_type, 'channel');
  assert.equal(data!.metrics.followers, 215000);
  assert.equal(data!.metrics.media_count, 312);
  assert.equal(data!.metrics.views, 48200000);
  assert.equal(data!.uploadsPlaylistId, 'UUdemo000000000000000001');
  assert.equal(log.entries[0]!.request_units, 1);
  assert.equal(log.entries[0]!.endpoint, 'youtube.channels.list');
  assert.deepEqual(quota.usedToday({ family: 'youtube', platformId: 'youtube', connectionId: null }), { unitsUsed: 1, calls: 1 });
});

test('channelMine nulls: suscriptores ocultos → followers null', async () => {
  const { api } = await client([['channels.list', 'mine.nulls']]);
  const { data } = await api.channelMine();
  assert.equal(data!.metrics.followers, null);
  assert.equal(data!.metrics.media_count, 312);
});

test('channelByHandle ok y empty (null); handle inválido no llama', async () => {
  const a = await client([['channels.list', 'handle.ok']]);
  const { data } = await a.api.channelByHandle('@NutriveOficial');
  assert.deepEqual(data, { platform_id: 'youtube', external_account_id: 'UCnutrive00000000000000e4', handle: 'nutriveoficial', followers_count: 38400, media_count: 140 });
  assert.ok(a.fetch.calls[0]!.url.includes('forHandle=%40NutriveOficial'));
  const b = await client([['channels.list', 'handle.empty']]);
  assert.equal((await b.api.channelByHandle('nadie-aqui')).data, null);
  await assert.rejects(() => b.api.channelByHandle('a b'), /inválido/);
  assert.equal(b.fetch.calls.length, 1);
});

test('uploadsPlaylistItems ok, empty, paginated y not_found', async () => {
  const a = await client([['playlist_items.list', 'ok']]);
  const { data } = await a.api.uploadsPlaylistItems('UUdemo000000000000000001');
  assert.equal(data.items.length, 3);
  assert.equal(data.items[0]!.videoId, 'vid00000001');
  assert.equal(data.items[0]!.publishedAt?.toISOString(), '2026-09-01T15:00:00.000Z');
  assert.equal(data.hasMore, false);
  const b = await client([['playlist_items.list', 'empty']]);
  assert.deepEqual((await b.api.uploadsPlaylistItems('UUdemo000000000000000001')).data, { items: [], cursor: null, hasMore: false });
  const c = await client([['playlist_items.list', 'paginated']]);
  const pages = [];
  for await (const p of c.api.iterateUploads('UUdemo000000000000000001')) pages.push(p.data);
  assert.equal(pages.length, 2);
  assert.equal(pages[0]!.cursor, 'CAUQAA');
  assert.ok(c.fetch.calls[1]!.url.includes('pageToken=CAUQAA'));
  const d = await client([['playlist_items.list', 'not_found']]);
  const err = await failure(d.api.uploadsPlaylistItems('UUnoexiste'));
  assert.equal(err.kind, 'permanent');
  assert.equal(err.code, 'playlistNotFound');
});

test('videosById ok: duración ISO 8601, contadores y hashtags de la descripción', async () => {
  const { api } = await client([['videos.list', 'ok']]);
  const { data } = await api.videosById(['vid00000001', 'vid00000002']);
  assert.equal(data.length, 2);
  const v = data[0]!;
  assert.equal(v.post.external_post_id, 'vid00000001');
  assert.equal(v.post.url, 'https://www.youtube.com/watch?v=vid00000001');
  assert.equal(v.post.duration_s, 73);
  assert.equal(v.post.cover_url, 'https://i.ytimg.com/vi/vid00000001/hqdefault.jpg');
  assert.deepEqual(v.post.hashtags, ['desayuno', 'recetafacil']);
  assert.equal(v.post.surface, null, 'la API no dice si es un Short');
  assert.equal(v.metrics.views, 90001);
  assert.equal(v.metrics.likes, 4101);
  assert.equal(v.metrics.comments, 211);
  assert.equal(v.metrics.shares, null);
  assert.equal(data[1]!.post.duration_s, 12 * 3600 + 3 * 60);
  assert.equal(iso8601DurationToSeconds('P1DT2H'), 93600);
  assert.equal(iso8601DurationToSeconds('PT'), null);
  assert.equal(iso8601DurationToSeconds(undefined), null);
});

test('videosById empty y nulls; más de 50 ids se rechaza', async () => {
  const a = await client([['videos.list', 'empty']]);
  assert.deepEqual((await a.api.videosById(['x'])).data, []);
  const b = await client([['videos.list', 'nulls']]);
  const v = (await b.api.videosById(['vid00000009'])).data[0]!;
  assert.equal(v.metrics.views, 0, 'viewCount "0" es un cero real');
  assert.equal(v.metrics.likes, null);
  assert.equal(v.metrics.comments, null);
  assert.equal(v.post.duration_s, null);
  assert.equal(v.post.cover_url, null);
  await assert.rejects(() => b.api.videosById(Array.from({ length: 51 }, (_, i) => `v${i}`)), /entre 1 y 50/);
});

test('videosById rate_limited (403 rateLimitExceeded → transitorio con backoff), quota_exceeded (→ quota), server_error_then_ok, invalid_token', async () => {
  const a = await client([['videos.list', 'rate_limited']]);
  assert.equal((await a.api.videosById(['vid00000001'])).data.length, 1);
  assert.deepEqual(a.clock.sleeps, [1000]);
  assert.equal(a.log.entries[0]!.rate_limited, true);
  assert.equal(a.log.entries.length, 2, 'los dos intentos cuestan cuota y quedan en el log');
  const b = await client([['videos.list', 'quota_exceeded']]);
  const q = await failure(b.api.videosById(['vid00000001']));
  assert.equal(q.kind, 'quota');
  assert.equal(q.code, 'quotaExceeded');
  assert.equal(b.fetch.calls.length, 1);
  const c = await client([['videos.list', 'server_error_then_ok']]);
  assert.equal((await c.api.videosById(['vid00000001'])).data.length, 1);
  assert.deepEqual(c.log.entries.map((e) => e.http_status), [503, 200]);
  const d = await client([['videos.list', 'invalid_token']]);
  const t = await failure(d.api.videosById(['vid00000001']));
  assert.equal(t.kind, 'auth');
  assert.equal(t.code, 'authError');
  assert.ok(!JSON.stringify(d.log.entries).includes(TOKENS.accessToken));
});

test('videoDailyMetrics: filas por día con nombres de post_metric_snapshot; la familia es youtube-analytics', async () => {
  const { api, log, quota } = await client([['analytics.query', 'video_daily.ok']]);
  const { data } = await api.videoDailyMetrics('vid00000001', '2026-09-01', '2026-09-03');
  assert.equal(data.length, 3);
  assert.equal(data[0]!.day, '2026-09-01');
  assert.equal(data[0]!.metrics.views, 12000);
  assert.equal(data[0]!.metrics.total_watch_time_s, 9800 * 60);
  assert.equal(data[0]!.metrics.avg_watch_time_s, 49);
  assert.equal(data[0]!.metrics.completion_rate, 0.6712);
  assert.equal(data[0]!.metrics.follows_from_post, 21);
  assert.equal(data[0]!.metrics.saves, null);
  assert.equal(log.entries[0]!.endpoint, 'youtube.analytics.query');
  assert.deepEqual(quota.usedToday({ family: 'youtube', platformId: 'youtube', connectionId: null }), { unitsUsed: 0, calls: 0 }, 'Analytics no gasta la cuota de la Data API');
  await assert.rejects(() => api.videoDailyMetrics('v', '2026/09/01', '2026-09-03'), /YYYY-MM-DD/);
});

test('videoDemographics: ageGroup × gender como age_gender con share 0..1; sin filas → lista vacía', async () => {
  const a = await client([['analytics.query', 'demographics.ok']]);
  const { data } = await a.api.videoDemographics('vid00000001', '2026-09-01', '2026-09-30');
  assert.equal(data.length, 7);
  assert.deepEqual(data[2], { population: 'viewers', dimension: 'age_gender', bucket: '25-34|F', share: 0.302, absolute: null });
  assert.deepEqual(data[6], { population: 'viewers', dimension: 'age_gender', bucket: '65+|U', share: 0.003, absolute: null });
  const b = await client([['analytics.query', 'demographics.empty']]);
  assert.deepEqual((await b.api.videoDemographics('vid00000009', '2026-09-01', '2026-09-30')).data, []);
});

test('countryBreakdown: views por país con absolutos y sin share', async () => {
  const { api } = await client([['analytics.query', 'country.ok']]);
  const { data } = await api.countryBreakdown(null, '2026-09-01', '2026-09-30');
  assert.deepEqual(data[0], { population: 'viewers', dimension: 'country', bucket: 'CO', share: null, absolute: 31000 });
  assert.equal(guard.attempts, 0);
});
