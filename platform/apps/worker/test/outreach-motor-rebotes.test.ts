/**
 * VEN-10 · los rebotes: el que devuelve el proveedor al enviar y el que
 * llega al buzón (VEN-15) dejan lo mismo: la ficha con el correo
 * inválido, sus correos cancelados y la cadencia en 'bounced'. Postgres
 * embebido con las migraciones del repo, como mc_worker. Sin red.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeGmail, InMemorySecretStore, type GmailMessage } from '@mc/connectors';
import { enrollContacts } from '@mc/db/queries/outreach';
import { fakeChannels } from '../src/jobs/ventas/canales/fake.ts';
import { GmailChannel } from '../src/jobs/ventas/canales/gmail.ts';
import { runBounces } from '../src/jobs/ventas/outbound.bounces.ts';
import { runDispatch } from '../src/jobs/ventas/outbound.dispatch.ts';
import { motorDbFromJob, type MotorDb } from '../src/jobs/ventas/motor-db.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { openTestDatabase, SETUP_TIMEOUT } from './helpers/harness.ts';
import { bogota, motorKit } from './helpers/motor-kit.ts';

let db: PgliteDatabase;
let motor: MotorDb;

before(async () => {
  db = await openTestDatabase();
  motor = motorDbFromJob(db);
}, SETUP_TIMEOUT);
after(async () => {
  await db?.close();
});

const { workspace, enroll, deps, touches, scalar, secuencia } = motorKit({ db: () => db, motor: () => motor, prefix: '00000116', slug: 'motor-rebotes' });

test('un rebote cancela lo pendiente de ese canal y la cadencia termina en bounced', async () => {
  const w = await workspace(1, { contacts: 1 });
  const c = w.contacts[0]!;
  const enr = await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  fake.email.failNext(1, { kind: 'permanent', code: 'bounced', message: '550 5.1.1 user unknown' });
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(r.failed.length, 1);
  const t = await touches(c);
  assert.deepEqual(t.map((x) => [x.status, x.blocked_reason]), [['failed', 'bounced'], ['canceled', 'bounced'], ['canceled', 'bounced']]);
  assert.equal(await scalar<string>(`SELECT status AS v FROM outbound_enrollment WHERE id = $1`, [enr.get(c)]), 'bounced');
  assert.equal(await scalar<boolean>(`SELECT opted_out AS v FROM contact WHERE id = $1`, [c]), false, 'un rebote no es una baja');
  const aviso = await db.raw.query<{ title_es: string; body_es: string }>(
    `SELECT title_es, body_es FROM notification WHERE workspace_id = $1 AND kind = 'outreach_failed'`, [w.id],
  );
  assert.equal(aviso.rows[0]!.title_es, 'Un mensaje a Marca 1 no salió');
  assert.equal(aviso.rows[0]!.body_es, 'El mensaje a Persona 1 Prueba por correo no se envió: el correo rebotó. Revisa la ficha de Marca 1.');
  assert.equal(await scalar<boolean>(`SELECT email_invalid AS v FROM contact WHERE id = $1`, [c]), true, 'r4: el rebote síncrono marca el correo inválido');
});

test('un correo a una dirección que rebotó para siempre (VEN-15) no se reclama: se cancela en la cola', async () => {
  const w = await workspace(2, { contacts: 2 });
  const [rebotado, sano] = w.contacts as [string, string];
  await enroll(w, bogota('2026-09-23', '07:00'));
  await db.raw.query(
    `UPDATE contact SET email_invalid = true, email_invalid_at = now(), email_invalid_reason = '550 5.1.1 user unknown' WHERE id = $1`,
    [rebotado],
  );
  const fake = fakeChannels();
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(r.claim.canceledEmailInvalid, 1);
  assert.equal(r.sent.length, 1, 'la otra marca sí recibe su correo');
  const [t1] = await touches(rebotado);
  assert.deepEqual([t1!.status, t1!.blocked_reason], ['canceled', 'email_invalid']);
  assert.equal((await touches(sano))[0]!.status, 'sent');
});

/** Los avisos grabados de VEN-15 (test/fixtures/rebotes/buzon.json), como los entrega GmailApi (GmailMessage). */
function avisosDelFixture(): GmailMessage[] {
  const crudos = JSON.parse(readFileSync(new URL('./fixtures/rebotes/buzon.json', import.meta.url), 'utf8')) as Array<{
    id: string; receivedAt: string; from: string; subject: string | null; headers: Record<string, string>; body: string;
  }>;
  return crudos.map((m) => ({
    id: m.id, threadId: `hilo-${m.id}`, messageIdRfc: null, inReplyTo: m.headers['in-reply-to'] ?? null, references: [],
    from: m.from, to: 'creadora@motor-rebotes.test', subject: m.subject, sentAt: new Date(m.receivedAt), snippet: m.body.slice(0, 100),
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
