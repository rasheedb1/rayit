import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { OutreachApiError } from '../src/outreach/errors.ts';
import { FakeUnipile } from '../src/outreach/fake-unipile.ts';
import { InMemoryOutreachCallLog } from '../src/outreach/log.ts';
import { FixtureFetch, loadFixtures, withoutNetwork, type NetworkGuard } from '../src/testing/fixture-fetch.ts';
import { classifyUnipileError, loadUnipileConfig, LINKEDIN_INVITE_NOTE_MAX, UnipileClient } from '../src/unipile.ts';

let guard: NetworkGuard;
before(() => { guard = withoutNetwork(); });
after(() => {
  guard.restore();
  assert.equal(guard.attempts, 0, 'ninguna prueba de Unipile salió a la red');
});

const KEY = 'unipile-LLAVE-SECRETA-123456';
const CA = '00000005-0000-4000-8000-0000000ac002';

async function client(names: ReadonlyArray<[string, string?]>) {
  const log = new InMemoryOutreachCallLog();
  const fetch = new FixtureFetch(await loadFixtures('unipile', names));
  const slept: number[] = [];
  const api = new UnipileClient({
    config: { dsn: 'api1.unipile.test:13111', accessToken: KEY }, callLog: log, fetch: fetch.fetch,
    sleep: async (ms) => { slept.push(ms); }, random: () => 0.5,
  });
  return { api, log, fetch, slept };
}

async function failure(p: Promise<unknown>): Promise<OutreachApiError> {
  return p.then(() => { throw new Error('esperaba un error'); }, (e: unknown) => e as OutreachApiError);
}

test('loadUnipileConfig: sin las dos variables dice cuáles faltan; con https:// en el DSN lo limpia', () => {
  assert.deepEqual(loadUnipileConfig({}), { missing: ['UNIPILE_DSN', 'UNIPILE_ACCESS_TOKEN'] });
  assert.deepEqual(loadUnipileConfig({ UNIPILE_DSN: 'https://api8.unipile.com:13851/', UNIPILE_ACCESS_TOKEN: ' k ' }), { config: { dsn: 'api8.unipile.com:13851', accessToken: 'k' } });
});

test('getAccount: normaliza la cuenta, manda X-API-KEY y deja una fila en la bitácora con la cuenta de canal', async () => {
  const { api, log, fetch } = await client([['accounts.get', 'ok']]);
  const a = await api.getAccount('acc_li_0001', { channelAccountId: CA });
  assert.deepEqual(a, { id: 'acc_li_0001', provider: 'LINKEDIN', name: 'Laura Gómez', username: 'laura-gomez-cocina', health: 'ok', rawStatus: 'OK' });
  assert.equal(fetch.calls[0]!.headers['X-API-KEY'], KEY, 'la llave viaja en la cabecera, no en la URL');
  assert.ok(!fetch.calls[0]!.url.includes(KEY));
  assert.deepEqual(log.entries.map((e) => [e.provider, e.endpoint, e.ok, e.channel_account_id]), [['unipile', 'unipile.accounts.get', true, CA]]);
});

test('getAccount con la fuente en CREDENTIALS: health needs_reconnect', async () => {
  const { api } = await client([['accounts.get', 'credentials']]);
  const a = await api.getAccount('acc_li_0001');
  assert.equal(a.health, 'needs_reconnect');
  assert.equal(a.rawStatus, 'CREDENTIALS');
});

test('un 503 se reintenta y la bitácora guarda los dos intentos', async () => {
  const { api, log, slept } = await client([['accounts.get', 'server_error_then_ok']]);
  const a = await api.getAccount('acc_li_0001');
  assert.equal(a.id, 'acc_li_0001');
  assert.equal(slept.length, 1);
  assert.deepEqual(log.entries.map((e) => [e.ok, e.error_code]), [[false, 'errors/service_unavailable'], [true, null]]);
});

test('listAccounts: LinkedIn e Instagram', async () => {
  const { api } = await client([['accounts.list', 'ok']]);
  const list = await api.listAccounts();
  assert.deepEqual(list.map((a) => [a.provider, a.username]), [['LINKEDIN', 'laura-gomez-cocina'], ['INSTAGRAM', 'laura.cocinafacil']]);
});

test('createHostedAuthLink: type create, el proveedor del canal y el estado firmado en name', async () => {
  const { api, fetch } = await client([['hosted.link', 'ok']]);
  const r = await api.createHostedAuthLink({
    channel: 'linkedin', state: 'ESTADO.FIRMA', notifyUrl: 'https://app.test/api/webhooks/unipile',
    successRedirectUrl: 'https://app.test/ventas/canales?ok=linkedin', failureRedirectUrl: 'https://app.test/ventas/canales?error=linkedin',
    expiresOn: new Date('2026-09-24T00:00:00Z'),
  });
  assert.equal(r.url, 'https://account.unipile.com/demo_hosted_token');
  const body = fetch.calls[0]!.body as Record<string, unknown>;
  assert.equal(body['name'], 'ESTADO.FIRMA');
  assert.equal(body['notify_url'], 'https://app.test/api/webhooks/unipile');
  assert.equal(body['api_url'], 'https://api1.unipile.test:13111');
  assert.equal(body['expiresOn'], '2026-09-24T00:00:00.000Z');
});

test('sendMessage: abre un chat nuevo o escribe en uno que ya existe', async () => {
  const { api, log } = await client([['chats.start', 'ok'], ['chats.messages.send', 'ok']]);
  assert.deepEqual(await api.sendMessage({ accountId: 'acc_li_0001', attendeeProviderId: 'ACoAAMarta_demo', text: 'Hola' }), { chatId: 'chat_0001', messageId: 'msg_0001' });
  assert.deepEqual(await api.sendMessage({ accountId: 'acc_li_0001', chatId: 'chat_0001', text: 'Sigo' }), { chatId: 'chat_0001', messageId: 'msg_0002' });
  assert.deepEqual(log.entries.map((e) => e.endpoint), ['unipile.chats.start', 'unipile.chats.messages.send']);
});

test('una cuenta desconectada da not_connected, sin reintentar, y la llave no aparece en el error', async () => {
  const { api, log, slept } = await client([['chats.messages.send', 'disconnected']]);
  const err = await failure(api.sendMessage({ accountId: 'acc_li_0001', chatId: 'chat_0001', text: 'x' }));
  assert.equal(err.kind, 'not_connected');
  assert.equal(err.code, 'errors/disconnected_account');
  assert.equal(err.httpStatus, 401);
  assert.equal(slept.length, 0);
  assert.ok(!JSON.stringify(log.entries).includes(KEY));
  assert.ok(!err.message.includes(KEY));
});

test('sendInvitation: la nota viaja como message; ya invitado → already_connected; cupo → limit', async () => {
  const ok = await client([['users.invite', 'ok']]);
  assert.deepEqual(await ok.api.sendInvitation({ accountId: 'acc_li_0001', providerId: 'ACoAAMarta_demo', note: 'Hola Marta' }), { invitationId: 'inv_0001' });
  assert.equal((ok.fetch.calls[0]!.body as Record<string, unknown>)['message'], 'Hola Marta');

  const dup = await client([['users.invite', 'already_invited']]);
  assert.equal((await failure(dup.api.sendInvitation({ accountId: 'acc_li_0001', providerId: 'x' }))).kind, 'already_connected');

  const lim = await client([['users.invite', 'limit']]);
  const err = await failure(lim.api.sendInvitation({ accountId: 'acc_li_0001', providerId: 'x' }));
  assert.equal(err.kind, 'limit');
  assert.equal(lim.log.entries[0]!.rate_limited, true);
});

test('sendInvitation con una nota de más de 300 caracteres no llama a Unipile', async () => {
  const { api, fetch } = await client([]);
  const err = await failure(api.sendInvitation({ accountId: 'acc_li_0001', providerId: 'x', note: 'á'.repeat(LINKEDIN_INVITE_NOTE_MAX + 1) }));
  assert.equal(err.code, 'note_too_long');
  assert.equal(fetch.calls.length, 0);
});

test('getProfile, reactToPost, commentOnPost, listChats y listMessages', async () => {
  const { api } = await client([
    ['users.get', 'ok'], ['posts.reaction', 'ok'], ['posts.comment', 'ok'], ['chats.list', 'ok'], ['chats.messages.list', 'ok'],
  ]);
  assert.deepEqual(await api.getProfile({ accountId: 'acc_li_0001', identifier: 'marta-rios-alma' }), {
    providerId: 'ACoAAMarta_demo', publicIdentifier: 'marta-rios-alma', name: 'Marta Ríos', headline: 'Jefa de marketing en Café Alma',
  });
  await api.reactToPost({ accountId: 'acc_li_0001', postId: 'urn:li:activity:7001' });
  await api.commentOnPost({ accountId: 'acc_li_0001', postId: 'urn:li:activity:7001', text: '¡Qué buena idea!' });
  const chats = await api.listChats({ accountId: 'acc_li_0001' });
  assert.equal(chats.cursor, 'cur_2');
  assert.equal(chats.items[0]!.attendeeProviderId, 'ACoAAMarta_demo');
  const msgs = await api.listMessages({ chatId: 'chat_0001' });
  assert.deepEqual(msgs.items.map((m) => m.isSender), [true, false]);
  assert.deepEqual(msgs.items.map((m) => m.hasAttachments), [false, false]);
});

test('listMessages lee los adjuntos: una respuesta que solo trae una foto', async () => {
  const { api } = await client([['chats.messages.list', 'solo_adjunto']]);
  const msgs = await api.listMessages({ chatId: 'chat_0001' });
  assert.deepEqual(msgs.items.map((m) => [m.id, m.text, m.hasAttachments]), [
    ['msg_0001', 'Hola Marta, vi la campaña de otoño de Café Alma.', false],
    ['msg_0004', '', true],
  ]);
});

test('classifyUnipileError: nuestra llave mala no tumba la cuenta de la persona', () => {
  assert.equal(classifyUnipileError(401, { code: 'errors/missing_credentials', message: null }), 'permanent');
  assert.equal(classifyUnipileError(401, { code: 'errors/expired_credentials', message: null }), 'not_connected');
  assert.equal(classifyUnipileError(429, { code: 'errors/too_many_requests', message: null }), 'limit');
  assert.equal(classifyUnipileError(504, { code: 'errors/request_timeout', message: null }), 'transient');
});

test('FakeUnipile cumple la misma interfaz: cuenta caída → not_connected; failNext programa un error', async () => {
  const fake = new FakeUnipile();
  fake.addAccount({ id: 'acc_1', health: 'needs_reconnect' });
  fake.addAccount({ id: 'acc_2' });
  assert.equal((await failure(fake.sendMessage({ accountId: 'acc_1', attendeeProviderId: 'p', text: 'x' }))).kind, 'not_connected');
  const sent = await fake.sendMessage({ accountId: 'acc_2', attendeeProviderId: 'p', text: 'hola' }, { channelAccountId: CA });
  assert.ok(sent.chatId && sent.messageId);
  assert.equal(fake.calls.at(-1)!.channelAccountId, CA);
  fake.failNext('sendInvitation', 'limit', 'errors/limit_exceeded', 422);
  assert.equal((await failure(fake.sendInvitation({ accountId: 'acc_2', providerId: 'p' }))).kind, 'limit');
  assert.deepEqual(await fake.sendInvitation({ accountId: 'acc_2', providerId: 'p' }), { invitationId: 'inv_0003' });
});

test('deleteAccount y deleteWebhook: DELETE con la bitácora; un 404 cuenta como borrado', async () => {
  const { api, log, fetch } = await client([['accounts.delete', 'ok'], ['webhooks.delete', 'ok']]);
  await api.deleteAccount('acc_li_0001', { channelAccountId: CA });
  await api.deleteWebhook('wh_0001', { channelAccountId: CA });
  assert.deepEqual(fetch.calls.map((c) => c.method), ['DELETE', 'DELETE']);
  assert.deepEqual(log.entries.map((e) => [e.endpoint, e.ok, e.channel_account_id]), [
    ['unipile.accounts.delete', true, CA], ['unipile.webhooks.delete', true, CA],
  ]);
  const gone = await client([['accounts.delete', 'not_found']]);
  await gone.api.deleteAccount('acc_li_0001');
  const fake = new FakeUnipile();
  fake.addAccount({ id: 'acc_x' });
  await fake.deleteAccount('acc_x');
  assert.equal(fake.accounts.has('acc_x'), false);
  assert.deepEqual(fake.deletedAccounts, ['acc_x']);
});
