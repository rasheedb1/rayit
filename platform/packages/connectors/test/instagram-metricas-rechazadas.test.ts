/**
 * Meta rechaza la llamada entera de insights si UNA métrica de la lista no
 * aplica a ese medio («does not support the metrics: reposts», code 100).
 * En producción eso dejó sin lecturas a 25 carruseles durante cuatro días
 * (5-oct-2026). El cliente quita las métricas que Meta nombra y repite una
 * sola vez; si el error no nombra ninguna de las pedidas, o las nombra
 * todas, se propaga tal cual.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { HttpCore } from '../src/http/client.ts';
import type { PlatformApiError } from '../src/http/errors.ts';
import { InMemoryCallLogSink } from '../src/log/memory.ts';
import { QuotaManager } from '../src/quota/manager.ts';
import { INSTAGRAM_MEDIA_METRICS, InstagramClient, metricasRechazadas } from '../src/platforms/instagram-api.ts';
import { FixtureFetch, loadFixture, withoutNetwork, type Fixture, type FixtureResponse, type NetworkGuard } from '../src/testing/fixture-fetch.ts';
import type { OAuthTokens } from '../src/types.ts';
import { FakeClock } from './helpers/fake-clock.ts';

let guard: NetworkGuard;
before(() => { guard = withoutNetwork(); });
after(() => { guard.restore(); });

const TOKENS: OAuthTokens = { accessToken: 'IGQVJ-SECRETO-0987654321', accessExpiresAt: new Date('2026-11-20T00:00:00Z'), scopes: ['instagram_business_basic', 'instagram_business_manage_insights'] };
const CONN = '00000002-0000-4000-8000-0000000000c1';

function rechazo(metricas: string): FixtureResponse {
  return { status: 400, body: { error: { message: `Instagram Insights Media API endpoint does not support the metrics: ${metricas}. Please refer to https://developers.facebook.com/docs/instagram/reference/media#insights for more details.`, type: 'OAuthException', code: 100, fbtrace_id: 'AbCdEfDemo' } } };
}

async function cliente(fixtures: readonly Fixture[]) {
  const clock = new FakeClock();
  const log = new InMemoryCallLogSink();
  const fetch = new FixtureFetch(fixtures);
  const core = new HttpCore({ callLog: log, quota: new QuotaManager({ now: clock.now, sleep: clock.sleep }), fetch: fetch.fetch, now: clock.now, sleep: clock.sleep, random: () => 1 });
  return { log, fetch, api: new InstagramClient(core, { connectionId: CONN, tokens: TOKENS }) };
}

function metricasPedidas(url: string): string[] {
  return (new URL(url).searchParams.get('metric') ?? '').split(',');
}

test('metricasRechazadas lee las que Meta nombra, solo entre las pedidas', async () => {
  const feed = await loadFixture('instagram', 'media.insights', 'feed.ok');
  const c = await cliente([{ ...feed, response: rechazo('reposts, link_clicks') }]);
  const err = await c.api.mediaInsights('1800000000000000d02', 'FEED', { metrics: ['reach', 'reposts', 'likes', 'link_clicks'] }).then(() => null, (e: unknown) => e as PlatformApiError);
  assert.ok(err);
  assert.deepEqual(metricasRechazadas(err, ['reach', 'reposts', 'likes', 'link_clicks']), ['reposts', 'link_clicks']);
  assert.deepEqual(metricasRechazadas(err, ['reach', 'likes']), [], 'nada que quitar si no pidió las rechazadas');
  assert.deepEqual(metricasRechazadas(new Error('otra cosa'), ['reposts']), []);
});

test('media.insights: un 100 que nombra métricas repite una vez sin ellas y la lectura sale bien', async () => {
  const feed = await loadFixture('instagram', 'media.insights', 'feed.ok');
  const respuestaBuena = Array.isArray(feed.response) ? feed.response[0]! : feed.response;
  const c = await cliente([{ ...feed, response: [rechazo('reposts'), respuestaBuena] }]);
  const { data } = await c.api.mediaInsights('1800000000000000d02', 'FEED', { metrics: ['reach', 'likes', 'reposts', 'link_clicks'] });
  assert.equal(data.reach, 21000, 'la lectura buena se normaliza');
  assert.equal(data.link_clicks, 4);
  assert.equal(c.fetch.calls.length, 2, 'dos llamadas: la rechazada y la repetida');
  assert.deepEqual(metricasPedidas(c.fetch.calls[0]!.url), ['reach', 'likes', 'reposts', 'link_clicks']);
  assert.deepEqual(metricasPedidas(c.fetch.calls[1]!.url), ['reach', 'likes', 'link_clicks'], 'sin reposts');
  // Las dos quedan en el log: la rechazada con su mensaje, la buena en 200.
  assert.deepEqual(c.log.entries.map((e) => [e.endpoint, e.ok]), [['instagram.media.insights', false], ['instagram.media.insights', true]]);
});

test('media.insights: si Meta rechaza algo que no pedimos, o todo, no se repite', async () => {
  const feed = await loadFixture('instagram', 'media.insights', 'feed.ok');
  const a = await cliente([{ ...feed, response: rechazo('ig_reels_avg_watch_time') }]);
  const errA = await a.api.mediaInsights('1800000000000000d02', 'FEED').then(() => null, (e: unknown) => e as PlatformApiError);
  assert.equal(errA?.code, '100');
  assert.equal(a.fetch.calls.length, 1, 'nada que quitar: una sola llamada');

  const b = await cliente([{ ...feed, response: rechazo('reach, likes') }]);
  const errB = await b.api.mediaInsights('1800000000000000d02', 'FEED', { metrics: ['reach', 'likes'] }).then(() => null, (e: unknown) => e as PlatformApiError);
  assert.equal(errB?.code, '100');
  assert.equal(b.fetch.calls.length, 1, 'rechazadas todas: no hay con qué repetir');
});

test('la lista de feed ya no pide reposts', () => {
  assert.ok(!INSTAGRAM_MEDIA_METRICS.FEED.includes('reposts'));
  assert.ok(INSTAGRAM_MEDIA_METRICS.FEED.includes('link_clicks'));
});

test('account.insights: la misma regla con /me/insights', async () => {
  const ok = await loadFixture('instagram', 'account.insights', 'ok');
  const respuestaBuena = Array.isArray(ok.response) ? ok.response[0]! : ok.response;
  const c = await cliente([{ ...ok, response: [rechazo('profile_views'), respuestaBuena] }]);
  const { data } = await c.api.accountInsights('2026-09-21', { metrics: ['reach', 'views', 'profile_views'] });
  assert.equal(data.views, 310000);
  assert.equal(c.fetch.calls.length, 2);
  assert.deepEqual(metricasPedidas(c.fetch.calls[1]!.url), ['reach', 'views']);
});
