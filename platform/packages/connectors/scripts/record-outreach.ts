/**
 * Graba una sesión REAL de los canales de Ventas (VEN-9) contra Google y
 * Unipile, sin secretos ni contenido de personas (src/testing/grabacion.ts),
 * y deja cada respuesta en fixtures/<proveedor>/<endpoint>.recorded.json
 * con meta.source = 'recorded'. Es lo que falta para dar VEN-9 por hecha
 * (docs/ventas-outreach.md §9.3, REQUIRED_OUTREACH_RECORDINGS).
 *
 *   pnpm --filter @mc/connectors record:outreach -- google --port 8788 --send-to <buzón de pruebas>
 *   pnpm --filter @mc/connectors record:outreach -- avisos --port 8787 --forward http://localhost:3100
 *   pnpm --filter @mc/connectors record:outreach -- unipile --account <account_id> [--profile <identificador>] [--app-url <túnel>]
 *
 * google   Hace SU PROPIO OAuth con el cliente de GOOGLE_OUTREACH_CLIENT_ID (en modo
 *          Prueba, con http://localhost:<port>/callback entre sus URI de
 *          redirección): canje, userinfo, refresco, un correo de prueba a
 *          --send-to (con su Message-ID leído), el hilo y la búsqueda de
 *          respuestas y rebotes. Con --revoke, al final revoca la concesión.
 * avisos   Un proxy delante de la web: el túnel (APP_URL público) apunta
 *          aquí, cada POST se reenvía tal cual a --forward y se guarda su
 *          cuerpo con lo que respondió la web (meta.appStatus). Conectar
 *          LinkedIn desde /ventas/canales, escribirle a la cuenta y
 *          desconectarla en LinkedIn graba account.created, message.received
 *          (y message.echo, el eco de lo que envía la cuenta) y account.status.
 * unipile  Con la cuenta ya conectada: el enlace de hosted auth (con un
 *          estado del largo real, sin completarlo), la cuenta, la lista de
 *          cuentas, sus chats, los mensajes del primero y, con --profile,
 *          un perfil.
 *
 * Las llaves salen del entorno (platform/.env.local); nunca se escriben.
 * Sale con 2 si falta un argumento o una llave.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FetchLike } from '../src/http/client.ts';
import { currentMasterKey, keyringFromEnv } from '../src/crypto/master-key.ts';
import { GmailClient, GoogleOAuth, loadGoogleTokenConfig } from '../src/gmail.ts';
import { InMemoryOutreachCallLog } from '../src/outreach/log.ts';
import { channelStateKey, newNonce, signChannelState } from '../src/outreach/state.ts';
import { UNIPILE_ROUTE_HEADER, UNIPILE_SECRET_HEADER } from '../src/outreach/unipile-webhook.ts';
import { loadUnipileConfig, UnipileClient, type UnipileChannel } from '../src/unipile.ts';
import { FIXTURES_DIR } from '../src/testing/fixture-fetch.ts';
import {
  recordedFileName, recordedFixture, recordedWebhook, RecordingFetch, type CapturedCall,
} from '../src/testing/grabacion.ts';

type Args = Record<string, string | true>;

function parseArgs(argv: readonly string[]): { mode: string; args: Args } {
  const [mode = '', ...rest] = argv.filter((a) => a !== '--');
  const args: Args = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) continue;
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
    else {
      args[a.slice(2)] = next;
      i++;
    }
  }
  return { mode, args };
}

function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

const say = (msg: string): void => {
  process.stdout.write(`${msg}\n`);
};

const arg = (args: Args, name: string): string | undefined => (typeof args[name] === 'string' ? (args[name] as string) : undefined);

/** Escribe un fixture grabado. El archivo de la documentación con el mismo endpoint no se toca. */
async function save(provider: 'gmail' | 'unipile', tag: string, fixture: unknown): Promise<void> {
  const path = join(FIXTURES_DIR, provider, recordedFileName(tag));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  say(`  grabado ${provider}/${recordedFileName(tag)}`);
}

/**
 * El nombre de fixture de una llamada de Google: por su ruta, y la
 * etiqueta del paso cuando la afina ('messages.send.reply') o cuando la
 * ruta no basta (el canje y el refresco van al mismo /token).
 */
export function gmailName(call: CapturedCall): string {
  const u = new URL(call.url);
  const base = u.hostname === 'oauth2.googleapis.com' && u.pathname === '/token' ? null
    : u.pathname.endsWith('/revoke') ? 'oauth.revoke'
      : u.pathname.endsWith('/userinfo') ? 'userinfo'
        : u.pathname.endsWith('/messages/send') ? 'messages.send'
          : /\/messages\/[^/]+$/.test(u.pathname) ? 'messages.get.metadata'
            : /\/threads\/[^/]+$/.test(u.pathname) ? 'threads.get'
              : null;
  if (base === null) return call.tag;
  return call.tag.startsWith(`${base}.`) ? call.tag : base;
}

/** Guarda la ÚLTIMA respuesta de cada nombre (un reintento deja la buena). */
async function saveCalls(provider: 'gmail' | 'unipile', calls: readonly CapturedCall[], nameOf: (c: CapturedCall) => string, secrets: readonly string[]): Promise<void> {
  const byName = new Map<string, CapturedCall>();
  for (const c of calls) byName.set(nameOf(c), c);
  const now = new Date();
  for (const [name, call] of byName) {
    await save(provider, name, recordedFixture(call, now, `Grabado con scripts/record-outreach.ts (${call.method} ${new URL(call.url).pathname}).`, { secrets }));
  }
}

const realFetch: FetchLike = (url, init) => fetch(url, init);

// ---------------------------------------------------------------------
// google
// ---------------------------------------------------------------------

/** Espera la vuelta de Google en http://localhost:<port>/callback y devuelve el code (si el state casa). */
function waitForCallback(port: number, state: string, authUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (u.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = u.searchParams.get('code');
      const ok = u.searchParams.get('state') === state && code !== null;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' })
        .end(ok ? 'Listo: vuelve a la terminal.' : 'La vuelta no casa con esta grabación.');
      server.close();
      if (ok) resolve(code);
      else reject(new Error(`Google volvió sin code o con otro state (${u.searchParams.get('error') ?? 'sin error'}).`));
    });
    server.listen(port, () => say(`Abre en el navegador y autoriza con el buzón de pruebas:\n\n  ${authUrl}\n`));
  });
}

async function google(args: Args): Promise<void> {
  const port = Number(arg(args, 'port') ?? '8788');
  const loaded = loadGoogleTokenConfig(process.env);
  if ('missing' in loaded) fail(`Faltan ${loaded.missing.join(', ')} (platform/.env.example dice cómo se consiguen).`);
  const redirectUri = `http://localhost:${port}/callback`;
  const rec = new RecordingFetch(realFetch);
  const log = new InMemoryOutreachCallLog();
  const oauth = new GoogleOAuth({ ...loaded.config, redirectUri }, { callLog: log, fetch: rec.fetch });
  const state = randomBytes(24).toString('base64url');
  const code = await waitForCallback(port, state, oauth.authorizationUrl(state, { selectAccount: true }));

  const { tokens, scopesGranted } = await rec.as('oauth.token.code', () => oauth.exchangeCode(code));
  const secrets = [code, loaded.config.clientSecret, tokens.accessToken, tokens.refreshToken ?? ''];
  say(`Canje: alcances ${scopesGranted.join(' ')}`);
  const me = await rec.as('userinfo', () => oauth.userEmail(tokens));
  const fresh = await rec.as('oauth.token.refresh', () => oauth.refresh(tokens));
  secrets.push(fresh.accessToken);
  const gmail = new GmailClient({ tokens: fresh, oauth, channelAccountId: null, callLog: log, fetch: rec.fetch });

  const to = arg(args, 'send-to');
  if (to) {
    const subject = 'Prueba de On Cue (grabación de VEN-9)';
    const first = await rec.as('messages.send', () => gmail.send({
      from: { address: me.email }, to: { address: to }, subject,
      text: 'Correo de prueba para grabar la forma de las respuestas de Gmail. Se puede borrar.',
      unsubscribeUrl: 'https://example.test/baja/prueba',
    }));
    say(`Enviado: hilo ${first.threadId}, Message-ID ${first.messageIdRfc ?? '(pendiente)'}`);
    // La respuesta en el mismo hilo, con In-Reply-To y References del Message-ID real.
    if (first.messageIdRfc) {
      await rec.as('messages.send.reply', () => gmail.send({
        from: { address: me.email }, to: { address: to }, subject: `Re: ${subject}`, text: 'Segundo toque, en el mismo hilo.',
        threadId: first.threadId, inReplyTo: first.messageIdRfc!, references: [first.messageIdRfc!],
      }));
    }
    await rec.as('threads.get', () => gmail.getThread(first.threadId));
  } else {
    say('Sin --send-to no se graba messages.send: VEN-9 lo necesita.');
  }
  const since = new Date(Date.now() - 30 * 86_400_000);
  await rec.as('messages.list.replies', () => gmail.searchReplies({ since, max: 5 }));
  await rec.as('messages.list.bounces', () => gmail.searchBounces({ since, max: 5 }));
  if (args['revoke'] === true) await rec.as('oauth.revoke', () => oauth.revoke(fresh));
  await saveCalls('gmail', rec.calls, gmailName, secrets);
}

// ---------------------------------------------------------------------
// avisos: el proxy delante de la web
// ---------------------------------------------------------------------

const rec_ = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Qué aviso es, por su cuerpo y por lo que respondió la web (el eco de un envío propio lo dice ella). */
export function webhookKind(body: unknown, appReply: unknown): string {
  const b = rec_(body);
  if (b['status'] === 'CREATION_SUCCESS') return 'account.created';
  if (b['status'] === 'RECONNECTED') return 'account.reconnected';
  if (Object.keys(rec_(b['AccountStatus'])).length > 0) return 'account.status';
  if (b['event'] === 'message_received') {
    const ignored = rec_(appReply)['ignored'];
    return typeof ignored === 'string' && /eco/.test(ignored) ? 'message.echo' : 'message.received';
  }
  const other = String(b['event'] ?? b['status'] ?? 'desconocido').toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return `otro.${other}`;
}

const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'content-encoding']);

async function relay(req: IncomingMessage, res: ServerResponse, forward: string, secrets: readonly string[]): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !HOP_BY_HOP.has(k)) headers[k] = v;
  const method = req.method ?? 'GET';
  const upstream = await fetch(new URL(req.url ?? '/', forward), {
    method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : raw, redirect: 'manual',
  });
  const text = await upstream.text();
  const out: Record<string, string | string[]> = {};
  upstream.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k) && k !== 'set-cookie') out[k] = v;
  });
  const cookies = upstream.headers.getSetCookie();
  if (cookies.length > 0) out['set-cookie'] = cookies;
  res.writeHead(upstream.status, out).end(text);

  if (method !== 'POST' || !(req.url ?? '').startsWith('/api/webhooks/unipile')) return;
  const body = parseMaybeJson(raw.toString('utf8'));
  const reply = parseMaybeJson(text);
  const kind = webhookKind(body, reply);
  const ours = [UNIPILE_SECRET_HEADER, UNIPILE_ROUTE_HEADER].filter((h) => req.headers[h] !== undefined);
  const fx = recordedWebhook(body, ours, new Date(), `Aviso de Unipile recibido por el proxy de scripts/record-outreach.ts; la web respondió ${upstream.status}.`, { secrets });
  await save('unipile', `webhooks/${kind}`, { ...fx, meta: { ...fx.meta, appStatus: upstream.status, appReply: reply } });
}

function webhookSecrets(): string[] {
  return [process.env['UNIPILE_WEBHOOK_SECRET'], process.env['UNIPILE_WEBHOOK_SECRET_PREVIOUS']].filter((v): v is string => !!v?.trim());
}

async function avisos(args: Args): Promise<void> {
  const port = Number(arg(args, 'port') ?? '8787');
  const forward = arg(args, 'forward') ?? fail('Falta --forward <la web local, p. ej. http://localhost:3100>.');
  const secrets = webhookSecrets();
  const server = createServer((req, res) => {
    relay(req, res, forward, secrets).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(502).end();
      say(`  el reenvío falló: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  say(`Proxy en http://localhost:${port} → ${forward}. Apunta el túnel aquí y pon APP_URL = la URL del túnel en la web. Ctrl+C para terminar.`);
}

// ---------------------------------------------------------------------
// unipile: la API con una cuenta ya conectada
// ---------------------------------------------------------------------

const ZERO_UUID = '00000000-0000-4000-8000-000000000000';

async function unipile(args: Args): Promise<void> {
  const loaded = loadUnipileConfig(process.env);
  if ('missing' in loaded) fail(`Faltan ${loaded.missing.join(', ')} (platform/.env.example dice cómo se consiguen).`);
  const accountId = arg(args, 'account') ?? fail('Falta --account <account_id de Unipile> (la cuenta conectada desde /ventas/canales).');
  let master: Uint8Array;
  try {
    master = currentMasterKey(keyringFromEnv(process.env));
  } catch {
    fail('Falta TOKEN_ENCRYPTION_KEY: el estado de la hosted auth se firma con ella, del largo real.');
  }
  const rec = new RecordingFetch(realFetch);
  const client = new UnipileClient({ config: loaded.config, callLog: new InMemoryOutreachCallLog(), fetch: rec.fetch });
  const secrets = [loaded.config.accessToken, ...webhookSecrets()];
  const channel: UnipileChannel = arg(args, 'channel') === 'instagram_dm' ? 'instagram_dm' : 'linkedin';
  const appUrl = (arg(args, 'app-url') ?? 'https://example.test').replace(/\/+$/, '');

  // Un estado como el de la web (mismo cifrado, misma firma, mismo largo); el enlace no se completa.
  const state = signChannelState({ workspaceId: ZERO_UUID, creatorId: ZERO_UUID, channel, nonce: newNonce() }, channelStateKey(master), new Date());
  await rec.as('hosted.link', () => client.createHostedAuthLink({
    channel, state, notifyUrl: `${appUrl}/api/webhooks/unipile`, successRedirectUrl: `${appUrl}/ventas/canales?conectado=${channel}`,
    failureRedirectUrl: `${appUrl}/ventas/canales/conectar?fallo=grabacion&canal=${channel}`, expiresOn: new Date(Date.now() + 3_600_000),
  }));
  say(`Enlace pedido con un estado de ${state.length} caracteres (no se completa: solo se graba la respuesta).`);

  const acc = await rec.as('accounts.get', () => client.getAccount(accountId));
  say(`Cuenta: identidad ${acc.providerIdentity ? 'presente' : 'AUSENTE'}, fecha de alta ${acc.createdAt ? 'presente' : 'AUSENTE'}, name de ${acc.hostedAuthName?.length ?? 0} caracteres.`);
  await rec.as('accounts.list', () => client.listAccounts());
  const chats = await rec.as('chats.list', () => client.listChats({ accountId, limit: 5 }));
  const first = chats.items[0];
  if (first) await rec.as('chats.messages.list', () => client.listMessages({ chatId: first.id, limit: 5 }));
  const profile = arg(args, 'profile');
  if (profile) {
    secrets.push(profile);
    await rec.as('users.get', () => client.getProfile({ accountId, identifier: profile }));
  }
  await saveCalls('unipile', rec.calls, (c) => c.tag, secrets);
}

// ---------------------------------------------------------------------

const MODES: Record<string, (args: Args) => Promise<void>> = { google, avisos, unipile };

// Solo al correrlo como guion: la prueba importa gmailName y webhookKind sin arrancar nada.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { mode, args } = parseArgs(process.argv.slice(2));
  const run = MODES[mode] ?? fail('Uso: record:outreach -- <google|avisos|unipile> [opciones] (ver el comentario de scripts/record-outreach.ts).');
  run(args).catch((err: unknown) => {
    process.stderr.write(`La grabación falló: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
