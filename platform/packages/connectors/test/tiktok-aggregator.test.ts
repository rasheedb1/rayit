/**
 * CON-12 · proveedor de datos de TikTok (EnsembleData): seguidores y
 * vistas por @, errores del proveedor con su frase, parseo tolerante en
 * lo accesorio y definitivo cuando cambia de forma, y el token fuera de
 * todo log y de toda URL grabada.
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

test('con el token: seguidores del perfil y vistas sumadas del catálogo completo; access_mode aggregator', async () => {
  const { src, log, fetch } = await source([['user.info', 'ok'], ['user.posts', 'ok']]);
  assert.equal(src.accessMode, 'aggregator');
  assert.equal(src.label, TIKTOK_AGGREGATOR_LABEL);
  const p = await src.lookup('@laura.cocinafacil');

  assert.equal(p.profile.handle, 'laura.cocinafacil');
  assert.equal(p.profile.display_name, 'Laura · Cocina fácil');
  assert.equal(p.profile.external_account_id, 'laura.cocinafacil', 'el mismo id externo que el oEmbed de CON-10: contratar el proveedor no duplica la cuenta');
  assert.equal(p.profile.profile_url, 'https://www.tiktok.com/@laura.cocinafacil');
  assert.deepEqual(p.metrics, { followers: 128400, following: 312, mediaCount: 3, views: 65401 });
  assert.deepEqual(p.coverage, { postsRead: 3, postsTotal: 3, maxPosts: 200, complete: true });
  assert.equal(p.source, 'ensembledata.tt.user.info');
  assert.match(p.metricsNote!, /suma de las reproducciones/);

  assert.deepEqual(log.entries.map((e) => e.endpoint), ['ensembledata.tt.user.info', 'ensembledata.tt.user.posts']);
  // El catálogo se cobra por bloques de diez: 200 publicaciones de tope = 5 bloques en la primera llamada.
  assert.deepEqual(log.entries.map((e) => e.request_units), [1, 5]);
  // R4: el token va en la query del proveedor, y no aparece ni en el log ni en la URL grabada.
  assert.ok(fetch.calls[0]!.url.includes('token=REDACTADO'), fetch.calls[0]!.url);
  assert.ok(!JSON.stringify(fetch.calls).includes(TOKEN));
  assert.ok(!JSON.stringify(log.entries).includes(TOKEN));
});

test('un nulo no es un cero: sin followingCount ni videoCount quedan en null y las vistas se siguen sumando', async () => {
  const { src } = await source([['user.info', 'nulls'], ['user.posts', 'ok']]);
  const p = await src.lookup('laura.cocinafacil');
  assert.deepEqual(p.metrics, { followers: 128400, following: null, mediaCount: null, views: 65401 });
});

test('lista vacía sin un cero declarado en el perfil: las vistas quedan sin dato, no en cero', async () => {
  const { src } = await source([['user.info', 'nulls'], ['user.posts', 'empty']]);
  const p = await src.lookup('laura.cocinafacil');
  assert.equal(p.metrics!.views, null);
  assert.match(p.metricsNote!, /no devolvió ningún video/);
});

test('el catálogo pagina: dos llamadas, cursor consumido y las vistas suman el total', async () => {
  const { src, log } = await source([['user.info', 'ok'], ['user.posts', 'paginated']]);
  const p = await src.lookup('laura.cocinafacil');
  assert.equal(p.metrics!.views, 65401);
  assert.equal(p.coverage!.complete, true);
  assert.equal(log.entries.filter((e) => e.endpoint === 'ensembledata.tt.user.posts').length, 2);
});

test('forma anidada (data.posts y cursor dentro): se tolera y da el mismo total', async () => {
  const { src } = await source([['user.info', 'ok'], ['user.posts', 'forma_anidada']]);
  const p = await src.lookup('laura.cocinafacil');
  assert.equal(p.metrics!.views, 65401);
  assert.equal(p.coverage!.complete, true);
});

test('catálogo más largo que el tope: seguidores sí, vistas null con la razón; nunca un total a medias', async () => {
  const { src } = await source([['user.info', 'ok'], ['user.posts', 'truncado']], { ...ENV, ENSEMBLEDATA_MAX_POSTS: '3' });
  const p = await src.lookup('laura.cocinafacil');
  assert.equal(p.metrics!.followers, 128400);
  assert.equal(p.metrics!.views, null);
  assert.deepEqual(p.coverage, { postsRead: 3, postsTotal: 3, maxPosts: 3, complete: false });
  assert.match(p.metricsNote!, /pasa de 3 videos/);
  assert.match(p.metricsNote!, /ENSEMBLEDATA_MAX_POSTS/);
});

test('el tope es de gasto, no de datos: lo que el proveedor mande de más se suma, no se recorta', async () => {
  // Con el tope en 2 el proveedor igual manda sus 10 (un bloque) y cierra
  // el catálogo: recortar a 2 daría un total MÁS BAJO que el real,
  // etiquetado como «todo el catálogo».
  const { src } = await source([['user.info', 'ok'], ['user.posts', 'ok']], { ...ENV, ENSEMBLEDATA_MAX_POSTS: '2' });
  const p = await src.lookup('laura.cocinafacil');
  assert.equal(p.metrics!.views, 65401);
  assert.deepEqual(p.coverage, { postsRead: 3, postsTotal: 3, maxPosts: 2, complete: true });
});

test('el proveedor dice que hay más y no manda nada: no se afirma un total', async () => {
  const { src, log } = await source([['user.info', 'ok'], ['user.posts', 'vacia_con_cursor']]);
  const p = await src.lookup('laura.cocinafacil');
  assert.equal(p.metrics!.followers, 128400);
  assert.equal(p.metrics!.views, null);
  assert.equal(p.coverage!.complete, false);
  assert.equal(log.entries.filter((e) => e.endpoint === 'ensembledata.tt.user.posts').length, 1, 'no se queda en bucle gastando unidades');
});

test('un video sin play_count: el total tampoco se guarda', async () => {
  const { src } = await source([['user.info', 'ok'], ['user.posts', 'sin_play_count']]);
  const p = await src.lookup('laura.cocinafacil');
  assert.equal(p.metrics!.followers, 128400);
  assert.equal(p.metrics!.views, null);
  assert.match(p.metricsNote!, /no dio las reproducciones/);
});

test('el proveedor cambia de forma: error definitivo con mensaje, no una cuenta a medias', async () => {
  const cambiada = await source([['user.info', 'forma_cambiada']]);
  await assert.rejects(cambiada.src.lookup('laura.cocinafacil'), (e: unknown) =>
    e instanceof PublicLookupError && e.code === 'not_discoverable' && /formato que no reconocemos/.test(e.messageEs) && /uniqueId/.test(e.messageEs));

  const sinSeguidores = await source([['user.info', 'sin_seguidores']]);
  await assert.rejects(sinSeguidores.src.lookup('laura.cocinafacil'), (e: unknown) =>
    e instanceof PublicLookupError && e.code === 'not_discoverable' && /followerCount/.test(e.messageEs));
  // No se llegó a pedir el catálogo: un perfil que no se entiende no gasta más unidades.
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

test('429 y 500 son transitorios: el núcleo reintenta solo y la cuenta se lee igual', async () => {
  const limitada = await source([['user.info', 'rate_limited'], ['user.posts', 'ok']]);
  const p = await limitada.src.lookup('laura.cocinafacil');
  assert.equal(p.metrics!.followers, 128400);
  assert.equal(limitada.log.entries.filter((e) => e.endpoint === 'ensembledata.tt.user.info').length, 2);
  assert.equal(limitada.log.entries[0]!.rate_limited, true);
  assert.equal(limitada.log.entries[0]!.retry_after_s, 3);

  const caida = await source([['user.info', 'server_error_then_ok'], ['user.posts', 'ok']]);
  assert.equal((await caida.src.lookup('laura.cocinafacil')).metrics!.followers, 128400);
});

test('la cuota del proveedor se contabiliza por unidades y con su propia familia', async () => {
  const { src, quota } = await source([['user.info', 'ok'], ['user.posts', 'ok']]);
  await src.lookup('laura.cocinafacil');
  assert.deepEqual(quota.usedToday({ family: 'ensembledata', platformId: 'tiktok', connectionId: null }), { unitsUsed: 6, calls: 2 });
  // La Display API de TikTok es otro contrato: no comparte presupuesto.
  assert.deepEqual(quota.usedToday({ family: 'tiktok', platformId: 'tiktok', connectionId: null }), { unitsUsed: 0, calls: 0 });
});

test('con el proveedor, TikTok SÍ tiene fuente de publicaciones para CON-5', async () => {
  const clock = new FakeClock();
  const log = new InMemoryCallLogSink();
  const fetch = new FixtureFetch(await loadFixtures('ensembledata', [['user.posts', 'ok']]));
  const core = new HttpCore({ callLog: log, quota: new QuotaManager({ now: clock.now, sleep: clock.sleep }), fetch: fetch.fetch, now: clock.now, sleep: clock.sleep, random: () => 1 });
  const target = { connectionId: null, handle: 'laura.cocinafacil', externalAccountId: 'laura.cocinafacil', tokens: null };

  const conProveedor = createPublicPostSources(core, ENV).tiktok!;
  assert.equal(conProveedor.noPostsNoteEs, null, 'ya no hay que explicar por qué no hay videos');
  assert.equal(conProveedor.supportsLookupById, false, 'no se puede preguntar por un video suelto: un ausente no es un borrado');

  const videos = [];
  for await (const v of conProveedor.listRecentPosts(target, { max: 10 })) videos.push(v);
  assert.equal(videos.length, 3);
  assert.equal(videos[0]!.post.external_post_id, '7400000000000000d01');
  assert.equal(videos[0]!.post.url, 'https://www.tiktok.com/@laura.cocinafacil/video/7400000000000000d01');
  assert.equal(videos[0]!.post.duration_s, 31, 'video.duration del aweme viene en milisegundos');
  assert.deepEqual(videos[0]!.post.hashtags, ['recetafacil']);
  assert.deepEqual(videos[0]!.post.mentions, ['cafealma.co']);
  assert.equal(videos[0]!.post.published_at?.toISOString(), '2026-08-28T16:00:00.000Z');
  assert.equal(videos[0]!.metrics.views, 50001);

  const medidas = await conProveedor.postMetrics(target, [{ externalPostId: '7400000000000000d02', surface: 'feed', mediaType: 'video' }]);
  assert.deepEqual(medidas.readings.map((r) => [r.externalPostId, r.metrics.views]), [['7400000000000000d02', 12000]]);
  assert.deepEqual(medidas.missingIds, [], 'no preguntar por un id no prueba que ya no exista');
  assert.ok(log.entries.every((e) => e.endpoint === 'ensembledata.tt.user.posts'));

  // Sin la variable, la fuente de CON-5 vuelve a ser la que explica por qué no hay videos.
  const sinProveedor = createPublicPostSources(core, {}).tiktok!;
  assert.match(sinProveedor.noPostsNoteEs!, /no publica los videos/);
});

test('un @ mal escrito no gasta una unidad: se rechaza antes de llamar', async () => {
  const { src, fetch } = await source([['user.info', 'ok']]);
  await assert.rejects(src.lookup('x'), (e: unknown) => e instanceof PublicLookupError && e.code === 'invalid_handle');
  assert.equal(fetch.calls.length, 0);
});
