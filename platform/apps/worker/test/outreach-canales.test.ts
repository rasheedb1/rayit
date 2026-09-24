/**
 * VEN-10 · los adaptadores de canal sobre los clientes de VEN-9 (sin red)
 * y la decisión del despachador antes de enviar.
 *
 *   · Gmail (GmailChannel sobre GmailApi): el MIME que sale con el pie de
 *     VEN-15 y la cabecera de UN CLIC, el hilo, la renovación del token,
 *     «canal no configurado» sin las llaves de Google, los errores, el
 *     corte después del POST, y la lectura (sin lo nuestro, sin rebotes,
 *     sin fecha inventada, con las automáticas marcadas).
 *   · Unipile (UnipileChannel sobre UnipileApi): chat nuevo, chat
 *     existente, invitación, cuenta desconectada, destinatario inválido y
 *     lectura del chat.
 *   · decideBeforeSend: la relectura que Chief no hacía.
 *
 * Los dobles son los de VEN-9 (FakeGmail, FakeUnipile), que cumplen las
 * mismas interfaces que los clientes reales; donde importa el HTTP (el
 * token renovado, el 2xx sin id, el corte), el GmailClient real corre
 * contra un fetch grabado.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeGmail, FakeUnipile, GmailClient, InMemorySecretStore, normalizeGmailMessage, NULL_OUTREACH_CALL_LOG,
  type FetchLike, type GmailMessage,
} from '@mc/connectors';
import { decideBeforeSend, type OpenThread, type SendContext } from '@mc/db/queries/outreach';
import { appUrlFrom, buildChannels } from '../src/jobs/ventas/canales/index.ts';
import { GmailChannel } from '../src/jobs/ventas/canales/gmail.ts';
import { inviteNote, profileIdentifier, UnipileChannel } from '../src/jobs/ventas/canales/unipile.ts';
import type { OutgoingMessage } from '../src/jobs/ventas/canales/types.ts';
import { claimBudget, composeMessage, ESTIMATED_SEND_MS } from '../src/jobs/ventas/outbound.dispatch.ts';

const NOW = new Date('2026-09-24T15:00:00Z');
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Un fetch grabado: responde por el primer prefijo «MÉTODO url» que coincida, y anota cada llamada. */
function recorded(routes: Array<[string, number, unknown] | [string, 'corte']>): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    const key = `${init?.method ?? 'GET'} ${String(url)}`;
    calls.push(key);
    const hit = routes.find(([k]) => key.startsWith(k));
    if (!hit) throw new Error(`Sin grabación para ${key}`);
    if (hit[1] === 'corte') throw new TypeError('fetch failed: la conexión se cortó después de enviar');
    return new Response(JSON.stringify(hit[2]), { status: hit[1], headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const ACCOUNT = { id: 'acc', provider: 'gmail_oauth' as const, providerAccountId: 'laura@cocina-facil.test', secretRef: 'enc:gmail:laura', displayName: 'Laura · Cocina fácil' };

function email(over: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    touchId: '0000000b-0000-4000-8000-000000070001', workspaceId: 'ws', channel: 'email', stepType: 'email', attempt: 1,
    account: ACCOUNT, recipient: 'sofia@vitale.test', recipientName: 'Sofía Cárdenas', subject: 'Tu audiencia y la mía',
    body: 'Hola, Sofía.\n\n--\nSi no quieres…', content: 'Hola, Sofía.', reply: null,
    unsubscribeUrl: `https://oncue.test/baja/${TOKEN}/un-clic`, ...over,
  };
}

function secrets(expiresAt: Date) {
  return new InMemorySecretStore({
    'enc:gmail:laura': { accessToken: 'ya29.viejo', refreshToken: '1//refresh', accessExpiresAt: expiresAt, scopes: ['gmail.send'] },
  });
}

/** Un GmailChannel sobre FakeGmail (buzón y OAuth en memoria). */
function gmailOnFake(fake = new FakeGmail({ now: () => NOW }), store = secrets(new Date(NOW.getTime() + 3600_000))) {
  const channel = new GmailChannel({ secrets: store, oauth: fake, mailbox: () => fake, now: () => NOW });
  return { channel, fake, store };
}

/** Un GmailChannel sobre el GmailClient real y un fetch grabado; FakeGmail hace de OAuth. */
function gmailOnHttp(fetch: FetchLike, store = secrets(new Date(NOW.getTime() + 3600_000)), oauth = new FakeGmail({ now: () => NOW })) {
  const channel = new GmailChannel({
    secrets: store, oauth, now: () => NOW,
    mailbox: ({ tokens, oauth: o, account, onTokens }) =>
      new GmailClient({ tokens, oauth: o, channelAccountId: account.id, onTokens, callLog: NULL_OUTREACH_CALL_LOG, fetch, now: () => NOW, retry: { maxRetries: 0 } }),
  });
  return { channel, oauth, store };
}

const CLAIMED_AT = new Date('2026-09-24T14:58:00Z');
function ctx(over: Partial<SendContext> = {}): SendContext {
  return {
    touchId: 't', workspaceId: 'ws', status: 'processing', claimedAt: CLAIMED_AT, scheduledFor: CLAIMED_AT, capsReservedOn: null, channel: 'email', stepType: 'email',
    attempt: 1, stepDayOffset: 0, stepOrderInDay: 0, unconfirmedAttempt: null,
    subject: 'Hola', body: 'Hola, Sofía.', recipient: 'sofia@vitale.test', enrollmentId: 'e', contactId: 'c', dealId: null,
    contactName: 'Sofía', companyName: 'Vitalé', enrollmentStatus: 'active', resumeAt: null, sequenceStatus: 'active',
    optedOut: false, enabled: true, postalAddress: 'Calle 93 # 11-26, Bogotá', requireOptoutLink: true, workspaceName: 'Laura', locale: 'es-CO',
    timeZone: 'America/Bogota', window: { start: '09:00', end: '17:00' },
    account: { id: 'acc', status: 'connected', provider: 'gmail_oauth', providerAccountId: 'laura@cocina-facil.test', secretRef: 'enc:gmail:laura', displayName: null },
    previous: null, ...over,
  };
}
const CLAIMED = {
  id: 't', workspaceId: 'ws', channel: 'email' as const, stepType: 'email' as const, attempt: 1, accountId: 'acc',
  recipient: 'sofia@vitale.test', optoutToken: TOKEN, claimedAt: CLAIMED_AT, capsReservedOn: null,
};

// ---------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------

test('Gmail: el correo lleva el pie con la página de baja y la cabecera de UN CLIC (…/un-clic, RFC 8058)', async () => {
  const { channel, fake } = gmailOnFake();
  const m = composeMessage(ctx(), CLAIMED, 'https://oncue.test');
  assert.equal(m.unsubscribeUrl, `https://oncue.test/baja/${TOKEN}/un-clic`);
  const r = await channel.send(m);
  assert.equal(r.ok, true);
  const sent = fake.sent[0]!;
  assert.match(sent.mime, new RegExp(`^List-Unsubscribe: <https://oncue\\.test/baja/${TOKEN}/un-clic>\\r$`, 'm'));
  assert.match(sent.mime, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click\r$/m);
  // El pie es el de VEN-15: la PÁGINA de baja (un GET no da de baja a nadie) y la dirección postal.
  assert.ok(sent.message.text.startsWith('Hola, Sofía.\n\n--\n'));
  assert.ok(sent.message.text.includes(`https://oncue.test/baja/${TOKEN}`));
  assert.ok(!sent.message.text.includes('/un-clic'));
  assert.ok(sent.message.text.endsWith('Calle 93 # 11-26, Bogotá'));
  // En inglés si el workspace es inglés.
  const en = composeMessage(ctx({ locale: 'en-US' }), CLAIMED, 'https://oncue.test');
  assert.match(en.body, /unsubscribe here/);
  // En desarrollo (http) no hay cabecera, pero el pie sigue.
  const dev = composeMessage(ctx(), CLAIMED, 'http://localhost:3100');
  assert.equal(dev.unsubscribeUrl, null);
  assert.ok(dev.body.includes(`http://localhost:3100/baja/${TOKEN}`));
});

test('Gmail: la respuesta en el hilo va al threadId con el Message-ID real en In-Reply-To', async () => {
  const { channel, fake } = gmailOnFake();
  const m = composeMessage(
    ctx({ stepType: 'email_reply', subject: null, previous: { subject: 'Hola', threadRef: 'th-1', messageIdRfc: '<m1@mail.gmail.com>', providerMessageId: 'p' } }),
    { ...CLAIMED, stepType: 'email_reply' }, 'https://oncue.test',
  );
  assert.equal(m.subject, 'Re: Hola');
  const r = await channel.send(m);
  assert.ok(r.ok && r.threadRef === 'th-1');
  assert.equal(fake.sent[0]!.message.threadId, 'th-1');
  assert.match(fake.sent[0]!.mime, /^In-Reply-To: <m1@mail\.gmail\.com>\r$/m);
});

test('Gmail sin GOOGLE_CLIENT_ID/SECRET: «canal no configurado», y sin gastar la cuenta', async () => {
  const real = buildChannels({ env: { APP_URL: 'https://oncue.test' }, secrets: new InMemorySecretStore() });
  assert.equal(real.senders.email!.configured(), false);
  assert.equal(real.readers.email!.configured(), false);
  const conLlaves = buildChannels({ env: { APP_URL: 'https://oncue.test', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' }, secrets: new InMemorySecretStore() });
  assert.equal(conLlaves.senders.email!.configured(), true);
  // Si igual le llega un correo, espera como cuenta no disponible, sin tocar la cuenta.
  const r = await new GmailChannel({ secrets: secrets(NOW), oauth: null }).send(email());
  assert.ok(!r.ok && r.account === 'unavailable' && r.code === 'token_expired');
  // Sin el token en el almacén: lo mismo (es nuestro, no de la persona).
  const sinToken = await new GmailChannel({ secrets: new InMemorySecretStore(), oauth: new FakeGmail() }).send(email());
  assert.ok(!sinToken.ok && sinToken.account === 'unavailable' && sinToken.code === 'secret_missing');
});

test('Gmail renueva el token vencido por el cliente de VEN-9 y lo guarda con la misma ref; invalid_grant pide reconectar', async () => {
  const { fetch, calls } = recorded([
    [`POST ${GMAIL_API}/messages/send`, 200, { id: 'm-1', threadId: 'th-1' }],
    [`GET ${GMAIL_API}/messages/m-1`, 200, { payload: { headers: [{ name: 'Message-ID', value: '<real@mail.gmail.com>' }] } }],
  ]);
  const store = secrets(new Date(NOW.getTime() - 60_000));
  const { channel, oauth } = gmailOnHttp(fetch, store);
  const r = await channel.send(email());
  assert.deepEqual(r, { ok: true, providerMessageId: 'm-1', threadRef: 'th-1', messageIdRfc: '<real@mail.gmail.com>', warning: null });
  assert.equal(oauth.refreshCalls, 1);
  const saved = await store.get('enc:gmail:laura');
  assert.notEqual(saved!.accessToken, 'ya29.viejo', 'el token nuevo quedó con la misma ref');
  assert.equal(saved!.refreshToken, '1//refresh');
  assert.equal(calls.length, 2);

  const revocado = new FakeGmail({ now: () => NOW });
  revocado.revoked.add('1//refresh');
  const caida = await gmailOnHttp(fetch, secrets(new Date(NOW.getTime() - 60_000)), revocado).channel.send(email());
  assert.ok(!caida.ok && caida.account === 'needs_reconnect' && caida.code === 'account_auth');
});

test('Gmail: un corte después del POST es ambiguo, un 429 es transitorio, un 2xx sin id es un envío', async () => {
  const corte = await gmailOnHttp(recorded([[`POST ${GMAIL_API}/messages/send`, 'corte']]).fetch).channel.send(email());
  assert.ok(!corte.ok && corte.kind === 'transient' && corte.ambiguous === true, 'pudo haber salido');
  const limite = await gmailOnHttp(recorded([[`POST ${GMAIL_API}/messages/send`, 429, { error: { code: 429, errors: [{ reason: 'rateLimitExceeded' }] } }]]).fetch)
    .channel.send(email());
  assert.ok(!limite.ok && limite.kind === 'transient' && limite.code === 'rate_limited' && !limite.ambiguous);
  const auth = await gmailOnHttp(recorded([[`POST ${GMAIL_API}/messages/send`, 401, { error: { code: 401, status: 'UNAUTHENTICATED' } }]]).fetch)
    .channel.send(email());
  assert.ok(!auth.ok && auth.account === 'needs_reconnect');
  const sinId = await gmailOnHttp(recorded([
    [`POST ${GMAIL_API}/messages/send`, 200, {}],
    [`GET ${GMAIL_API}/messages?`, 200, {}],
  ]).fetch).channel.send(email());
  assert.ok(sinId.ok && sinId.providerMessageId.startsWith('gmail-sin-id:') && /2xx sin id/.test(sinId.warning ?? ''));
});

test('Gmail findSent: busca en Enviados por destinatario, asunto y texto (Gmail cambia el Message-ID)', async () => {
  const { channel, fake } = gmailOnFake();
  assert.deepEqual(await channel.findSent(email()), { found: false });
  await channel.send(email({ body: 'Hola, Sofía.\n\n--\nenlace del intento 1' }));
  const hit = await channel.findSent(email({ attempt: 2, body: 'Hola, Sofía.\n\n--\nenlace del intento 2' }));
  assert.ok(hit.found === true && hit.proof.providerMessageId === fake.sent[0]!.result.providerMessageId);
  assert.deepEqual(await channel.findSent(email({ content: 'Otro texto' })), { found: false });
  assert.deepEqual(await channel.findSent(email({ subject: 'Otro asunto' })), { found: false });
  fake.failNext('transient', 'network');
  assert.equal((await channel.findSent(email())).found, 'unknown');
});

function thread(over: Partial<OpenThread> = {}): OpenThread {
  return {
    workspaceId: 'ws', enrollmentId: null, contactId: null, dealId: null, channel: 'email', threadRef: 'th-1', touchId: 't',
    lastSentAt: NOW, firstSentAt: NOW, recipient: 'sofia@vitale.test',
    account: { id: 'acc', provider: 'gmail_oauth', providerAccountId: 'laura@cocina-facil.test', secretRef: 'enc:gmail:laura', status: 'connected' },
    knownMessageIds: ['conocido'], checkedAt: null, ...over,
  };
}

function inboxMessage(over: Partial<GmailMessage>): GmailMessage {
  return {
    id: 'x', threadId: 'th-1', messageIdRfc: null, inReplyTo: null, references: [], from: 'Sofía <sofia@vitale.test>', to: null,
    subject: 'Re: Hola', sentAt: NOW, snippet: '', text: 'Nos interesa.', labelIds: ['INBOX'], failedRecipient: null, ...over,
  };
}

test('Gmail lee solo lo de la marca: ni lo enviado, ni lo conocido, ni rebotes, ni lo que no trae fecha; marca las automáticas', async () => {
  const avisos: string[] = [];
  const fake = new FakeGmail({ now: () => NOW });
  fake.inbox.push(
    inboxMessage({ id: 'nuestro', labelIds: ['SENT'] }),
    inboxMessage({ id: 'conocido' }),
    inboxMessage({ id: 'rebote', from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', failedRecipient: 'sofia@vitale.test' }),
    inboxMessage({ id: 'sin-fecha', sentAt: null }),
    inboxMessage({ id: 'vacaciones', text: 'Estoy fuera hasta el lunes.', automatic: true }),
    inboxMessage({ id: 'respuesta', messageIdRfc: '<r@vitale.test>' }),
  );
  const channel = new GmailChannel({
    secrets: secrets(new Date(NOW.getTime() + 3600_000)), oauth: fake, mailbox: () => fake, now: () => NOW,
    logger: { warn: (m) => { avisos.push(m); } },
  });
  const got = await channel.readThread(thread());
  assert.deepEqual(got.map((m) => [m.providerMessageId, m.automatic]), [['vacaciones', true], ['respuesta', false]]);
  assert.equal(got[1]!.fromAddress, 'sofia@vitale.test');
  assert.equal(got[1]!.occurredAt.getTime(), NOW.getTime(), 'la fecha es la del proveedor, nunca la del reloj');
  assert.match(avisos.join(' '), /sin fecha/);
});

test('Una respuesta automática se reconoce por sus cabeceras (RFC 3834, X-Autoreply, Precedence)', () => {
  const raw = (headers: Array<{ name: string; value: string }>) => ({ id: 'a', threadId: 't', internalDate: String(NOW.getTime()), payload: { headers } });
  assert.equal(normalizeGmailMessage(raw([{ name: 'Auto-Submitted', value: 'auto-replied' }])).automatic, true);
  assert.equal(normalizeGmailMessage(raw([{ name: 'Auto-Submitted', value: 'no' }])).automatic, false);
  assert.equal(normalizeGmailMessage(raw([{ name: 'X-Autoreply', value: 'yes' }])).automatic, true);
  assert.equal(normalizeGmailMessage(raw([{ name: 'Precedence', value: 'auto_reply' }])).automatic, true);
  assert.equal(normalizeGmailMessage(raw([{ name: 'Precedence', value: 'bulk' }])).automatic, false);
  assert.equal(normalizeGmailMessage({ id: 'b', threadId: 't', payload: {} }).sentAt, null, 'sin internalDate no se inventa la fecha');
});

// ---------------------------------------------------------------------
// Unipile
// ---------------------------------------------------------------------

const LI_ACCOUNT = { id: 'acc-li', provider: 'unipile' as const, providerAccountId: 'uni-1', secretRef: null, displayName: null };
function linkedin(over: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return email({
    channel: 'linkedin', stepType: 'linkedin_message', account: LI_ACCOUNT, recipient: 'https://www.linkedin.com/in/sofia-cardenas/',
    subject: null, body: 'Hola, Sofía.', content: 'Hola, Sofía.', unsubscribeUrl: null, ...over,
  });
}
function unipile() {
  const fake = new FakeUnipile();
  fake.addAccount({ id: 'uni-1' });
  return { fake, channel: new UnipileChannel('linkedin', { api: fake }) };
}

test('Unipile: sin llaves no está configurado; con ellas abre un chat nuevo por el provider_id del perfil', async () => {
  const sinLlaves = new UnipileChannel('linkedin', { api: null });
  assert.equal(sinLlaves.configured(), false);
  const r0 = await sinLlaves.send(linkedin());
  assert.ok(!r0.ok && r0.code === 'not_configured' && r0.account === 'unavailable');
  const env = { UNIPILE_DSN: 'api1.unipile.com:13111', UNIPILE_ACCESS_TOKEN: 'k' };
  assert.equal(buildChannels({ env, secrets: new InMemorySecretStore() }).senders.linkedin!.configured(), true);

  const { fake, channel } = unipile();
  const r = await channel.send(linkedin());
  assert.ok(r.ok && r.threadRef !== null);
  assert.deepEqual(fake.calls.map((c) => c.method), ['getProfile', 'sendMessage']);
  assert.deepEqual(fake.calls[1]!.args, { accountId: 'uni-1', text: 'Hola, Sofía.', attendeeProviderId: 'prov_sofia-cardenas' });
  assert.equal(fake.calls[1]!.channelAccountId, 'acc-li', 'la bitácora sabe de qué cuenta es la llamada');
  assert.equal(profileIdentifier('instagram_dm', '@vitale.co'), 'vitale.co');
  assert.equal(profileIdentifier('linkedin', 'no es un perfil'), null);
});

test('Unipile: el segundo mensaje va al chat que ya existe; la invitación lleva su nota entera, y una de más de 300 no sale cortada; ya invitada es un paso hecho', async () => {
  const { fake, channel } = unipile();
  const first = await channel.send(linkedin());
  assert.ok(first.ok);
  const second = await channel.send(linkedin({ body: 'Te escribo otra vez.', reply: { threadRef: first.threadRef, messageIdRfc: null } }));
  assert.ok(second.ok && second.threadRef === first.threadRef);
  const larga = await channel.send(linkedin({ stepType: 'linkedin_connect', body: 'á'.repeat(400) }));
  assert.ok(!larga.ok && larga.code === 'note_too_long' && larga.kind === 'permanent', 'no se corta a 300: no sale');
  assert.equal(fake.calls.filter((c) => c.method === 'sendInvitation').length, 0, 'ni llega a Unipile');
  const inv = await channel.send(linkedin({ stepType: 'linkedin_connect', body: 'á'.repeat(300) }));
  assert.ok(inv.ok && inv.threadRef === null);
  const invite = fake.calls.find((c) => c.method === 'sendInvitation')!.args as { note: string };
  assert.equal([...invite.note].length, 300, 'la nota entera');
  assert.equal(inviteNote('  hola  '), 'hola');
  fake.failNext('sendInvitation', 'already_connected', 'errors/already_invited_recently');
  const ya = await channel.send(linkedin({ stepType: 'linkedin_connect' }));
  assert.ok(ya.ok && /LinkedIn/.test(ya.warning ?? ''));
});

test('Unipile traduce los errores de VEN-9: cuenta desconectada, destinatario inválido, límite, corte y nuestra llave', async () => {
  const { fake, channel } = unipile();
  fake.accounts.get('uni-1')!.health = 'needs_reconnect';
  const caida = await channel.send(linkedin());
  assert.ok(!caida.ok && caida.account === 'needs_reconnect');
  fake.accounts.get('uni-1')!.health = 'ok';
  fake.failNext('getProfile', 'permanent', 'errors/invalid_recipient', 422);
  const invalido = await channel.send(linkedin());
  assert.ok(!invalido.ok && invalido.kind === 'permanent' && invalido.code === 'invalid_recipient');
  fake.failNext('sendMessage', 'limit', 'errors/too_many_requests', 429);
  const limite = await channel.send(linkedin());
  assert.ok(!limite.ok && limite.kind === 'transient' && limite.code === 'rate_limited');
  fake.failNext('sendMessage', 'transient', 'timeout');
  const corte = await channel.send(linkedin());
  assert.ok(!corte.ok && corte.ambiguous === true, 'un tiempo agotado al enviar pudo haber salido');
  fake.failNext('getProfile', 'transient', 'timeout');
  const perfil = await channel.send(linkedin());
  assert.ok(!perfil.ok && !perfil.ambiguous, 'leer el perfil no envía nada');
  fake.failNext('sendMessage', 'permanent', 'errors/missing_credentials', 401);
  const llave = await channel.send(linkedin());
  assert.ok(!llave.ok && llave.account === 'unavailable', 'nuestra llave, no la cuenta de la persona');
});

test('Unipile lee del chat solo lo que escribió la otra parte, no conocemos y trae fecha; findSent lee el chat', async () => {
  const avisos: string[] = [];
  const fake = new FakeUnipile();
  fake.addAccount({ id: 'uni-1' });
  fake.messages.set('chat-1', [
    { id: 'm1', chatId: 'chat-1', senderId: 'uni-1', text: 'Hola, Sofía.', isSender: true, sentAt: NOW },
    { id: 'conocido', chatId: 'chat-1', senderId: 'p', text: 'Ya leído', isSender: false, sentAt: NOW },
    { id: 'm3', chatId: 'chat-1', senderId: 'p', text: '¡Hola! Nos interesa.', isSender: false, sentAt: NOW },
    { id: 'm4', chatId: 'chat-1', senderId: 'p', text: '', isSender: false, sentAt: NOW },
    { id: 'm5', chatId: 'chat-1', senderId: 'p', text: 'Sin fecha', isSender: false, sentAt: null },
  ]);
  const channel = new UnipileChannel('linkedin', { api: fake, logger: { warn: (m) => { avisos.push(m); } } });
  const got = await channel.readThread(thread({ channel: 'linkedin', threadRef: 'chat-1' }));
  assert.deepEqual(got.map((m) => m.providerMessageId), ['m3']);
  assert.match(avisos.join(' '), /sin fecha/);
  const enviado = await channel.findSent(linkedin({ reply: { threadRef: 'chat-1', messageIdRfc: null } }));
  assert.ok(enviado.found === true && enviado.proof.providerMessageId === 'm1');
  assert.deepEqual(await channel.findSent(linkedin({ body: 'otro', reply: { threadRef: 'chat-1', messageIdRfc: null } })), { found: false });
  assert.equal((await channel.findSent(linkedin())).found, 'unknown', 'un chat nuevo no se puede comprobar');
});

// ---------------------------------------------------------------------
// Qué adaptador, y la decisión antes de enviar
// ---------------------------------------------------------------------

test('buildChannels: el canal falso nunca en producción', () => {
  const avisos: string[] = [];
  const logger = { warn: (msg: string) => { avisos.push(msg); } };
  const prod = buildChannels({ env: { OUTREACH_CHANNELS: 'fake', NODE_ENV: 'production' }, secrets: new InMemorySecretStore(), logger });
  assert.equal(prod.mode, 'real');
  assert.match(avisos[0] ?? '', /se ignora en producción/);
  assert.equal(buildChannels({ env: {}, secrets: new InMemorySecretStore(), mode: 'fake' }).mode, 'fake');
});

test('buildChannels: falso o real según OUTREACH_CHANNELS, y la URL del enlace de baja', () => {
  const s = new InMemorySecretStore();
  const fake = buildChannels({ env: { OUTREACH_CHANNELS: 'fake' }, secrets: s });
  assert.equal(fake.mode, 'fake');
  assert.equal(fake.appUrl, 'http://localhost:3100');
  const real = buildChannels({ env: { APP_URL: 'https://on-cue-web.vercel.app/algo' }, secrets: s });
  assert.equal(real.mode, 'real');
  assert.equal(real.appUrl, 'https://on-cue-web.vercel.app');
  assert.equal(real.senders.linkedin!.configured(), false, 'sin UNIPILE_* LinkedIn espera en la cola');
  assert.equal(appUrlFrom({ VERCEL_PROJECT_PRODUCTION_URL: 'on-cue-web.vercel.app' }), 'https://on-cue-web.vercel.app');
  assert.equal(appUrlFrom({}), null);
});

test('decideBeforeSend relee todo en la transacción del envío', () => {
  assert.deepEqual(decideBeforeSend(ctx(), CLAIMED_AT, NOW), { kind: 'send' });
  assert.deepEqual(decideBeforeSend(ctx({ claimedAt: NOW }), CLAIMED_AT, NOW), { kind: 'gone' }, 'otro reclamo');
  assert.deepEqual(decideBeforeSend(ctx({ optedOut: true }), CLAIMED_AT, NOW), { kind: 'cancel', reason: 'opted_out' });
  assert.deepEqual(decideBeforeSend(ctx({ enabled: false }), CLAIMED_AT, NOW), { kind: 'cancel', reason: 'outreach_disabled' });
  assert.deepEqual(decideBeforeSend(ctx({ enrollmentStatus: 'replied' }), CLAIMED_AT, NOW), { kind: 'cancel', reason: 'replied' });
  assert.equal(decideBeforeSend(ctx({ enrollmentStatus: 'paused' }), CLAIMED_AT, NOW).kind, 'postpone');
  // La cuenta cayó entre el reclamo y el envío: el mensaje espera, no falla.
  const caida = decideBeforeSend(ctx({ account: { ...ctx().account!, status: 'needs_reconnect' } }), CLAIMED_AT, NOW);
  assert.deepEqual(caida.kind === 'postpone' && caida.reason, 'account_unavailable');
  assert.ok(caida.kind === 'postpone' && caida.until.getTime() > NOW.getTime());
  assert.deepEqual(decideBeforeSend(ctx({ enrollmentStatus: 'bounced' }), CLAIMED_AT, NOW), { kind: 'cancel', reason: 'bounced' });
  assert.deepEqual(decideBeforeSend(ctx({ enrollmentStatus: 'completed' }), CLAIMED_AT, NOW), { kind: 'cancel', reason: 'completed' });
  // «Como te comenté ayer…» sobre un correo que no salió: retenido, no huérfano.
  const huerfano = decideBeforeSend(ctx({ stepType: 'email_reply', subject: null, previous: null }), CLAIMED_AT, NOW);
  assert.equal(huerfano.kind, 'hold');
  assert.equal(huerfano.kind === 'hold' ? huerfano.reason : '', 'reply_without_thread');
  assert.equal(decideBeforeSend(ctx({ body: 'Hola, {{first_name}}' }), CLAIMED_AT, NOW).kind, 'hold');
  assert.equal(decideBeforeSend(ctx({ postalAddress: null }), CLAIMED_AT, NOW).kind, 'hold');
});

test('claimBudget: se reclama solo lo que cabe en el tiempo que le queda a la corrida', () => {
  const ahora = Date.parse('2026-09-24T15:00:00Z');
  assert.equal(claimBudget({}), 50, 'sin límite de tiempo, el lote entero');
  assert.equal(claimBudget({ limit: 10 }), 10);
  assert.equal(claimBudget({ deadline: new Date(ahora + 80_000) }, ahora), 80_000 / ESTIMATED_SEND_MS);
  assert.equal(claimBudget({ deadline: new Date(ahora + 1_000_000) }, ahora), 50, 'nunca más que el lote');
  assert.equal(claimBudget({ deadline: new Date(ahora - 1) }, ahora), 0, 'sin tiempo, nada');
});
