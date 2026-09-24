/**
 * VEN-15 · outbound.bounces sobre Postgres embebido, como mc_worker, con
 * un buzón de avisos grabados (test/fixtures/rebotes/buzon.json).
 *
 * El «terminado cuando»: un rebote de fixture marca el correo inválido y
 * cancela los correos pendientes de esa ficha. Además: LinkedIn sigue; un
 * rebote blando se anota y no marca nada; una respuesta normal no es un
 * rebote, ni un «fuera de la oficina» de postmaster@ que dice «no existe»;
 * leer el buzón otra vez no cuenta dos rebotes; sin conector de Gmail el
 * canal cuenta como no configurado; y el adaptador de GmailApi (VEN-9)
 * lleva un rebote de Gmail hasta la ficha.
 *
 * Ronda 3: nada de lo que llega al buzón de un creador tiene efectos en
 * otro workspace (dos workspaces y un contacto global); un aviso sin el
 * Message-ID de un correo enviado queda anotado y nada más; se cancela
 * solo lo que va a la dirección que rebotó; el aviso de Gmail sin
 * cabeceras DSN (en inglés y en español) llega a la ficha; y el cursor
 * por cuenta lee 150 avisos en dos pasadas sin dejar ninguno atrás.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allJobs } from '../src/jobs/index.ts';
import {
  BOUNCES_JOB_ID, gmailNoConfigurado, nextBouncesCursor, runBounces, type BounceBatch, type BounceMailbox, type BounceMessage,
  type MailboxFor,
} from '../src/jobs/ventas/outbound.bounces.ts';
import {
  gmailBounceMailbox, gmailMessageToBounce, type GmailBounceMessage, type GmailBounceSource, type GmailMessageRef,
  type GmailRefPage,
} from '../src/jobs/ventas/gmail-rebotes.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { openTestDatabase } from './helpers/harness.ts';

const NOW = new Date('2026-09-23T14:00:00Z');
const WS = '0000015b-0000-4000-8000-000000000001';
const COMPANY = '0000015b-0000-4000-8000-0000000000c1';
const ACCOUNT = '0000015b-0000-4000-8000-00000000acc1';
const C_DURO = '0000015b-0000-4000-8000-0000000000a1';
const C_LLENO = '0000015b-0000-4000-8000-0000000000a2';
const T_ENVIADO = '0000015b-0000-4000-8000-0000000070a1';
const T_CORREO = '0000015b-0000-4000-8000-0000000070a2';
const T_BORRADOR = '0000015b-0000-4000-8000-0000000070a3';
const T_LINKEDIN = '0000015b-0000-4000-8000-0000000070a4';
const T_LLENO = '0000015b-0000-4000-8000-0000000070b1';
/** Un correo pendiente de la MISMA ficha, pero a otra dirección: esa no rebotó. */
const T_OTRA_DIRECCION = '0000015b-0000-4000-8000-0000000070a5';

const AVISOS: BounceMessage[] = (
  JSON.parse(readFileSync(new URL('./fixtures/rebotes/buzon.json', import.meta.url), 'utf8')) as Array<
    Omit<BounceMessage, 'receivedAt'> & { receivedAt: string }
  >
).map((m) => ({ ...m, receivedAt: new Date(m.receivedAt) }));

/** Un buzón con avisos dados: devuelve lo recibido desde `since`, del más viejo al más nuevo, y anota cada lectura. */
class BuzonGrabado implements BounceMailbox {
  lecturas: Date[] = [];
  readonly avisos: BounceMessage[];
  constructor(avisos: BounceMessage[] = AVISOS) {
    this.avisos = avisos;
  }
  async listBounceCandidates({ since, max }: { since: Date; max: number }): Promise<BounceBatch> {
    this.lecturas.push(since);
    const todos = this.avisos
      .filter((m) => m.receivedAt >= since)
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
    return { messages: todos.slice(0, max), complete: todos.length <= max };
  }
}

let db: PgliteDatabase;

before(async () => {
  db = await openTestDatabase();
  await db.raw.exec(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS}', 'rebotes', 'Laura', 'America/Bogota');
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${COMPANY}', 'Marca Rebote', '${WS}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS}', '${COMPANY}');
    INSERT INTO contact (id, company_id, full_name, email, source, owner_workspace_id) VALUES
      ('${C_DURO}', '${COMPANY}', 'No existe', 'no-existe@marca-rebote.test', 'user_provided', '${WS}'),
      ('${C_LLENO}', '${COMPANY}', 'Buzón lleno', 'lleno@marca-rebote.test', 'user_provided', '${WS}');
    INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, status)
    VALUES ('${ACCOUNT}', '${WS}', 'email', 'gmail_oauth', 'laura.creadora@gmail.com', 'connected');
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, body, status, scheduled_for,
                                sent_at, provider_message_id, message_id_rfc, recipient_address, attempt_count) VALUES
      ('${T_ENVIADO}', '${WS}', '${COMPANY}', '${C_DURO}', 'email', 'Hola', 'sent', '2026-09-23T13:00:00Z',
       '2026-09-23T13:00:00Z', 'gmail-msg-1', '<CAF=rebote001@mail.gmail.com>', 'no-existe@marca-rebote.test', 1),
      ('${T_CORREO}', '${WS}', '${COMPANY}', '${C_DURO}', 'email', 'Sigo', 'scheduled', '2026-09-26T13:00:00Z',
       NULL, NULL, NULL, NULL, 0),
      ('${T_BORRADOR}', '${WS}', '${COMPANY}', '${C_DURO}', 'email', 'Último', 'draft', '2026-09-30T13:00:00Z',
       NULL, NULL, NULL, NULL, 0),
      ('${T_LINKEDIN}', '${WS}', '${COMPANY}', '${C_DURO}', 'linkedin', 'Hola por aquí', 'scheduled', '2026-09-27T13:00:00Z',
       NULL, NULL, NULL, NULL, 0),
      ('${T_LLENO}', '${WS}', '${COMPANY}', '${C_LLENO}', 'email', 'Hola', 'scheduled', '2026-09-25T13:00:00Z',
       NULL, NULL, NULL, NULL, 0);
    -- Un reintento que el despachador ya dirigió a la dirección nueva de la ficha (la dejó escrita al reclamarlo).
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, body, status, scheduled_for,
                                recipient_address, attempt_count)
    VALUES ('${T_OTRA_DIRECCION}', '${WS}', '${COMPANY}', '${C_DURO}', 'email', 'A la nueva', 'scheduled',
            '2026-09-28T13:00:00Z', 'nueva@marca-rebote.test', 1);
  `);
});
after(async () => {
  await db?.close();
});

async function toque(id: string) {
  const { rows } = await db.raw.query<{ status: string; blocked_reason: string | null }>(
    `SELECT status, blocked_reason FROM outbound_touch WHERE id = '${id}'`,
  );
  return rows[0];
}

async function cursor(accountId: string): Promise<string | null> {
  const { rows } = await db.raw.query<{ c: Date | null }>(
    `SELECT bounces_read_at AS c FROM outreach_channel_account WHERE id = '${accountId}'`,
  );
  return rows[0]?.c ? new Date(rows[0].c).toISOString() : null;
}

test('el job está registrado y programado cada media hora (0038)', async () => {
  assert.ok(allJobs.some((j) => j.id === BOUNCES_JOB_ID));
  const { rows } = await db.raw.query<{ queue: string; default_cron: string }>(
    'SELECT queue, default_cron FROM job_definition WHERE id = $1',
    [BOUNCES_JOB_ID],
  );
  assert.deepEqual(rows[0], { queue: 'sales', default_cron: '*/30 * * * *' });
});

test('sin conector de Gmail la cuenta es «canal no configurado» y no se toca nada', async () => {
  const r = await runBounces(db, NOW, gmailNoConfigurado);
  assert.equal(r.accounts, 1);
  assert.equal(r.notConfigured, 1);
  assert.equal(r.bounces, 0);
  assert.equal((await toque(T_CORREO))?.status, 'scheduled');
  assert.equal(await cursor(ACCOUNT), null, 'sin leer, el cursor no se mueve');
});

test('un rebote duro marca el correo inválido y cancela los correos pendientes a esa dirección; LinkedIn sigue', async () => {
  const buzon = new BuzonGrabado();
  const r = await runBounces(db, NOW, () => buzon);
  assert.deepEqual(
    { read: r.read, bounces: r.bounces, hard: r.hard, verified: r.verified, invalidated: r.contactsInvalidated, canceled: r.touchesCanceled },
    { read: 4, bounces: 2, hard: 1, verified: 1, invalidated: 1, canceled: 2 },
  );
  // La primera lectura va 72 h hacia atrás.
  assert.equal(buzon.lecturas[0]?.toISOString(), '2026-09-20T14:00:00.000Z');

  const { rows: [c] } = await db.raw.query<{ email_invalid: boolean; email_invalid_reason: string; bounced: boolean }>(
    `SELECT email_invalid, email_invalid_reason, bounced FROM contact WHERE id = '${C_DURO}'`,
  );
  assert.equal(c?.email_invalid, true);
  assert.match(c?.email_invalid_reason ?? '', /5\.1\.1/);
  assert.equal(c?.bounced, true);
  assert.deepEqual(await toque(T_CORREO), { status: 'canceled', blocked_reason: 'email_invalid' });
  assert.deepEqual(await toque(T_BORRADOR), { status: 'canceled', blocked_reason: 'email_invalid' });
  assert.equal((await toque(T_ENVIADO))?.status, 'sent');
  assert.deepEqual(await toque(T_LINKEDIN), { status: 'scheduled', blocked_reason: null });
  // Lo que ya va a OTRA dirección de la misma ficha no rebotó (la misma regla que 0038 §2).
  assert.deepEqual(await toque(T_OTRA_DIRECCION), { status: 'scheduled', blocked_reason: null });

  const { rows: bitacora } = await db.raw.query<{
    kind: string; touch_id: string | null; contact_id: string | null; status_code: string; verified: boolean;
  }>(`SELECT kind, touch_id, contact_id, status_code, verified FROM outbound_bounce WHERE workspace_id = '${WS}' ORDER BY received_at`);
  assert.deepEqual(bitacora, [
    { kind: 'hard', touch_id: T_ENVIADO, contact_id: C_DURO, status_code: '5.1.1', verified: true },
    { kind: 'soft', touch_id: null, contact_id: C_LLENO, status_code: '5.2.2', verified: false },
  ]);
  // Todo leído: el cursor queda en «ahora» menos la hora de solape.
  assert.equal(await cursor(ACCOUNT), '2026-09-23T13:00:00.000Z');
});

test('un rebote blando se anota y no marca la ficha ni cancela nada', async () => {
  const { rows: [c] } = await db.raw.query<{ email_invalid: boolean }>(`SELECT email_invalid FROM contact WHERE id = '${C_LLENO}'`);
  assert.equal(c?.email_invalid, false);
  assert.equal((await toque(T_LLENO))?.status, 'scheduled');
});

test('leer el buzón otra vez no cuenta dos rebotes, y lee desde el cursor de la cuenta', async () => {
  const buzon = new BuzonGrabado();
  const r = await runBounces(db, NOW, () => buzon);
  assert.equal(r.bounces, 0);
  assert.equal(buzon.lecturas[0]?.toISOString(), '2026-09-23T13:00:00.000Z');
  const { rows: [n] } = await db.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbound_bounce WHERE workspace_id = '${WS}'`);
  assert.equal(n?.n, 2);
});

test('un buzón que falla no tumba la corrida ni mueve el cursor', async () => {
  const antes = await cursor(ACCOUNT);
  const roto: MailboxFor = () => ({
    listBounceCandidates: async () => {
      throw new Error('token vencido');
    },
  });
  const errores: string[] = [];
  const r = await runBounces(db, NOW, roto, { onAccountError: (a) => errores.push(a.id) });
  assert.equal(r.failed, 1);
  assert.deepEqual(errores, [ACCOUNT]);
  assert.equal(await cursor(ACCOUNT), antes);
});

test('el cursor avanza solo hasta lo leído: completo, «ahora» menos el solape; a medias, el último aviso', () => {
  const since = new Date('2026-09-23T10:00:00Z');
  const aviso = (at: string) => ({ id: at, from: '', body: '', receivedAt: new Date(at) });
  assert.equal(nextBouncesCursor(since, { messages: [], complete: true }, NOW).toISOString(), '2026-09-23T13:00:00.000Z');
  assert.equal(
    nextBouncesCursor(since, { messages: [aviso('2026-09-23T10:05:00Z'), aviso('2026-09-23T10:07:00Z')], complete: false }, NOW)
      .toISOString(),
    '2026-09-23T10:07:00.000Z',
  );
  // Nunca hacia atrás.
  const reciente = new Date('2026-09-23T13:30:00Z');
  assert.equal(nextBouncesCursor(reciente, { messages: [], complete: true }, NOW), reciente);
  assert.equal(nextBouncesCursor(since, { messages: [], complete: false }, NOW), since);
});

// ------------------------------------------------------------------
// Dos workspaces y un contacto global (hallazgo r3)
// ------------------------------------------------------------------

describe('un aviso en el buzón de un creador no toca a los demás', () => {
  const WS_A = '0000015b-0000-4000-8000-0000000000a0';
  const WS_B = '0000015b-0000-4000-8000-0000000000b0';
  const ACC_A = '0000015b-0000-4000-8000-00000000aca0';
  const MARCA = '0000015b-0000-4000-8000-0000000000c9';
  const GLOBAL = '0000015b-0000-4000-8000-0000000000f9';
  const T_A_ENVIADO = '0000015b-0000-4000-8000-0000000071a1';
  const T_A_PENDIENTE = '0000015b-0000-4000-8000-0000000071a2';
  const T_B_ENVIADO = '0000015b-0000-4000-8000-0000000071b1';
  const T_B_PENDIENTE = '0000015b-0000-4000-8000-0000000071b2';
  const PRENSA = 'prensa@marca-global.test';

  const aviso = (id: string, over: Partial<BounceMessage>): BounceMessage => ({
    id,
    from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    subject: 'Delivery Status Notification (Failure)',
    body: `Final-Recipient: rfc822; ${PRENSA}\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 User unknown`,
    headers: {},
    receivedAt: new Date('2026-09-23T13:30:00Z'),
    ...over,
  });

  before(async () => {
    await db.raw.exec(`
      INSERT INTO workspace (id, slug, name, timezone) VALUES
        ('${WS_A}', 'creador-a', 'Creador A', 'America/Bogota'), ('${WS_B}', 'creador-b', 'Creador B', 'America/Bogota');
      INSERT INTO company (id, name, owner_workspace_id) VALUES ('${MARCA}', 'Marca global', NULL);
      INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_A}', '${MARCA}'), ('${WS_B}', '${MARCA}');
      -- Fuente pública, sin dueño: la ven los dos.
      INSERT INTO contact (id, company_id, full_name, email, source, source_url, owner_workspace_id)
      VALUES ('${GLOBAL}', '${MARCA}', 'Prensa', '${PRENSA}', 'public_website', 'https://marca-global.test/prensa', NULL);
      INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, status)
      VALUES ('${ACC_A}', '${WS_A}', 'email', 'gmail_oauth', 'yo@a.test', 'connected');
      INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, body, status, scheduled_for,
                                  sent_at, provider_message_id, message_id_rfc, recipient_address, attempt_count) VALUES
        ('${T_A_ENVIADO}', '${WS_A}', '${MARCA}', '${GLOBAL}', 'email', 'Hola', 'sent', '2026-09-23T12:00:00Z',
         '2026-09-23T12:00:00Z', 'gmail-a-1', '<CAF=a001@mail.gmail.com>', '${PRENSA}', 1),
        ('${T_A_PENDIENTE}', '${WS_A}', '${MARCA}', '${GLOBAL}', 'email', 'Sigo', 'scheduled', '2026-09-26T13:00:00Z',
         NULL, NULL, NULL, NULL, 0),
        ('${T_B_ENVIADO}', '${WS_B}', '${MARCA}', '${GLOBAL}', 'email', 'Hola desde B', 'sent', '2026-09-22T12:00:00Z',
         '2026-09-22T12:00:00Z', 'gmail-b-1', '<CAF=b001@mail.gmail.com>', '${PRENSA}', 1),
        ('${T_B_PENDIENTE}', '${WS_B}', '${MARCA}', '${GLOBAL}', 'email', 'Sigo desde B', 'scheduled', '2026-09-26T13:00:00Z',
         NULL, NULL, NULL, NULL, 0);
    `);
  });

  const soloA = (avisos: BounceMessage[]): MailboxFor => (a) => (a.id === ACC_A ? new BuzonGrabado(avisos) : null);

  test('un «Status: 5.1.1» que no viene de mailer-daemon ni es un aviso', async () => {
    const r = await runBounces(db, NOW, soloA([aviso('falso-1', { from: 'Yo <yo@a.test>', subject: 'Hola', headers: { 'in-reply-to': '<CAF=a001@mail.gmail.com>' } })]));
    assert.equal(r.bounces, 0);
    assert.equal((await toque(T_A_PENDIENTE))?.status, 'scheduled');
  });

  test('un aviso con el Message-ID de un correo de OTRO workspace no se verifica: se anota y no hace nada', async () => {
    const r = await runBounces(db, NOW, soloA([aviso('ajeno-1', { headers: { 'in-reply-to': '<CAF=b001@mail.gmail.com>' } })]));
    assert.deepEqual({ bounces: r.bounces, hard: r.hard, verified: r.verified, canceled: r.touchesCanceled }, { bounces: 1, hard: 1, verified: 0, canceled: 0 });
    assert.equal((await toque(T_A_PENDIENTE))?.status, 'scheduled');
    assert.equal((await toque(T_B_PENDIENTE))?.status, 'scheduled');
  });

  test('un aviso sin Message-ID tampoco: no se adivina el correo por la dirección', async () => {
    const r = await runBounces(db, NOW, soloA([aviso('sin-id-1', {})]));
    assert.equal(r.verified, 0);
    assert.equal((await toque(T_A_PENDIENTE))?.status, 'scheduled');
    const { rows } = await db.raw.query<{ verified: boolean; touch_id: string | null }>(
      `SELECT verified, touch_id FROM outbound_bounce WHERE provider_message_id = 'sin-id-1'`,
    );
    assert.deepEqual(rows, [{ verified: false, touch_id: null }]);
  });

  test('un rebote verificado de A cancela lo de A, no marca la ficha compartida y B sigue escribiéndole', async () => {
    const r = await runBounces(db, NOW, soloA([aviso('real-1', { headers: { 'in-reply-to': '<CAF=a001@mail.gmail.com>' } })]));
    assert.deepEqual({ verified: r.verified, invalidated: r.contactsInvalidated, canceled: r.touchesCanceled }, { verified: 1, invalidated: 0, canceled: 1 });
    assert.deepEqual(await toque(T_A_PENDIENTE), { status: 'canceled', blocked_reason: 'email_invalid' });
    assert.deepEqual(await toque(T_B_PENDIENTE), { status: 'scheduled', blocked_reason: null }, 'el correo de B sigue programado');
    const { rows: [g] } = await db.raw.query<{ email_invalid: boolean; bounced: boolean }>(
      `SELECT email_invalid, bounced FROM contact WHERE id = '${GLOBAL}'`,
    );
    assert.deepEqual(g, { email_invalid: false, bounced: false }, 'la ficha compartida no lleva la marca de un solo creador');

    // A ya no le puede programar un correo a esa dirección; B, sí.
    // La regla vale para cualquiera que programe: aquí, el worker.
    const nuevo = (ws: string) =>
      db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, scheduled_for)
           VALUES ('${ws}', '${MARCA}', '${GLOBAL}', 'email', 'Otra vez', 'scheduled', '2026-09-29T13:00:00Z')`,
        );
      });
    await assert.rejects(nuevo(WS_A), /rebotó en un correo de este espacio/);
    await nuevo(WS_B);
  });
});

// ------------------------------------------------------------------
// El adaptador de GmailApi (VEN-9) a BounceMailbox
// ------------------------------------------------------------------

/**
 * Un Gmail falso con la forma de messages.list: searchBounces filtra los
 * avisos desde `since`, los ordena del más NUEVO al más viejo (como
 * Gmail) y los entrega en páginas de `pagina` con su nextPageToken.
 * getMessage devuelve el GmailMessage normalizado.
 */
class GmailFalso implements GmailBounceSource {
  pedidos: string[] = [];
  paginas = 0;
  readonly inbox: GmailBounceMessage[];
  readonly pagina: number;
  constructor(inbox: GmailBounceMessage[], pagina = 40) {
    this.inbox = inbox;
    this.pagina = pagina;
  }
  async searchBounces(opts: { since: Date; max?: number; pageToken?: string }): Promise<GmailRefPage> {
    this.paginas++;
    const todos = this.inbox
      .filter((m) => /mailer-daemon|postmaster/i.test(m.from ?? '') && (m.sentAt?.getTime() ?? 0) >= opts.since.getTime())
      .sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0));
    const desde = Number(opts.pageToken ?? 0);
    const tam = Math.min(opts.max ?? 100, this.pagina);
    const hasta = desde + tam;
    return {
      messages: todos.slice(desde, hasta).map(({ id }) => ({ id, threadId: `hilo-${id}` })),
      nextPageToken: hasta < todos.length ? String(hasta) : null,
    };
  }
  async getMessage(id: string) {
    this.pedidos.push(id);
    const m = this.inbox.find((x) => x.id === id);
    if (!m) throw new Error(`no existe ${id}`);
    return m;
  }
}

/** El aviso duro de Gmail, como lo normaliza normalizeGmailMessage de VEN-9 (solo el text/plain). */
function avisoDeGmail(id: string, destino: string, messageId: string | null, sentAt: string, dsn = true): GmailBounceMessage {
  return {
    id,
    from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    subject: 'Delivery Status Notification (Failure)',
    text:
      `** Address not found **\n\nYour message wasn't delivered to ${destino} because the address couldn't be found.\n\n` +
      'The response from the remote server was:\n550 5.1.1 The email account that you tried to reach does not exist.\n',
    sentAt: new Date(sentAt),
    inReplyTo: messageId,
    references: messageId ? [messageId] : [],
    failedRecipient: dsn ? destino : null,
  };
}

test('el adaptador de Gmail entrega el aviso con su destinatario, su hilo y su hora', async () => {
  const gmail = new GmailFalso([avisoDeGmail('g-1', 'x@marca.test', '<CAF=x@mail.gmail.com>', '2026-09-23T13:00:00Z')]);
  const { messages: [m], complete } = await gmailBounceMailbox(gmail).listBounceCandidates({ since: new Date('2026-09-23T00:00:00Z'), max: 10 });
  assert.equal(complete, true);
  assert.equal(m?.id, 'g-1');
  assert.equal(m?.receivedAt.toISOString(), '2026-09-23T13:00:00.000Z');
  assert.deepEqual(m?.headers, {
    'x-failed-recipients': 'x@marca.test',
    'in-reply-to': '<CAF=x@mail.gmail.com>',
    references: '<CAF=x@mail.gmail.com>',
  });
  assert.deepEqual(
    (await gmailBounceMailbox(gmail).listBounceCandidates({ since: new Date('2026-09-24T00:00:00Z'), max: 10 })).messages,
    [],
    'lo anterior a since no se pide',
  );
  const sinFecha = gmailMessageToBounce({ ...avisoDeGmail('g-2', 'y@m.test', '<a@b>', '2026-09-23T00:00:00Z'), sentAt: null }, NOW);
  assert.equal(sinFecha.receivedAt, NOW);
});

test('con el searchBounces de hoy (un arreglo, sin páginas) y la lista llena, el lote sale marcado como truncado', async () => {
  const lleno: GmailMessageRef[] = Array.from({ length: 500 }, (_, i) => ({ id: `x-${i}`, threadId: `h-${i}` }));
  const sinPaginas: GmailBounceSource = {
    searchBounces: async () => lleno,
    getMessage: async (id) => avisoDeGmail(id, 'x@m.test', null, '2026-09-23T10:00:00Z'),
  };
  const r = await gmailBounceMailbox(sinPaginas).listBounceCandidates({ since: new Date('2026-09-23T00:00:00Z'), max: 5 });
  assert.equal(r.truncated, true);
  assert.equal(r.complete, false);
  assert.equal(r.messages.length, 5);
});

describe('con el adaptador, de Gmail a la ficha (pglite)', () => {
  const WS2 = '0000015b-0000-4000-8000-000000000002';
  const ACC2 = '0000015b-0000-4000-8000-00000000acc2';
  const C2 = '0000015b-0000-4000-8000-0000000000d1';
  const C_EN = '0000015b-0000-4000-8000-0000000000d2';
  const C_ES = '0000015b-0000-4000-8000-0000000000d3';
  const T2_ENVIADO = '0000015b-0000-4000-8000-0000000070d1';
  const T2_PENDIENTE = '0000015b-0000-4000-8000-0000000070d2';
  const T_EN_ENVIADO = '0000015b-0000-4000-8000-0000000070e1';
  const T_EN_PENDIENTE = '0000015b-0000-4000-8000-0000000070e2';
  const T_ES_ENVIADO = '0000015b-0000-4000-8000-0000000070e3';
  const T_ES_PENDIENTE = '0000015b-0000-4000-8000-0000000070e4';
  let gmail: GmailFalso;
  const deTomas: MailboxFor = (a) => (a.id === ACC2 ? gmailBounceMailbox(gmail) : null);

  before(async () => {
    await db.raw.exec(`
      INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS2}', 'rebotes-gmail', 'Tomás', 'America/Bogota');
      INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS2}', '${COMPANY}');
      INSERT INTO contact (id, company_id, full_name, email, source, owner_workspace_id) VALUES
        ('${C2}', '${COMPANY}', 'No existe 2', 'nadie@marca-rebote.test', 'user_provided', '${WS2}'),
        ('${C_EN}', '${COMPANY}', 'Sin DSN', 'compras@tienda-rebote.com.co', 'user_provided', '${WS2}'),
        ('${C_ES}', '${COMPANY}', 'Sin DSN (es)', 'hola@tienda-rebote.co', 'user_provided', '${WS2}');
      INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, status)
      VALUES ('${ACC2}', '${WS2}', 'email', 'gmail_oauth', 'tomas@gmail.com', 'connected');
      INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, body, status, scheduled_for,
                                  sent_at, provider_message_id, message_id_rfc, recipient_address, attempt_count) VALUES
        ('${T2_ENVIADO}', '${WS2}', '${COMPANY}', '${C2}', 'email', 'Hola', 'sent', '2026-09-23T12:00:00Z',
         '2026-09-23T12:00:00Z', 'gmail-t2', '<CAF=tomas001@mail.gmail.com>', 'nadie@marca-rebote.test', 1),
        ('${T2_PENDIENTE}', '${WS2}', '${COMPANY}', '${C2}', 'email', 'Sigo', 'scheduled', '2026-09-26T13:00:00Z',
         NULL, NULL, NULL, NULL, 0),
        ('${T_EN_ENVIADO}', '${WS2}', '${COMPANY}', '${C_EN}', 'email', 'Hola', 'sent', '2026-09-23T11:00:00Z',
         '2026-09-23T11:00:00Z', 'gmail-en', '<CAF=tomas-en@mail.gmail.com>', 'compras@tienda-rebote.com.co', 1),
        ('${T_EN_PENDIENTE}', '${WS2}', '${COMPANY}', '${C_EN}', 'email', 'Sigo', 'scheduled', '2026-09-26T13:00:00Z',
         NULL, NULL, NULL, NULL, 0),
        ('${T_ES_ENVIADO}', '${WS2}', '${COMPANY}', '${C_ES}', 'email', 'Hola', 'sent', '2026-09-23T11:00:00Z',
         '2026-09-23T11:00:00Z', 'gmail-es', '<CAF=tomas-es@mail.gmail.com>', 'hola@tienda-rebote.co', 1),
        ('${T_ES_PENDIENTE}', '${WS2}', '${COMPANY}', '${C_ES}', 'email', 'Sigo', 'scheduled', '2026-09-26T13:00:00Z',
         NULL, NULL, NULL, NULL, 0);
    `);
  });

  test('un rebote de Gmail marca la ficha y cancela sus correos pendientes', async () => {
    gmail = new GmailFalso([
      avisoDeGmail('g-tomas-1', 'nadie@marca-rebote.test', '<CAF=tomas001@mail.gmail.com>', '2026-09-23T12:05:00Z'),
    ]);
    const r = await runBounces(db, NOW, deTomas);
    assert.equal(r.hard, 1);
    assert.equal(r.contactsInvalidated, 1);
    const { rows: [c] } = await db.raw.query<{ email_invalid: boolean }>(`SELECT email_invalid FROM contact WHERE id = '${C2}'`);
    assert.equal(c?.email_invalid, true);
    assert.deepEqual(await toque(T2_PENDIENTE), { status: 'canceled', blocked_reason: 'email_invalid' });
    const { rows: [b] } = await db.raw.query<{ touch_id: string }>(
      `SELECT touch_id FROM outbound_bounce WHERE provider_message_id = 'g-tomas-1'`,
    );
    assert.equal(b?.touch_id, T2_ENVIADO, 'el toque se encuentra por el In-Reply-To del aviso');
  });

  test('el aviso de Gmail sin cabeceras DSN, en inglés y en español, también llega a la ficha', async () => {
    const enProsa = (id: string, texto: string, messageId: string): GmailBounceMessage => ({
      id,
      from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
      subject: 'Delivery Status Notification (Failure)',
      text: `${texto}\n\nThe response from the remote server was:\n550 5.1.1 The email account that you tried to reach does not exist.`,
      sentAt: new Date('2026-09-23T13:45:00Z'),
      inReplyTo: messageId,
      references: [messageId],
      failedRecipient: null,
    });
    gmail = new GmailFalso([
      enProsa(
        'g-en', "Your message wasn't delivered to compras@tienda-rebote.com.co because the address couldn't be found.",
        '<CAF=tomas-en@mail.gmail.com>',
      ),
      enProsa(
        'g-es', 'Tu mensaje no se ha entregado a hola@tienda-rebote.co porque no se ha encontrado la dirección.',
        '<CAF=tomas-es@mail.gmail.com>',
      ),
    ]);
    const r = await runBounces(db, NOW, deTomas);
    assert.equal(r.verified, 2);
    assert.equal(r.contactsInvalidated, 2);
    assert.deepEqual(await toque(T_EN_PENDIENTE), { status: 'canceled', blocked_reason: 'email_invalid' });
    assert.deepEqual(await toque(T_ES_PENDIENTE), { status: 'canceled', blocked_reason: 'email_invalid' });
    const { rows } = await db.raw.query<{ provider_message_id: string; recipient_address: string }>(
      `SELECT provider_message_id, recipient_address::text FROM outbound_bounce WHERE provider_message_id IN ('g-en', 'g-es')
        ORDER BY provider_message_id`,
    );
    assert.deepEqual(rows, [
      { provider_message_id: 'g-en', recipient_address: 'compras@tienda-rebote.com.co' },
      { provider_message_id: 'g-es', recipient_address: 'hola@tienda-rebote.co' },
    ]);
  });

  test('150 avisos en media hora: dos pasadas los leen todos, del más viejo al más nuevo, sin dejar ninguno atrás', async () => {
    // Una lista mala: 150 avisos entre las 13:00 y las 13:30, sin correo nuestro detrás (se anotan, sin efectos).
    const base = Date.parse('2026-09-23T13:00:00Z');
    const avisos = Array.from({ length: 150 }, (_, i) =>
      avisoDeGmail(`rafaga-${String(i).padStart(3, '0')}`, `r${i}@lista-mala.test`, null, new Date(base + i * 12_000).toISOString()),
    );
    gmail = new GmailFalso(avisos, 40);
    // El cursor de la cuenta, en las 12:59 (la pasada anterior terminó ahí).
    await db.raw.query(`UPDATE outreach_channel_account SET bounces_read_at = '2026-09-23T12:59:00Z' WHERE id = '${ACC2}'`);
    const cuantos = async () =>
      (await db.raw.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbound_bounce WHERE workspace_id = '${WS2}' AND provider_message_id LIKE 'rafaga-%'`,
      )).rows[0]?.n;

    const r1 = await runBounces(db, NOW, deTomas, { perRun: 100 });
    assert.equal(r1.bounces, 100);
    assert.equal(r1.pending, 1, 'quedan avisos para la próxima pasada');
    assert.ok(gmail.paginas >= 4, 'recorre todas las páginas de ids antes de leer');
    assert.deepEqual(gmail.pedidos.slice(-100, -99), ['rafaga-000'], 'empieza por el más viejo');
    assert.equal(await cursor(ACC2), new Date(base + 99 * 12_000).toISOString(), 'el cursor queda en el último leído');
    assert.equal(await cuantos(), 100);

    const r2 = await runBounces(db, NOW, deTomas, { perRun: 100 });
    assert.equal(r2.bounces, 50);
    assert.equal(r2.pending, 0);
    assert.equal(await cuantos(), 150);
    // Con todo leído, «ahora» menos el solape… sin volver atrás del último leído.
    assert.equal(await cursor(ACC2), new Date(base + 99 * 12_000).toISOString());
  });
});
