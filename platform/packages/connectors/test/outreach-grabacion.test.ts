/**
 * VEN-9 · grabar una sesión real sin secretos ni contenido de personas
 * (src/testing/grabacion.ts, scripts/record-outreach.ts), y lo que ya
 * esté grabado, contra los normalizadores:
 *
 *   · anonymizeOutreach tapa tokens, correos, textos y perfiles; conserva
 *     la forma de Message-ID (el hilo depende de ella), los estados de
 *     Unipile y los ids de LinkedIn con un hash ESTABLE (quien escribe
 *     sigue casando con la identidad de la cuenta);
 *   · un fixture grabado vuelve a servirse con FixtureFetch y el cliente
 *     lo lee igual que el de la documentación;
 *   · los nombres de fixture del guion (gmailName, webhookKind);
 *   · cada `*.recorded.json` que haya en fixtures/gmail y fixtures/unipile
 *     pasa por el normalizador que lo va a leer en producción: si Unipile
 *     o Google responden distinto de lo que dice su documentación, esta
 *     prueba es la que se pone en rojo.
 *
 * Sin red: withoutNetwork() en toda la suite.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InMemoryOutreachCallLog } from '../src/outreach/log.ts';
import { parseUnipileWebhook } from '../src/outreach/unipile-webhook.ts';
import { normalizeGmailMessage } from '../src/gmail.ts';
import { normalizeUnipileAccount, UnipileClient } from '../src/unipile.ts';
import { FIXTURES_DIR, FixtureFetch, withoutNetwork, type Fixture, type NetworkGuard } from '../src/testing/fixture-fetch.ts';
import {
  anonymizeOutreach, recordedFixture, recordedWebhook, RecordingFetch, REQUIRED_OUTREACH_RECORDINGS, STATE_MARK_RE, stateMark,
} from '../src/testing/grabacion.ts';
import { gmailName, webhookKind } from '../scripts/record-outreach.ts';

let guard: NetworkGuard;
before(() => { guard = withoutNetwork(); });
after(() => {
  guard.restore();
  assert.equal(guard.attempts, 0, 'ninguna prueba de grabación salió a la red');
});

const NOW = new Date('2026-09-25T12:00:00Z');
const STATE = `${'A'.repeat(300)}.${'b'.repeat(180)}.c_d-e`;

describe('anonymizeOutreach', () => {
  test('tapa tokens por nombre y por valor, correos, textos y perfiles', () => {
    const out = anonymizeOutreach({
      access_token: 'ya29.ACCESO-REAL', refresh_token: '1//REFRESCO-REAL', token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/gmail.send',
      email: 'laura.real@gmail.com', snippet: 'Hola Laura, te escribo por…', otro: 'lleva ya29.ACCESO-REAL dentro',
      payload: { headers: [
        { name: 'Subject', value: 'Propuesta privada' },
        { name: 'From', value: '"Laura Real" <laura.real@gmail.com>' },
        { name: 'To', value: 'marta@marca-real.com' },
        { name: 'Message-ID', value: '<CAF1234abcd@mail.gmail.com>' },
        { name: 'References', value: '<uno@mail.gmail.com> <dos@mail.gmail.com>' },
      ], body: { data: 'SG9sYSBMYXVyYQ==' } },
    }, { secrets: ['ya29.ACCESO-REAL'] }) as Record<string, unknown>;
    const texto = JSON.stringify(out);
    for (const fuga of ['ACCESO-REAL', 'REFRESCO-REAL', 'laura.real', 'marta@', 'marca-real', 'Propuesta privada', 'Laura Real', 'Hola Laura', 'SG9sYSBMYXVyYQ==', 'CAF1234abcd']) {
      assert.ok(!texto.includes(fuga), `«${fuga}» no queda en el fixture`);
    }
    assert.equal(out['token_type'], 'Bearer');
    assert.equal(out['scope'], 'https://www.googleapis.com/auth/gmail.send', 'los alcances se conservan: la prueba los mira');
    assert.match(String(out['email']), /^demo-[0-9a-f]{6}@gmail\.com$/, 'el dominio de Google se conserva');
    const headers = (out['payload'] as { headers: { name: string; value: string }[] }).headers;
    assert.match(headers.find((h) => h.name === 'Message-ID')!.value, /^<[0-9a-f]{16}@mail\.gmail\.com>$/, 'la forma <local@dominio> se conserva');
    assert.match(headers.find((h) => h.name === 'To')!.value, /^demo-[0-9a-f]{6}@example\.test$/);
    assert.equal(headers.find((h) => h.name === 'Subject')!.value, 'Asunto de la prueba');
  });

  test('el hash es estable: el mismo id de LinkedIn da lo mismo en la cuenta y en quien escribe; el rebote conserva mailer-daemon', () => {
    const cuenta = anonymizeOutreach({ connection_params: { im: { id: 'ACoAABcdEfGhIjKlMn', username: 'Laura Real' } } }) as { connection_params: { im: { id: string; username: string } } };
    const aviso = anonymizeOutreach({ sender: { attendee_provider_id: 'ACoAABcdEfGhIjKlMn', attendee_name: 'Laura Real' } }) as { sender: { attendee_provider_id: string } };
    assert.equal(cuenta.connection_params.im.id, aviso.sender.attendee_provider_id);
    assert.notEqual(cuenta.connection_params.im.id, 'ACoAABcdEfGhIjKlMn');
    assert.match(cuenta.connection_params.im.username, /^demo-/);
    const rebote = anonymizeOutreach({ name: 'From', value: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' }) as { value: string };
    assert.match(rebote.value, /<mailer-daemon@googlemail\.com>$/, 'searchBounces depende de esa dirección');
  });

  test('el estado firmado del name queda como marca con su largo; un estado de Unipile se conserva', () => {
    const out = anonymizeOutreach({ status: 'CREATION_SUCCESS', account_id: 'acc_1', name: STATE, AccountStatus: { message: 'CREDENTIALS' } }) as Record<string, unknown>;
    assert.equal(out['name'], stateMark(STATE.length));
    assert.match(String(out['name']), STATE_MARK_RE);
    assert.equal((out['AccountStatus'] as { message: string }).message, 'CREDENTIALS');
    assert.match(String((anonymizeOutreach({ name: 'Laura Gómez' }) as { name: string }).name), /^demo-/, 'un nombre corto de persona no es un estado');
  });
});

describe('RecordingFetch y los fixtures grabados', () => {
  test('anota cada respuesta con la etiqueta del paso, y la etiqueta vuelve aunque el paso lance', async () => {
    const inner = async (): Promise<Response> => new Response(JSON.stringify({ id: 'x' }), { status: 200 });
    const rec = new RecordingFetch(inner);
    await rec.as('accounts.get', () => rec.fetch('https://api1.unipile.test:13111/api/v1/accounts/acc_1', { method: 'GET' }));
    await assert.rejects(rec.as('otra', async () => { throw new Error('falla'); }));
    assert.equal(rec.tag, 'sin-etiqueta');
    assert.deepEqual(rec.calls.map((c) => [c.tag, c.method, c.status, c.body]), [['accounts.get', 'GET', 200, { id: 'x' }]]);
  });

  test('un fixture grabado lo sirve FixtureFetch y el cliente lo lee como el de la documentación', async () => {
    const call = {
      tag: 'accounts.get', method: 'GET', url: 'https://api9.unipile.com:13443/api/v1/accounts/acc_real_1', status: 200,
      body: {
        object: 'Account', type: 'LINKEDIN', id: 'acc_real_1', name: STATE, created_at: '2026-09-25T11:00:00.000Z',
        connection_params: { im: { id: 'ACoAABcdEfGhIjKlMn', publicIdentifier: 'laura-real', username: 'Laura Real' } },
        sources: [{ id: 'acc_real_1_MESSAGING', status: 'OK' }],
      },
    };
    const fx = recordedFixture(call, NOW, 'prueba');
    assert.deepEqual(fx.meta, { source: 'recorded', recordedAt: '2026-09-25', notes: 'prueba' });
    const fetcher = new FixtureFetch([fx as Fixture]);
    const client = new UnipileClient({ config: { dsn: 'api1.unipile.test:13111', accessToken: 'k' }, callLog: new InMemoryOutreachCallLog(), fetch: fetcher.fetch });
    const acc = await client.getAccount('acc_real_1');
    assert.equal(acc.id, 'acc_real_1');
    assert.ok(acc.providerIdentity?.startsWith('ACoAA') && acc.providerIdentity !== 'ACoAABcdEfGhIjKlMn');
    assert.equal(acc.hostedAuthName, stateMark(STATE.length));
    assert.ok(!JSON.stringify(fx).includes('laura-real'));
  });

  test('un aviso grabado guarda los NOMBRES de nuestras cabeceras, nunca sus valores', () => {
    const fx = recordedWebhook({ event: 'message_received', message: 'hola' }, ['X-On-Cue-Secret', 'x-on-cue-route'], NOW, 'n');
    assert.deepEqual(fx.meta.headers, ['x-on-cue-route', 'x-on-cue-secret']);
    assert.equal((fx.body as { message: string }).message, 'Texto de la prueba (omitido).');
  });

  test('los nombres de fixture del guion', () => {
    const c = (url: string, tag: string) => ({ tag, method: 'GET', url, status: 200, body: null });
    const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
    assert.equal(gmailName(c('https://oauth2.googleapis.com/token', 'oauth.token.refresh')), 'oauth.token.refresh');
    assert.equal(gmailName(c(`${G}/messages/send`, 'messages.send.reply')), 'messages.send.reply');
    assert.equal(gmailName(c(`${G}/messages/18c0ffee?format=metadata`, 'messages.send.reply')), 'messages.get.metadata');
    assert.equal(gmailName(c(`${G}/threads/18c0ffee`, 'threads.get')), 'threads.get');
    assert.equal(gmailName(c(`${G}/messages?q=x`, 'messages.list.bounces')), 'messages.list.bounces');
    assert.equal(webhookKind({ status: 'CREATION_SUCCESS' }, { ok: true }), 'account.created');
    assert.equal(webhookKind({ AccountStatus: { message: 'OK' } }, { ok: true }), 'account.status');
    assert.equal(webhookKind({ event: 'message_received' }, { ok: true, ignored: 'eco de un envío propio' }), 'message.echo');
    assert.equal(webhookKind({ event: 'message_received' }, { ok: true }), 'message.received');
  });
});

// ---------------------------------------------------------------------
// Lo que haya grabado, contra los normalizadores de producción
// ---------------------------------------------------------------------

async function listJson(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...(await listJson(join(dir, e.name))).map((f) => join(e.name, f)));
    else if (e.name.endsWith('.json')) out.push(e.name);
  }
  return out;
}

const read = async (provider: string, file: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(FIXTURES_DIR, provider, file), 'utf8')) as Record<string, unknown>;

const bodyOf = (fx: Record<string, unknown>): unknown => {
  const r = fx['response'];
  return Array.isArray(r) ? (r.at(-1) as { body: unknown }).body : (r as { body: unknown } | undefined)?.body ?? fx['body'];
};

describe('fixtures de outreach', () => {
  test('cada fixture de gmail y unipile dice de dónde sale (docs o recorded) y cuándo', async () => {
    for (const provider of ['gmail', 'unipile']) {
      for (const file of await listJson(join(FIXTURES_DIR, provider))) {
        const fx = await read(provider, file);
        const meta = fx['meta'] as { source?: string; recordedAt?: string } | undefined;
        // Los avisos de la documentación son el cuerpo tal cual (sin meta); los grabados, { meta, body }.
        if (file.startsWith('webhooks/') && !file.endsWith('.recorded.json')) continue;
        assert.ok(meta?.source === 'docs' || meta?.source === 'recorded', `${provider}/${file}: meta.source`);
        assert.match(String(meta?.recordedAt), /^\d{4}-\d{2}-\d{2}$/, `${provider}/${file}: meta.recordedAt`);
        assert.equal(meta?.source === 'recorded', file.endsWith('.recorded.json'), `${provider}/${file}: solo los .recorded.json son grabados`);
      }
    }
  });

  test('lo grabado se lee con los normalizadores de producción (sin grabaciones, no hay nada que mirar)', async () => {
    const vistos: string[] = [];
    for (const provider of ['gmail', 'unipile']) {
      for (const file of (await listJson(join(FIXTURES_DIR, provider))).filter((f) => f.endsWith('.recorded.json'))) {
        const fx = await read(provider, file);
        const body = bodyOf(fx);
        const name = `${provider}/${file.replace(/\.recorded\.json$/, '')}`;
        vistos.push(name);
        if (name === 'unipile/accounts.get') {
          const acc = normalizeUnipileAccount(body);
          assert.ok(acc.id && acc.providerIdentity && acc.createdAt, `${name}: id, connection_params.im.id y created_at`);
        } else if (name === 'unipile/webhooks/account.created') {
          const ev = parseUnipileWebhook(body);
          assert.equal(ev.kind, 'account_connected', `${name}: se lee como cuenta conectada`);
          const len = Number(STATE_MARK_RE.exec(String((body as { name?: string }).name))?.[1] ?? 0);
          assert.ok(len >= 300, `${name}: el name trae el estado entero (${len} caracteres)`);
          assert.equal((fx['meta'] as { appStatus?: number }).appStatus, 200, `${name}: la web verificó la firma del estado que volvió`);
        } else if (name === 'unipile/webhooks/message.received' || name === 'unipile/webhooks/message.echo') {
          const ev = parseUnipileWebhook(body);
          assert.equal(ev.kind, 'message', name);
          assert.ok(ev.kind === 'message' && ev.senderProviderId, `${name}: trae quién escribe (sender.attendee_provider_id)`);
        } else if (name === 'unipile/webhooks/account.status') {
          assert.equal(parseUnipileWebhook(body).kind, 'account_status', name);
        } else if (name === 'gmail/oauth.token.code') {
          const b = body as { refresh_token?: string; scope?: string };
          assert.ok(b.refresh_token, `${name}: Google devolvió refresh_token`);
          assert.match(String(b.scope), /gmail\.send/);
          assert.match(String(b.scope), /gmail\.modify/);
        } else if (name === 'gmail/messages.get.metadata') {
          assert.match(String(normalizeGmailMessage(body).messageIdRfc), /^<[^>]+@[^>]+>$/, `${name}: el Message-ID real`);
        } else if (name === 'gmail/messages.send') {
          const b = body as { id?: string; threadId?: string };
          assert.ok(b.id && b.threadId, `${name}: id y threadId por separado`);
        }
      }
    }
    for (const v of vistos) assert.ok(!v.includes('..'), v);
    assert.ok(REQUIRED_OUTREACH_RECORDINGS.length > 0);
  });
});
