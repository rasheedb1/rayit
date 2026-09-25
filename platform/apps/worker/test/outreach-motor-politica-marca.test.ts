/**
 * VEN-10 · la política de la marca: cuántos mensajes recibe una marca,
 * cuántos días entre uno y otro, y la revisión humana. Postgres embebido
 * con las migraciones del repo, como mc_worker, con el canal falso y un
 * reloj falso. Sin red.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { enrollContacts } from '@mc/db/queries/outreach';
import { fakeChannels } from '../src/jobs/ventas/canales/fake.ts';
import { runDispatch } from '../src/jobs/ventas/outbound.dispatch.ts';
import { motorDbFromJob, type MotorDb } from '../src/jobs/ventas/motor-db.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { openTestDatabase, SETUP_TIMEOUT } from './helpers/harness.ts';
import { bogota, localDay, motorKit } from './helpers/motor-kit.ts';

let db: PgliteDatabase;
let motor: MotorDb;

before(async () => {
  db = await openTestDatabase();
  motor = motorDbFromJob(db);
}, SETUP_TIMEOUT);
after(async () => {
  await db?.close();
});

const { workspace, enroll, deps, touches, scalar, secuencia } = motorKit({ db: () => db, motor: () => motor, prefix: '00000112', slug: 'motor-marca' });

test('una secuencia de seis pasos con un tope de cuatro por marca: salen cuatro y los otros dos se cancelan; otra secuencia suma', async () => {
  const w = await workspace(1, { contacts: 2, maxTouchesPerCompany: 4 });
  const [c, otra] = w.contacts as [string, string];
  const pasos = [0, 1, 2, 3, 4, 5].map((d) => ({ type: 'email', channel: 'email', day: d, subject: `Idea ${d + 1}`, body: `Idea ${d + 1} para {{company}}.` }));
  const seq = await secuencia(w, 2, pasos);
  const r = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: seq, contactIds: [c], now: bogota('2026-09-23', '07:00') }));
  // Con los pasos concretos que se cancelarán: los dos últimos.
  const [, , , , p5, p6] = (await db.raw.query<{ id: string }>(`SELECT id FROM outbound_step WHERE sequence_id = $1 ORDER BY day_offset`, [seq])).rows;
  assert.deepEqual(r.warnings, [{ code: 'over_company_cap', steps: 6, cap: 4, stepIds: [p5!.id, p6!.id] }], 'avisa al enrolar');
  const fake = fakeChannels();
  // Un día hábil tras otro, a las 15:00: del miércoles 23 al miércoles 30.
  for (const dia of ['2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30']) {
    await runDispatch(motor, deps(w, fake, () => bogota(dia, '15:00')));
  }
  const filas = await db.raw.query<{ status: string; blocked_reason: string | null }>(
    `SELECT status, blocked_reason FROM outbound_touch WHERE enrollment_id = $1 ORDER BY step_index`, [r.enrolled[0]!.enrollmentId],
  );
  assert.deepEqual(filas.rows.map((x) => x.status), ['sent', 'sent', 'sent', 'sent', 'canceled', 'canceled']);
  assert.deepEqual(filas.rows.slice(4).map((x) => x.blocked_reason), ['company_cap', 'company_cap']);
  assert.equal(await scalar<string>(`SELECT status AS v FROM outbound_enrollment WHERE id = $1`, [r.enrolled[0]!.enrollmentId]), 'completed');
  // Otra persona de la misma marca, en otra secuencia: la marca ya recibió sus cuatro.
  await enroll(w, bogota('2026-09-30', '07:00'), [otra]);
  const r2 = await runDispatch(motor, deps(w, fake, () => bogota('2026-10-01', '15:00')));
  assert.equal(r2.sent.length, 0);
  assert.equal(r2.claim.canceledCompanyCap, 1);
});

test('dos pasos en los días 0 y 1 con tres días entre mensajes: el segundo espera a que se cumplan', async () => {
  const w = await workspace(2, { contacts: 1, minDaysBetweenTouches: 3 });
  const [c] = w.contacts as [string];
  const r = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: w.seq, contactIds: [c], now: bogota('2026-09-23', '07:00') }));
  const aviso = r.warnings.find((x) => x.code === 'steps_closer_than_min_gap');
  assert.deepEqual(aviso && aviso.stepIds, [w.steps[1], w.steps[2]], 'avisa al enrolar, con los pasos que se correrán');
  const fake = fakeChannels();
  const d0 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '15:00')));
  assert.equal(d0.sent.length, 1);
  const enviado = fake.email.sent[0]!;
  const primero = (await touches(c))[0]!;
  const d1 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-24', '15:00')));
  assert.equal(d1.sent.length, 0);
  assert.deepEqual(d1.claim.paced.map((x) => x.reason), ['company_gap']);
  const hasta = d1.claim.paced[0]!.until;
  const enviadoEn = await scalar<Date>(`SELECT sent_at AS v FROM outbound_touch WHERE id = $1`, [primero.id]);
  assert.ok(hasta.getTime() >= enviadoEn.getTime() + 3 * 86_400_000, 'tres días después del primero');
  assert.equal(localDay(hasta), '2026-09-28', 'el sábado 26 se corre al lunes');
  const [, segundo, tercero] = await touches(c);
  assert.equal(segundo!.attempt_count, 0, 'sin gastar intento');
  assert.ok(tercero!.scheduled_for.getTime() > hasta.getTime(), 'el de detrás se corre con él');
  const d2 = await runDispatch(motor, deps(w, fake, () => new Date(hasta.getTime() + 60_000)));
  assert.equal(d2.sent.length, 1);
  assert.equal(fake.email.sent.at(-1)!.reply?.threadRef, enviado.threadRef, 'en el hilo');
});

test('con la revisión humana encendida los mensajes nacen retenidos (needs_review) y el despachador no envía nada', async () => {
  const w = await workspace(3, { contacts: 1, humanReview: true });
  const [c] = w.contacts as [string];
  const r = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: w.seq, contactIds: [c], now: bogota('2026-09-23', '07:00') }));
  assert.deepEqual([r.enrolled[0]!.scheduled, r.enrolled[0]!.held], [0, 3]);
  assert.deepEqual((await touches(c)).map((t) => [t.status, t.held_reason]), [['held', 'needs_review'], ['held', 'needs_review'], ['held', 'needs_review']]);
  const fake = fakeChannels();
  const d = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '15:00')));
  assert.equal(d.claim.claimed, 0);
  assert.equal(fake.email.sent.length, 0);
  // Una secuencia en modo 'review' también, aunque la política no pida revisión.
  const w2 = await workspace(4, { contacts: 1 });
  await db.raw.query(`UPDATE outbound_sequence SET automation_mode = 'review' WHERE id = $1`, [w2.seq]);
  const r2 = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: w2.seq, contactIds: w2.contacts, now: bogota('2026-09-23', '07:00') }));
  assert.equal(r2.enrolled[0]!.held, 3);
});
