/**
 * QA de CON-1: los casos de transporte (invalid_token, rate_limited,
 * server_error_then_ok) valen para TODOS los endpoints, no solo para el
 * de lista. Aquí se sintetizan las respuestas por plataforma y se
 * ejercita cada método público de los cuatro clientes: el token no se
 * reintenta, el 429 espera lo que dice Retry-After y el 5xx se recupera,
 * y cada intento deja su fila en el log con el endpoint lógico correcto.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { HttpCore } from '../src/http/client.ts';
import type { PlatformApiError } from '../src/http/errors.ts';
import { InMemoryCallLogSink } from '../src/log/memory.ts';
import { QuotaManager } from '../src/quota/manager.ts';
import { InstagramClient } from '../src/platforms/instagram-api.ts';
import { TikTokAccountsClient } from '../src/platforms/tiktok-accounts.ts';
import { TikTokDisplayClient } from '../src/platforms/tiktok-display.ts';
import { YouTubeClient } from '../src/platforms/youtube-api.ts';
import { FixtureFetch, withoutNetwork, type Fixture, type FixtureResponse, type NetworkGuard } from '../src/testing/fixture-fetch.ts';
import type { OAuthTokens, PlatformId } from '../src/types.ts';
import { FakeClock } from './helpers/fake-clock.ts';

let guard: NetworkGuard;
before(() => { guard = withoutNetwork(); });
after(() => { guard.restore(); });

const TOKENS: OAuthTokens = { accessToken: 'MATRIZ-SECRETO-1234567890', accessExpiresAt: new Date('2027-01-01T00:00:00Z'), scopes: [] };
const CONN = '00000002-0000-4000-8000-0000000000c9';

type Clients = { tiktok: TikTokDisplayClient; accounts: TikTokAccountsClient; instagram: InstagramClient; youtube: YouTubeClient };

interface Endpoint {
  platformId: PlatformId;
  endpoint: string;
  urlPattern: string;
  call: (c: Clients) => Promise<unknown>;
}

const OK_BODIES: Record<PlatformId, unknown> = {
  tiktok: { data: {}, error: { code: 'ok', message: '', log_id: 'x' } },
  instagram: { data: [] },
  facebook: { data: [] },
  youtube: { items: [], columnHeaders: [], rows: [] },
};

/** Respuesta de «token inválido» tal como la manda cada API. */
function invalidToken(platformId: PlatformId, business: boolean): FixtureResponse {
  if (platformId === 'tiktok' && business) return { status: 200, body: { code: 40104, message: 'Access token is invalid.', request_id: 'r' } };
  if (platformId === 'tiktok') return { status: 401, body: { data: {}, error: { code: 'access_token_invalid', message: 'invalid', log_id: 'x' } } };
  if (platformId === 'youtube') return { status: 401, body: { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError', domain: 'global' }], status: 'UNAUTHENTICATED' } } };
  return { status: 400, body: { error: { message: 'Error validating access token', type: 'OAuthException', code: 190, error_subcode: 463, fbtrace_id: 'f' } } };
}

function rateLimited(platformId: PlatformId, business: boolean): FixtureResponse {
  if (platformId === 'tiktok' && business) return { status: 429, headers: { 'retry-after': '5' }, body: { code: 40022, message: 'Too many requests', request_id: 'r' } };
  if (platformId === 'tiktok') return { status: 429, headers: { 'retry-after': '5' }, body: { data: {}, error: { code: 'rate_limit_exceeded', message: 'slow down', log_id: 'x' } } };
  if (platformId === 'youtube') return { status: 429, headers: { 'retry-after': '5' }, body: { error: { code: 429, message: 'Resource has been exhausted', errors: [{ reason: 'rateLimitExceeded', domain: 'global' }], status: 'RESOURCE_EXHAUSTED' } } };
  // Meta no manda 429: su límite por usuario es kind quota y no se reintenta; se cubre en instagram.test.ts.
  return { status: 429, headers: { 'retry-after': '5' }, body: { error: { message: 'throttled', type: 'OAuthException', code: 613, fbtrace_id: 'f' } } };
}

function serverError(platformId: PlatformId, business: boolean): FixtureResponse {
  if (platformId === 'tiktok' && business) return { status: 200, body: { code: 50002, message: 'Internal service error', request_id: 'r' } };
  if (platformId === 'tiktok') return { status: 500, body: { data: {}, error: { code: 'internal_error', message: 'boom', log_id: 'x' } } };
  if (platformId === 'youtube') return { status: 503, body: { error: { code: 503, message: 'Backend Error', errors: [{ reason: 'backendError', domain: 'global' }], status: 'UNAVAILABLE' } } };
  return { status: 500, body: { error: { message: 'An unexpected error has occurred.', type: 'OAuthException', code: 2, fbtrace_id: 'f' } } };
}

const ENDPOINTS: Endpoint[] = [
  { platformId: 'tiktok', endpoint: 'tiktok.user.info', urlPattern: 'open\\.tiktokapis\\.com/v2/user/info/', call: (c) => c.tiktok.userInfo() },
  { platformId: 'tiktok', endpoint: 'tiktok.video.list', urlPattern: 'open\\.tiktokapis\\.com/v2/video/list/', call: (c) => c.tiktok.listVideos() },
  { platformId: 'tiktok', endpoint: 'tiktok.video.query', urlPattern: 'open\\.tiktokapis\\.com/v2/video/query/', call: (c) => c.tiktok.queryVideos(['1']) },
  { platformId: 'tiktok', endpoint: 'tiktok.business.get', urlPattern: 'business-api\\.tiktok\\.com/open_api/v1\\.3/business/get/', call: (c) => c.accounts.accountInfo() },
  { platformId: 'tiktok', endpoint: 'tiktok.business.video.list', urlPattern: 'business-api\\.tiktok\\.com/open_api/v1\\.3/business/video/list/\\?business_id=b&fields=%5B%22item_id', call: (c) => c.accounts.listVideos() },
  { platformId: 'tiktok', endpoint: 'tiktok.business.video.insights', urlPattern: 'business-api\\.tiktok\\.com/open_api/v1\\.3/business/video/list/.*filters=', call: (c) => c.accounts.videoInsights(['1']) },
  { platformId: 'instagram', endpoint: 'instagram.me', urlPattern: 'graph\\.instagram\\.com/v25\\.0/me\\?fields=id%2Cuser_id', call: (c) => c.instagram.me() },
  { platformId: 'instagram', endpoint: 'instagram.media.list', urlPattern: 'graph\\.instagram\\.com/v25\\.0/me/media\\?', call: (c) => c.instagram.media() },
  { platformId: 'instagram', endpoint: 'instagram.media.insights', urlPattern: 'graph\\.instagram\\.com/v25\\.0/m1/insights\\?', call: (c) => c.instagram.mediaInsights('m1', 'REELS') },
  { platformId: 'instagram', endpoint: 'instagram.account.insights', urlPattern: 'graph\\.instagram\\.com/v25\\.0/me/insights\\?metric=reach', call: (c) => c.instagram.accountInsights('2026-09-21') },
  { platformId: 'instagram', endpoint: 'instagram.account.follower_count', urlPattern: 'graph\\.instagram\\.com/v25\\.0/me/insights\\?metric=follower_count', call: (c) => c.instagram.followerCountSeries('2026-09-20', '2026-09-21') },
  { platformId: 'instagram', endpoint: 'instagram.account.demographics', urlPattern: 'graph\\.instagram\\.com/v25\\.0/me/insights\\?metric=follower_demographics', call: (c) => c.instagram.audienceDemographics('followers', 'age') },
  { platformId: 'instagram', endpoint: 'instagram.business_discovery', urlPattern: 'graph\\.instagram\\.com/v25\\.0/me\\?fields=business_discovery', call: (c) => c.instagram.businessDiscovery('cafealma') },
  { platformId: 'youtube', endpoint: 'youtube.channels.list', urlPattern: 'googleapis\\.com/youtube/v3/channels\\?part=snippet%2CcontentDetails', call: (c) => c.youtube.channelMine() },
  { platformId: 'youtube', endpoint: 'youtube.channels.list', urlPattern: 'googleapis\\.com/youtube/v3/channels\\?part=snippet%2Cstatistics&forHandle', call: (c) => c.youtube.channelByHandle('marca') },
  { platformId: 'youtube', endpoint: 'youtube.playlist_items.list', urlPattern: 'googleapis\\.com/youtube/v3/playlistItems\\?', call: (c) => c.youtube.uploadsPlaylistItems('UUx') },
  { platformId: 'youtube', endpoint: 'youtube.videos.list', urlPattern: 'googleapis\\.com/youtube/v3/videos\\?', call: (c) => c.youtube.videosById(['v']) },
  { platformId: 'youtube', endpoint: 'youtube.analytics.query', urlPattern: 'youtubeanalytics\\.googleapis\\.com/v2/reports\\?', call: (c) => c.youtube.videoDailyMetrics('v', '2026-09-01', '2026-09-02') },
  { platformId: 'youtube', endpoint: 'youtube.analytics.query', urlPattern: 'youtubeanalytics\\.googleapis\\.com/v2/reports\\?.*dimensions=ageGroup', call: (c) => c.youtube.videoDemographics('v', '2026-09-01', '2026-09-02') },
  { platformId: 'youtube', endpoint: 'youtube.analytics.query', urlPattern: 'youtubeanalytics\\.googleapis\\.com/v2/reports\\?.*dimensions=country', call: (c) => c.youtube.countryBreakdown(null, '2026-09-01', '2026-09-02') },
];

function harness(fixture: Fixture) {
  const clock = new FakeClock();
  const log = new InMemoryCallLogSink();
  const fetch = new FixtureFetch([fixture]);
  const core = new HttpCore({ callLog: log, quota: new QuotaManager({ now: clock.now, sleep: clock.sleep }), fetch: fetch.fetch, now: clock.now, sleep: clock.sleep, random: () => 1 });
  const auth = { connectionId: CONN, tokens: TOKENS };
  const clients: Clients = {
    tiktok: new TikTokDisplayClient(core, auth),
    accounts: new TikTokAccountsClient(core, auth, 'b'),
    instagram: new InstagramClient(core, auth),
    youtube: new YouTubeClient(core, auth),
  };
  return { clock, log, fetch, clients };
}

function fixtureFor(e: Endpoint, responses: FixtureResponse[]): Fixture {
  return { meta: { source: 'docs', recordedAt: '2026-09-22', notes: 'sintetizado por transport-matrix.test.ts' }, request: { method: '*', urlPattern: e.urlPattern }, response: responses };
}

for (const e of ENDPOINTS) {
  const business = e.endpoint.startsWith('tiktok.business');
  const label = `${e.endpoint} (${e.urlPattern.slice(0, 30)}…)`;

  test(`${label}: token inválido → auth, un solo intento, endpoint correcto en el log, sin token`, async () => {
    const h = harness(fixtureFor(e, [invalidToken(e.platformId, business)]));
    const err = await e.call(h.clients).then(() => null, (x: unknown) => x as PlatformApiError);
    assert.equal(err?.kind, 'auth', `${label}: ${err?.code}`);
    assert.equal(h.fetch.calls.length, 1);
    assert.equal(h.log.entries.length, 1);
    assert.equal(h.log.entries[0]!.endpoint, e.endpoint);
    assert.equal(h.log.entries[0]!.connection_id, CONN);
    assert.ok(!JSON.stringify([h.log.entries, err?.message, err?.messageEs]).includes(TOKENS.accessToken));
    assert.ok(!h.fetch.calls[0]!.url.includes(TOKENS.accessToken));
  });

  test(`${label}: 429 con Retry-After 5 → espera 5 s falsos y luego ok; dos filas`, async () => {
    const h = harness(fixtureFor(e, [rateLimited(e.platformId, business), { status: 200, body: OK_BODIES[e.platformId] }]));
    await e.call(h.clients);
    assert.deepEqual(h.clock.sleeps, [5000]);
    assert.equal(h.log.entries.length, 2);
    assert.equal(h.log.entries[0]!.rate_limited, true);
    assert.equal(h.log.entries[1]!.ok, true);
  });

  test(`${label}: 5xx y luego ok → se recupera con backoff; dos filas`, async () => {
    const h = harness(fixtureFor(e, [serverError(e.platformId, business), { status: 200, body: OK_BODIES[e.platformId] }]));
    await e.call(h.clients);
    assert.deepEqual(h.clock.sleeps, [1000]);
    assert.deepEqual(h.log.entries.map((x) => x.ok), [false, true]);
    assert.equal(guard.attempts, 0);
  });
}
