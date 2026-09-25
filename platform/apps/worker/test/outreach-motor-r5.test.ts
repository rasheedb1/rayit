/**
 * VEN-10 r5 · lo que la quinta revisión encontró en el motor, caso por
 * caso, sobre Postgres embebido con las migraciones del repo, como
 * mc_worker, con el canal falso (o el de Unipile sobre FakeUnipile) y un
 * reloj falso. Sin red.
 *
 *   · una baja por respuesta se queda en su workspace: la ficha de otro
 *     workspace con el mismo correo sigue intacta (hallazgos 1 y 12);
 *   · un tercero en copia que pide la baja no da de baja a la ficha (5);
 *   · un 422 de Unipile falla solo ese mensaje; un 404 del chat abre otro (3);
 *   · la política de la marca: el tope de mensajes y la separación en
 *     días, también entre secuencias (9);
 *   · la revisión humana: los mensajes nacen retenidos y no salen (10);
 *   · el ritmo por hora de la cuenta: 15 Instagram vencidos a las 09:00
 *     salen como mucho 10 en la primera hora (14);
 *   · el tope reprograma al siguiente día hábil del WORKSPACE (16).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeUnipile } from '@mc/connectors';
import { zonedParts } from '@mc/core';
import { enrollContacts } from '@mc/db/queries/outreach';
import { fakeChannels } from '../src/jobs/ventas/canales/fake.ts';
import { UnipileChannel } from '../src/jobs/ventas/canales/unipile.ts';
import { runDispatch } from '../src/jobs/ventas/outbound.dispatch.ts';
import { runReplies } from '../src/jobs/ventas/outbound.replies.ts';
import { motorDbFromJob, type MotorDb } from '../src/jobs/ventas/motor-db.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { openTestDatabase, SETUP_TIMEOUT } from './helpers/harness.ts';
import { bogota, hex, localDay, motorKit, TZ, type Ws } from './helpers/motor-kit.ts';

let db: PgliteDatabase;
let motor: MotorDb;

before(async () => {
  db = await openTestDatabase();
  motor = motorDbFromJob(db);
}, SETUP_TIMEOUT);
after(async () => {
  await db?.close();
});

const { workspace, enroll, deps, touches, scalar } = motorKit({ db: () => db, motor: () => motor, prefix: '0000010f', slug: 'motor-r5' });

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

/** Una cuenta de Unipile conectada (LinkedIn o Instagram) y la dirección de cada ficha en ese canal. */
async function unipile(w: Ws, channel: 'linkedin' | 'instagram_dm', dailyCap = 100): Promise<string> {
  const acc = `${w.id.slice(0, 24)}0000000ac0${channel === 'linkedin' ? '02' : '03'}`;
  await db.raw.exec(`
    INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, display_name, status, daily_cap, weekly_cap)
    VALUES ('${acc}', '${w.id}', '${channel}', 'unipile', 'uni-${channel}-${w.n}', 'Creadora ${w.n}', 'connected', ${dailyCap}, ${channel === 'linkedin' ? 200 : 700});
    UPDATE contact SET linkedin_url = 'https://www.linkedin.com/in/persona-' || right(id::text, 4),
                       instagram_handle = 'persona_' || right(id::text, 4)
     WHERE owner_workspace_id = '${w.id}';
  `);
  return acc;
}

// ---------------------------------------------------------------------
// La baja se queda en su workspace (hallazgos 1 y 12)
// ---------------------------------------------------------------------

test('una baja por respuesta en A no toca la ficha de B con el mismo correo, ni sus mensajes, ni su cadencia', async () => {
  const a = await workspace(1, { contacts: 1 });
  const b = await workspace(2, { contacts: 1 });
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
  const w = await workspace(3, { contacts: 1 });
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
  const w2 = await workspace(4, { contacts: 1 });
  const [c2] = w2.contacts as [string];
  await enroll(w2, bogota('2026-09-23', '07:00'));
  await runDispatch(motor, deps(w2, fake, () => bogota('2026-09-23', '12:00')));
  const m2 = fake.email.sent.find((m) => m.workspaceId === w2.id)!;
  fake.email.reply(m2.threadRef, 'Please remove me from your list.', bogota('2026-09-23', '13:00'), `Persona <${m2.recipient.toUpperCase()}>`);
  const r2 = await runReplies(motor, { readers: fake, now: () => bogota('2026-09-23', '14:00'), workspaceId: w2.id });
  assert.equal(r2.optOuts, 1);
  assert.equal(await scalar<boolean>(`SELECT opted_out AS v FROM contact WHERE id = $1`, [c2]), true);
});

// ---------------------------------------------------------------------
// Unipile: solo los códigos explícitos cancelan la cadencia (hallazgo 3)
// ---------------------------------------------------------------------

test('un 422 genérico de Unipile falla solo ese mensaje: los otros pasos de LinkedIn siguen', async () => {
  const w = await workspace(5, { contacts: 1 });
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

// ---------------------------------------------------------------------
// La política de la marca (hallazgo 9)
// ---------------------------------------------------------------------

test('una secuencia de seis pasos con un tope de cuatro por marca: salen cuatro y los otros dos se cancelan; otra secuencia suma', async () => {
  const w = await workspace(6, { contacts: 2, maxTouchesPerCompany: 4 });
  const [c, otra] = w.contacts as [string, string];
  const pasos = [0, 1, 2, 3, 4, 5].map((d) => ({ type: 'email', channel: 'email', day: d, subject: `Idea ${d + 1}`, body: `Idea ${d + 1} para {{company}}.` }));
  const seq = await secuencia(w, 2, pasos);
  const r = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: seq, contactIds: [c], now: bogota('2026-09-23', '07:00') }));
  // (r3) Con los pasos concretos que se cancelarán: los dos últimos.
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
  const w = await workspace(7, { contacts: 1, minDaysBetweenTouches: 3 });
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

// ---------------------------------------------------------------------
// La revisión humana (hallazgo 10)
// ---------------------------------------------------------------------

test('con la revisión humana encendida los mensajes nacen retenidos (needs_review) y el despachador no envía nada', async () => {
  const w = await workspace(8, { contacts: 1, humanReview: true });
  const [c] = w.contacts as [string];
  const r = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: w.seq, contactIds: [c], now: bogota('2026-09-23', '07:00') }));
  assert.deepEqual([r.enrolled[0]!.scheduled, r.enrolled[0]!.held], [0, 3]);
  assert.deepEqual((await touches(c)).map((t) => [t.status, t.held_reason]), [['held', 'needs_review'], ['held', 'needs_review'], ['held', 'needs_review']]);
  const fake = fakeChannels();
  const d = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '15:00')));
  assert.equal(d.claim.claimed, 0);
  assert.equal(fake.email.sent.length, 0);
  // Una secuencia en modo 'review' también, aunque la política no pida revisión.
  const w2 = await workspace(9, { contacts: 1 });
  await db.raw.query(`UPDATE outbound_sequence SET automation_mode = 'review' WHERE id = $1`, [w2.seq]);
  const r2 = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: w2.seq, contactIds: w2.contacts, now: bogota('2026-09-23', '07:00') }));
  assert.equal(r2.enrolled[0]!.held, 3);
});

// ---------------------------------------------------------------------
// El ritmo de la cuenta (hallazgo 14) y el día de los contadores (16)
// ---------------------------------------------------------------------

test('15 Instagram vencidos a las 09:00 salen como mucho 10 en la primera hora, separados, y el resto después', async () => {
  const w = await workspace(10, { contacts: 15 });
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
  const w = await workspace(11, { contacts: 2, dailyCap: 1, sequenceTimeZone: 'Europe/Madrid' });
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
