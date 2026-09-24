/**
 * VEN-10 · los adaptadores de canal contra respuestas grabadas (sin red)
 * y la decisión del despachador antes de enviar.
 *
 *   · Gmail: el MIME que sale (acentos, hilo, List-Unsubscribe), el
 *     Message-ID real que se lee después, el refresco del token, y la
 *     traducción de errores (401 → cuenta; red → transitorio).
 *   · Unipile: chat nuevo, chat existente, invitación, cuenta
 *     desconectada, destinatario inválido y lectura del chat.
 *   · decideBeforeSend: la relectura que Chief no hacía.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { InMemorySecretStore } from '@mc/connectors';
import { decideBeforeSend, type OpenThread, type SendContext } from '@mc/db/queries/outreach';
import { appUrlFrom, buildChannels } from '../src/jobs/ventas/canales/index.ts';
import { GmailChannel } from '../src/jobs/ventas/canales/gmail.ts';
import { encodeHeader } from '../src/jobs/ventas/canales/mime.ts';
import { profileIdentifier, UnipileChannel } from '../src/jobs/ventas/canales/unipile.ts';
import type { Fetch, OutgoingMessage } from '../src/jobs/ventas/canales/types.ts';
import { composeMessage } from '../src/jobs/ventas/outbound.dispatch.ts';

const GMAIL = JSON.parse(readFileSync(new URL('./fixtures/outreach/gmail.json', import.meta.url), 'utf8'));
const UNIPILE = JSON.parse(readFileSync(new URL('./fixtures/outreach/unipile.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-09-24T15:00:00Z');

interface Call { method: string; url: string; body: unknown; headers: Record<string, string> }

/** Un fetch grabado: responde por el primer prefijo «MÉTODO url» que coincida, y anota cada llamada. */
function recorded(routes: Array<[string, number, unknown]>): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body, headers: (init?.headers ?? {}) as Record<string, string> });
    const hit = routes.find(([k]) => `${method} ${url}`.startsWith(k));
    if (!hit) throw new Error(`Sin grabación para ${method} ${url}`);
    return new Response(JSON.stringify(hit[2]), { status: hit[1], headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const ACCOUNT = { id: 'acc', provider: 'gmail_oauth' as const, providerAccountId: 'laura@cocina-facil.test', secretRef: 'enc:gmail:laura', displayName: 'Laura · Cocina fácil' };

function email(over: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    touchId: '0000000b-0000-4000-8000-000000070001', workspaceId: 'ws', channel: 'email', stepType: 'email', attempt: 1,
    account: ACCOUNT, recipient: 'sofia@vitale.test', recipientName: 'Sofía Cárdenas', subject: 'Tu audiencia y la mía',
    body: 'Hola, Sofía.', reply: null, unsubscribeUrl: 'https://oncue.test/baja/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', ...over,
  };
}

function secrets(expiresAt: Date) {
  return new InMemorySecretStore({
    'enc:gmail:laura': { accessToken: 'ya29.viejo', refreshToken: '1//refresh', accessExpiresAt: expiresAt, scopes: ['gmail.send'] },
  });
}

test('Gmail envía el MIME correcto y guarda el Message-ID real', async () => {
  const { fetch, calls } = recorded([
    ['POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send', 200, GMAIL.send],
    ['GET https://gmail.googleapis.com/gmail/v1/users/me/messages/', 200, GMAIL.metadata],
  ]);
  const gmail = new GmailChannel({ secrets: secrets(new Date(NOW.getTime() + 3600_000)), fetch, now: () => NOW });
  const r = await gmail.send(email({ stepType: 'email_reply', subject: 'Re: Tu audiencia y la mía', reply: { threadRef: 'th-1', messageIdRfc: '<prev@mail.gmail.com>' } }));
  assert.deepEqual(r, { ok: true, providerMessageId: GMAIL.send.id, threadRef: GMAIL.send.threadId, messageIdRfc: '<CAF=gmail-real-0001@mail.gmail.com>' });
  assert.equal(calls[0]!.headers['authorization'], 'Bearer ya29.viejo');
  const sent = JSON.parse(String(calls[0]!.body)) as { raw: string; threadId?: string };
  assert.equal(sent.threadId, 'th-1', 'la respuesta va en el hilo de Gmail');
  const mime = Buffer.from(sent.raw, 'base64url').toString('utf8');
  assert.match(mime, /^From: =\?UTF-8\?B\?.+\?= <laura@cocina-facil\.test>\r\n/m);
  assert.match(mime, /^To: =\?UTF-8\?B\?.+\?= <sofia@vitale\.test>\r\n/m);
  assert.match(mime, /^In-Reply-To: <prev@mail\.gmail\.com>\r\n/m, 'el Message-ID real, no el threadId');
  assert.match(mime, /^List-Unsubscribe: <https:\/\/oncue\.test\/baja\/[^>]+>\r\n/m);
  assert.match(mime, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n/m);
  const body = Buffer.from(mime.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.equal(body, 'Hola, Sofía.');
  assert.equal(encodeHeader('Hola'), 'Hola');
  assert.equal(Buffer.from(encodeHeader('Canción').slice(10, -2), 'base64').toString('utf8'), 'Canción');
});

test('Gmail refresca un token vencido y lo guarda; sin llaves, espera', async () => {
  const store = secrets(new Date(NOW.getTime() - 1000));
  const { fetch, calls } = recorded([
    ['POST https://oauth2.googleapis.com/token', 200, { access_token: 'ya29.nuevo', expires_in: 3599 }],
    ['POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send', 200, GMAIL.send],
    ['GET https://gmail.googleapis.com/gmail/v1/users/me/messages/', 200, GMAIL.metadata],
  ]);
  const gmail = new GmailChannel({ secrets: store, fetch, clientId: 'cid', clientSecret: 'secret', now: () => NOW });
  assert.equal((await gmail.send(email())).ok, true);
  assert.equal(calls[1]!.headers['authorization'], 'Bearer ya29.nuevo');
  assert.equal((await store.get('enc:gmail:laura'))!.accessToken, 'ya29.nuevo');

  const sinLlaves = new GmailChannel({ secrets: secrets(new Date(NOW.getTime() - 1000)), fetch, now: () => NOW });
  const r = await sinLlaves.send(email());
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.kind, 'transient');
  assert.equal(!r.ok && r.code, 'token_expired');
});

test('Gmail traduce los errores: 401 es la cuenta, la red es transitoria, invalid_grant pide reconectar', async () => {
  const s = secrets(new Date(NOW.getTime() + 3600_000));
  const r401 = await new GmailChannel({ secrets: s, fetch: recorded([['POST https://gmail', 401, GMAIL.unauthorized]]).fetch, now: () => NOW }).send(email());
  assert.deepEqual(!r401.ok && [r401.kind, r401.code, r401.account], ['permanent', 'account_auth', 'needs_reconnect']);
  // Un corte sin código (timeout, conexión cerrada) con el POST ya hecho: pudo salir. Ambiguo.
  const red = await new GmailChannel({ secrets: s, fetch: async () => { throw new TypeError('fetch failed'); }, now: () => NOW }).send(email());
  assert.deepEqual(!red.ok && [red.kind, red.code, red.ambiguous], ['transient', 'network_ambiguous', true]);
  // Sin conexión (ECONNREFUSED): la petición nunca salió. Transitorio y sin ambigüedad.
  const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  const antes = await new GmailChannel({ secrets: s, fetch: async () => { throw refused; }, now: () => NOW }).send(email());
  assert.deepEqual(!antes.ok && [antes.kind, antes.code, antes.ambiguous], ['transient', 'network', false]);
  const r503 = await new GmailChannel({ secrets: s, fetch: recorded([['POST https://gmail', 503, {}]]).fetch, now: () => NOW }).send(email());
  assert.deepEqual(!r503.ok && r503.kind, 'transient');
  const grant = await new GmailChannel({
    secrets: secrets(new Date(NOW.getTime() - 1000)), clientId: 'c', clientSecret: 's', now: () => NOW,
    fetch: recorded([['POST https://oauth2', 400, { error: 'invalid_grant' }]]).fetch,
  }).send(email());
  assert.deepEqual(!grant.ok && [grant.code, grant.account], ['account_auth', 'needs_reconnect']);
  const sinSecreto = await new GmailChannel({ secrets: new InMemorySecretStore(), now: () => NOW }).send(email());
  assert.deepEqual(!sinSecreto.ok && [sinSecreto.kind, sinSecreto.code, sinSecreto.account], ['transient', 'secret_missing', undefined], 'un fallo nuestro no toca la cuenta');
});

const THREAD: OpenThread = {
  workspaceId: 'ws', enrollmentId: null, contactId: null, dealId: null, channel: 'email', threadRef: '18f2a9c4d1e0b001',
  touchId: 't', lastSentAt: NOW, firstSentAt: NOW, recipient: 'sofia@vitale.test',
  account: { id: 'acc', provider: 'gmail_oauth', providerAccountId: 'laura@cocina-facil.test', secretRef: 'enc:gmail:laura', status: 'connected' },
  knownMessageIds: ['18f2a9c4d1e0b001'],
};

test('Gmail lee solo lo de la marca: ni lo enviado, ni lo conocido, ni los rebotes', async () => {
  const gmail = new GmailChannel({ secrets: secrets(new Date(NOW.getTime() + 3600_000)), fetch: recorded([['GET https://gmail.googleapis.com/gmail/v1/users/me/threads/', 200, GMAIL.thread]]).fetch, now: () => NOW });
  const msgs = await gmail.readThread(THREAD);
  assert.equal(msgs.length, 1);
  assert.deepEqual(
    { ...msgs[0], occurredAt: msgs[0]!.occurredAt.toISOString() },
    {
      providerMessageId: '18f2a9c4d1e0b002', messageIdRfc: '<sofia-0002@vitale.test>', inReplyTo: '<CAF=gmail-real-0001@mail.gmail.com>',
      fromAddress: 'sofia@vitale.test', subject: 'Re: Hola, Sofía', body: 'Hola, Laura. Sí, me interesa. ¿Hablamos el jueves?',
      occurredAt: new Date(1790186400000).toISOString(),
    },
  );
});

const UNI = { dsn: 'api9.unipile.test:13111', accessToken: 'unipile-token' };
function linkedin(over: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return email({
    channel: 'linkedin', stepType: 'linkedin_message', subject: null, unsubscribeUrl: null,
    account: { id: 'acc2', provider: 'unipile', providerAccountId: 'unipile-acc-1', secretRef: null, displayName: null },
    recipient: 'https://www.linkedin.com/in/sofia-cardenas-vitale/', ...over,
  });
}

test('Unipile: sin llaves no está configurado; con ellas abre un chat nuevo por el provider_id', async () => {
  assert.equal(new UnipileChannel('linkedin', { dsn: undefined, accessToken: undefined }).configured(), false);
  const { fetch, calls } = recorded([
    ['GET https://api9.unipile.test:13111/api/v1/users/sofia-cardenas-vitale?account_id=unipile-acc-1', 200, UNIPILE.user],
    ['POST https://api9.unipile.test:13111/api/v1/chats', 200, UNIPILE.chatStarted],
  ]);
  const r = await new UnipileChannel('linkedin', { ...UNI, fetch }).send(linkedin());
  assert.deepEqual(r, { ok: true, providerMessageId: 'msg-demo-0001', threadRef: 'chat-demo-0001', messageIdRfc: null });
  assert.equal(calls[0]!.headers['X-API-KEY'], 'unipile-token');
  const form = calls[1]!.body as FormData;
  assert.deepEqual([form.get('account_id'), form.get('attendees_ids'), form.get('text')], ['unipile-acc-1', 'ACoAAAdemoSofiaCardenas', 'Hola, Sofía.']);
});

test('Unipile: el segundo mensaje va al chat que ya existe, y la invitación lleva la nota de 300', async () => {
  const chat = recorded([['POST https://api9.unipile.test:13111/api/v1/chats/chat-demo-0001/messages', 200, UNIPILE.messageSent]]);
  const r = await new UnipileChannel('linkedin', { ...UNI, fetch: chat.fetch }).send(linkedin({ reply: { threadRef: 'chat-demo-0001', messageIdRfc: null } }));
  assert.deepEqual(r, { ok: true, providerMessageId: 'msg-demo-0002', threadRef: 'chat-demo-0001', messageIdRfc: null });
  const inv = recorded([
    ['GET https://api9.unipile.test:13111/api/v1/users/', 200, UNIPILE.user],
    ['POST https://api9.unipile.test:13111/api/v1/users/invite', 200, UNIPILE.invite],
  ]);
  const ri = await new UnipileChannel('linkedin', { ...UNI, fetch: inv.fetch }).send(linkedin({ stepType: 'linkedin_connect', body: 'x'.repeat(400) }));
  assert.equal(ri.ok && ri.providerMessageId, '7390000000000000001');
  assert.equal((JSON.parse(String(inv.calls[1]!.body)) as { message: string }).message.length, 300);
});

test('Unipile traduce los errores: cuenta desconectada y destinatario inválido son permanentes', async () => {
  const off = await new UnipileChannel('linkedin', { ...UNI, fetch: recorded([['GET https://api9', 401, UNIPILE.disconnected]]).fetch }).send(linkedin());
  assert.deepEqual(!off.ok && [off.kind, off.code, off.account], ['permanent', 'account_auth', 'needs_reconnect']);
  const bad = await new UnipileChannel('linkedin', {
    ...UNI, fetch: recorded([['GET https://api9', 200, UNIPILE.user], ['POST https://api9', 422, UNIPILE.invalidRecipient]]).fetch,
  }).send(linkedin());
  assert.deepEqual(!bad.ok && [bad.kind, bad.code], ['permanent', 'invalid_recipient']);
  const noUrl = await new UnipileChannel('linkedin', { ...UNI, fetch: recorded([]).fetch }).send(linkedin({ recipient: 'no es un perfil' }));
  assert.deepEqual(!noUrl.ok && noUrl.code, 'invalid_recipient');
  assert.equal(profileIdentifier('instagram_dm', '@olla.facil'), 'olla.facil');
  assert.equal(profileIdentifier('instagram_dm', 'https://instagram.com/olla.facil/'), 'olla.facil');
});

test('Unipile lee del chat solo lo que escribió la otra parte y no conocemos', async () => {
  const reader = new UnipileChannel('linkedin', { ...UNI, fetch: recorded([['GET https://api9.unipile.test:13111/api/v1/chats/chat-demo-0001/messages', 200, UNIPILE.messages]]).fetch });
  const msgs = await reader.readThread({ ...THREAD, channel: 'linkedin', threadRef: 'chat-demo-0001', knownMessageIds: ['msg-demo-0001', 'msg-demo-0002'] });
  assert.deepEqual(msgs.map((m) => [m.providerMessageId, m.body]), [['msg-demo-0003', 'Gracias, Laura. Pásame tu media kit.']]);
});

test('Gmail: un 2xx ilegible es un envío (lo busca por su Message-ID), y findSent dice si un intento salió', async () => {
  const s = secrets(new Date(NOW.getTime() + 3600_000));
  const ilegible: Fetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'POST') return new Response('<html>ok</html>', { status: 200 });
    if (url.includes('/messages?q=')) return new Response(JSON.stringify({ messages: [{ id: '18f2a9c4d1e0b777', threadId: '18f2a9c4d1e0b001' }] }), { status: 200 });
    throw new Error(`Sin grabación para ${method} ${url}`);
  };
  const r = await new GmailChannel({ secrets: s, fetch: ilegible, now: () => NOW }).send(email());
  assert.equal(r.ok, true, 'nunca un fallo que se reintenta');
  assert.equal(r.ok && r.providerMessageId, '18f2a9c4d1e0b777');
  assert.match(r.ok ? r.warning ?? '' : '', /sin cuerpo legible/);

  const busca = recorded([['GET https://gmail.googleapis.com/gmail/v1/users/me/messages?q=', 200, { resultSizeEstimate: 0 }]]);
  const no = await new GmailChannel({ secrets: s, fetch: busca.fetch, now: () => NOW }).findSent(email({ attempt: 2 }));
  assert.deepEqual(no, { found: false });
  assert.match(decodeURIComponent(busca.calls[0]!.url), /rfc822msgid:0000000b-0000-4000-8000-000000070001\.2@mail\.oncue\.app/);
  const caido = await new GmailChannel({ secrets: s, fetch: recorded([['GET https://gmail', 500, {}]]).fetch, now: () => NOW }).findSent(email());
  assert.equal(caido.found, 'unknown');
});

test('Unipile: un 2xx ilegible es un envío sin id; findSent lee el chat o, si no puede, no lo sabe', async () => {
  const roto: Fetch = async () => new Response('not json', { status: 201 });
  const r = await new UnipileChannel('linkedin', { ...UNI, fetch: roto }).send(linkedin({ reply: { threadRef: 'chat-demo-0001', messageIdRfc: null } }));
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.providerMessageId, 'unipile:0000000b-0000-4000-8000-000000070001.1');
  assert.ok(r.ok && r.warning);
  const chat = recorded([['GET https://api9.unipile.test:13111/api/v1/chats/chat-demo-0001/messages', 200, {
    items: [{ id: 'msg-x', text: 'Hola, Sofía. Te escribo por LinkedIn.', is_sender: 1 }],
  }]]);
  const uni = new UnipileChannel('linkedin', { ...UNI, fetch: chat.fetch });
  const si = await uni.findSent(linkedin({ body: 'Hola, Sofía. Te escribo por LinkedIn.', reply: { threadRef: 'chat-demo-0001', messageIdRfc: null } }));
  assert.deepEqual(si, { found: true, proof: { providerMessageId: 'msg-x', threadRef: 'chat-demo-0001', messageIdRfc: null } });
  const otro = await uni.findSent(linkedin({ body: 'Otro texto', reply: { threadRef: 'chat-demo-0001', messageIdRfc: null } }));
  assert.deepEqual(otro, { found: false });
  assert.equal((await uni.findSent(linkedin())).found, 'unknown', 'un chat nuevo no se puede comprobar');
});

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

// ---------------------------------------------------------------------
// La decisión antes de enviar
// ---------------------------------------------------------------------

const CLAIMED_AT = new Date('2026-09-24T14:58:00Z');
function ctx(over: Partial<SendContext> = {}): SendContext {
  return {
    touchId: 't', workspaceId: 'ws', status: 'processing', claimedAt: CLAIMED_AT, channel: 'email', stepType: 'email', attempt: 1,
    stepDayOffset: 0, stepOrderInDay: 0, unconfirmedAttempt: null,
    subject: 'Hola', body: 'Hola, Sofía.', recipient: 'sofia@vitale.test', enrollmentId: 'e', contactId: 'c', dealId: null,
    contactName: 'Sofía', companyName: 'Vitalé', enrollmentStatus: 'active', resumeAt: null, sequenceStatus: 'active',
    optedOut: false, enabled: true, postalAddress: 'Calle 93', requireOptoutLink: true, workspaceName: 'Laura', locale: 'es-CO',
    timeZone: 'America/Bogota', window: { start: '09:00', end: '17:00' },
    account: { id: 'a', status: 'connected', provider: 'gmail_oauth', providerAccountId: 'laura@x.test', secretRef: null, displayName: null },
    previous: null, ...over,
  };
}

test('decideBeforeSend relee todo en la transacción del envío', () => {
  assert.deepEqual(decideBeforeSend(ctx(), CLAIMED_AT, NOW), { kind: 'send' });
  assert.deepEqual(decideBeforeSend(ctx({ claimedAt: NOW }), CLAIMED_AT, NOW), { kind: 'gone' }, 'otro reclamo');
  assert.deepEqual(decideBeforeSend(ctx({ optedOut: true }), CLAIMED_AT, NOW), { kind: 'cancel', reason: 'opted_out' });
  assert.deepEqual(decideBeforeSend(ctx({ enabled: false }), CLAIMED_AT, NOW), { kind: 'cancel', reason: 'outreach_disabled' });
  assert.deepEqual(decideBeforeSend(ctx({ enrollmentStatus: 'replied' }), CLAIMED_AT, NOW), { kind: 'cancel', reason: 'replied' });
  const paused = decideBeforeSend(ctx({ enrollmentStatus: 'paused' }), CLAIMED_AT, NOW);
  assert.equal(paused.kind, 'postpone');
  // La cuenta cayó entre el reclamo y el envío: el mensaje espera, no falla.
  const caida = decideBeforeSend(ctx({ account: { ...ctx().account!, status: 'needs_reconnect' } }), CLAIMED_AT, NOW);
  assert.deepEqual(caida.kind === 'postpone' && caida.reason, 'account_unavailable');
  assert.ok(caida.kind === 'postpone' && caida.until.getTime() > NOW.getTime());
  assert.deepEqual(decideBeforeSend(ctx({ enrollmentStatus: 'bounced' }), CLAIMED_AT, NOW), { kind: 'cancel', reason: 'bounced' });
  assert.deepEqual(decideBeforeSend(ctx({ enrollmentStatus: 'completed' }), CLAIMED_AT, NOW), { kind: 'cancel', reason: 'completed' });
  // «Como te comenté ayer…» sobre un correo que no salió: retenido, no huérfano.
  const huerfano = decideBeforeSend(ctx({ stepType: 'email_reply', subject: null, previous: null }), CLAIMED_AT, NOW);
  assert.equal(huerfano.kind, 'hold');
  assert.match(huerfano.kind === 'hold' ? huerfano.reason : '', /no salió/);
  assert.equal(decideBeforeSend(ctx({ body: 'Hola, {{first_name}}' }), CLAIMED_AT, NOW).kind, 'hold');
  assert.equal(decideBeforeSend(ctx({ postalAddress: null }), CLAIMED_AT, NOW).kind, 'hold');
});

test('composeMessage pone el pie de baja al correo y el hilo a la respuesta', () => {
  const claimed = { id: 't', workspaceId: 'ws', channel: 'email' as const, stepType: 'email_reply' as const, attempt: 1, accountId: 'a', recipient: 'sofia@vitale.test', optoutToken: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', claimedAt: CLAIMED_AT };
  const m = composeMessage(
    ctx({ stepType: 'email_reply', subject: null, previous: { subject: 'Hola', threadRef: 'th', messageIdRfc: '<m@x>', providerMessageId: 'p' } }),
    claimed, 'https://oncue.test',
  );
  assert.equal(m.subject, 'Re: Hola');
  assert.deepEqual(m.reply, { threadRef: 'th', messageIdRfc: '<m@x>' });
  assert.equal(m.unsubscribeUrl, 'https://oncue.test/baja/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG');
  assert.ok(m.body.startsWith('Hola, Sofía.\n\n—\nCalle 93\n'));
  assert.ok(m.body.endsWith(m.unsubscribeUrl!));
});
