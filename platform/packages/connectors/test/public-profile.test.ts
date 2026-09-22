/** CON-10 · fuentes públicas por @: identidad y métricas oficiales, errores en español, sin credenciales en log ni URL grabada. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { HttpCore } from '../src/http/client.ts';
import { InMemoryCallLogSink } from '../src/log/memory.ts';
import { QuotaManager } from '../src/quota/manager.ts';
import { cleanHandle, createPublicProfileSources, PublicLookupError } from '../src/public/index.ts';
import { FixtureFetch, loadFixtures, withoutNetwork, type NetworkGuard } from '../src/testing/fixture-fetch.ts';
import { FakeClock } from './helpers/fake-clock.ts';

let guard: NetworkGuard;
before(() => { guard = withoutNetwork(); });
after(() => { guard.restore(); });

const ENV = { INSTAGRAM_HOUSE_TOKEN: 'IGAA-house-token-SECRETO-0001', GOOGLE_API_KEY: 'AIza-google-key-SECRETO-0001' };

async function sources(fixtures: ReadonlyArray<[string, string, string?]>, env: Record<string, string | undefined> = ENV) {
  const clock = new FakeClock();
  const log = new InMemoryCallLogSink();
  const all = [];
  for (const [platform, endpoint, variant] of fixtures) all.push(...(await loadFixtures(platform, [[endpoint, variant]])));
  const fetch = new FixtureFetch(all);
  const core = new HttpCore({ callLog: log, quota: new QuotaManager({ now: clock.now, sleep: clock.sleep }), fetch: fetch.fetch, now: clock.now, sleep: clock.sleep, random: () => 1 });
  return { log, fetch, src: createPublicProfileSources(core, env) };
}

test('cleanHandle acepta @, URL del perfil y espacios', () => {
  assert.equal(cleanHandle(' @selvathegolden '), 'selvathegolden');
  assert.equal(cleanHandle('https://www.tiktok.com/@selvathegolden?lang=es'), 'selvathegolden');
  assert.equal(cleanHandle('https://www.instagram.com/nicolasduartea/'), 'nicolasduartea');
  assert.equal(cleanHandle('youtube.com/@NutriveOficial'), 'NutriveOficial');
});

test('TikTok por oEmbed: confirma identidad, métricas null con la razón; handle inexistente → not_found', async () => {
  const { src, log, fetch } = await sources([['tiktok', 'oembed.profile', 'ok']]);
  const p = await src.tiktok!.lookup('@laura.cocinafacil');
  assert.equal(p.profile.handle, 'laura.cocinafacil');
  assert.equal(p.profile.display_name, 'Laura · Cocina fácil');
  assert.equal(p.profile.profile_url, 'https://www.tiktok.com/@laura.cocinafacil');
  assert.equal(p.metrics, null);
  assert.match(p.metricsNote!, /no publica seguidores/);
  assert.equal(p.source, 'tiktok.oembed');
  assert.equal(log.entries[0]!.endpoint, 'tiktok.oembed');
  assert.equal(fetch.calls[0]!.headers['Authorization'], undefined, 'sin credencial: es público');
  const nf = await sources([['tiktok', 'oembed.profile', 'not_found']]);
  await assert.rejects(nf.src.tiktok!.lookup('noexiste.zz9'), (e: unknown) => e instanceof PublicLookupError && e.code === 'not_found' && /No encontramos @noexiste.zz9 en TikTok/.test(e.messageEs));
  await assert.rejects(src.tiktok!.lookup('x'), (e: unknown) => e instanceof PublicLookupError && e.code === 'invalid_handle');
});

test('Instagram por business_discovery con el token casa: seguidores y publicaciones; sin token → not_configured; cuenta personal → not_discoverable', async () => {
  const { src, log, fetch } = await sources([['instagram', 'business_discovery', 'ok']]);
  const p = await src.instagram!.lookup('cafealma');
  assert.equal(p.profile.external_account_id, '17841400000000e01');
  assert.equal(p.profile.handle, 'cafealma');
  assert.deepEqual(p.metrics, { followers: 267793, following: null, mediaCount: 1205, views: null });
  assert.equal(p.source, 'instagram.business_discovery');
  assert.equal(log.entries[0]!.endpoint, 'instagram.business_discovery');
  assert.equal(fetch.calls[0]!.headers['Authorization'], '[REDACTADO]');
  assert.ok(!JSON.stringify(fetch.calls).includes(ENV.INSTAGRAM_HOUSE_TOKEN) && !JSON.stringify(log.entries).includes(ENV.INSTAGRAM_HOUSE_TOKEN));
  const sin = await sources([], { GOOGLE_API_KEY: 'x' });
  assert.deepEqual(sin.src.instagram!.missing, ['INSTAGRAM_HOUSE_TOKEN']);
  await assert.rejects(sin.src.instagram!.lookup('cafealma'), (e: unknown) => e instanceof PublicLookupError && e.code === 'not_configured' && /INSTAGRAM_HOUSE_TOKEN/.test(e.messageEs));
  const personal = await sources([['instagram', 'business_discovery', 'personal']]);
  await assert.rejects(personal.src.instagram!.lookup('cuentapersonal'), (e: unknown) => e instanceof PublicLookupError && e.code === 'not_discoverable' && /cuenta personal/.test(e.messageEs));
});

test('YouTube con API key: suscriptores, vistas y videos; la key va en la query pero no en el log ni en la URL grabada; sin key → not_configured', async () => {
  const { src, log, fetch } = await sources([['youtube', 'channels.list', 'handle.ok']]);
  const p = await src.youtube!.lookup('@NutriveOficial');
  assert.equal(p.profile.display_name, 'Nutrivé');
  assert.equal(p.profile.handle, 'nutriveoficial');
  assert.equal(p.metrics!.followers, 38400);
  assert.ok(p.metrics!.mediaCount !== null && p.metrics!.views !== null);
  assert.equal(log.entries[0]!.endpoint, 'youtube.channels.list');
  assert.ok(fetch.calls[0]!.url.includes('key=REDACTADO'), fetch.calls[0]!.url);
  assert.ok(!JSON.stringify(fetch.calls).includes(ENV.GOOGLE_API_KEY) && !JSON.stringify(log.entries).includes(ENV.GOOGLE_API_KEY));
  const sin = await sources([], { INSTAGRAM_HOUSE_TOKEN: 'x' });
  assert.deepEqual(sin.src.youtube!.missing, ['GOOGLE_API_KEY']);
  const empty = await sources([['youtube', 'channels.list', 'handle.empty']]);
  await assert.rejects(empty.src.youtube!.lookup('nadie'), (e: unknown) => e instanceof PublicLookupError && e.code === 'not_found');
});
