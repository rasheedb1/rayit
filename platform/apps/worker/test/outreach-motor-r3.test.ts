/**
 * VEN-10 r3 · lo que la tercera revisión encontró en el motor, caso por
 * caso, sobre Postgres embebido con las migraciones del repo, como
 * mc_worker, con el canal falso (o el de Gmail sobre FakeGmail) y un
 * reloj falso. Sin red.
 *
 *   · el lector de respuestas lee TODOS los hilos por turno: con 250, la
 *     respuesta del hilo 240 se ve en dos corridas de 200 como mucho;
 *   · una respuesta automática se guarda sin cancelar ni avisar;
 *   · un paso generado por IA que sigue en borrador frena a los de detrás;
 *     el borrador de un paso manual no;
 *   · un paso que sale tarde (retenido y aprobado dos días después) corre
 *     a los de detrás: el 2 no sale dos minutos después del 1;
 *   · sin las llaves de Google el correo no se reclama y no gasta intentos;
 *     sin el token en el almacén, espera sin gastar intento ni tumbar la cuenta;
 *   · el tope del día es la curva de calentamiento de VEN-15 sobre el
 *     límite que rige de VEN-9, en la zona del workspace;
 *   · la plaza vuelve al día en que se reservó, no a hoy.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGmail, InMemorySecretStore } from '@mc/connectors';
import { warmupCurve, warmupDailyLimit } from '@mc/core/outreach/deliverability';
import { accountDailyCap, claimDueTouches, OPEN_THREADS_PAGE, rescueZombies } from '@mc/db/queries/outreach';
import { buildChannels } from '../src/jobs/ventas/canales/index.ts';
import { fakeChannels } from '../src/jobs/ventas/canales/fake.ts';
import { GmailChannel } from '../src/jobs/ventas/canales/gmail.ts';
import { runDispatch } from '../src/jobs/ventas/outbound.dispatch.ts';
import { runReplies } from '../src/jobs/ventas/outbound.replies.ts';
import { motorDbFromJob, type MotorDb } from '../src/jobs/ventas/motor-db.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { openTestDatabase } from './helpers/harness.ts';
import { bogota, localDay, motorKit, TZ } from './helpers/motor-kit.ts';

let db: PgliteDatabase;
let motor: MotorDb;

before(async () => {
  db = await openTestDatabase();
  motor = motorDbFromJob(db);
});
after(async () => {
  await db?.close();
});

const { workspace, enroll, deps, touches, scalar, setDue } = motorKit({ db: () => db, motor: () => motor, prefix: '0000010d', slug: 'motor-r3' });

// ---------------------------------------------------------------------
// Las respuestas
// ---------------------------------------------------------------------

test('el lector recorre todos los hilos por turno: con 250, la respuesta del hilo 240 se ve en dos corridas', async () => {
  const w = await workspace(1, { contacts: 1 });
  const contact = w.contacts[0]!;
  const now = bogota('2026-09-24', '12:00');
  // 250 correos enviados, uno por hilo; hilo-000 el más reciente, hilo-249 el más viejo.
  await motor.transaction((tx) => tx.query(
    `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, attempt_count, sent_at, thread_ref,
                                 provider_message_id, channel_account_id, recipient_address)
     SELECT $1::uuid, $2::uuid, $3::uuid, 'email', 'Hola.', 'sent', 1, $4::timestamptz - make_interval(mins => i),
            'hilo-' || lpad(i::text, 3, '0'), 'enviado-' || i, $5::uuid, 'p1.motor-r31@marca.test'
       FROM generate_series(0, 249) AS i`,
    [w.id, w.company, contact, now.toISOString(), w.gmail],
  ));
  const fake = fakeChannels();
  fake.email.reply('hilo-240', 'Hola, sí nos interesa. ¿Hablamos?', bogota('2026-09-24', '11:00'));
  const corrida = () => runReplies(motor, { readers: fake, now: () => now, workspaceId: w.id, maxPages: 1 });

  const r1 = await corrida();
  assert.equal(r1.threads, OPEN_THREADS_PAGE, 'una página');
  assert.equal(r1.inbound, 0, 'el hilo 240 no entra en la primera página (la ronda 2 no lo leía nunca)');
  const r2 = await corrida();
  assert.equal(r2.inbound, 1, 'la segunda corrida empieza por los 50 que no se habían leído');
  assert.equal(await scalar<number>(`SELECT count(*)::int AS v FROM outbound_message WHERE thread_ref = 'hilo-240' AND direction = 'inbound'`), 1);
  assert.equal(
    await scalar<number>(`SELECT count(*)::int AS v FROM outbound_touch WHERE workspace_id = $1 AND replies_checked_at IS NULL`, [w.id]), 0,
    'después de dos corridas no queda ningún hilo sin leer',
  );
  // Sin tope de páginas, una sola corrida los lee todos.
  const todo = await runReplies(motor, { readers: fake, now: () => now, workspaceId: w.id });
  assert.equal(todo.threads, 250);
  assert.equal(todo.pages, 2);
});

test('una respuesta automática se guarda sin cancelar la cadencia, sin avisar y sin contar como respuesta', async () => {
  const w = await workspace(2, { contacts: 1 });
  const c = w.contacts[0]!;
  await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(r.sent.length, 1);
  const sent = fake.email.sent[0]!;
  fake.email.reply(sent.threadRef, 'Estoy de vacaciones hasta el lunes.', bogota('2026-09-23', '12:05'), undefined, { automatic: true });
  const lectura = await runReplies(motor, { readers: fake, now: () => bogota('2026-09-23', '13:00'), workspaceId: w.id });
  assert.equal(lectura.inbound, 1);
  assert.equal(lectura.automatic, 1);
  assert.equal(lectura.canceled, 0);
  assert.deepEqual((await touches(c)).map((t) => t.status), ['sent', 'scheduled', 'scheduled'], 'la cadencia sigue');
  assert.equal(await scalar<string>(`SELECT status AS v FROM outbound_enrollment WHERE contact_id = $1`, [c]), 'active');
  assert.equal(await scalar<number>(`SELECT count(*)::int AS v FROM notification WHERE workspace_id = $1 AND kind = 'outreach_reply'`, [w.id]), 0);
  assert.equal(await scalar<Date | null>(`SELECT replied_at AS v FROM outbound_touch WHERE provider_message_id = $1`, [sent.providerMessageId]), null);
  assert.equal(await scalar<number>(`SELECT count(*)::int AS v FROM outbound_message WHERE workspace_id = $1 AND direction = 'inbound'`, [w.id]), 1,
    'queda en la conversación para el clasificador de VEN-14');
});

// ---------------------------------------------------------------------
// El orden de los pasos
// ---------------------------------------------------------------------

test('un paso generado por IA que sigue en borrador frena a los de detrás; un borrador manual no', async () => {
  const w = await workspace(3, { contacts: 1, firstStepByAi: true });
  const c = w.contacts[0]!;
  await enroll(w, bogota('2026-09-23', '07:00')); // miércoles
  assert.deepEqual((await touches(c)).map((t) => t.status), ['draft', 'scheduled', 'scheduled'], 'el 1 espera al generador de VEN-12');
  const fake = fakeChannels();
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-25', '12:00')));
  assert.equal(r.claim.claimed, 0, 'el 2 y el 3 ya vencieron, pero la cadencia no empieza por el día 2');
  assert.equal(fake.email.sent.length, 0);

  // Un paso manual (una tarea) en borrador no frena nada: lo hace una persona cuando pueda.
  const m = await workspace(4, { contacts: 1 });
  await db.raw.exec(`
    UPDATE outbound_step SET step_type = 'manual_task', subject_template = NULL WHERE id = '${m.steps[0]}';
    UPDATE outbound_step SET step_type = 'email', subject_template = 'Una idea para {{company}}' WHERE id = '${m.steps[1]}';
  `);
  await enroll(m, bogota('2026-09-23', '07:00'));
  assert.equal((await touches(m.contacts[0]!))[0]!.status, 'draft');
  const fm = fakeChannels();
  const rm = await runDispatch(motor, deps(m, fm, () => bogota('2026-09-24', '12:00')));
  assert.equal(rm.sent.length, 1, 'el correo del día 1 sale');
  assert.equal(fm.email.sent[0]!.subject, 'Una idea para Marca 4');
});

test('un paso que sale tarde corre a los de detrás: el 2 no sale dos minutos después del 1', async () => {
  const w = await workspace(5, { contacts: 1 });
  const c = w.contacts[0]!;
  await enroll(w, bogota('2026-09-23', '07:00')); // miércoles: pasos el miércoles, el jueves y el viernes
  const [t1] = await touches(c);
  // El 1 quedó retenido para revisión y nadie lo aprobó hasta el viernes.
  await db.raw.query(`UPDATE outbound_touch SET status = 'held', held_reason = 'revisar el tono' WHERE id = $1`, [t1!.id]);
  const fake = fakeChannels();
  const jueves = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-24', '12:00')));
  assert.equal(jueves.claim.claimed, 0, 'el 2 espera al 1, que está retenido');
  await db.raw.query(`UPDATE outbound_touch SET status = 'scheduled', held_reason = NULL WHERE id = $1`, [t1!.id]);
  const viernes = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-25', '11:00')));
  assert.deepEqual(viernes.sent, [t1!.id], 'sale el 1, dos días tarde');
  const [, t2, t3] = await touches(c);
  assert.equal(localDay(t2!.scheduled_for), '2026-09-28', 'el 2, un día hábil después del envío real: el lunes');
  assert.equal(localDay(t3!.scheduled_for), '2026-09-29', 'y el 3 detrás');
  const dosMinutos = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-25', '11:02')));
  assert.equal(dosMinutos.sent.length, 0, '«Como te comenté ayer…» no llega dos minutos después');
  const lunes = await runDispatch(motor, deps(w, fake, () => new Date(t2!.scheduled_for.getTime() + 60_000)));
  assert.deepEqual(lunes.sent, [t2!.id]);
});

// ---------------------------------------------------------------------
// Canal no configurado y cuenta no disponible
// ---------------------------------------------------------------------

test('sin las llaves de Google el correo no se reclama: espera en la cola sin gastar intentos', async () => {
  const w = await workspace(6, { contacts: 1 });
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
  const w = await workspace(7, { contacts: 1 });
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

// ---------------------------------------------------------------------
// Topes
// ---------------------------------------------------------------------

test('el tope del día es la curva de VEN-15 sobre el límite que rige de VEN-9, contada en la zona del workspace', async () => {
  const clock = bogota('2026-09-24', '12:00');
  const conectada = bogota('2026-09-22', '08:00'); // el día 3 de calentamiento en Bogotá
  const w = await workspace(8, { contacts: 25, dailyCap: 60, warmupDays: 14, warmupStartedAt: conectada });
  const limite = await scalar<number>(
    `SELECT effective_daily AS v FROM outreach_channel_account_limits WHERE channel_account_id = $1`, [w.gmail],
  );
  assert.equal(limite, 60, 'el tope propio, por debajo del de la política (100) y del proveedor');
  const esperado = warmupDailyLimit({ day: 3, policyLimit: limite, warmupDays: 14 });
  assert.equal(esperado, 20, 'la meseta de la primera semana');
  await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  const r = await runDispatch(motor, deps(w, fake, () => clock));
  assert.equal(r.sent.length, esperado, 'el despachador envía lo mismo que la pantalla dice');
  assert.equal(r.claim.rescheduled.length, 25 - esperado);
  assert.ok(r.claim.rescheduled.every((x) => x.cap === 'account_day' && localDay(x.until) === '2026-09-25'));

  // Y día a día, la misma curva que pinta /ventas/politica (warmupCurve).
  for (const p of warmupCurve(60, 14)) {
    const dia = new Date(conectada.getTime() + (p.day - 1) * 86_400_000);
    assert.equal(accountDailyCap({ effectiveDaily: 60, warmupStartedAt: conectada, warmupDays: 14, now: dia, timeZone: TZ }), p.limit, `día ${p.day}`);
  }
  assert.equal(accountDailyCap({ effectiveDaily: 60, warmupStartedAt: null, warmupDays: 14, now: clock, timeZone: TZ }), 60, 'sin fecha, sin calentamiento');
});

test('la plaza de un reclamo que no salió vuelve al día en que se reservó, no a hoy', async () => {
  const w = await workspace(9, { contacts: 1 });
  await enroll(w, bogota('2026-09-23', '07:00'));
  const claimedAt = bogota('2026-09-23', '12:00');
  const claim = await motor.transaction((tx) => claimDueTouches(tx, { now: claimedAt, channels: ['email'], workspaceId: w.id }));
  assert.equal(claim.claimed.length, 1);
  const touch = claim.claimed[0]!;
  assert.ok(touch.capsReservedOn, 'el reclamo anota el día de la reserva');
  // Como si ese reclamo fuera de hace una semana (el worker estuvo caído), y hoy ya hubiera salido otro correo.
  await db.raw.exec(`
    UPDATE outbound_counter SET period_start = period_start - 7 WHERE workspace_id = '${w.id}';
    UPDATE outbound_touch SET caps_reserved_on = caps_reserved_on - 7 WHERE id = '${touch.id}';
  `);
  await db.raw.query(
    `INSERT INTO outbound_counter (workspace_id, channel_account_id, period, period_start, action_type, count)
     SELECT workspace_id, channel_account_id, period, period_start + 7, action_type, 1 FROM outbound_counter WHERE workspace_id = $1`,
    [w.id],
  );
  const zombies = await motor.transaction((tx) => rescueZombies(tx, new Date(claimedAt.getTime() + 10 * 60_000), w.id));
  assert.deepEqual(zombies.released, [touch.id]);
  const filas = await db.raw.query<{ period: string; viejo: boolean; count: number }>(
    `SELECT period, period_start < outreach_local_date(workspace_id, now()) - 6 AS viejo, count
       FROM outbound_counter WHERE workspace_id = $1 ORDER BY period, viejo`, [w.id],
  );
  for (const f of filas.rows) {
    assert.equal(f.count, f.viejo ? 0 : 1, `${f.period} ${f.viejo ? 'de hace una semana: devuelta' : 'de hoy: intacta'}`);
  }
  assert.equal(filas.rows.filter((f) => f.viejo).length, 3, 'día y semana de la cuenta, y día de los correos del workspace');
});
