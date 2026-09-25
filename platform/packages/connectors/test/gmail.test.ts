import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  freshGoogleTokens, GmailClient, GMAIL_REFRESH_MARGIN_MS, GMAIL_SCOPES, GoogleOAuth, htmlToText, loadGoogleOAuthConfig, loadGoogleTokenConfig, normalizeGmailMessage, shortScope,
} from '../src/gmail.ts';
import type { OutreachApiError } from '../src/outreach/errors.ts';
import { FakeGmail } from '../src/testing/index.ts';
import { InMemoryOutreachCallLog } from '../src/outreach/log.ts';
import { FixtureFetch, loadFixtures, withoutNetwork, type NetworkGuard } from '../src/testing/fixture-fetch.ts';
import type { OAuthTokens } from '../src/types.ts';

let guard: NetworkGuard;
before(() => { guard = withoutNetwork(); });
after(() => {
  guard.restore();
  assert.equal(guard.attempts, 0, 'ninguna prueba de Gmail salió a la red');
});

const NOW = new Date('2026-09-23T12:00:00Z');
const CFG = { clientId: 'client-id.apps.googleusercontent.com', clientSecret: 'GOCSPX-SECRETO-DEL-CLIENTE', redirectUri: 'https://app.test/api/oauth/google/callback' };
const CA = '00000005-0000-4000-8000-0000000ac001';
const TOKENS: OAuthTokens = {
  accessToken: 'ya29.ACCESO-VIEJO-123456', refreshToken: '1//REFRESH-SECRETO-123456',
  accessExpiresAt: new Date(NOW.getTime() + 60 * 60_000), scopes: [...GMAIL_SCOPES],
};

async function setup(names: ReadonlyArray<[string, string?]>) {
  const log = new InMemoryOutreachCallLog();
  const fetch = new FixtureFetch(await loadFixtures('gmail', names));
  const http = { callLog: log, fetch: fetch.fetch, now: () => NOW, sleep: async () => {}, random: () => 0 };
  return { log, fetch, http, oauth: new GoogleOAuth(CFG, http) };
}

async function failure(p: Promise<unknown>): Promise<OutreachApiError> {
  return p.then(() => { throw new Error('esperaba un error'); }, (e: unknown) => e as OutreachApiError);
}

test('loadGoogleOAuthConfig: dice qué falta y deduce la redirección del origen', () => {
  assert.deepEqual(loadGoogleOAuthConfig({}, 'https://app.test'), { missing: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] });
  const ok = loadGoogleOAuthConfig({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' }, 'https://app.test/');
  assert.deepEqual(ok, { config: { clientId: 'a', clientSecret: 'b', redirectUri: 'https://app.test/api/oauth/google/callback' } });
});

test('loadGoogleTokenConfig: el worker refresca sin APP_URL ni GOOGLE_REDIRECT_URI, y no puede iniciar una conexión', async () => {
  assert.deepEqual(loadGoogleTokenConfig({}), { missing: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] });
  const cfg = loadGoogleTokenConfig({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' });
  assert.ok('config' in cfg);
  assert.equal(cfg.config.redirectUri, null);
  const log = new InMemoryOutreachCallLog();
  const fetch = new FixtureFetch(await loadFixtures('gmail', [['oauth.token.refresh', 'ok']]));
  const oauth = new GoogleOAuth(cfg.config, { callLog: log, fetch: fetch.fetch, now: () => NOW, sleep: async () => {}, random: () => 0 });
  const t = await oauth.refresh(TOKENS);
  assert.equal(t.refreshToken, TOKENS.refreshToken, 'refrescar no necesita la redirección');
  assert.throws(() => oauth.authorizationUrl('E'), /redirectUri/);
});

test('authorizationUrl: offline, consent, los tres alcances y el state', async () => {
  const { oauth } = await setup([]);
  const u = new URL(oauth.authorizationUrl('ESTADO', { loginHint: 'laura@x.test' }));
  assert.equal(u.searchParams.get('login_hint'), 'laura@x.test', 'reconectar propone el buzón caído');
  // «Conectar otra cuenta»: Google pregunta cuál, sin dejar de pedir consentimiento (refresh_token).
  assert.equal(new URL(oauth.authorizationUrl('E', { selectAccount: true })).searchParams.get('prompt'), 'select_account consent');
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.equal(u.searchParams.get('state'), 'ESTADO');
  assert.deepEqual(u.searchParams.get('scope')!.split(' ').map(shortScope), ['gmail.send', 'gmail.modify', 'userinfo.email']);
  assert.ok(!u.toString().includes(CFG.clientSecret));
});

test('exchangeCode + userEmail: tokens con refresh, alcances concedidos y el buzón en minúsculas', async () => {
  const { oauth, log, fetch } = await setup([['oauth.token.code', 'ok'], ['userinfo', 'ok']]);
  const { tokens, scopesGranted } = await oauth.exchangeCode('4/CODIGO-DE-UN-USO');
  assert.equal(tokens.refreshToken, '1//demo-refresh');
  assert.equal(tokens.accessExpiresAt.getTime(), NOW.getTime() + 3599_000);
  assert.ok(scopesGranted.includes('https://www.googleapis.com/auth/gmail.modify'));
  assert.deepEqual(await oauth.userEmail(tokens), { email: 'laura@cocina-facil.test', verified: true });
  assert.deepEqual(log.entries.map((e) => [e.provider, e.endpoint, e.ok]), [['gmail', 'google.oauth.token', true], ['gmail', 'google.userinfo', true]]);
  assert.equal((fetch.calls[0]!.body as Record<string, string>)['code'], '[REDACTADO]');
});

test('refresh: conserva el refresh token; invalid_grant → not_connected sin filtrar secretos', async () => {
  const { oauth } = await setup([['oauth.token.refresh', 'ok']]);
  const t = await oauth.refresh(TOKENS);
  assert.equal(t.accessToken, 'ya29.demo-access-2');
  assert.equal(t.refreshToken, TOKENS.refreshToken);

  const bad = await setup([['oauth.token.refresh', 'invalid_grant']]);
  const err = await failure(bad.oauth.refresh(TOKENS, { channelAccountId: CA }));
  assert.equal(err.kind, 'not_connected');
  assert.equal(err.code, 'invalid_grant');
  assert.equal(bad.log.entries[0]!.channel_account_id, CA);
  const dump = JSON.stringify(bad.log.entries) + err.message;
  for (const s of [TOKENS.refreshToken!, CFG.clientSecret]) assert.ok(!dump.includes(s));
});

test('freshGoogleTokens: con más de dos minutos no refresca; con menos, sí', async () => {
  let calls = 0;
  const refresh = async (t: OAuthTokens) => { calls += 1; return { ...t, accessToken: 'nuevo', accessExpiresAt: new Date(NOW.getTime() + 3600_000) }; };
  const lejos = { ...TOKENS, accessExpiresAt: new Date(NOW.getTime() + GMAIL_REFRESH_MARGIN_MS + 1000) };
  assert.equal((await freshGoogleTokens(lejos, NOW, refresh)).refreshed, false);
  const cerca = { ...TOKENS, accessExpiresAt: new Date(NOW.getTime() + GMAIL_REFRESH_MARGIN_MS - 1000) };
  const r = await freshGoogleTokens(cerca, NOW, refresh);
  assert.equal(r.refreshed, true);
  assert.equal(r.tokens.accessToken, 'nuevo');
  assert.equal(calls, 1);
});

test('send: MIME en raw, threadId, y el Message-ID real leído después; refresca antes si el token vence', async () => {
  const { http, oauth, fetch, log } = await setup([['oauth.token.refresh', 'ok'], ['messages.send', 'ok'], ['messages.get', 'metadata.ok']]);
  const saved: OAuthTokens[] = [];
  const gmail = new GmailClient({
    ...http, oauth, channelAccountId: CA, tokens: { ...TOKENS, accessExpiresAt: new Date(NOW.getTime() + 60_000) },
    onTokens: async (t) => { saved.push(t); }, mime: { boundary: (n) => `b${n}` },
  });
  const sent = await gmail.send({
    from: { address: 'laura@cocina-facil.test', name: 'Laura Gómez' }, to: { address: 'marta@cafealma.test' },
    subject: 'Re: Una idea para Café Alma', text: 'Sigo con la idea.', threadId: '18c1f0a0b0c0d0e1', inReplyTo: '<CAPrev@mail.gmail.com>',
    unsubscribeUrl: 'https://app.test/baja/tok',
  });
  assert.deepEqual(sent, { providerMessageId: '18c1f0a0b0c0d0e1', threadId: '18c1f0a0b0c0d0e1', messageIdRfc: '<CADemo123@mail.gmail.com>' });
  assert.equal(saved.length, 1, 'el token renovado se entrega para guardarlo con la misma ref');
  const body = fetch.calls[1]!.body as { raw: string; threadId: string };
  assert.equal(body.threadId, '18c1f0a0b0c0d0e1');
  const mime = Buffer.from(body.raw, 'base64url').toString('utf8');
  assert.match(mime, /^In-Reply-To: <CAPrev@mail\.gmail\.com>\r$/m);
  assert.match(mime, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click\r$/m);
  assert.equal(fetch.calls[1]!.headers['Authorization'], '[REDACTADO]');
  assert.deepEqual(log.entries.map((e) => e.endpoint), ['google.oauth.refresh', 'gmail.messages.send', 'gmail.messages.get']);
  assert.ok(log.entries.every((e) => e.channel_account_id === CA));
});

test('send con 429: limit, con Retry-After, y no se reintenta dentro de la llamada', async () => {
  const { http, oauth, log } = await setup([['messages.send', 'rate_limited']]);
  const gmail = new GmailClient({ ...http, oauth, channelAccountId: CA, tokens: TOKENS });
  const err = await failure(gmail.send({ from: { address: 'a@b.test' }, to: { address: 'c@d.test' }, subject: 'x', text: 'y' }));
  assert.equal(err.kind, 'limit');
  assert.equal(err.retryAfterS, 120);
  assert.equal(log.entries.length, 1);
});

test('getThread, searchReplies, searchBounces y getMessage de un rebote', async () => {
  const { http, oauth } = await setup([['threads.get', 'ok'], ['messages.list', 'bounces.ok'], ['messages.get', 'bounce']]);
  const gmail = new GmailClient({ ...http, oauth, channelAccountId: CA, tokens: TOKENS });
  const thread = await gmail.getThread('18c1f0a0b0c0d0e1');
  assert.equal(thread.length, 2);
  assert.equal(thread[1]!.inReplyTo, '<CADemo123@mail.gmail.com>');
  assert.equal(thread[1]!.text, 'Me interesa, ¿tienes media kit?');
  const bounces = await gmail.searchBounces({ since: NOW });
  assert.equal(bounces.length, 1);
  const bounce = await gmail.getMessage(bounces[0]!.id);
  assert.equal(bounce.failedRecipient, 'nadie@cafealma.test');
});

test('correo real: el charset de la parte, una respuesta solo en HTML (sin lo que cita) y el DSN de un postmaster ajeno', async () => {
  const { http, oauth } = await setup([['messages.get', 'reply_latin1'], ['messages.get', 'reply_html_only'], ['messages.get', 'bounce_dsn']]);
  const gmail = new GmailClient({ ...http, oauth, channelAccountId: CA, tokens: TOKENS });
  // iso-8859-1 de Outlook: sin caracteres rotos para el detector de bajas y el clasificador.
  const latin = await gmail.getMessage('18c1f0a0b0c0d0a1');
  assert.match(latin.text, /^¿Cómo estás, Laura\? Gracias, pero no me escribas más\./);
  assert.ok(!latin.text.includes('�'), 'ni un carácter de reemplazo');
  // Solo HTML (windows-1252): el texto sin etiquetas, sin estilos y sin la cita anidada (que traía «dame de baja»).
  const html = await gmail.getMessage('18c1f0a0b0c0d0a2');
  assert.equal(html.text, '¡Hola Laura! Nos interesa, ¿tienes media kit?\nEscríbeme el lunes.');
  assert.equal(html.snippet, '¡Hola Laura! Nos interesa, ¿tienes media kit? Escríbeme el lunes.', 'el snippet sin entidades');
  // multipart/report sin X-Failed-Recipients: Final-Recipient sale de la parte message/delivery-status.
  const dsn = await gmail.getMessage('18c1f0a0b0c0d0a3');
  assert.equal(dsn.failedRecipient, 'nadie@marca.test');
  assert.match(dsn.text, /^This is the mail system/, 'el texto es la parte legible, no el mensaje original');
});

test('htmlToText y el charset desconocido: nunca lanzan', () => {
  assert.equal(htmlToText('<p>Uno</p><p>Dos &amp; tres&nbsp;&#8364;</p><script>alert(1)</script>'), 'Uno\nDos & tres €');
  assert.equal(htmlToText('Sí<blockquote>a<blockquote>b</blockquote>c</blockquote>'), 'Sí');
  const raro = normalizeGmailMessage({
    id: 'x', threadId: 'x', payload: { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=x-inventado' }], body: { data: Buffer.from('Hola ñ').toString('base64url') } },
  });
  assert.equal(raro.text, 'Hola ñ', 'un charset que no existe se lee como UTF-8');
  const vacio = normalizeGmailMessage({ id: 'y', threadId: 'y', snippet: 'Solo el snippet &#39;corto&#39;', payload: { mimeType: 'multipart/mixed', parts: [] } });
  assert.equal(vacio.text, "Solo el snippet 'corto'", 'sin cuerpo legible, el snippet');
});

test('FakeGmail: refresca con un token nuevo y responde invalid_grant a un refresh token revocado', async () => {
  const fake = new FakeGmail({ now: () => NOW, email: 'Laura@X.test' });
  const { tokens } = await fake.exchangeCode('code');
  const renewed = await fake.refresh(tokens);
  assert.notEqual(renewed.accessToken, tokens.accessToken);
  assert.equal(renewed.refreshToken, tokens.refreshToken);
  fake.revoked.add(tokens.refreshToken!);
  assert.equal((await failure(fake.refresh(tokens))).kind, 'not_connected');
  assert.deepEqual(await fake.userEmail(), { email: 'laura@x.test', verified: true });
  const sent = await fake.send({ from: { address: 'laura@x.test' }, to: { address: 'm@y.test' }, subject: 'Hola', text: 'x' });
  assert.match(sent.messageIdRfc!, /^<.+@mail\.gmail\.test>$/);
  assert.equal(fake.sent.length, 1);
});

test('send: si la lectura del Message-ID falla después de enviar, NO lanza (el correo ya salió) y lo marca pendiente', async () => {
  const { http, oauth, log } = await setup([['messages.send', 'ok'], ['messages.get', 'unavailable']]);
  const gmail = new GmailClient({ ...http, oauth, channelAccountId: CA, tokens: TOKENS, mime: { boundary: (n) => `b${n}` } });
  const sent = await gmail.send({ from: { address: 'laura@cocina-facil.test' }, to: { address: 'marta@cafealma.test' }, subject: 'Hola', text: 'x' });
  assert.deepEqual(sent, { providerMessageId: '18c1f0a0b0c0d0e1', threadId: '18c1f0a0b0c0d0e1', messageIdRfc: null, messageIdPending: true });
  // El envío salió una sola vez; la falla de la lectura quedó en la bitácora.
  assert.equal(log.entries.filter((e) => e.endpoint === 'gmail.messages.send').length, 1);
  assert.ok(log.entries.some((e) => e.endpoint === 'gmail.messages.get' && !e.ok));
});

test('searchReplies con threadId lee ESE hilo: sin lo enviado, sin rebotes y desde `since`', async () => {
  const { http, oauth, fetch } = await setup([['threads.get', 'metadata.ok']]);
  const gmail = new GmailClient({ ...http, oauth, channelAccountId: CA, tokens: TOKENS });
  const since = new Date(1790000000000);
  assert.deepEqual(await gmail.searchReplies({ since, threadId: '18c1f0a0b0c0d0e1' }), [{ id: '18c1f0a0b0c0d0f2', threadId: '18c1f0a0b0c0d0e1' }]);
  assert.match(fetch.calls[0]!.url, /threads\/18c1f0a0b0c0d0e1\?format=metadata/);
  // Todo lo del hilo es anterior a `since`: nada.
  const later = await setup([['threads.get', 'metadata.ok']]);
  const g2 = new GmailClient({ ...later.http, oauth: later.oauth, channelAccountId: CA, tokens: TOKENS });
  assert.deepEqual(await g2.searchReplies({ since: new Date(1790009999999), threadId: '18c1f0a0b0c0d0e1' }), []);
});

test('searchReplies sin hilo busca en la bandeja con los filtros', async () => {
  const { http, oauth, fetch } = await setup([['messages.list', 'replies.ok']]);
  const gmail = new GmailClient({ ...http, oauth, channelAccountId: CA, tokens: TOKENS });
  assert.equal((await gmail.searchReplies({ since: NOW })).length > 0, true);
  assert.match(decodeURIComponent(fetch.calls[0]!.url), /-from:mailer-daemon/);
});

test('revoke: manda el refresh token a /revoke sin dejarlo en la bitácora; invalid_token cuenta como revocado', async () => {
  const { oauth, log, fetch } = await setup([['oauth.revoke', 'ok']]);
  await oauth.revoke(TOKENS, { channelAccountId: CA });
  assert.equal(fetch.calls[0]!.url, 'https://oauth2.googleapis.com/revoke');
  assert.deepEqual(log.entries.map((e) => [e.endpoint, e.ok, e.channel_account_id]), [['google.oauth.revoke', true, CA]]);
  assert.ok(!JSON.stringify(log.entries).includes(TOKENS.refreshToken!));
  const gone = await setup([['oauth.revoke', 'invalid_token']]);
  await gone.oauth.revoke(TOKENS);
  const fake = new FakeGmail({ now: () => NOW });
  const { tokens } = await fake.exchangeCode('c');
  await fake.revoke(tokens);
  assert.equal((await failure(fake.refresh(tokens))).kind, 'not_connected', 'revocado: Google ya no acepta el refresh token');
});

/** Un fetch inyectado que cuenta las peticiones por método y responde con `reply` (o lanza). */
function countingFetch(reply: (n: number) => Response | Error) {
  const seen: string[] = [];
  const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
    seen.push(init.method ?? 'GET');
    const r = reply(seen.length);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, seen };
}

test('send no se reintenta ante un error de red: exactamente 1 POST y kind transient (VEN-10 decide tras mirar el hilo)', async () => {
  const log = new InMemoryOutreachCallLog();
  const { fetch, seen } = countingFetch(() => new TypeError('fetch failed'));
  const http = { callLog: log, fetch, now: () => NOW, sleep: async () => {}, random: () => 0 };
  const gmail = new GmailClient({ ...http, oauth: new GoogleOAuth(CFG, http), channelAccountId: CA, tokens: TOKENS });
  const err = await failure(gmail.send({ from: { address: 'a@b.test' }, to: { address: 'c@d.test' }, subject: 'x', text: 'y' }));
  assert.equal(err.kind, 'transient');
  assert.equal(err.code, 'network');
  assert.deepEqual(seen, ['POST'], 'un POST que pudo haber llegado no se repite');
  assert.equal(log.entries.length, 1);
});

test('send con un 502 del borde tampoco se reintenta; una lectura con 503 sí', async () => {
  const log = new InMemoryOutreachCallLog();
  const bad = () => new Response(JSON.stringify({ error: { code: 502, message: 'Bad Gateway' } }), { status: 502 });
  const send = countingFetch(bad);
  const http = { callLog: log, fetch: send.fetch, now: () => NOW, sleep: async () => {}, random: () => 0 };
  const gmail = new GmailClient({ ...http, oauth: new GoogleOAuth(CFG, http), channelAccountId: CA, tokens: TOKENS });
  assert.equal((await failure(gmail.send({ from: { address: 'a@b.test' }, to: { address: 'c@d.test' }, subject: 'x', text: 'y' }))).kind, 'transient');
  assert.deepEqual(send.seen, ['POST']);

  const read = countingFetch((n) => (n === 1 ? bad() : new Response(JSON.stringify({ id: 't1', messages: [] }), { status: 200 })));
  const http2 = { ...http, fetch: read.fetch };
  const gmail2 = new GmailClient({ ...http2, oauth: new GoogleOAuth(CFG, http2), channelAccountId: CA, tokens: TOKENS });
  await gmail2.getThread('t1');
  assert.deepEqual(read.seen, ['GET', 'GET'], 'leer dos veces no le hace nada a nadie');
});
