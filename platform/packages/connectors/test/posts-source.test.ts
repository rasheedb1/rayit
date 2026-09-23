/**
 * CON-5 · fuentes de posts, sin red.
 *
 * Lo que se demuestra aquí: qué entrega cada fuente pública, que lo que
 * la API no da queda en null (nunca en cero), que la ventana `since` y
 * el tope `max` cortan de verdad, que solo las fuentes con consulta por
 * id anuncian borrados, y que el token de la casa y la API key no
 * aparecen en ninguna URL ni en ninguna llamada registrada.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpCore } from '../src/http/client.ts';
import type { PlatformApiError } from '../src/http/errors.ts';
import { InMemoryCallLogSink } from '../src/log/memory.ts';
import type { NormalizedVideo } from '../src/normalize/types.ts';
import { createAuthorizedPostSource, createInstagramPublicPostSource, createPublicPostSources, productTypeFor, TIKTOK_POSTS_NOTE_ES, type PostSource, type PostSourceTarget } from '../src/posts/index.ts';
import { PublicLookupError } from '../src/public/types.ts';
import { QuotaManager } from '../src/quota/manager.ts';
import { FixtureFetch, loadFixtures, withoutNetwork, type Fixture, type NetworkGuard } from '../src/testing/fixture-fetch.ts';
import type { OAuthTokens } from '../src/types.ts';
import { FakeClock } from './helpers/fake-clock.ts';

let guard: NetworkGuard;
before(() => { guard = withoutNetwork(); });
after(() => { guard.restore(); });

const HOUSE = 'IGAA-token-de-la-casa-SECRETO';
const API_KEY = 'AIza-llave-del-proyecto-SECRETO';
const ENV = { INSTAGRAM_HOUSE_TOKEN: HOUSE, GOOGLE_API_KEY: API_KEY };
const CONN = '00000005-0000-4000-8000-0000000000c1';
const OWNER: OAuthTokens = { accessToken: 'act.token-del-dueno-SECRETO', accessExpiresAt: new Date('2026-12-01T00:00:00Z'), scopes: ['user.info.basic', 'video.list'] };

function target(handle: string, tokens: OAuthTokens | null = null): PostSourceTarget {
  return { connectionId: tokens ? CONN : null, handle, externalAccountId: handle, tokens };
}

async function arnes(fixtures: readonly Fixture[]) {
  const clock = new FakeClock();
  const log = new InMemoryCallLogSink();
  const fetch = new FixtureFetch(fixtures);
  const core = new HttpCore({ callLog: log, quota: new QuotaManager({ now: clock.now, sleep: clock.sleep }), fetch: fetch.fetch, now: clock.now, sleep: clock.sleep, random: () => 1 });
  return { core, log, fetch, publicas: createPublicPostSources(core, ENV) };
}

async function todos(source: PostSource, t: PostSourceTarget, opts: Parameters<PostSource['listRecentPosts']>[1] = {}): Promise<NormalizedVideo[]> {
  const out: NormalizedVideo[] = [];
  for await (const v of source.listRecentPosts(t, opts)) out.push(v);
  return out;
}

async function falla(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => { throw new Error('esperaba un error'); }, (e: unknown) => e);
}

// ---------------------------------------------------------------------
// Instagram por @
// ---------------------------------------------------------------------

test('instagram por @: reel con vistas, feed sin vistas (null, no cero) y hashtags del caption', async () => {
  const a = await arnes(await loadFixtures('instagram', [['business_discovery.media', 'ok']]));
  const videos = await todos(a.publicas.instagram!, target('cafealma'));
  assert.equal(videos.length, 3);

  const reel = videos[0]!;
  assert.equal(reel.post.external_post_id, '1800000000000000b01');
  assert.equal(reel.post.media_type, 'video');
  assert.equal(reel.post.surface, 'reels');
  assert.equal(reel.post.permalink, 'https://www.instagram.com/reel/demo-b01/');
  assert.deepEqual(reel.post.hashtags, ['coldbrew', 'cafe']);
  assert.deepEqual(reel.post.mentions, ['cafealma']);
  assert.equal(reel.post.published_at?.toISOString(), '2026-09-20T17:00:00.000Z');
  assert.equal(reel.metrics.views, 141200);
  assert.equal(reel.metrics.likes, 5120);
  assert.equal(reel.metrics.comments, 208);

  const feed = videos[1]!;
  assert.equal(feed.post.media_type, 'image');
  assert.equal(feed.post.surface, 'feed');
  assert.equal(feed.metrics.views, null, 'Instagram no publica vistas de feed: null, no cero');
  assert.equal(videos[2]!.post.media_type, 'carousel');

  for (const v of videos) {
    // Lo que solo da el permiso del dueño no se inventa.
    assert.equal(v.metrics.reach, null);
    assert.equal(v.metrics.saves, null);
    assert.equal(v.metrics.shares, null);
    assert.equal(v.metrics.completion_rate, null);
    assert.equal(v.metrics.reach_non_followers, null);
  }

  // El token de la casa va en la cabecera, jamás en la URL.
  assert.equal(a.fetch.calls.length, 1);
  assert.ok(!a.fetch.calls[0]!.url.includes(HOUSE));
  assert.equal(a.fetch.calls[0]!.headers['Authorization'], '[REDACTADO]');
  assert.equal(a.log.entries[0]!.endpoint, 'instagram.business_discovery.media');
  assert.equal(guard.attempts, 0);
});

test('instagram por @: cuenta sin publicaciones y campos ausentes que no son ceros', async () => {
  const vacia = await arnes(await loadFixtures('instagram', [['business_discovery.media', 'empty']]));
  assert.deepEqual(await todos(vacia.publicas.instagram!, target('reciencreada')), []);

  const nulos = await arnes(await loadFixtures('instagram', [['business_discovery.media', 'nulls']]));
  const [v] = await todos(nulos.publicas.instagram!, target('sinlikes'));
  assert.equal(v!.metrics.likes, null, 'los «me gusta» ocultos son null, no cero');
  assert.equal(v!.metrics.comments, 0, 'un cero que sí vino se conserva');
  assert.equal(v!.metrics.views, null);
  assert.equal(v!.post.caption, null);
  assert.deepEqual(v!.post.hashtags, []);
  assert.equal(v!.post.surface, null, 'sin media_product_type no se adivina la superficie');
});

test('instagram por @: la segunda página se pide con media.after(CURSOR) y max corta', async () => {
  // Páginas de 2 para poder ejercitar la paginación sin fixtures de 25
  // medios; en producción son 25 (INSTAGRAM_POSTS_PAGE).
  const a = await arnes(await loadFixtures('instagram', [['business_discovery.media', 'paginated']]));
  const source = createInstagramPublicPostSource(a.core, ENV, { pageSize: 2 });
  const videos = await todos(source, target('paginada'), { max: 4 });
  assert.deepEqual(videos.map((v) => v.post.external_post_id), ['1800000000000000p01', '1800000000000000p02', '1800000000000000p03']);
  assert.equal(a.fetch.calls.length, 2);
  assert.ok(a.fetch.calls[0]!.url.includes('media.limit%282%29'), a.fetch.calls[0]!.url);
  assert.ok(a.fetch.calls[1]!.url.includes('media.after%28QVFIU_p_after_1%29'), a.fetch.calls[1]!.url);

  const b = await arnes(await loadFixtures('instagram', [['business_discovery.media', 'paginated']]));
  const dos = await todos(createInstagramPublicPostSource(b.core, ENV, { pageSize: 2 }), target('paginada'), { max: 2 });
  assert.equal(dos.length, 2, 'max corta antes de pedir la segunda página');
  assert.equal(b.fetch.calls.length, 1);
});

test('instagram por @: la página con un post ya conocido se entrega entera y no se pide la siguiente', async () => {
  // El corte es por página, no por elemento: la página ya se pagó, así
  // que entregarla entera no cuesta una llamada más y sí permite
  // refrescar (y fusionar) lo que ya teníamos.
  const a = await arnes(await loadFixtures('instagram', [['business_discovery.media', 'paginated']]));
  const source = createInstagramPublicPostSource(a.core, ENV, { pageSize: 2 });
  const videos = await todos(source, target('paginada'), { since: new Date('2026-09-20T10:00:00Z') });
  assert.deepEqual(videos.map((v) => v.post.external_post_id), ['1800000000000000p01', '1800000000000000p02']);
  assert.equal(a.fetch.calls.length, 1, 'la segunda página no se pide: de ahí para atrás ya está todo guardado');
});

test('instagram por @: una cuenta que no se puede descubrir se explica, no se cae', async () => {
  const a = await arnes(await loadFixtures('instagram', [['business_discovery.media', 'no_discovery']]));
  const err = await falla(todos(a.publicas.instagram!, target('privada')));
  assert.ok(err instanceof PublicLookupError);
  assert.equal(err.code, 'not_discoverable');
  assert.match(err.messageEs, /solo las cuentas profesionales/);
});

test('instagram por @: el token de la casa vencido es problema nuestro (not_configured), no de la cuenta', async () => {
  const a = await arnes(await loadFixtures('instagram', [['business_discovery.media', 'invalid_token']]));
  const err = await falla(todos(a.publicas.instagram!, target('sintoken')));
  assert.ok(err instanceof PublicLookupError);
  assert.equal(err.code, 'not_configured');
  assert.match(err.messageEs, /credencial de Instagram de On Cue/);
});

test('instagram por @: el límite de la aplicación sale como cuota', async () => {
  const a = await arnes(await loadFixtures('instagram', [['business_discovery.media', 'rate_limited']]));
  const err = (await falla(todos(a.publicas.instagram!, target('pasada')))) as PublicLookupError;
  // toLookupError traduce lo que la pantalla puede decir; el kind original queda en la causa.
  assert.ok(err instanceof PublicLookupError);
  assert.equal((err.cause as PlatformApiError).kind, 'quota');
});

test('instagram por @: sin INSTAGRAM_HOUSE_TOKEN la fuente lo declara y no llama', async () => {
  const clock = new FakeClock();
  const fetch = new FixtureFetch([]);
  const core = new HttpCore({ callLog: new InMemoryCallLogSink(), quota: new QuotaManager({ now: clock.now, sleep: clock.sleep }), fetch: fetch.fetch, now: clock.now, sleep: clock.sleep });
  const source = createPublicPostSources(core, {}).instagram!;
  assert.deepEqual([...source.missing], ['INSTAGRAM_HOUSE_TOKEN']);
  const err = await falla(todos(source, target('cafealma')));
  assert.equal((err as PublicLookupError).code, 'not_configured');
  assert.equal(fetch.calls.length, 0);
});

test('instagram por @: postMetrics empareja por id y no anuncia borrados', async () => {
  const a = await arnes(await loadFixtures('instagram', [['business_discovery.media', 'ok']]));
  const res = await a.publicas.instagram!.postMetrics(target('cafealma'), [
    { externalPostId: '1800000000000000b02', surface: 'feed', mediaType: 'image' },
    { externalPostId: 'no-existe', surface: null, mediaType: 'video' },
  ]);
  assert.deepEqual(res.readings.map((r) => r.externalPostId), ['1800000000000000b02']);
  assert.equal(res.readings[0]!.metrics.likes, 1830);
  assert.deepEqual(res.missingIds, [], 'business_discovery no deja preguntar por un id: no saber no es haber sido borrado');
  assert.equal(a.publicas.instagram!.supportsLookupById, false);
});

// ---------------------------------------------------------------------
// YouTube por @
// ---------------------------------------------------------------------

test('youtube por @: canal → lista de subidas → videos, con duración y contadores', async () => {
  const a = await arnes([
    ...(await loadFixtures('youtube', [['channels.list', 'handle.uploads.ok'], ['playlist_items.list', 'uploads.ok'], ['videos.list', 'canal.ok']])),
  ]);
  const videos = await todos(a.publicas.youtube!, target('NutriveOficial'));
  // La lista de subidas llega de lo más nuevo a lo más viejo y el
  // recolector conserva ese orden al pedir los videos.
  assert.deepEqual(videos.map((v) => v.post.external_post_id), ['vid00000003', 'vid00000002', 'vid00000001']);
  const uno = videos[2]!;
  assert.equal(uno.post.title, 'Receta 1 en 10 minutos');
  assert.equal(uno.post.duration_s, 73);
  assert.equal(uno.metrics.views, 90001);
  assert.equal(uno.metrics.likes, 4101);
  assert.equal(uno.metrics.comments, 211);
  assert.equal(uno.metrics.reach, null, 'el alcance es de Analytics: pide OAuth');
  assert.equal(uno.metrics.completion_rate, null);
  assert.equal(videos[0]!.metrics.comments, null, 'sin commentCount los comentarios son null, no cero');

  assert.deepEqual(a.log.entries.map((e) => e.endpoint), ['youtube.channels.list', 'youtube.playlist_items.list', 'youtube.videos.list']);
  assert.deepEqual(a.log.entries.map((e) => e.request_units), [1, 1, 1], 'tres unidades de cuota por canal y corrida');
  for (const call of a.fetch.calls) assert.ok(!call.url.includes(API_KEY), 'la API key se tapa en la URL registrada');
});

test('youtube por @: con un video ya conocido en la página no se pide una página más', async () => {
  const a = await arnes(await loadFixtures('youtube', [['channels.list', 'handle.uploads.ok'], ['playlist_items.list', 'uploads.ok'], ['videos.list', 'canal.ok']]));
  const videos = await todos(a.publicas.youtube!, target('NutriveOficial'), { since: new Date('2026-09-03T15:00:00Z') });
  assert.deepEqual(videos.map((v) => v.post.external_post_id), ['vid00000003', 'vid00000002', 'vid00000001']);
  assert.deepEqual(a.log.entries.map((e) => e.endpoint), ['youtube.channels.list', 'youtube.playlist_items.list', 'youtube.videos.list'], 'una sola página de la lista de subidas');
});

test('youtube por @: max corta el listado sin pedir más páginas', async () => {
  const a = await arnes(await loadFixtures('youtube', [['channels.list', 'handle.uploads.ok'], ['playlist_items.list', 'uploads.ok'], ['videos.list', 'canal.ok']]));
  const videos = await todos(a.publicas.youtube!, target('NutriveOficial'), { max: 2 });
  assert.deepEqual(videos.map((v) => v.post.external_post_id), ['vid00000003', 'vid00000002']);
});

test('youtube por @: un canal que no existe se dice con palabras', async () => {
  const a = await arnes(await loadFixtures('youtube', [['channels.list', 'handle.uploads.empty']]));
  const err = await falla(todos(a.publicas.youtube!, target('noexiste')));
  assert.equal((err as PublicLookupError).code, 'not_found');
  assert.match((err as PublicLookupError).messageEs, /No encontramos el canal @noexiste/);
});

test('youtube por @: postMetrics devuelve los ids que la plataforma ya no tiene', async () => {
  const a = await arnes(await loadFixtures('youtube', [['videos.list', 'ok']]));
  const res = await a.publicas.youtube!.postMetrics(target('NutriveOficial'), [
    { externalPostId: 'vid00000001', surface: null, mediaType: 'video' },
    { externalPostId: 'vid00000002', surface: null, mediaType: 'video' },
    { externalPostId: 'vid00000099', surface: null, mediaType: 'video' },
  ]);
  assert.deepEqual(res.readings.map((r) => r.externalPostId), ['vid00000001', 'vid00000002']);
  assert.deepEqual(res.missingIds, ['vid00000099']);
  assert.equal(a.publicas.youtube!.supportsLookupById, true);
  assert.equal(a.fetch.calls.length, 1, 'hasta 50 ids por unidad de cuota');
});

// ---------------------------------------------------------------------
// TikTok por @
// ---------------------------------------------------------------------

test('tiktok por @: no lista videos, lo explica y no llama a nadie', async () => {
  const a = await arnes([]);
  const tt = a.publicas.tiktok!;
  assert.equal(tt.noPostsNoteEs, TIKTOK_POSTS_NOTE_ES);
  assert.match(tt.noPostsNoteEs!, /archivo de TikTok Studio/);
  assert.deepEqual(await todos(tt, target('selvathegolden')), []);
  assert.deepEqual(await tt.postMetrics(target('selvathegolden'), [{ externalPostId: 'x', surface: null, mediaType: 'video' }]), { readings: [], missingIds: [] });
  assert.equal(a.fetch.calls.length, 0);
});

// ---------------------------------------------------------------------
// Estrategia autorizada
// ---------------------------------------------------------------------

test('autorizada de tiktok: lista videos y pregunta por id; lo que no vuelve es un borrado', async () => {
  const a = await arnes(await loadFixtures('tiktok', [['video.list', 'ok'], ['video.query', 'ok']]));
  const source = createAuthorizedPostSource(a.core, 'tiktok')!;
  const videos = await todos(source, target('laura.cocinafacil', OWNER), { max: 20 });
  assert.deepEqual(videos.map((v) => v.post.external_post_id), ['7400000000000000d01', '7400000000000000d02', '7400000000000000d03']);
  assert.ok(videos[0]!.metrics.views !== null, 'el permiso del dueño trae las vistas de TikTok');
  assert.equal(source.supportsLookupById, true);

  // El fixture de video/query responde por dos de los tres ids: el
  // tercero ya no está en la plataforma.
  const res = await source.postMetrics(target('laura.cocinafacil', OWNER), [
    { externalPostId: '7400000000000000d01', surface: null, mediaType: 'video' },
    { externalPostId: '7400000000000000d02', surface: null, mediaType: 'video' },
  ]);
  assert.deepEqual(res.readings.map((r) => r.externalPostId), ['7400000000000000d01', '7400000000000000d02']);
  assert.deepEqual(res.missingIds, []);
  for (const call of a.fetch.calls) assert.ok(!JSON.stringify(call).includes(OWNER.accessToken));
});

test('autorizada de instagram: los insights llegan por la superficie del post', async () => {
  const a = await arnes(await loadFixtures('instagram', [['media.insights', 'reels.ok']]));
  const source = createAuthorizedPostSource(a.core, 'instagram')!;
  const res = await source.postMetrics(target('laura.cocinafacil', OWNER), [{ externalPostId: '1800000000000000d01', surface: 'reels', mediaType: 'video' }]);
  assert.equal(res.readings.length, 1);
  assert.ok(res.readings[0]!.metrics.reach !== null, 'el permiso del dueño es lo que trae el alcance');
  assert.ok(a.fetch.calls[0]!.url.includes('metric='));
});

test('autorizada de youtube: un token del dueño rechazado sale como auth, no como «credencial de la casa»', async () => {
  // Si se tradujera a not_configured, el job culparía a nuestra API key
  // y la cuenta del creador se quedaría para siempre en «activa» con un
  // token muerto, sin aviso y reintentando cada día.
  const a = await arnes(await loadFixtures('youtube', [['videos.list', 'invalid_token']]));
  const source = createAuthorizedPostSource(a.core, 'youtube')!;
  const err = await falla(source.postMetrics(target('NutriveOficial', OWNER), [{ externalPostId: 'vid00000001', surface: null, mediaType: 'video' }]));
  assert.ok(!(err instanceof PublicLookupError), 'no se traduce: el job necesita el kind original');
  assert.equal((err as PlatformApiError).kind, 'auth');
});

test('la de @ sí traduce: una API key rechazada es problema nuestro, no de la cuenta', async () => {
  const a = await arnes(await loadFixtures('youtube', [['videos.list', 'invalid_token']]));
  const err = await falla(a.publicas.youtube!.postMetrics(target('NutriveOficial'), [{ externalPostId: 'vid00000001', surface: null, mediaType: 'video' }]));
  assert.ok(err instanceof PublicLookupError);
  assert.equal(err.code, 'not_configured');
});

test('productTypeFor traduce la superficie sin adivinar', () => {
  assert.equal(productTypeFor('reels'), 'REELS');
  assert.equal(productTypeFor('story'), 'STORY');
  assert.equal(productTypeFor('ad'), 'AD');
  assert.equal(productTypeFor('feed'), 'FEED');
  assert.equal(productTypeFor(null), 'FEED');
});

test('una conexión autorizada sin credenciales en el almacén no se confunde con una cuenta rota', async () => {
  const a = await arnes([]);
  const source = createAuthorizedPostSource(a.core, 'tiktok')!;
  const err = await falla(todos(source, target('laura.cocinafacil', null)));
  assert.equal((err as PublicLookupError).code, 'not_configured');
  assert.equal(a.fetch.calls.length, 0);
});

test('facebook no tiene fuente de posts en esta versión', async () => {
  const a = await arnes([]);
  assert.equal(createAuthorizedPostSource(a.core, 'facebook'), null);
  assert.equal(createAuthorizedPostSource(a.core, 'noexiste'), null);
  assert.equal(a.publicas.facebook, undefined);
});
