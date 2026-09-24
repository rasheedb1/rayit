/**
 * VEN-9 · los avisos de Unipile: la ruta firmada, el secreto compartido,
 * la lectura del cuerpo con los fixtures grabados y el alta de un aviso
 * por cuenta (POST /webhooks), sin red.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { InMemoryOutreachCallLog } from '../src/outreach/log.ts';
import { FakeUnipile } from '../src/outreach/fake-unipile.ts';
import {
  channelRouteKey, channelSigningKeys, parseUnipileWebhook, sharedSecretMatches, signChannelRoute, verifyChannelRoute,
} from '../src/outreach/unipile-webhook.ts';
import { keyringOf } from '../src/crypto/master-key.ts';
import { GOOGLE_STATE_TTL_MS, signChannelState, verifyChannelState } from '../src/outreach/state.ts';
import { FixtureFetch, loadFixtures, withoutNetwork, type NetworkGuard } from '../src/testing/fixture-fetch.ts';
import { UnipileClient } from '../src/unipile.ts';

let guard: NetworkGuard;
before(() => { guard = withoutNetwork(); });
after(() => {
  guard.restore();
  assert.equal(guard.attempts, 0, 'ninguna prueba de avisos salió a la red');
});

const MASTER = new Uint8Array(32).fill(7);
const OTRA = new Uint8Array(32).fill(8);
const ROUTE = { workspaceId: '00000002-0000-4000-8000-000000000001', channelAccountId: '00000005-0000-4000-8000-0000000ac002' };
const NOW = new Date('2026-09-24T12:00:00Z');

const fixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(`../fixtures/unipile/webhooks/${name}.json`, import.meta.url), 'utf8'));

test('la ruta firmada: abre con la misma llave, no con otra, y una alterada no pasa', () => {
  const key = channelRouteKey(MASTER);
  const token = signChannelRoute(ROUTE, key, NOW);
  assert.deepEqual(verifyChannelRoute(token, key, new Date('2030-01-01T00:00:00Z')), ROUTE, 'vive lo que vive el aviso');
  assert.equal(verifyChannelRoute(token, channelRouteKey(OTRA), NOW), null);
  assert.equal(verifyChannelRoute(`${token.slice(0, -2)}xx`, key, NOW), null);
  assert.equal(verifyChannelRoute(undefined, key, NOW), null);
  const rara = signChannelRoute({ workspaceId: 'no-es-uuid', channelAccountId: ROUTE.channelAccountId }, key, NOW);
  assert.equal(verifyChannelRoute(rara, key, NOW), null, 'firma buena, forma mala: no pasa');
});

test('el secreto compartido: igual casa; distinto, vacío o ausente, no', () => {
  assert.equal(sharedSecretMatches('s3creto-largo', 's3creto-largo'), true);
  assert.equal(sharedSecretMatches('s3creto-larga', 's3creto-largo'), false);
  assert.equal(sharedSecretMatches('corto', 's3creto-largo'), false);
  assert.equal(sharedSecretMatches(null, 's3creto-largo'), false);
  assert.equal(sharedSecretMatches('', ''), false, 'sin secreto configurado nada casa');
});

test('parseUnipileWebhook: cuenta creada, salud y mensaje, con los fixtures grabados', async () => {
  assert.deepEqual(parseUnipileWebhook(await fixture('account.created')), {
    kind: 'account_connected', accountId: 'acc_li_0001', state: '<estado firmado>', reconnected: false,
  });
  assert.deepEqual(parseUnipileWebhook(await fixture('account.status.credentials')), { kind: 'account_status', accountId: 'acc_li_0001', status: 'CREDENTIALS' });
  const m = parseUnipileWebhook(await fixture('message.received'));
  assert.ok(m.kind === 'message');
  assert.equal(m.chatId, 'chat_0001');
  assert.equal(m.messageId, 'msg_0003');
  assert.equal(m.senderName, 'Marta Ríos');
  assert.equal(m.fromSelf, false);
  assert.equal(m.occurredAt?.toISOString(), '2026-09-22T15:00:00.000Z');
});

test('parseUnipileWebhook: el eco de un envío propio se marca, y lo incompleto se ignora', async () => {
  const raw = await fixture('message.received') as Record<string, unknown>;
  const eco = parseUnipileWebhook({ ...raw, sender: { attendee_provider_id: 'ACoAAB_demo', attendee_name: 'Laura' } });
  assert.ok(eco.kind === 'message' && eco.fromSelf);
  assert.equal(parseUnipileWebhook({ status: 'CREATION_SUCCESS', account_id: 'x' }).kind, 'ignored');
  assert.equal(parseUnipileWebhook({ event: 'message_read' }).kind, 'ignored');
  assert.equal(parseUnipileWebhook('basura').kind, 'ignored');
});

test('createWebhook: un aviso por cuenta con las cabeceras nuestras; el secreto no sale en la bitácora', async () => {
  const log = new InMemoryOutreachCallLog();
  const fetch = new FixtureFetch(await loadFixtures('unipile', [['webhooks.create', 'ok']]));
  const api = new UnipileClient({ config: { dsn: 'api1.unipile.test:13111', accessToken: 'llave' }, callLog: log, fetch: fetch.fetch });
  const r = await api.createWebhook({
    source: 'messaging', accountId: 'acc_li_0001', requestUrl: 'https://app.test/api/webhooks/unipile',
    headers: { 'x-on-cue-secret': 'SECRETO-COMPARTIDO', 'x-on-cue-route': 'ruta' },
  }, { channelAccountId: ROUTE.channelAccountId });
  assert.deepEqual(r, { webhookId: 'wh_demo_0001' });
  const body = fetch.calls[0]!.body as Record<string, unknown>;
  assert.deepEqual(body['account_ids'], ['acc_li_0001']);
  assert.deepEqual(body['events'], ['message_received']);
  assert.ok(!JSON.stringify(log.entries).includes('SECRETO-COMPARTIDO'));
  assert.deepEqual(log.entries.map((e) => [e.endpoint, e.ok, e.channel_account_id]), [['unipile.webhooks.create', true, ROUTE.channelAccountId]]);
});

test('FakeUnipile.createWebhook guarda el aviso y no registra el valor de las cabeceras', async () => {
  const fake = new FakeUnipile();
  await fake.createWebhook({ source: 'account_status', accountId: 'acc_1', requestUrl: 'https://x.test', headers: { 'x-on-cue-secret': 'S' } });
  assert.equal(fake.webhooks.length, 1);
  assert.deepEqual((fake.calls[0]!.args as { headers: string[] }).headers, ['x-on-cue-secret']);
});

test('rotar TOKEN_ENCRYPTION_KEY no deja 401 lo ya firmado: v1 firma, se rota a v2 y la ruta y el estado siguen abriendo', () => {
  const v1 = channelSigningKeys(keyringOf({ v1: MASTER }));
  const route = signChannelRoute(ROUTE, v1.current.route, NOW);
  const state = signChannelState({ workspaceId: ROUTE.workspaceId, creatorId: ROUTE.workspaceId, channel: 'linkedin', nonce: 'n'.repeat(43) }, v1.current.state, NOW);

  const rotado = channelSigningKeys(keyringOf({ v1: MASTER, v2: OTRA }, 'v2'));
  assert.notDeepEqual(rotado.current.route, v1.current.route, 'lo nuevo se firma con v2');
  assert.equal(rotado.route.length, 2);
  assert.deepEqual(verifyChannelRoute(route, rotado.route, NOW), ROUTE, 'el aviso firmado con v1 sigue entrando');
  assert.equal(verifyChannelState(state, rotado.state, NOW, GOOGLE_STATE_TTL_MS).ok, true);
  // Con la actual sola (el comportamiento de antes) no abría: es lo que se arregla.
  assert.equal(verifyChannelRoute(route, rotado.current.route, NOW), null);
  // Retirada v1 del llavero, ya no abre: la rotación termina cuando se vuelven a firmar las rutas.
  assert.equal(verifyChannelRoute(route, channelSigningKeys(keyringOf({ v2: OTRA })).route, NOW), null);
  // Firmada con v2, abre con el llavero rotado.
  assert.deepEqual(verifyChannelRoute(signChannelRoute(ROUTE, rotado.current.route, NOW), rotado.route, NOW), ROUTE);
});
