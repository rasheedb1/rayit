/**
 * VEN-10 · las cuentas que envían: cuál sale por cada mensaje, qué pasa
 * si cae, si faltan las llaves o el token, y los errores de Unipile.
 * Postgres embebido con las migraciones del repo, como mc_worker, con el
 * canal falso (o los dobles de VEN-9) y un reloj falso. Sin red.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySecretStore } from '@mc/connectors';
import { FakeGmail, FakeUnipile } from '@mc/connectors/testing';
import { enrollContacts } from '@mc/db/queries/outreach';
import { buildChannels } from '../src/jobs/ventas/canales/index.ts';
import { fakeChannels } from '../src/jobs/ventas/canales/fake.ts';
import { GmailChannel } from '../src/jobs/ventas/canales/gmail.ts';
import { UnipileChannel } from '../src/jobs/ventas/canales/unipile.ts';
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

const { workspace, enroll, deps, touches, scalar, setDue, secuencia, unipile, otroGmail, cuentas } = motorKit({ db: () => db, motor: () => motor, prefix: '00000115', slug: 'motor-cuentas' });

test('dos Gmail con tope 1: salen los dos correos del día, uno por cuenta, y nada se va a mañana', async () => {
  const w = await workspace(1, { contacts: 2, dailyCap: 1 });
  const segunda = await otroGmail(w, 1);
  const [c1, c2] = w.contacts as [string, string];
  await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(r.sent.length, 2, 'la segunda cuenta tenía plaza');
  assert.equal(r.claim.rescheduled.length, 0);
  const primeros = [(await cuentas(c1))[0], (await cuentas(c2))[0]];
  assert.deepEqual(new Set(primeros), new Set([w.gmail, segunda]), 'una por cuenta');

  // El día 1, la respuesta en el hilo de cada una sale por SU buzón.
  const r2 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-24', '15:00')));
  assert.equal(r2.sent.length, 2);
  for (const c of [c1, c2]) {
    const [primero, respuesta] = await cuentas(c);
    assert.equal(respuesta, primero, 'el mismo buzón que tiene el hilo');
  }
});

test('la respuesta en el hilo espera a SU buzón caído aunque otro esté conectado; la otra cadencia sigue', async () => {
  const w = await workspace(2, { contacts: 2, dailyCap: 1 });
  const segunda = await otroGmail(w, 5);
  const [c1, c2] = w.contacts as [string, string];
  await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  const deLaPrimera = (await cuentas(c1))[0] === w.gmail ? c1 : c2;
  const deLaSegunda = deLaPrimera === c1 ? c2 : c1;
  assert.equal((await cuentas(deLaSegunda))[0], segunda);

  await db.raw.query(`UPDATE outreach_channel_account SET status = 'needs_reconnect' WHERE id = $1`, [w.gmail]);
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-24', '15:00')));
  assert.equal(r.sent.length, 1, 'solo la del buzón conectado');
  assert.deepEqual(r.claim.waitingAccount.map((x) => x.touchId), [(await touches(deLaPrimera))[1]!.id]);
  assert.equal((await touches(deLaPrimera))[1]!.status, 'scheduled', 'espera, no sale por otro buzón');
  assert.equal((await cuentas(deLaSegunda))[1], segunda);
});

test('con la cuenta caída los mensajes esperan, con un solo aviso, y salen al reconectar', async () => {
  const w = await workspace(3, { contacts: 3 });
  await enroll(w, bogota('2026-09-23', '07:00'));
  await db.raw.query(`UPDATE outreach_channel_account SET status = 'needs_reconnect' WHERE id = $1`, [w.gmail]);
  const fake = fakeChannels();
  let clock = bogota('2026-09-23', '12:00');
  const r = await runDispatch(motor, deps(w, fake, () => clock));
  assert.equal(r.claim.waitingAccount.length, 3);
  assert.equal(r.claim.accountDownNotices, 1);
  assert.equal(r.failed.length, 0);
  const avisos = async () => (await db.raw.query<{ title_es: string; body_es: string }>(
    `SELECT title_es, body_es FROM notification WHERE workspace_id = $1 AND kind = 'outreach_failed'`, [w.id],
  )).rows;
  assert.equal((await avisos()).length, 1);
  assert.equal((await avisos())[0]!.title_es, 'Tu cuenta de correo no está conectada');
  assert.match((await avisos())[0]!.body_es, /3 mensajes esperan/);
  for (const c of w.contacts) assert.equal((await touches(c))[0]!.status, 'scheduled', 'no falla: espera');
  // Una hora después sigue caída: esperan otra vez, sin otro aviso.
  clock = bogota('2026-09-23', '13:30');
  const r2 = await runDispatch(motor, deps(w, fake, () => clock));
  assert.equal(r2.claim.waitingAccount.length, 3);
  assert.equal((await avisos()).length, 1);
  // Al reconectar, salen solos.
  await db.raw.query(`UPDATE outreach_channel_account SET status = 'connected' WHERE id = $1`, [w.gmail]);
  clock = bogota('2026-09-23', '15:00');
  const r3 = await runDispatch(motor, deps(w, fake, () => clock));
  assert.equal(r3.sent.length, 3);
});

test('sin las llaves de Google el correo no se reclama: espera en la cola sin gastar intentos', async () => {
  const w = await workspace(4, { contacts: 1 });
  const c = w.contacts[0]!;
  await enroll(w, bogota('2026-09-23', '07:00'));
  const channels = buildChannels({ env: { APP_URL: 'https://oncue.test' }, secrets: new InMemorySecretStore() });
  for (const hora of ['12:00', '13:00', '14:00']) {
    const r = await runDispatch(motor, deps(w, channels.senders, () => bogota('2026-09-23', hora)));
    assert.equal(r.claim.claimed, 0);
    assert.ok(r.notConfigured.includes('email'));
  }
  const [t1] = await touches(c);
  assert.deepEqual([t1!.status, t1!.attempt_count], ['scheduled', 0]);
});

test('sin el token en el almacén el correo espera como cuenta no disponible: sin gastar intento ni tumbar la cuenta', async () => {
  const w = await workspace(5, { contacts: 1 });
  const c = w.contacts[0]!;
  await enroll(w, bogota('2026-09-23', '07:00'));
  const gmail = new FakeGmail();
  const senders = { email: new GmailChannel({ secrets: new InMemorySecretStore(), oauth: gmail, mailbox: () => gmail }) };
  const r = await runDispatch(motor, deps(w, senders, () => bogota('2026-09-23', '12:00')));
  const [t1] = await touches(c);
  assert.deepEqual(r.waiting, [t1!.id]);
  assert.deepEqual([t1!.status, t1!.attempt_count], ['scheduled', 0], 'el intento que no llegó al proveedor no cuenta');
  assert.ok(t1!.scheduled_for.getTime() >= bogota('2026-09-23', '13:00').getTime(), 'vuelve a mirar en una hora');
  assert.equal(await scalar<string>(`SELECT status AS v FROM outreach_channel_account WHERE id = $1`, [w.gmail]), 'connected', 'la cuenta no es la culpable');
  assert.equal(await scalar<number>(`SELECT count(*)::int AS v FROM outbound_optout_link WHERE touch_id = $1`, [t1!.id]), 0, 'sin el enlace de un intento que no salió');
  // Otra vuelta el mismo día: sigue sin gastar intentos, con un solo aviso.
  await setDue(t1!.id, bogota('2026-09-23', '14:00'));
  await runDispatch(motor, deps(w, senders, () => bogota('2026-09-23', '14:05')));
  assert.equal((await touches(c))[0]!.attempt_count, 0);
  assert.equal(await scalar<number>(`SELECT count(*)::int AS v FROM notification WHERE workspace_id = $1 AND kind = 'outreach_failed'`, [w.id]), 1);
  assert.equal(gmail.sent.length, 0);
});

test('el job registrado arma los buzones con buildChannels: sin llaves de Google o con el canal falso, canal no configurado', async () => {
  const cuenta = { id: '0000010e-0000-4000-8000-0000000ac0ff', workspaceId: '0000010e-0000-4000-8000-000000000001', providerAccountId: 'x@y.test', secretRef: 'enc:x' };
  const sinLlaves = buildChannels({ env: { APP_URL: 'https://oncue.test' }, secrets: new InMemorySecretStore() });
  assert.equal(sinLlaves.bounces(cuenta), null);
  const falso = buildChannels({ env: { APP_URL: 'https://oncue.test' }, secrets: new InMemorySecretStore(), mode: 'fake' });
  assert.equal(falso.bounces(cuenta), null);
  const conLlaves = buildChannels({
    env: { APP_URL: 'https://oncue.test', GOOGLE_OUTREACH_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_OUTREACH_CLIENT_SECRET: 'secreto' },
    secrets: new InMemorySecretStore(),
  });
  assert.ok(conLlaves.bounces(cuenta), 'con las llaves, cada cuenta de correo tiene su buzón');
  // Sin token en el almacén, esa lectura falla (el job la anota) sin llamar a Google.
  // MailboxFor puede ser asíncrono desde VEN-15 r5 (el token sale del vault) y pide `max`.
  await assert.rejects((await conLlaves.bounces(cuenta))!.listBounceCandidates({ since: new Date(), max: 10 }), /secret_missing/);
});

test('un 422 genérico de Unipile falla solo ese mensaje: los otros pasos de LinkedIn siguen', async () => {
  const w = await workspace(6, { contacts: 1 });
  const [c] = w.contacts as [string];
  await unipile(w, 'linkedin');
  const seq = await secuencia(w, 1, [
    { type: 'linkedin_message', channel: 'linkedin', day: 0, body: 'Hola, {{first_name}}: una idea para {{company}}.' },
    { type: 'linkedin_message', channel: 'linkedin', day: 3, body: 'Te dejo mi media kit, {{first_name}}.' },
  ]);
  const enr = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: seq, contactIds: [c], now: bogota('2026-09-23', '07:00') }));
  const api = new FakeUnipile();
  api.addAccount({ id: `uni-linkedin-${w.n}` });
  api.failNext('sendMessage', 'permanent', 'errors/invalid_parameters', 422);
  const linkedin = new UnipileChannel('linkedin', { api });
  const r = await runDispatch(motor, deps(w, { linkedin }, () => bogota('2026-09-23', '12:00')));
  assert.deepEqual(r.failed.length, 1);
  const filas = await db.raw.query<{ status: string; blocked_reason: string | null }>(
    `SELECT status, blocked_reason FROM outbound_touch WHERE enrollment_id = $1 ORDER BY step_index`, [enr.enrolled[0]!.enrollmentId],
  );
  assert.deepEqual(filas.rows.map((x) => [x.status, x.blocked_reason]), [['failed', 'rejected'], ['scheduled', null]]);
  assert.equal(await scalar<string>(`SELECT status AS v FROM outbound_enrollment WHERE id = $1`, [enr.enrolled[0]!.enrollmentId]), 'active');
});

test('un 404 al escribir en un chat que ya no existe abre otro con la persona; el 404 del perfil sí es un destinatario inválido', async () => {
  const api = new FakeUnipile();
  api.addAccount({ id: 'uni-1' });
  const canal = new UnipileChannel('linkedin', { api });
  const account = { id: 'acc-li', provider: 'unipile' as const, providerAccountId: 'uni-1', secretRef: null, displayName: null };
  const base = {
    touchId: 't', workspaceId: 'ws', channel: 'linkedin' as const, stepType: 'linkedin_message' as const, attempt: 1, account,
    recipient: 'https://www.linkedin.com/in/sofia-cardenas/', recipientName: 'Sofía', subject: null, body: 'Hola.', content: 'Hola.',
    unsubscribeUrl: null,
  };
  api.failNext('sendMessage', 'permanent', 'errors/resource_not_found', 404);
  const r = await canal.send({ ...base, reply: { threadRef: 'chat-borrado', messageIdRfc: null } });
  assert.ok(r.ok, 'salió por un chat nuevo');
  assert.notEqual(r.ok && r.threadRef, 'chat-borrado');
  assert.deepEqual(api.calls.map((x) => x.method), ['sendMessage', 'getProfile', 'sendMessage']);
  api.failNext('getProfile', 'permanent', 'errors/resource_not_found', 404);
  const sinPerfil = await canal.send({ ...base, reply: null });
  assert.ok(!sinPerfil.ok && sinPerfil.code === 'invalid_recipient');
  api.failNext('sendMessage', 'permanent', 'errors/recipient_cannot_be_reached', 422);
  const explicito = await canal.send({ ...base, reply: null });
  assert.ok(!explicito.ok && explicito.code === 'invalid_recipient', 'el código explícito sí');
});
