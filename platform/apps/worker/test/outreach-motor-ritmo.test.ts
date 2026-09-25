/**
 * VEN-10 · la ventana, los topes y el ritmo del despachador. Postgres
 * embebido con las migraciones del repo, como mc_worker, con el canal
 * falso y un reloj falso. Sin red.
 *
 *   · la ventana laboral manda al reclamar y al reintentar;
 *   · el tope corre los pasos de detrás, y ningún paso sale antes que el anterior;
 *   · un paso que sale tarde corre a los de detrás;
 *   · el tope del día es la curva de calentamiento sobre el límite de la
 *     cuenta, en la zona del workspace, y la plaza vuelve al día en que se reservó;
 *   · el techo de LinkedIn es uno para invitaciones y mensajes;
 *   · el ritmo por hora de Instagram y el siguiente día hábil del workspace;
 *   · el reclamo no toca lo de otro workspace.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { isInsideWindow, zonedParts } from '@mc/core';
import { warmupCurve, warmupDailyLimit } from '@mc/core/outreach/deliverability';
import { accountDailyCap, claimDueTouches, enrollContacts, rescueZombies } from '@mc/db/queries/outreach';
import { fakeChannels } from '../src/jobs/ventas/canales/fake.ts';
import { runDispatch } from '../src/jobs/ventas/outbound.dispatch.ts';
import { motorDbFromJob, type MotorDb } from '../src/jobs/ventas/motor-db.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { openTestDatabase, SETUP_TIMEOUT } from './helpers/harness.ts';
import { bogota, localClock, localDay, TZ, W, motorKit } from './helpers/motor-kit.ts';

let db: PgliteDatabase;
let motor: MotorDb;

before(async () => {
  db = await openTestDatabase();
  motor = motorDbFromJob(db);
}, SETUP_TIMEOUT);
after(async () => {
  await db?.close();
});

const { workspace, enroll, deps, touches, scalar, setDue, secuencia, unipile } = motorKit({ db: () => db, motor: () => motor, prefix: '00000111', slug: 'motor-ritmo' });

test('la ventana manda al despachar: a las 03:00 no sale nada y el toque pasa a la apertura', async () => {
  const w = await workspace(1, { contacts: 1 });
  const c = w.contacts[0]!;
  await enroll(w, bogota('2026-09-21', '07:00')); // lunes
  const [t1] = await touches(c);
  // El worker estuvo caído: el paso del lunes sigue vencido el martes a las 03:00.
  const fake = fakeChannels();
  let clock = bogota('2026-09-22', '03:00');
  const r = await runDispatch(motor, deps(w, fake, () => clock));
  assert.equal(r.sent.length, 0);
  assert.equal(fake.email.sent.length, 0);
  assert.deepEqual(r.claim.outsideWindow.map((x) => x.touchId), [t1!.id]);
  const [movido] = await touches(c);
  assert.equal(movido!.status, 'scheduled');
  assert.equal(movido!.attempt_count, 0, 'sin gastar un intento');
  assert.equal(localDay(movido!.scheduled_for), '2026-09-22');
  assert.match(localClock(movido!.scheduled_for), /^09:[0-2]\d$/, 'al abrir, con su dispersión');
  assert.equal(await scalar<number>(`SELECT coalesce(sum(count), 0)::int AS v FROM outbound_counter WHERE workspace_id = $1`, [w.id]), 0, 'sin gastar plaza');
  clock = new Date(movido!.scheduled_for.getTime() + 60_000);
  const r2 = await runDispatch(motor, deps(w, fake, () => clock));
  assert.deepEqual(r2.sent, [t1!.id]);
});

test('el reintento del viernes a las 16:50 no sale de noche: sale el lunes, dentro de la ventana', async () => {
  const w = await workspace(2, { contacts: 1 });
  const c = w.contacts[0]!;
  await enroll(w, bogota('2026-09-25', '07:00')); // viernes
  const [t1] = await touches(c);
  // Tres intentos ya fallaron; el cuarto es a las 16:50 y también falla.
  await db.raw.query(`UPDATE outbound_touch SET attempt_count = 3 WHERE id = $1`, [t1!.id]);
  await setDue(t1!.id, bogota('2026-09-25', '16:45'));
  const fake = fakeChannels();
  fake.email.failNext(1, { kind: 'transient', code: 'rate_limited', message: '429' });
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-25', '16:50')));
  assert.deepEqual(r.retried, [t1!.id]);
  const [t] = await touches(c);
  assert.equal(t!.attempt_count, 4);
  assert.ok(t!.next_retry_at);
  assert.equal(localDay(t!.next_retry_at!), '2026-09-28', 'el lunes');
  assert.ok(isInsideWindow(t!.next_retry_at!, TZ, W), `dentro de la ventana: ${t!.next_retry_at!.toISOString()}`);
  assert.equal(await scalar<number>(`SELECT coalesce(sum(count), 0)::int AS v FROM outbound_counter WHERE workspace_id = $1`, [w.id]), 0,
    'el reintento devolvió su plaza');
});

test('el tope corre los pasos de detrás, y ningún paso sale antes que el anterior', async () => {
  const w = await workspace(3, { contacts: 1 });
  const c = w.contacts[0]!;
  await enroll(w, bogota('2026-09-25', '07:00')); // viernes: pasos el viernes, el lunes y el martes
  const antes = await touches(c);
  assert.deepEqual(antes.map((t) => localDay(t.scheduled_for)), ['2026-09-25', '2026-09-28', '2026-09-29']);
  // El tope diario de la cuenta ya está lleno hoy (el contador cuenta el día del reloj del despachador, 0052 §3).
  await db.raw.query(`UPDATE outreach_channel_account SET daily_cap = 1 WHERE id = $1`, [w.gmail]);
  await db.raw.query(
    `INSERT INTO outbound_counter (workspace_id, channel_account_id, period, period_start, action_type, count)
     VALUES ($1, $2, 'day', $3::date, 'email', 1)`,
    [w.id, w.gmail, '2026-09-25'],
  );
  const fake = fakeChannels();
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-25', '12:00')));
  assert.equal(r.sent.length, 0);
  assert.equal(r.claim.rescheduled.length, 1);
  const despues = await touches(c);
  assert.deepEqual(despues.map((t) => localDay(t.scheduled_for)), ['2026-09-28', '2026-09-29', '2026-09-30'],
    'el paso 1 al lunes, y los de detrás un día hábil cada uno detrás de él');
  assert.equal(localClock(despues[1]!.scheduled_for), localClock(antes[1]!.scheduled_for), 'cada uno con su hora de reloj');

  // Aunque el paso 2 quedara vencido antes que el 1 (una reprogramación a mano), no sale mientras el 1 siga en la cola.
  // El lunes los contadores ya son otro día (0052 §3): solo se devuelve el tope.
  await db.raw.query(`UPDATE outreach_channel_account SET daily_cap = 40 WHERE id = $1`, [w.gmail]);
  await setDue(despues[1]!.id, bogota('2026-09-28', '10:00'));
  const r2 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-28', '11:00')));
  assert.equal(r2.claim.claimed, 0, 'el paso 2 espera al 1');
  assert.equal(fake.email.sent.length, 0);
  const r3 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-28', '12:30')));
  assert.deepEqual(r3.sent, [despues[0]!.id], 'primero el 1: en esta corrida el 2 todavía lo espera');
  // El 1 salió tres horas tarde: el 2 no sale dos minutos después, se corre un día hábil desde hoy.
  const r4 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-28', '12:32')));
  assert.deepEqual(r4.sent, []);
  const [, t2] = await touches(c);
  assert.equal(localDay(t2!.scheduled_for), '2026-09-29');
  const r5 = await runDispatch(motor, deps(w, fake, () => new Date(t2!.scheduled_for.getTime() + 60_000)));
  assert.deepEqual(r5.sent, [despues[1]!.id], 'y al día hábil siguiente, en el hilo, el 2');
  assert.deepEqual(fake.email.sent.map((m) => m.stepType), ['email', 'email_reply']);
  assert.equal(fake.email.sent[1]!.subject, 'Re: Hola, Persona');
  assert.equal(fake.email.sent[1]!.reply?.threadRef, fake.email.sent[0]!.threadRef);
});

test('un paso que sale tarde corre a los de detrás: el 2 no sale dos minutos después del 1', async () => {
  const w = await workspace(4, { contacts: 1 });
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

test('el tope del día es la curva de VEN-15 sobre el límite que rige de VEN-9, contada en la zona del workspace', async () => {
  const clock = bogota('2026-09-24', '12:00');
  const conectada = bogota('2026-09-22', '08:00'); // el día 3 de calentamiento en Bogotá
  const w = await workspace(5, { contacts: 25, dailyCap: 60, warmupDays: 14, warmupStartedAt: conectada });
  const limite = await scalar<number>(
    `SELECT effective_daily AS v FROM outreach_channel_account_limits WHERE channel_account_id = $1`, [w.gmail],
  );
  assert.equal(limite, 60, 'el tope propio, por debajo del de la política (100) y del proveedor');
  const esperado = warmupDailyLimit({ day: 3, policyLimit: limite, warmupDays: 14 });
  assert.equal(esperado, 20, 'la meseta de la primera semana');
  await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  // La primera hora, el ritmo de la cuenta: un cuarto de su tope que
  // rige (0052 §1), 60 / 4 = 15. Lo demás espera su turno sin gastar plaza.
  const porHora = await scalar<number>(
    `SELECT effective_hourly AS v FROM outreach_channel_account_limits WHERE channel_account_id = $1`, [w.gmail],
  );
  assert.equal(porHora, 15);
  const r = await runDispatch(motor, deps(w, fake, () => clock));
  assert.equal(r.sent.length, porHora, 'la primera hora, el ritmo de la cuenta');
  assert.equal(r.claim.paced.length, 25 - porHora);
  assert.ok(r.claim.paced.every((x) => x.reason === 'account_hour'));
  // Una hora después, lo que queda del día: la curva de calentamiento manda.
  const r2 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-24', '13:05')));
  assert.equal(r.sent.length + r2.sent.length, esperado, 'en el día, el despachador envía lo mismo que la pantalla dice');
  assert.equal(r2.claim.rescheduled.length, 25 - esperado);
  assert.ok(r2.claim.rescheduled.every((x) => x.cap === 'account_day' && localDay(x.until) === '2026-09-25'));

  // Y día a día, la misma curva que pinta /ventas/politica (warmupCurve).
  for (const p of warmupCurve(60, 14)) {
    const dia = new Date(conectada.getTime() + (p.day - 1) * 86_400_000);
    assert.equal(accountDailyCap({ effectiveDaily: 60, warmupStartedAt: conectada, warmupDays: 14, now: dia, timeZone: TZ }), p.limit, `día ${p.day}`);
  }
  assert.equal(accountDailyCap({ effectiveDaily: 60, warmupStartedAt: null, warmupDays: 14, now: clock, timeZone: TZ }), 60, 'sin fecha, sin calentamiento');
});

test('la plaza de un reclamo que no salió vuelve al día en que se reservó, no a hoy', async () => {
  const w = await workspace(6, { contacts: 1 });
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
    // Los contadores cuentan el día del reloj del despachador (0052 §3): «hoy» es el del reclamo.
    `SELECT period, period_start < $2::date - 6 AS viejo, count
       FROM outbound_counter WHERE workspace_id = $1 ORDER BY period, viejo`, [w.id, localDay(claimedAt)],
  );
  for (const f of filas.rows) {
    assert.equal(f.count, f.viejo ? 0 : 1, `${f.period} ${f.viejo ? 'de hace una semana: devuelta' : 'de hoy: intacta'}`);
  }
  assert.equal(filas.rows.filter((f) => f.viejo).length, 3, 'día y semana de la cuenta, y día de los correos del workspace');
});

test('el techo de LinkedIn es uno para la cuenta: con 1 al día, una invitación y un mensaje no salen el mismo día', async () => {
  const w = await workspace(7, { contacts: 2 });
  const [a, b] = w.contacts as [string, string];
  const acc = await unipile(w, 'linkedin', 1);
  const invitar = await secuencia(w, 3, [{ type: 'linkedin_connect', channel: 'linkedin', day: 0, body: 'Hola, {{first_name}}: me gustaría conectar.' }]);
  const escribir = await secuencia(w, 4, [{ type: 'linkedin_message', channel: 'linkedin', day: 0, body: 'Hola, {{first_name}}: una idea para {{company}}.' }]);
  const t0 = bogota('2026-09-23', '07:00'); // miércoles
  await motor.transaction((tx) => enrollContacts(tx, { sequenceId: invitar, contactIds: [a], now: t0 }));
  await motor.transaction((tx) => enrollContacts(tx, { sequenceId: escribir, contactIds: [b], now: t0 }));
  const fake = fakeChannels();
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(r.sent.length, 1, 'una sola acción por la cuenta');
  assert.equal(fake.linkedin.sent.length, 1);
  assert.equal(r.claim.rescheduled.length, 1);
  assert.equal(r.claim.rescheduled[0]!.cap, 'account_day');
  assert.equal(localDay(r.claim.rescheduled[0]!.until), '2026-09-24', 'al siguiente día hábil');
  // Una sola fila por cuenta y día: la que suma /ventas/canales (used_today).
  const filas = await db.raw.query<{ action_type: string; period: string; count: number }>(
    `SELECT action_type, period, count FROM outbound_counter WHERE channel_account_id = $1 ORDER BY period`, [acc],
  );
  assert.deepEqual(filas.rows.map((f) => [f.action_type, f.period, f.count]), [['linkedin', 'day', 1], ['linkedin', 'week', 1]]);
  // Al día siguiente, a su hora, sale el otro. Los contadores cuentan el día
  // del reloj del despachador (p_at, 0052 §3), no el now() de la base: el
  // reloj falso cambia de día y la plaza del jueves es una fila nueva.
  const manana = new Date(r.claim.rescheduled[0]!.until.getTime() + 60_000);
  const r2 = await runDispatch(motor, deps(w, fake, () => manana));
  assert.equal(r2.sent.length, 1);
  assert.deepEqual(new Set(fake.linkedin.sent.map((m) => m.stepType)), new Set(['linkedin_connect', 'linkedin_message']));
  const dias = await db.raw.query<{ period_start: string; count: number }>(
    `SELECT period_start::text, count FROM outbound_counter WHERE channel_account_id = $1 AND period = 'day' ORDER BY period_start`, [acc],
  );
  assert.deepEqual(dias.rows.map((f) => [f.period_start, f.count]), [['2026-09-23', 1], ['2026-09-24', 1]], 'una fila por día del reloj');
});

test('15 Instagram vencidos a las 09:00 salen como mucho 10 en la primera hora, separados, y el resto después', async () => {
  const w = await workspace(8, { contacts: 15 });
  await unipile(w, 'instagram_dm');
  const seq = await secuencia(w, 3, [{ type: 'instagram_dm', channel: 'instagram_dm', day: 0, body: 'Hola, {{first_name}}: me encanta {{company}}.' }]);
  await motor.transaction((tx) => enrollContacts(tx, { sequenceId: seq, contactIds: w.contacts, now: bogota('2026-09-22', '07:00') }));
  await db.raw.query(`UPDATE outbound_touch SET scheduled_for = $2 WHERE sequence_id = $1`, [seq, bogota('2026-09-23', '09:00').toISOString()]);
  const fake = fakeChannels();
  const envios: Date[] = [];
  // Cada dos minutos, como el cron, de 09:00 a 10:58.
  for (let m = 0; m < 120; m += 2) {
    const at = new Date(bogota('2026-09-23', '09:00').getTime() + m * 60_000);
    const r = await runDispatch(motor, deps(w, fake, () => at));
    for (let i = 0; i < r.sent.length; i++) envios.push(at);
  }
  const primeraHora = envios.filter((x) => x.getTime() < bogota('2026-09-23', '10:00').getTime());
  assert.ok(primeraHora.length <= 10, `salieron ${primeraHora.length} en la primera hora`);
  assert.ok(primeraHora.length >= 8, 'y no se frena de más');
  for (let i = 1; i < envios.length; i++) {
    assert.ok(envios[i]!.getTime() - envios[i - 1]!.getTime() >= 120_000, 'nunca dos en menos de 120 s');
  }
  for (let i = 10; i < envios.length; i++) {
    assert.ok(envios[i]!.getTime() - envios[i - 10]!.getTime() > 3600_000, 'nunca once en una hora corrida');
  }
  assert.equal(envios.length, 15, 'antes de las 11:00 salieron todos');
});

test('el tope reprograma al siguiente día hábil del workspace (el de los contadores), dentro de la ventana de la cadencia', async () => {
  // El workspace en Bogotá, la cadencia en Madrid (siete horas más), una plaza al día.
  const w = await workspace(9, { contacts: 2, dailyCap: 1, sequenceTimeZone: 'Europe/Madrid' });
  await enroll(w, bogota('2026-09-22', '07:00'));
  await db.raw.query(`UPDATE outbound_touch SET scheduled_for = $2 WHERE sequence_id = $1 AND step_index = 1`, [w.seq, bogota('2026-09-23', '05:00').toISOString()]);
  const fake = fakeChannels();
  const now = bogota('2026-09-23', '06:00'); // 13:00 en Madrid: dentro de su ventana
  const r = await runDispatch(motor, deps(w, fake, () => now));
  assert.equal(r.sent.length, 1);
  assert.equal(r.claim.rescheduled.length, 1);
  const hasta = r.claim.rescheduled[0]!.until;
  assert.ok(localDay(hasta) > localDay(now), 'otro día en la zona del workspace, la de los contadores');
  const madrid = zonedParts(hasta, 'Europe/Madrid');
  assert.ok(madrid.seconds >= 9 * 3600 && madrid.seconds < 17 * 3600, 'dentro de la ventana de la cadencia');
  // Con el reloj del despachador en esa hora, el contador es otro día: sale, sin borrar outbound_counter a mano.
  const r2 = await runDispatch(motor, deps(w, fake, () => new Date(hasta.getTime() + 60_000)));
  assert.equal(r2.sent.length, 1);
  assert.equal(TZ, 'America/Bogota');
});

test('el reclamo no toca lo de otro workspace aunque corra para todos', async () => {
  const w = await workspace(10, { contacts: 1 });
  await enroll(w, bogota('2026-09-23', '07:00'));
  const claim = await motor.transaction((tx) => claimDueTouches(tx, { now: bogota('2026-09-23', '12:00'), channels: ['email'], workspaceId: w.id }));
  assert.ok(claim.claimed.every((t) => t.workspaceId === w.id));
  // Y lo deja en processing con su cuenta, de su workspace y de su canal.
  const row = await db.raw.query<{ channel_account_id: string }>(`SELECT channel_account_id FROM outbound_touch WHERE id = $1`, [claim.claimed[0]!.id]);
  assert.equal(row.rows[0]!.channel_account_id, w.gmail);
});
