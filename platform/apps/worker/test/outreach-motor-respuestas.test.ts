/**
 * VEN-10 · lo que hace una respuesta, venga por el lector del motor o por
 * el webhook: cancelar lo pendiente, detener la cadencia, dar de baja o
 * dejarlo a una persona. Postgres embebido con las migraciones del repo,
 * como mc_worker, con el canal falso y un reloj falso. Sin red.
 *
 *   · el lector recorre todos los hilos por turno;
 *   · una respuesta automática no cuenta como respuesta, salvo que pida la baja;
 *   · la baja después de una respuesta se respeta en todas las secuencias;
 *   · la baja se queda en el workspace del mensaje, y una ficha pública no se marca;
 *   · un tercero en copia que pide la baja no da de baja a la ficha.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { enrollContacts, OPEN_THREADS_PAGE } from '@mc/db/queries/outreach';
import { fakeChannels } from '../src/jobs/ventas/canales/fake.ts';
import { runDispatch } from '../src/jobs/ventas/outbound.dispatch.ts';
import { runReplies } from '../src/jobs/ventas/outbound.replies.ts';
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

const { workspace, enroll, deps, touches, scalar } = motorKit({ db: () => db, motor: () => motor, prefix: '00000113', slug: 'motor-respuestas' });

test('el lector recorre todos los hilos por turno: con 250, la respuesta del hilo 240 se ve en dos corridas', async () => {
  const w = await workspace(1, { contacts: 1 });
  const contact = w.contacts[0]!;
  const now = bogota('2026-09-24', '12:00');
  // 250 correos enviados, uno por hilo; hilo-000 el más reciente, hilo-249 el más viejo.
  await motor.transaction((tx) => tx.query(
    `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, attempt_count, sent_at, thread_ref,
                                 provider_message_id, channel_account_id, recipient_address)
     SELECT $1::uuid, $2::uuid, $3::uuid, 'email', 'Hola.', 'sent', 1, $4::timestamptz - make_interval(mins => i),
            'hilo-' || lpad(i::text, 3, '0'), 'enviado-' || i, $5::uuid, 'p1.motor-respuestas1@marca.test'
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

test('una respuesta automática que pide la baja da de baja; no cuenta como respuesta', async () => {
  const w = await workspace(3, { contacts: 1 });
  const c = w.contacts[0]!;
  const enr = await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  const hilo = fake.email.sent[0]!.threadRef;
  fake.email.reply(hilo, 'Ya no trabajo aquí. Sáquenme de su lista.', bogota('2026-09-23', '12:05'), undefined, { automatic: true });
  const r = await runReplies(motor, { readers: fake, now: () => bogota('2026-09-23', '13:00'), workspaceId: w.id });
  assert.deepEqual([r.inbound, r.optOuts, r.automatic], [1, 1, 1]);
  assert.equal(await scalar<boolean>(`SELECT opted_out AS v FROM contact WHERE id = $1`, [c]), true);
  assert.equal(await scalar<string>(`SELECT status AS v FROM outbound_enrollment WHERE id = $1`, [enr.get(c)]), 'opted_out');
  assert.equal(await scalar<Date | null>(`SELECT replied_at AS v FROM outbound_touch WHERE thread_ref = $1`, [hilo]), null, 'no es una respuesta');
});

test('la baja que llega después de una respuesta se respeta, y cancela lo de las otras secuencias', async () => {
  const w = await workspace(4, { contacts: 1 });
  const c = w.contacts[0]!;
  const enr = await enroll(w, bogota('2026-09-23', '07:00'));
  // La misma marca, también en otra secuencia de un paso.
  const seq2 = `${w.id.slice(0, 24)}0000005e0002`;
  const step2 = `${w.id.slice(0, 24)}0000005e0201`;
  await db.raw.exec(`
    INSERT INTO outbound_sequence (id, workspace_id, name, channel, status, automation_mode)
    VALUES ('${seq2}', '${w.id}', 'Otra', 'email', 'active', 'auto');
    INSERT INTO outbound_step (id, workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time,
                               subject_template, body_template, generate_with_ai)
    VALUES ('${step2}', '${w.id}', '${seq2}', 3, 0, 'email', 'email', '10:00', 'Otra idea', 'Otra idea para {{company}}.', false);
  `);
  const otra = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: seq2, contactIds: [c], now: bogota('2026-09-23', '07:00') }));
  const fake = fakeChannels();
  let clock = bogota('2026-09-23', '12:00');
  await runDispatch(motor, deps(w, fake, () => clock));
  const hilo = fake.email.sent[0]!.threadRef;

  fake.email.reply(hilo, 'Hola. Me interesa, ¿hablamos el jueves?', bogota('2026-09-23', '13:00'));
  clock = bogota('2026-09-23', '14:00');
  const r1 = await runReplies(motor, { readers: fake, now: () => clock, workspaceId: w.id });
  assert.deepEqual([r1.inbound, r1.optOuts], [1, 0]);
  assert.equal(await scalar<string>(`SELECT status AS v FROM outbound_enrollment WHERE id = $1`, [enr.get(c)]), 'replied');

  // Días después, en el mismo hilo: la baja. El hilo de una cadencia que respondió se sigue leyendo.
  fake.email.reply(hilo, 'Lo pensamos mejor. No nos escriban más, gracias.', bogota('2026-09-24', '09:00'));
  clock = bogota('2026-09-24', '10:00');
  const r2 = await runReplies(motor, { readers: fake, now: () => clock, workspaceId: w.id });
  assert.deepEqual([r2.inbound, r2.optOuts], [1, 1]);
  assert.equal(await scalar<boolean>(`SELECT opted_out AS v FROM contact WHERE id = $1`, [c]), true);
  // Lo de la otra secuencia se cancela YA, no cuando venza.
  assert.equal(await scalar<string>(`SELECT status AS v FROM outbound_enrollment WHERE id = $1`, [otra.enrolled[0]!.enrollmentId]), 'opted_out');
  assert.equal(
    await scalar<string>(`SELECT status || ':' || blocked_reason AS v FROM outbound_touch WHERE step_id = $1`, [step2]),
    'canceled:opted_out',
  );
  const avisos = await db.raw.query<{ severity: string; title_es: string }>(
    `SELECT severity, title_es FROM notification WHERE workspace_id = $1 AND kind = 'outreach_reply' ORDER BY created_at`, [w.id],
  );
  assert.deepEqual(avisos.rows.map((a) => a.severity), ['success', 'warning'], 'un aviso de respuesta y uno de baja, sin repetir el de respuesta');
  assert.equal(avisos.rows[1]!.title_es, 'Persona 1 Prueba pidió no recibir más mensajes');
});

test('una ficha pública que responde «no me escriban más»: no se marca la ficha compartida, A no la vuelve a enrolar y B sí', async () => {
  const a = await workspace(5, { contacts: 1 });
  const b = await workspace(6, { contacts: 1 });
  const base = `0000010e-00ff-4000-8000-`;
  const [empresa, ficha] = [`${base}0000000000c9`, `${base}0000000c0c09`];
  await db.raw.exec(`
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${empresa}', 'Marca del catálogo', NULL);
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${a.id}', '${empresa}'), ('${b.id}', '${empresa}');
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source)
    VALUES ('${ficha}', '${empresa}', NULL, 'Prensa Catálogo', 'prensa@catalogo.test', 'press');
  `);
  const enrA = await enroll(a, bogota('2026-09-23', '07:00'), [ficha]);
  const fakeA = fakeChannels();
  await runDispatch(motor, deps(a, fakeA, () => bogota('2026-09-23', '12:00')));
  const hilo = fakeA.email.sent.find((m) => m.recipient === 'prensa@catalogo.test')!.threadRef;
  fakeA.email.reply(hilo, 'Gracias, pero no me escriban más.', bogota('2026-09-23', '13:00'));
  const r = await runReplies(motor, { readers: fakeA, now: () => bogota('2026-09-23', '14:00'), workspaceId: a.id });
  assert.equal(r.optOuts, 1);

  assert.equal(await scalar<boolean>(`SELECT opted_out AS v FROM contact WHERE id = $1`, [ficha]), false, 'la ficha compartida no se marca');
  assert.equal(await scalar<string>(`SELECT status AS v FROM outbound_enrollment WHERE id = $1`, [enrA.get(ficha)]), 'opted_out');
  // A no la vuelve a enrolar, ni en otra secuencia: su enrolamiento en opted_out la protege.
  const otraA = `${a.id.slice(0, 24)}0000005e0009`;
  await db.raw.exec(`
    INSERT INTO outbound_sequence (id, workspace_id, name, channel, status, automation_mode) VALUES ('${otraA}', '${a.id}', 'Otra', 'email', 'active', 'auto');
    INSERT INTO outbound_step (workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time, subject_template,
                               body_template, generate_with_ai)
    VALUES ('${a.id}', '${otraA}', 0, 0, 'email', 'email', '10:00', 'Hola', 'Hola.', false);
  `);
  const deNuevo = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: otraA, contactIds: [ficha], now: bogota('2026-09-24', '07:00') }));
  assert.deepEqual(deNuevo.skipped, [{ contactId: ficha, reason: 'opted_out' }]);
  // B, que no recibió esa respuesta, sí la enrola y le escribe.
  const enrB = await enroll(b, bogota('2026-09-24', '07:00'), [ficha]);
  assert.ok(enrB.get(ficha));
  const fakeB = fakeChannels();
  const rB = await runDispatch(motor, deps(b, fakeB, () => bogota('2026-09-24', '12:00')));
  assert.equal(rB.sent.length, 1);
  assert.equal(fakeB.email.sent[0]!.recipient, 'prensa@catalogo.test');
});

test('una baja por respuesta en A no toca la ficha de B con el mismo correo, ni sus mensajes, ni su cadencia', async () => {
  const a = await workspace(7, { contacts: 1 });
  const b = await workspace(8, { contacts: 1 });
  const [ca] = a.contacts as [string];
  const [cb] = b.contacts as [string];
  const correo = 'marcela@marca-compartida.test';
  await db.raw.query(`UPDATE contact SET email = $2 WHERE id = ANY($1::uuid[])`, [[ca, cb], correo]);
  const enrA = await enroll(a, bogota('2026-09-23', '07:00'));
  const enrB = await enroll(b, bogota('2026-09-23', '07:00'));
  // Un buzón por creadora: cada una tiene su Gmail.
  const fakeA = fakeChannels();
  const fakeB = fakeChannels();
  await runDispatch(motor, deps(a, fakeA, () => bogota('2026-09-23', '12:00')));
  await runDispatch(motor, deps(b, fakeB, () => bogota('2026-09-23', '12:00')));
  assert.equal(fakeA.email.sent.length + fakeB.email.sent.length, 2);

  fakeA.email.reply(fakeA.email.sent[0]!.threadRef, 'Por favor, sáquenme de su lista.', bogota('2026-09-23', '13:00'));
  const r = await runReplies(motor, { readers: fakeA, now: () => bogota('2026-09-23', '14:00'), workspaceId: a.id });
  assert.equal(r.optOuts, 1);

  assert.equal(await scalar<boolean>(`SELECT opted_out AS v FROM contact WHERE id = $1`, [ca]), true, 'A: la ficha de baja');
  assert.equal(await scalar<string>(`SELECT status AS v FROM outbound_enrollment WHERE id = $1`, [enrA.get(ca)]), 'opted_out');
  assert.equal(await scalar<boolean>(`SELECT opted_out AS v FROM contact WHERE id = $1`, [cb]), false, 'B: su ficha, intacta');
  assert.equal(await scalar<string>(`SELECT status AS v FROM outbound_enrollment WHERE id = $1`, [enrB.get(cb)]), 'active');
  assert.deepEqual((await touches(cb)).map((t) => t.status), ['sent', 'scheduled', 'scheduled'], 'B: lo pendiente sigue');
  assert.equal(await scalar<number>(`SELECT count(*)::int AS v FROM notification WHERE workspace_id = $1 AND kind = 'outreach_reply'`, [b.id]), 0);
  // Ni la lista global: una baja por respuesta no es verificable (0029 §1).
  assert.equal(await scalar<boolean>(`SELECT address_is_suppressed($1::citext) AS v`, [correo]), false);
  // Y B sigue escribiéndole: su siguiente correo sale.
  const r2 = await runDispatch(motor, deps(b, fakeB, () => bogota('2026-09-24', '15:00')));
  assert.equal(r2.sent.length, 1);
});

test('un tercero en copia que pide la baja no da de baja a la ficha: la cadencia se detiene y se avisa para revisar', async () => {
  const w = await workspace(9, { contacts: 1 });
  const [c] = w.contacts as [string];
  const enr = await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  const hilo = fake.email.sent[0]!.threadRef;
  fake.email.reply(hilo, 'Please remove me from your list.', bogota('2026-09-23', '13:00'), 'Jefe de Compras <jefe@otra-area.test>');
  const r = await runReplies(motor, { readers: fake, now: () => bogota('2026-09-23', '14:00'), workspaceId: w.id });
  assert.equal(r.optOuts, 0, 'no es una baja de la ficha');
  assert.equal(await scalar<boolean>(`SELECT opted_out AS v FROM contact WHERE id = $1`, [c]), false);
  assert.equal(await scalar<string>(`SELECT intent AS v FROM outbound_message WHERE direction = 'inbound' AND workspace_id = $1`, [w.id]), 'unsubscribe');
  assert.equal(await scalar<string>(`SELECT status AS v FROM outbound_enrollment WHERE id = $1`, [enr.get(c)]), 'replied', 'la cadencia se detiene');
  assert.deepEqual((await touches(c)).map((t) => t.status), ['sent', 'canceled', 'canceled']);
  const aviso = await db.raw.query<{ title_es: string; body_es: string }>(
    `SELECT title_es, body_es FROM notification WHERE workspace_id = $1 AND kind = 'outreach_reply'`, [w.id],
  );
  assert.equal(aviso.rows.length, 1);
  assert.match(aviso.rows[0]!.title_es, /Alguien en el hilo/);
  assert.match(aviso.rows[0]!.body_es, /jefe@otra-area\.test/);

  // La misma frase desde el correo de la ficha sí es su baja.
  const w2 = await workspace(10, { contacts: 1 });
  const [c2] = w2.contacts as [string];
  await enroll(w2, bogota('2026-09-23', '07:00'));
  await runDispatch(motor, deps(w2, fake, () => bogota('2026-09-23', '12:00')));
  const m2 = fake.email.sent.find((m) => m.workspaceId === w2.id)!;
  fake.email.reply(m2.threadRef, 'Please remove me from your list.', bogota('2026-09-23', '13:00'), `Persona <${m2.recipient.toUpperCase()}>`);
  const r2 = await runReplies(motor, { readers: fake, now: () => bogota('2026-09-23', '14:00'), workspaceId: w2.id });
  assert.equal(r2.optOuts, 1);
  assert.equal(await scalar<boolean>(`SELECT opted_out AS v FROM contact WHERE id = $1`, [c2]), true);
});
