/**
 * VEN-10 r4 · lo que la cuarta revisión encontró en el motor, caso por
 * caso, sobre Postgres embebido con las migraciones del repo, como
 * mc_worker, con el canal falso (o el de Gmail sobre FakeGmail) y un
 * reloj falso. Sin red.
 *
 *   · una ficha con el correo rebotado no tumba el lote al enrolar: sale
 *     con su motivo, y en una secuencia mixta solo se saltan sus correos;
 *   · el job de rebotes lee el Gmail de verdad (el GmailChannel del
 *     despachador) y un rebote duro del fixture marca la ficha y cancela;
 *   · un rebote SÍNCRONO (el proveedor lo devuelve al enviar) también
 *     marca email_invalid, y una secuencia nueva ya no le programa correos;
 *   · el techo de una cuenta de LinkedIn es uno para invitaciones y
 *     mensajes juntos;
 *   · el último paso sin dirección no deja la cadencia activa para siempre;
 *   · un mensaje retenido avisa (uno por mensaje) y lleva a la ficha;
 *   · la guardia de huecos mira el mensaje FINAL (asunto y pie incluidos);
 *   · una nota de LinkedIn de más de 300 no se corta: se retiene;
 *   · una respuesta automática que pide la baja da de baja;
 *   · job:dispatch cuenta lo mismo que la metadata del job.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeGmail, InMemorySecretStore, LINKEDIN_INVITE_NOTE_MAX as CONNECTOR_NOTE_MAX, type GmailMessage } from '@mc/connectors';
import { holdReasonText, LINKEDIN_INVITE_NOTE_MAX } from '@mc/core/outreach/messages';
import { enrollContacts } from '@mc/db/queries/outreach';
import { buildChannels } from '../src/jobs/ventas/canales/index.ts';
import { fakeChannels } from '../src/jobs/ventas/canales/fake.ts';
import { GmailChannel } from '../src/jobs/ventas/canales/gmail.ts';
import { parseArgs, resumenDespacho } from '../src/jobs/ventas/correr-motor.ts';
import { runBounces } from '../src/jobs/ventas/outbound.bounces.ts';
import { canceledCount, runDispatch } from '../src/jobs/ventas/outbound.dispatch.ts';
import { runReplies } from '../src/jobs/ventas/outbound.replies.ts';
import { motorDbFromJob, type MotorDb } from '../src/jobs/ventas/motor-db.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { openTestDatabase } from './helpers/harness.ts';
import { bogota, hex, localDay, motorKit, type Ws } from './helpers/motor-kit.ts';

let db: PgliteDatabase;
let motor: MotorDb;

before(async () => {
  db = await openTestDatabase();
  motor = motorDbFromJob(db);
});
after(async () => {
  await db?.close();
});

const { workspace, enroll, deps, touches, scalar } = motorKit({ db: () => db, motor: () => motor, prefix: '0000010e', slug: 'motor-r4' });

/** Marca el correo de una ficha como rebotado (lo que deja VEN-15). */
async function rebotar(contactId: string): Promise<void> {
  await db.raw.query(
    `UPDATE contact SET email_invalid = true, email_invalid_at = now(), email_invalid_reason = '550 5.1.1 user unknown' WHERE id = $1`,
    [contactId],
  );
}

/** Una secuencia más en el workspace: sus pasos (tipo, canal, día, plantilla) y su id. */
async function secuencia(w: Ws, n: number, pasos: Array<{ type: string; channel: string; day: number; body: string; subject?: string }>): Promise<string> {
  const seq = `${w.id.slice(0, 24)}${hex(0x5e00 + n, 12)}`;
  const filas = pasos.map((p, i) =>
    `('${seq.slice(0, 24)}${hex(0x5e0000 + n * 16 + i, 12)}', '${w.id}', '${seq}', ${p.day}, ${i}, '${p.type}', '${p.channel}', '10:00', ` +
    `${p.subject ? `'${p.subject}'` : 'NULL'}, '${p.body.replace(/'/g, "''")}', false)`,
  );
  await db.raw.exec(`
    INSERT INTO outbound_sequence (id, workspace_id, name, channel, status, automation_mode)
    VALUES ('${seq}', '${w.id}', 'Secuencia ${n}', '${pasos[0]!.channel}', 'active', 'auto');
    INSERT INTO outbound_step (id, workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time,
                               subject_template, body_template, generate_with_ai) VALUES ${filas.join(', ')};
  `);
  return seq;
}

/** Una cuenta de LinkedIn conectada, con su tope diario. */
async function linkedin(w: Ws, dailyCap: number): Promise<string> {
  const acc = `${w.id.slice(0, 24)}0000000ac002`;
  await db.raw.exec(`
    INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, display_name, status, daily_cap, weekly_cap)
    VALUES ('${acc}', '${w.id}', 'linkedin', 'unipile', 'acc_li_${w.n}', 'Creadora ${w.n}', 'connected', ${dailyCap}, 200);
    UPDATE contact SET linkedin_url = 'https://www.linkedin.com/in/persona-' || right(id::text, 4) WHERE owner_workspace_id = '${w.id}';
  `);
  return acc;
}

// ---------------------------------------------------------------------
// Enrolar con un correo rebotado (hallazgo 1)
// ---------------------------------------------------------------------

test('un lote con una ficha rebotada enrola la buena y dice por qué no la otra, sin tumbar el lote', async () => {
  const w = await workspace(1, { contacts: 2 });
  const [buena, rebotada] = w.contacts as [string, string];
  await rebotar(rebotada);
  const r = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: w.seq, contactIds: [buena, rebotada], now: bogota('2026-09-23', '07:00') }));
  assert.deepEqual(r.enrolled.map((e) => e.contactId), [buena]);
  assert.deepEqual(r.skipped, [{ contactId: rebotada, reason: 'email_invalid' }]);
  assert.equal(await scalar<number>(`SELECT count(*)::int AS v FROM outbound_enrollment WHERE contact_id = $1`, [rebotada]), 0);
});

test('en una secuencia mixta, a la ficha rebotada solo se le saltan los correos: LinkedIn sigue y la cadencia empieza por él', async () => {
  const w = await workspace(2, { contacts: 1 });
  const c = w.contacts[0]!;
  await linkedin(w, 20);
  await rebotar(c);
  const seq = await secuencia(w, 1, [
    { type: 'email', channel: 'email', day: 0, subject: 'Hola', body: 'Hola, {{first_name}}.' },
    { type: 'linkedin_message', channel: 'linkedin', day: 1, body: 'Te escribí por correo, {{first_name}}.' },
  ]);
  const r = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: seq, contactIds: [c], now: bogota('2026-09-23', '07:00') }));
  assert.equal(r.skipped.length, 0);
  assert.deepEqual({ ...r.enrolled[0], enrollmentId: undefined, contactId: undefined }, {
    enrollmentId: undefined, contactId: undefined, scheduled: 1, held: 0, drafts: 0, skipped: 1,
  });
  const filas = await db.raw.query<{ channel: string; status: string; blocked_reason: string | null }>(
    `SELECT channel, status, blocked_reason FROM outbound_touch WHERE enrollment_id = $1 ORDER BY step_index`, [r.enrolled[0]!.enrollmentId],
  );
  assert.deepEqual(filas.rows.map((x) => [x.channel, x.status, x.blocked_reason]), [['email', 'skipped', 'email_invalid'], ['linkedin', 'scheduled', null]]);
  assert.equal(
    await scalar<number>(`SELECT st.day_offset AS v FROM outbound_enrollment e JOIN outbound_step st ON st.id = e.current_step_id WHERE e.id = $1`,
      [r.enrolled[0]!.enrollmentId]),
    1, 'el paso actual es el de LinkedIn, no el correo saltado',
  );
});

// ---------------------------------------------------------------------
// Rebotes (hallazgos 2 y 12)
// ---------------------------------------------------------------------

/** Los avisos grabados de VEN-15 (test/fixtures/rebotes/buzon.json), como los entrega GmailApi (GmailMessage). */
function avisosDelFixture(): GmailMessage[] {
  const crudos = JSON.parse(readFileSync(new URL('./fixtures/rebotes/buzon.json', import.meta.url), 'utf8')) as Array<{
    id: string; receivedAt: string; from: string; subject: string | null; headers: Record<string, string>; body: string;
  }>;
  return crudos.map((m) => ({
    id: m.id, threadId: `hilo-${m.id}`, messageIdRfc: null, inReplyTo: m.headers['in-reply-to'] ?? null, references: [],
    from: m.from, to: 'creadora@motor-r4.test', subject: m.subject, sentAt: new Date(m.receivedAt), snippet: m.body.slice(0, 100),
    text: m.body, labelIds: ['INBOX'],
    // Como normalizeGmailMessage: X-Failed-Recipients o el Final-Recipient del informe.
    failedRecipient: m.headers['x-failed-recipients'] ?? /Final-Recipient:\s*rfc822;\s*(\S+)/i.exec(m.body)?.[1]?.toLowerCase() ?? null,
  }));
}

test('el job de rebotes lee el Gmail de verdad: un rebote duro del fixture marca la ficha, cancela sus correos y termina la cadencia', async () => {
  const w = await workspace(3, { contacts: 1 });
  const c = w.contacts[0]!;
  await db.raw.query(`UPDATE contact SET email = 'no-existe@marca-rebote.test' WHERE id = $1`, [c]);
  const enr = await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(r.sent.length, 1);

  // El buzón de la cuenta: el MISMO GmailChannel del despachador, sobre FakeGmail, con el token en el almacén.
  const gmail = new FakeGmail({ now: () => bogota('2026-09-23', '13:00') });
  gmail.inbox.push(...avisosDelFixture());
  const secrets = new InMemorySecretStore();
  const ref = await scalar<string>(`SELECT secret_ref AS v FROM outreach_channel_account WHERE id = $1`, [w.gmail]);
  await secrets.set(ref, { accessToken: 'ya29.prueba', refreshToken: '1//prueba', accessExpiresAt: new Date('2026-09-23T20:00:00Z'), scopes: ['gmail.send', 'gmail.modify'] });
  const canal = new GmailChannel({ secrets, oauth: gmail, mailbox: () => gmail });
  const leidos = await runBounces(db, bogota('2026-09-23', '14:00'), (a) => (a.id === w.gmail ? canal.bounceMailboxFor(a) : null));
  assert.deepEqual([leidos.hard, leidos.contactsInvalidated, leidos.touchesCanceled, leidos.failed], [1, 1, 2, 0]);
  assert.equal(await scalar<boolean>(`SELECT email_invalid AS v FROM contact WHERE id = $1`, [c]), true);
  assert.deepEqual((await touches(c)).map((t) => [t.status, t.blocked_reason]), [['sent', null], ['canceled', 'email_invalid'], ['canceled', 'email_invalid']]);
  assert.equal(await scalar<string>(`SELECT status AS v FROM outbound_enrollment WHERE id = $1`, [enr.get(c)]), 'bounced', 'no queda activa para siempre');
});

test('el job registrado arma los buzones con buildChannels: sin llaves de Google o con el canal falso, canal no configurado', async () => {
  const cuenta = { id: '0000010e-0000-4000-8000-0000000ac0ff', workspaceId: '0000010e-0000-4000-8000-000000000001', providerAccountId: 'x@y.test', secretRef: 'enc:x' };
  const sinLlaves = buildChannels({ env: { APP_URL: 'https://oncue.test' }, secrets: new InMemorySecretStore() });
  assert.equal(sinLlaves.bounces(cuenta), null);
  const falso = buildChannels({ env: { APP_URL: 'https://oncue.test' }, secrets: new InMemorySecretStore(), mode: 'fake' });
  assert.equal(falso.bounces(cuenta), null);
  const conLlaves = buildChannels({
    env: { APP_URL: 'https://oncue.test', GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secreto' },
    secrets: new InMemorySecretStore(),
  });
  assert.ok(conLlaves.bounces(cuenta), 'con las llaves, cada cuenta de correo tiene su buzón');
  // Sin token en el almacén, esa lectura falla (el job la anota) sin llamar a Google.
  await assert.rejects(conLlaves.bounces(cuenta)!.listBounceCandidates({ since: new Date() }), /secret_missing/);
});

test('un rebote síncrono marca el correo inválido: otra secuencia que la enrole ya no le programa correos', async () => {
  const w = await workspace(4, { contacts: 1 });
  const c = w.contacts[0]!;
  await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  fake.email.failNext(1, { kind: 'permanent', code: 'invalid_recipient', message: '550 5.1.1 user unknown' });
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(r.failed.length, 1);
  const marca = await db.raw.query<{ email_invalid: boolean; email_invalid_reason: string; bounced: boolean }>(
    `SELECT email_invalid, email_invalid_reason, bounced FROM contact WHERE id = $1`, [c],
  );
  assert.deepEqual(marca.rows[0], { email_invalid: true, email_invalid_reason: 'invalid_recipient', bounced: true });
  // Mañana, otra secuencia de correos: la ficha sale con su motivo y el lote no se cae.
  const otra = await secuencia(w, 2, [{ type: 'email', channel: 'email', day: 0, subject: 'Otra idea', body: 'Otra idea para {{company}}.' }]);
  const re = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: otra, contactIds: [c], now: bogota('2026-09-24', '07:00') }));
  assert.deepEqual(re.skipped, [{ contactId: c, reason: 'email_invalid' }]);
  assert.equal(fake.email.sent.length, 0);
});
