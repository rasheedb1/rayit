/**
 * VEN-10 · enrolar y retener: qué nace con cada toque y qué se queda
 * esperando a una persona. Postgres embebido con las migraciones del
 * repo, como mc_worker, con el canal falso y un reloj falso. Sin red.
 *
 *   · solo se enrolan fichas del workspace de la secuencia;
 *   · una ficha con el correo rebotado no tumba el lote: sale con su
 *     motivo, y en una secuencia mixta solo se saltan sus correos;
 *   · una dirección mal escrita se salta; un correo nuevo sin asunto se retiene;
 *   · la respuesta en el hilo cuyo correo no salió se retiene;
 *   · un paso generado por IA que sigue en borrador frena a los de detrás;
 *   · el último paso sin dirección no deja la cadencia activa para siempre;
 *   · un mensaje retenido guarda un código, avisa una vez y lleva a la ficha;
 *   · la guardia de huecos mira el mensaje final; una nota de LinkedIn de
 *     más de 300 caracteres se retiene, nunca se corta;
 *   · los avisos hablan el idioma del workspace.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { LINKEDIN_INVITE_NOTE_MAX as CONNECTOR_NOTE_MAX } from '@mc/connectors';
import { holdReasonText, LINKEDIN_INVITE_NOTE_MAX } from '@mc/core/outreach/messages';
import { enrollContacts } from '@mc/db/queries/outreach';
import { fakeChannels } from '../src/jobs/ventas/canales/fake.ts';
import { resumenDespacho } from '../src/jobs/ventas/correr-motor.ts';
import { runDispatch } from '../src/jobs/ventas/outbound.dispatch.ts';
import { motorDbFromJob, type MotorDb } from '../src/jobs/ventas/motor-db.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { openTestDatabase, SETUP_TIMEOUT } from './helpers/harness.ts';
import { bogota, hex, motorKit } from './helpers/motor-kit.ts';

let db: PgliteDatabase;
let motor: MotorDb;

before(async () => {
  db = await openTestDatabase();
  motor = motorDbFromJob(db);
}, SETUP_TIMEOUT);
after(async () => {
  await db?.close();
});

const { workspace, enroll, deps, touches, scalar, secuencia, unipile, rebotar } = motorKit({ db: () => db, motor: () => motor, prefix: '00000110', slug: 'motor-enrolar' });

test('un contacto de otro workspace no se enrola, ni desde el worker ni por la base', async () => {
  const a = await workspace(1);
  const b = await workspace(2);
  const ajeno = b.contacts[0]!;
  const r = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: a.seq, contactIds: [a.contacts[0]!, ajeno], now: bogota('2026-09-23', '07:00') }));
  assert.deepEqual(r.skipped, [{ contactId: ajeno, reason: 'not_found' }]);
  assert.equal(r.enrolled.length, 1);
  assert.equal(await scalar<number>(`SELECT count(*)::int AS v FROM outbound_touch WHERE contact_id = $1`, [ajeno]), 0);
  // Y aunque alguien escriba la fila a mano como el worker (BYPASSRLS), la base no la deja.
  await assert.rejects(
    motor.transaction((tx) => tx.query(
      `INSERT INTO outbound_enrollment (workspace_id, sequence_id, contact_id, status) VALUES ($1, $2, $3, 'active')`,
      [a.id, a.seq, ajeno],
    )),
    /no es del workspace/,
  );
  await assert.rejects(
    motor.transaction((tx) => tx.query(
      `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, scheduled_for)
       VALUES ($1, $2, $3, 'email', 'hola', 'scheduled', now())`,
      [a.id, a.company, ajeno],
    )),
    /no es del workspace/,
  );
});

test('un lote con una ficha rebotada enrola la buena y dice por qué no la otra, sin tumbar el lote', async () => {
  const w = await workspace(3, { contacts: 2 });
  const [buena, rebotada] = w.contacts as [string, string];
  await rebotar(rebotada);
  const r = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: w.seq, contactIds: [buena, rebotada], now: bogota('2026-09-23', '07:00') }));
  assert.deepEqual(r.enrolled.map((e) => e.contactId), [buena]);
  assert.deepEqual(r.skipped, [{ contactId: rebotada, reason: 'email_invalid' }]);
  assert.equal(await scalar<number>(`SELECT count(*)::int AS v FROM outbound_enrollment WHERE contact_id = $1`, [rebotada]), 0);
});

test('en una secuencia mixta, a la ficha rebotada solo se le saltan los correos: LinkedIn sigue y la cadencia empieza por él', async () => {
  const w = await workspace(4, { contacts: 1 });
  const c = w.contacts[0]!;
  await unipile(w, 'linkedin', 20);
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

test('una ficha con el correo mal escrito se salta y el resto del lote sale; al enrolar se dice invalid_address', async () => {
  const w = await workspace(5, { contacts: 2 });
  const [c1, c2] = w.contacts as [string, string];
  await enroll(w, bogota('2026-09-23', '07:00'));
  await db.raw.query(`UPDATE contact SET email = 'carla arroba marca.test' WHERE id = $1`, [c1]);
  const fake = fakeChannels();
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(r.sent.length, 1, 'la otra sale: el lote no se cae');
  assert.equal(r.claim.skippedInvalidAddress, 1);
  const [t1] = await touches(c1);
  assert.deepEqual([t1!.status, t1!.blocked_reason], ['skipped', 'invalid_address']);
  assert.equal((await touches(c2))[0]!.status, 'sent');

  const nuevo = `${w.id.slice(0, 24)}0000000c0f0f`;
  await db.raw.exec(`INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source)
                     VALUES ('${nuevo}', '${w.company}', '${w.id}', 'Mal Escrita', 'sin-arroba.marca.test', 'user_provided')`);
  const e = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: w.seq, contactIds: [nuevo], now: bogota('2026-09-23', '07:00') }));
  assert.deepEqual(e.skipped, [{ contactId: nuevo, reason: 'invalid_address' }]);
});

test('un correo nuevo sin asunto nace retenido (no_subject) y, si llega a la cola, el despachador tampoco lo envía', async () => {
  const w = await workspace(6, { contacts: 2 });
  const [c1, c2] = w.contacts as [string, string];
  const seq = `${w.id.slice(0, 24)}${hex(0x5e88, 12)}`;
  await db.raw.exec(`
    INSERT INTO outbound_sequence (id, workspace_id, name, channel, status, automation_mode) VALUES ('${seq}', '${w.id}', 'Sin asunto', 'email', 'active', 'auto');
    INSERT INTO outbound_step (workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time, subject_template,
                               body_template, generate_with_ai)
    VALUES ('${w.id}', '${seq}', 0, 0, 'email', 'email', '10:00', NULL, 'Hola, {{first_name}}.', false);
  `);
  const e = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: seq, contactIds: [c1], now: bogota('2026-09-23', '07:00') }));
  assert.equal(e.enrolled[0]!.held, 1);
  assert.equal(await scalar<string>(`SELECT held_reason AS v FROM outbound_touch WHERE contact_id = $1 AND sequence_id = $2`, [c1, seq]), 'no_subject');

  // Uno que alguien dejó en la cola sin asunto (la web lo programó a mano).
  await enroll(w, bogota('2026-09-23', '07:00'), [c2]);
  const [primero] = await touches(c2);
  await db.raw.query(`UPDATE outbound_touch SET subject = '  ' WHERE id = $1`, [primero!.id]);
  const fake = fakeChannels();
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(r.sent.length, 0);
  assert.deepEqual(r.held, [{ touchId: primero!.id, reason: 'no_subject' }]);
  assert.equal((await touches(c2))[0]!.held_reason, 'no_subject');
  assert.equal(fake.email.sent.length, 0, 'nunca «(sin asunto)»');
});

test('la respuesta en el hilo cuyo correo no salió se retiene: nunca huérfana ni sin asunto', async () => {
  const w = await workspace(7, { contacts: 1 });
  const c = w.contacts[0]!;
  await enroll(w, bogota('2026-09-23', '07:00')); // miércoles
  const fake = fakeChannels();
  fake.email.failNext(1, { kind: 'permanent', code: 'rejected', message: 'el proveedor lo rechazó' });
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(r.failed.length, 1);
  const r2 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-24', '12:00')));
  assert.equal(r2.sent.length, 0);
  assert.equal(r2.held.length, 1);
  const [t1, t2] = await touches(c);
  assert.equal(t1!.status, 'failed');
  assert.equal(t2!.status, 'held');
  assert.equal(t2!.held_reason, 'reply_without_thread', 'un código, no una frase (r4)');
  assert.match(holdReasonText('es', t2!.held_reason!), /no salió/);
  assert.equal(fake.email.sent.length, 0);
});

test('un paso generado por IA que sigue en borrador frena a los de detrás; un borrador manual no', async () => {
  const w = await workspace(8, { contacts: 1, firstStepByAi: true });
  const c = w.contacts[0]!;
  await enroll(w, bogota('2026-09-23', '07:00')); // miércoles
  assert.deepEqual((await touches(c)).map((t) => t.status), ['draft', 'scheduled', 'scheduled'], 'el 1 espera al generador de VEN-12');
  const fake = fakeChannels();
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-25', '12:00')));
  assert.equal(r.claim.claimed, 0, 'el 2 y el 3 ya vencieron, pero la cadencia no empieza por el día 2');
  assert.equal(fake.email.sent.length, 0);

  // Un paso manual (una tarea) en borrador no frena nada: lo hace una persona cuando pueda.
  const m = await workspace(9, { contacts: 1 });
  await db.raw.exec(`
    UPDATE outbound_step SET step_type = 'manual_task', subject_template = NULL WHERE id = '${m.steps[0]}';
    UPDATE outbound_step SET step_type = 'email', subject_template = 'Una idea para {{company}}' WHERE id = '${m.steps[1]}';
  `);
  await enroll(m, bogota('2026-09-23', '07:00'));
  assert.equal((await touches(m.contacts[0]!))[0]!.status, 'draft');
  const fm = fakeChannels();
  const rm = await runDispatch(motor, deps(m, fm, () => bogota('2026-09-24', '12:00')));
  assert.equal(rm.sent.length, 1, 'el correo del día 1 sale');
  assert.equal(fm.email.sent[0]!.subject, 'Una idea para Marca 9');
});

test('el último paso sin dirección no deja la cadencia activa para siempre', async () => {
  const w = await workspace(10, { contacts: 1 });
  const c = w.contacts[0]!;
  const enr = await enroll(w, bogota('2026-09-23', '07:00'));
  // Los dos primeros ya salieron; antes del tercero, alguien borró el correo de la ficha.
  await db.raw.query(
    `UPDATE outbound_touch SET status = 'sent', sent_at = scheduled_for, attempt_count = 1, provider_message_id = 'enviado-' || step_index,
            thread_ref = 'hilo-10', recipient_address = 'p1.motor-enrolar10@marca.test', channel_account_id = $2
      WHERE enrollment_id = $1 AND step_index IN (1, 2)`,
    [enr.get(c), w.gmail],
  );
  await db.raw.query(`UPDATE contact SET email = NULL WHERE id = $1`, [c]);
  const r = await runDispatch(motor, deps(w, fakeChannels(), () => bogota('2026-09-25', '12:00')));
  assert.equal(r.claim.skippedNoAddress, 1);
  assert.equal(await scalar<string>(`SELECT status AS v FROM outbound_enrollment WHERE id = $1`, [enr.get(c)]), 'completed');
  assert.match(resumenDespacho(r), /Sin dirección: 1\./);
});

test('un mensaje retenido guarda un código, avisa una sola vez y lleva a la ficha de la empresa', async () => {
  const w = await workspace(11, { contacts: 1, locale: 'en-US' });
  const c = w.contacts[0]!;
  await enroll(w, bogota('2026-09-23', '07:00'));
  const [t1] = await touches(c);
  await db.raw.query(`UPDATE outbound_touch SET body = 'Hola, [NOMBRE]: te escribo por la campaña.' WHERE id = $1`, [t1!.id]);
  const fake = fakeChannels();
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(r.held.length, 1);
  assert.equal((await touches(c))[0]!.held_reason, 'placeholders:[NOMBRE]', 'un código con su dato, no una frase');
  // La persona lo vuelve a programar sin corregirlo: se retiene otra vez, sin otro aviso.
  await db.raw.query(`UPDATE outbound_touch SET status = 'scheduled', held_reason = NULL WHERE id = $1`, [t1!.id]);
  await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '13:00')));
  const avisos = await db.raw.query<{ severity: string; title_es: string; body_es: string; action_url: string }>(
    `SELECT severity, title_es, body_es, action_url FROM notification WHERE workspace_id = $1 AND entity_type = 'outbound_touch_held'`, [w.id],
  );
  assert.equal(avisos.rows.length, 1, 'uno por mensaje');
  assert.equal(avisos.rows[0]!.title_es, 'A message to Marca 11 needs your review', 'en el idioma del workspace');
  assert.match(avisos.rows[0]!.body_es, /there are unfilled placeholders \(\[NOMBRE\]\)/);
  assert.equal(avisos.rows[0]!.action_url, `/ventas/empresas/${w.company}#cadencia`, 'al bloque donde se aprueba (r5)');
  assert.equal(fake.email.sent.length, 0);
});

test('la guardia de huecos mira el mensaje final: un pie con un hueco en la dirección postal no sale', async () => {
  const w = await workspace(12, { contacts: 1 });
  const c = w.contacts[0]!;
  await db.raw.query(`UPDATE outbound_policy SET postal_address = '[DIRECCIÓN POSTAL]' WHERE workspace_id = $1`, [w.id]);
  await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(r.sent.length, 0);
  assert.equal(r.held.length, 1);
  assert.equal((await touches(c))[0]!.held_reason, 'placeholders:[DIRECCIÓN POSTAL]');
  assert.equal(fake.email.sent.length, 0);
});

test('una nota de invitación de más de 300 caracteres no se corta: se retiene, al enrolar y al enviar', async () => {
  assert.equal(LINKEDIN_INVITE_NOTE_MAX, CONNECTOR_NOTE_MAX, 'el mismo límite que el cliente de Unipile');
  const w = await workspace(13, { contacts: 1 });
  const c = w.contacts[0]!;
  await unipile(w, 'linkedin', 20);
  const larga = 'Hola, {{first_name}}. ' + 'Me encantaría conectar contigo para hablar de una campaña. '.repeat(6);
  const seq = await secuencia(w, 5, [{ type: 'linkedin_connect', channel: 'linkedin', day: 0, body: larga }]);
  const r = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: seq, contactIds: [c], now: bogota('2026-09-23', '07:00') }));
  assert.equal(r.enrolled[0]!.held, 1);
  const held = await scalar<string>(`SELECT held_reason AS v FROM outbound_touch WHERE enrollment_id = $1`, [r.enrolled[0]!.enrollmentId]);
  assert.match(held, /^note_too_long:\d+$/);
  assert.match(holdReasonText('es', held), /tiene \d+ caracteres y el máximo es 300/);
  // Si alguien la aprueba tal cual, la relectura antes de enviar la retiene otra vez: no sale cortada.
  await db.raw.query(`UPDATE outbound_touch SET status = 'scheduled', held_reason = NULL WHERE enrollment_id = $1`, [r.enrolled[0]!.enrollmentId]);
  const fake = fakeChannels();
  const d = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(d.held.length, 1);
  assert.equal(fake.linkedin.sent.length, 0);
});

test('los avisos hablan el idioma del workspace', async () => {
  const w = await workspace(14, { contacts: 1, locale: 'en-US' });
  await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  fake.email.failNext(1, { kind: 'permanent', code: 'invalid_recipient', message: 'invalid To header' });
  await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  const aviso = await db.raw.query<{ title_es: string; body_es: string; action_url: string }>(
    `SELECT title_es, body_es, action_url FROM notification WHERE workspace_id = $1 AND kind = 'outreach_failed'`, [w.id],
  );
  assert.equal(aviso.rows[0]!.title_es, 'A message to Marca 14 was not sent');
  assert.equal(aviso.rows[0]!.body_es, "The message to Persona 1 Prueba over email was not sent: the address is not valid. Check Marca 14's page.");
  assert.equal(aviso.rows[0]!.action_url, `/ventas/empresas/${w.company}#cadencia`, 'a la ficha, no a una cola que no existe (r4)');
});
