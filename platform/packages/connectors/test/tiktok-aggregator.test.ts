/**
 * CON-12 · proveedor de datos de TikTok (EnsembleData): seguidores y
 * videos por @ (las vistas llegan por video: la de cuenta es la del día y
 * TikTok no la publica), errores del proveedor con su frase, parseo
 * tolerante en lo accesorio y definitivo cuando cambia de forma, el gasto
 * acotado al que pide, y el token fuera de todo log y de toda URL grabada.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { HttpCore } from '../src/http/client.ts';
import { InMemoryCallLogSink } from '../src/log/memory.ts';
import { QuotaManager } from '../src/quota/manager.ts';
import { createPublicPostSources } from '../src/posts/index.ts';
import { createPublicProfileSources, PublicLookupError } from '../src/public/index.ts';
import { ENSEMBLEDATA_TOKEN_ENV, TIKTOK_AGGREGATOR_LABEL } from '../src/public/tiktok-aggregator.ts';
import { FixtureFetch, loadFixtures, withoutNetwork, type NetworkGuard } from '../src/testing/fixture-fetch.ts';
import { FakeClock } from './helpers/fake-clock.ts';

let guard: NetworkGuard;
before(() => { guard = withoutNetwork(); });
after(() => { guard.restore(); });

const TOKEN = 'ed-token-SECRETO-0001';
const ENV = { [ENSEMBLEDATA_TOKEN_ENV]: TOKEN };

async function source(fixtures: ReadonlyArray<[string, string?]>, env: Record<string, string | undefined> = ENV) {
  const clock = new FakeClock();
  const log = new InMemoryCallLogSink();
  const all = await loadFixtures('ensembledata', fixtures);
  const fetch = new FixtureFetch(all);
  const quota = new QuotaManager({ now: clock.now, sleep: clock.sleep });
  const core = new HttpCore({ callLog: log, quota, fetch: fetch.fetch, now: clock.now, sleep: clock.sleep, random: () => 1 });
  return { log, fetch, quota, src: createPublicProfileSources(core, env).tiktok! };
}

test('sin ENSEMBLEDATA_TOKEN, TikTok sigue siendo el oEmbed de CON-10: el proveedor no existe y no se llama a su red', async () => {
  const { src, fetch } = await source([], { GOOGLE_API_KEY: 'x' });
  assert.equal(src.accessMode, 'public_profile');
  assert.equal(src.label, 'oEmbed de TikTok');
  assert.equal(fetch.calls.length, 0);
});

test('con el token: una sola llamada de perfil, seguidores y videos, vistas en null; access_mode aggregator', async () => {
  const { src, log, fetch } = await source([['user.info', 'ok']]);
  assert.equal(src.accessMode, 'aggregator');
  assert.equal(src.label, TIKTOK_AGGREGATOR_LABEL);
  const p = await src.lookup('@laura.cocinafacil');

  assert.equal(p.profile.handle, 'laura.cocinafacil');
  assert.equal(p.profile.display_name, 'Laura · Cocina fácil');
  assert.equal(p.profile.external_account_id, 'laura.cocinafacil', 'el mismo id externo que el oEmbed de CON-10: contratar el proveedor no duplica la cuenta');
  assert.equal(p.profile.profile_url, 'https://www.tiktok.com/@laura.cocinafacil');
  // views es la columna de las vistas DEL DÍA (Resumen la suma por día) y
  // TikTok no publica vistas de cuenta: null, y llegan video por video.
  assert.deepEqual(p.metrics, { followers: 128400, following: 312, mediaCount: 3, views: null });
  assert.equal(p.source, 'ensembledata.tt.user.info');
  assert.match(p.metricsNote!, /llegan video por video/);

  // Cierre CON-C: la lectura de cuenta ya no recorre el catálogo (hasta 21 unidades por cuenta y día).
  assert.deepEqual(log.entries.map((e) => [e.endpoint, e.request_units]), [['ensembledata.tt.user.info', 1]]);
  // R4: el token va en la query del proveedor, y no aparece ni en el log ni en la URL grabada.
  assert.ok(fetch.calls[0]!.url.includes('token=REDACTADO'), fetch.calls[0]!.url);
  assert.ok(!JSON.stringify(fetch.calls).includes(TOKEN));
  assert.ok(!JSON.stringify(log.entries).includes(TOKEN));
});

test('un nulo no es un cero: sin followingCount ni videoCount quedan en null', async () => {
  const { src } = await source([['user.info', 'nulls']]);
  const p = await src.lookup('laura.cocinafacil');
  assert.deepEqual(p.metrics, { followers: 128400, following: null, mediaCount: null, views: null });
});

test('el proveedor cambia de forma: error definitivo con mensaje, no una cuenta a medias', async () => {
  const cambiada = await source([['user.info', 'forma_cambiada']]);
  await assert.rejects(cambiada.src.lookup('laura.cocinafacil'), (e: unknown) =>
    e instanceof PublicLookupError && e.code === 'not_discoverable' && /formato que no reconocemos/.test(e.messageEs) && /uniqueId/.test(e.messageEs));

  const sinSeguidores = await source([['user.info', 'sin_seguidores']]);
  await assert.rejects(sinSeguidores.src.lookup('laura.cocinafacil'), (e: unknown) =>
    e instanceof PublicLookupError && e.code === 'not_discoverable' && /followerCount/.test(e.messageEs));
  assert.equal(sinSeguidores.log.entries.length, 1);
});

test('cada código del proveedor tiene su frase: no existe, privada, credencial, unidades y suscripción', async () => {
  const casos: ReadonlyArray<[string, PublicLookupError['code'], RegExp]> = [
    ['user_not_found', 'not_found', /No encontramos @laura\.cocinafacil/],
    ['private_user', 'not_discoverable', /privada o está restringida/],
    ['invalid_token', 'not_configured', /rechazó la credencial de On Cue/],
    ['units_depleted', 'not_configured', /Se agotaron las unidades del día/],
    ['subscription_expired', 'not_configured', /suscripción .* está vencida/],
    // Comprobado contra la API real: un token mal copiado sale por 422, no por 491.
    ['validation_error', 'not_configured', /mal copiado \(su token tiene 16 caracteres\)/],
  ];
  for (const [variante, code, mensaje] of casos) {
    const { src } = await source([['user.info', variante]]);
    await assert.rejects(src.lookup('laura.cocinafacil'), (e: unknown) => {
      assert.ok(e instanceof PublicLookupError, `${variante}: no es PublicLookupError`);
      assert.equal(e.code, code, `${variante}: código`);
      assert.match(e.messageEs, mensaje, `${variante}: mensaje`);
      return true;
    });
  }
});

test('un 401 del proveedor fuera de sus códigos es NUESTRA credencial: not_configured, nunca un «vuelve a autorizar» al creador', async () => {
  const clock = new FakeClock();
  const log = new InMemoryCallLogSink();
  const fetch = new FixtureFetch([{
    meta: { source: 'docs', recordedAt: '2026-09-23', notes: 'Un 401 genérico de la pasarela del proveedor.' },
    request: { method: 'GET', urlPattern: '^https://ensembledata\\.com/apis/tt/user/info\\?' },
    response: { status: 401, body: { detail: 'Unauthorized' } },
  }]);
  const core = new HttpCore({ callLog: log, quota: new QuotaManager({ now: clock.now, sleep: clock.sleep }), fetch: fetch.fetch, now: clock.now, sleep: clock.sleep, random: () => 1 });
  const src = createPublicProfileSources(core, ENV).tiktok!;
  await assert.rejects(src.lookup('laura.cocinafacil'), (e: unknown) =>
    e instanceof PublicLookupError && e.code === 'not_configured' && /credencial de On Cue/.test(e.messageEs) && /ENSEMBLEDATA_TOKEN/.test(e.messageEs) && !e.messageEs.includes(TOKEN));
});

test('429 y 500 son transitorios: el núcleo reintenta solo y la cuenta se lee igual', async () => {
  const limitada = await source([['user.info', 'rate_limited']]);
  const p = await limitada.src.lookup('laura.cocinafacil');
  assert.equal(p.metrics!.followers, 128400);
  assert.equal(limitada.log.entries.filter((e) => e.endpoint === 'ensembledata.tt.user.info').length, 2);
  assert.equal(limitada.log.entries[0]!.rate_limited, true);
  assert.equal(limitada.log.entries[0]!.retry_after_s, 3);

  const caida = await source([['user.info', 'server_error_then_ok']]);
  assert.equal((await caida.src.lookup('laura.cocinafacil')).metrics!.followers, 128400);
});

test('la cuota del proveedor se contabiliza por unidades y con su propia familia', async () => {
  const { src, quota } = await source([['user.info', 'ok']]);
  await src.lookup('laura.cocinafacil');
  assert.deepEqual(quota.usedToday({ family: 'ensembledata', platformId: 'tiktok', connectionId: null }), { unitsUsed: 1, calls: 1 });
  // La Display API de TikTok es otro contrato: no comparte presupuesto.
  assert.deepEqual(quota.usedToday({ family: 'tiktok', platformId: 'tiktok', connectionId: null }), { unitsUsed: 0, calls: 0 });
});

const TARGET = { connectionId: null, handle: 'laura.cocinafacil', externalAccountId: 'laura.cocinafacil', tokens: null };

async function postSource(variant: string, env: Record<string, string | undefined> = ENV) {
  const clock = new FakeClock();
  const log = new InMemoryCallLogSink();
  const fetch = new FixtureFetch(await loadFixtures('ensembledata', [['user.posts', variant]]));
  const core = new HttpCore({ callLog: log, quota: new QuotaManager({ now: clock.now, sleep: clock.sleep }), fetch: fetch.fetch, now: clock.now, sleep: clock.sleep, random: () => 1 });
  return { log, core, src: createPublicPostSources(core, env).tiktok! };
}

async function listAll(src: Awaited<ReturnType<typeof postSource>>['src'], max?: number) {
  const out = [];
  for await (const v of src.listRecentPosts(TARGET, max === undefined ? {} : { max })) out.push(v);
  return out;
}

test('con el proveedor, TikTok SÍ tiene fuente de publicaciones para CON-5', async () => {
  const { log, core, src: conProveedor } = await postSource('ok');
  const target = TARGET;
  assert.equal(conProveedor.noPostsNoteEs, null, 'ya no hay que explicar por qué no hay videos');
  assert.equal(conProveedor.supportsLookupById, false, 'no se puede preguntar por un video suelto: un ausente no es un borrado');

  const videos = await listAll(conProveedor, 10);
  assert.equal(videos.length, 3);
  assert.equal(videos[0]!.post.external_post_id, '7400000000000000d01');
  assert.equal(videos[0]!.post.url, 'https://www.tiktok.com/@laura.cocinafacil/video/7400000000000000d01');
  assert.equal(videos[0]!.post.duration_s, 31, 'video.duration del aweme viene en milisegundos');
  assert.deepEqual(videos[0]!.post.hashtags, ['recetafacil']);
  assert.deepEqual(videos[0]!.post.mentions, ['cafealma.co']);
  assert.equal(videos[0]!.post.published_at?.toISOString(), '2026-08-28T16:00:00.000Z');
  assert.equal(videos[0]!.metrics.views, 50001);
  assert.deepEqual(log.entries.map((e) => e.request_units), [1], 'max 10 pide un solo bloque de diez, no cinco');

  const medidas = await conProveedor.postMetrics(target, [{ externalPostId: '7400000000000000d02', surface: 'feed', mediaType: 'video' }]);
  assert.deepEqual(medidas.readings.map((r) => [r.externalPostId, r.metrics.views]), [['7400000000000000d02', 12000]]);
  assert.deepEqual(medidas.missingIds, [], 'no preguntar por un id no prueba que ya no exista');
  assert.ok(log.entries.every((e) => e.endpoint === 'ensembledata.tt.user.posts'));

  // Sin la variable, la fuente de CON-5 vuelve a ser la que explica por qué no hay videos.
  const sinProveedor = createPublicPostSources(core, {}).tiktok!;
  assert.match(sinProveedor.noPostsNoteEs!, /no publica los videos/);
});

test('el gasto sigue al max de quien lista: 25 son 3 bloques; sin max, 5 (el tope por llamada)', async () => {
  const veinticinco = await postSource('ok');
  await listAll(veinticinco.src, 25);
  assert.deepEqual(veinticinco.log.entries.map((e) => e.request_units), [3]);
  const sinMax = await postSource('ok');
  await listAll(sinMax.src);
  assert.deepEqual(sinMax.log.entries.map((e) => e.request_units), [5]);
});

test('el catálogo pagina: dos llamadas, el cursor se consume y llegan los tres videos', async () => {
  const { src, log } = await postSource('paginated');
  const videos = await listAll(src);
  assert.deepEqual(videos.map((v) => v.metrics.views), [50001, 12000, 3400]);
  assert.equal(log.entries.length, 2);
});

test('forma anidada (data.posts y cursor dentro): se tolera y da los mismos videos', async () => {
  const { src } = await postSource('forma_anidada');
  assert.deepEqual((await listAll(src)).map((v) => v.metrics.views), [50001, 12000, 3400]);
});

test('ENSEMBLEDATA_MAX_POSTS corta el gasto: con 3 y más catálogo por delante no se pide otro bloque', async () => {
  const { src, log } = await postSource('truncado', { ...ENV, ENSEMBLEDATA_MAX_POSTS: '3' });
  assert.equal((await listAll(src)).length, 3);
  assert.deepEqual(log.entries.map((e) => e.request_units), [1]);
});

test('el proveedor dice que hay más y no manda nada: no se queda en bucle gastando unidades', async () => {
  const { src, log } = await postSource('vacia_con_cursor');
  assert.deepEqual(await listAll(src), []);
  assert.equal(log.entries.length, 1);
});

test('un video sin play_count: su lectura queda en null, nunca en cero', async () => {
  const { src } = await postSource('sin_play_count');
  assert.deepEqual((await listAll(src)).map((v) => v.metrics.views), [50001, null]);
});

test('un @ mal escrito no gasta una unidad: se rechaza antes de llamar', async () => {
  const { src, fetch } = await source([['user.info', 'ok']]);
  await assert.rejects(src.lookup('x'), (e: unknown) => e instanceof PublicLookupError && e.code === 'invalid_handle');
  assert.equal(fetch.calls.length, 0);
});
