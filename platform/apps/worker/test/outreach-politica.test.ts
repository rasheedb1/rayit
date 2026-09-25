/**
 * VEN-10 r2 · la política del workspace y los bordes que la segunda
 * revisión encontró, de punta a punta sobre Postgres embebido, como
 * mc_worker, con el canal falso y un reloj falso. Sin red.
 *
 *   · revisión humana: en 'review' (o con require_human_review) los
 *     mensajes nacen retenidos, el despachador no los toma, y salen al
 *     aprobarlos (approveHeldTouch);
 *   · la marca: min_days_between_touches separa los mensajes a la misma
 *     empresa y max_touches_per_company los topa;
 *   · una ficha con una dirección mal escrita se salta y no tumba el
 *     reclamo de las demás;
 *   · lo vencido a las 02:00 de un sábado pasa al lunes sin salir;
 *   · la respuesta después del último paso (cadencia completed) se
 *     registra, y su baja se respeta;
 *   · el lector de respuestas sigue donde se quedó (limit).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { isInsideWindow, zonedParts } from '@mc/core';
import { approveHeldTouch, enrollContacts, REVIEW_HELD_REASON } from '@mc/db/queries/outreach';
import { fakeChannels } from '../src/jobs/ventas/canales/fake.ts';
import type { ChannelSender } from '../src/jobs/ventas/canales/types.ts';
import { runDispatch, type DispatchDeps } from '../src/jobs/ventas/outbound.dispatch.ts';
import { runReplies } from '../src/jobs/ventas/outbound.replies.ts';
import { motorDbFromJob, type MotorDb } from '../src/jobs/ventas/motor-db.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { openTestDatabase } from './helpers/harness.ts';

const TZ = 'America/Bogota';
const W = { start: '09:00', end: '17:00' };
/** Un instante a una hora local de Bogotá (UTC−5, sin horario de verano). */
const bogota = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-05:00`);

let db: PgliteDatabase;
let motor: MotorDb;

before(async () => {
  db = await openTestDatabase();
  motor = motorDbFromJob(db);
});
after(async () => {
  await db?.close();
});

interface Politica {
  review?: boolean;
  minDays?: number;
  maxPerCompany?: number;
  mode?: 'auto' | 'review' | 'manual';
}

interface Ws {
  id: string;
  seq: string;
  steps: [string, string, string];
  /** Un contacto por empresa, salvo sameCompany. */
  contacts: string[];
  companies: string[];
}

function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, '0');
}

/**
 * Un workspace con su Gmail, la política encendida y una secuencia de tres
 * correos (día 0, respuesta el día 1, día 2). Por defecto la política deja
 * salir la cadencia sola; cada prueba enciende lo que mira.
 */
async function workspace(n: number, opts: { contacts?: number; sameCompany?: boolean } & Politica = {}): Promise<Ws> {
  const base = `0000020c-${hex(n, 4)}-4000-8000-`;
  const count = opts.contacts ?? 1;
  const w: Ws = {
    id: `${base}000000000001`,
    seq: `${base}0000005e0001`,
    steps: [`${base}0000005e0101`, `${base}0000005e0102`, `${base}0000005e0103`],
    contacts: Array.from({ length: count }, (_, i) => `${base}0000000c${hex(i + 1, 4)}`),
    companies: Array.from({ length: opts.sameCompany ? 1 : count }, (_, i) => `${base}000000${hex(i + 1, 2)}00c1`),
  };
  const empresas = w.companies.map((c, i) => `('${c}', 'Marca ${n}.${i + 1}', '${w.id}')`).join(', ');
  const enlaces = w.companies.map((c) => `('${w.id}', '${c}')`).join(', ');
  const contactos = w.contacts
    .map((c, i) => `('${c}', '${w.companies[opts.sameCompany ? 0 : i]}', '${w.id}', 'Persona ${i + 1}', 'p${i + 1}.pol${n}@marca.test', 'user_provided')`)
    .join(', ');
  await db.raw.exec(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES ('${w.id}', 'politica-${n}', 'Creadora ${n}', '${TZ}');
    INSERT INTO company (id, name, owner_workspace_id) VALUES ${empresas};
    INSERT INTO company_link (workspace_id, company_id) VALUES ${enlaces};
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source) VALUES ${contactos};
    INSERT INTO outbound_policy (workspace_id, enabled, postal_address, max_emails_per_day,
                                 require_human_review, min_days_between_touches, max_touches_per_company)
    VALUES ('${w.id}', false, 'Calle 93 # 11-26, Bogotá, Colombia', 100,
            ${opts.review ?? false}, ${opts.minDays ?? 0}, ${opts.maxPerCompany ?? 50});
    INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, display_name, status, daily_cap, weekly_cap)
    VALUES ('${base}0000000ac001', '${w.id}', 'email', 'gmail_oauth', 'creadora${n}@gmail.test', 'Creadora ${n}', 'connected', 40, 200);
    INSERT INTO outbound_sequence (id, workspace_id, name, channel, status, automation_mode)
    VALUES ('${w.seq}', '${w.id}', 'Tres correos', 'email', 'active', '${opts.mode ?? 'auto'}');
    INSERT INTO outbound_step (id, workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time,
                               subject_template, body_template, generate_with_ai) VALUES
      ('${w.steps[0]}', '${w.id}', '${w.seq}', 0, 0, 'email', 'email', '09:30', 'Hola, {{first_name}}',
       'Hola, {{first_name}}: te escribo por {{company}}.', false),
      ('${w.steps[1]}', '${w.id}', '${w.seq}', 1, 0, 'email_reply', 'email', '10:00', NULL,
       'Como te comenté ayer, tengo una idea para {{company}}.', false),
      ('${w.steps[2]}', '${w.id}', '${w.seq}', 2, 0, 'email', 'email', '10:00', 'Una última idea',
       'Cierro con mi media kit, {{first_name}}.', false);
    SELECT enable_outreach('${w.id}');
  `);
  return w;
}

async function enroll(w: Ws, at: Date, contacts: readonly string[] = w.contacts) {
  return motor.transaction((tx) => enrollContacts(tx, { sequenceId: w.seq, contactIds: contacts, now: at }));
}

function deps(w: Ws, fake: Record<string, ChannelSender>, clock: () => Date, extra: Partial<DispatchDeps> = {}): DispatchDeps {
  return { senders: fake, now: clock, appUrl: 'https://oncue.test', workspaceId: w.id, ...extra };
}

interface TouchRow {
  id: string;
  status: string;
  scheduled_for: Date;
  held_reason: string | null;
  blocked_reason: string | null;
  attempt_count: number;
}

/** Los tres toques de un contacto, en el orden de sus pasos. */
async function touches(contactId: string): Promise<TouchRow[]> {
  const { rows } = await db.raw.query<TouchRow>(
    `SELECT t.id, t.status, t.scheduled_for, t.held_reason, t.blocked_reason, t.attempt_count
       FROM outbound_touch t JOIN outbound_step s ON s.id = t.step_id
      WHERE t.contact_id = $1 ORDER BY s.day_offset, s.order_in_day`,
    [contactId],
  );
  return rows;
}

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.raw.query<{ v: T }>(sql, params);
  return rows[0]!.v;
}

function localDay(at: Date): string {
  const { date } = zonedParts(at, TZ);
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------
// Revisión humana
// ---------------------------------------------------------------------

test('en review los mensajes nacen retenidos, el despachador no los toma, y salen al aprobarlos', async () => {
  const w = await workspace(1, { mode: 'review', review: true });
  const c = w.contacts[0]!;
  const r = await enroll(w, bogota('2026-09-23', '07:00')); // miércoles
  assert.deepEqual(r.enrolled.map((e) => [e.scheduled, e.held]), [[0, 3]]);
  const antes = await touches(c);
  assert.deepEqual(antes.map((t) => [t.status, t.held_reason]), Array(3).fill(['held', REVIEW_HELD_REASON]));

  const fake = fakeChannels();
  const r1 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(r1.claim.claimed, 0, 'nada sale sin que una persona lo apruebe');
  assert.equal(fake.email.sent.length, 0);

  // La creadora aprueba el primero a las 12:05: sale en la siguiente corrida; el segundo sigue esperando su revisión.
  assert.equal(await motor.transaction((tx) => approveHeldTouch(tx, antes[0]!.id, bogota('2026-09-23', '12:05'))), 'approved');
  const r2 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:06')));
  assert.deepEqual(r2.sent, [antes[0]!.id]);
  const r3 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-24', '12:00')));
  assert.equal(r3.claim.claimed, 0, 'el paso 2 no está aprobado');
  assert.equal(await motor.transaction((tx) => approveHeldTouch(tx, antes[0]!.id, bogota('2026-09-24', '12:00'))), 'not_reviewable');
});

test('con require_human_review, ni una secuencia auto sale sola; sin él, sí', async () => {
  const conRevision = await workspace(2, { mode: 'auto', review: true });
  const r = await enroll(conRevision, bogota('2026-09-23', '07:00'));
  assert.deepEqual(r.enrolled.map((e) => [e.scheduled, e.held]), [[0, 3]]);
  const sinRevision = await workspace(3, { mode: 'auto', review: false });
  const r2 = await enroll(sinRevision, bogota('2026-09-23', '07:00'));
  assert.deepEqual(r2.enrolled.map((e) => [e.scheduled, e.held]), [[3, 0]]);
  // Un retenido por huecos sin rellenar no se aprueba como revisado.
  const [, , t3] = await touches(conRevision.contacts[0]!);
  await db.raw.query(`UPDATE outbound_touch SET held_reason = 'placeholders: {{x}}', body = 'Hola {{x}}' WHERE id = $1`, [t3!.id]);
  assert.equal(await motor.transaction((tx) => approveHeldTouch(tx, t3!.id, bogota('2026-09-23', '08:00'))), 'not_reviewable');
  const inexistente = `${conRevision.id.slice(0, 24)}0000005e0201`;
  assert.equal(await motor.transaction((tx) => approveHeldTouch(tx, inexistente, bogota('2026-09-23', '08:00'))), 'not_found');
});

// ---------------------------------------------------------------------
// La marca: separación mínima y tope
// ---------------------------------------------------------------------

test('min_days_between_touches: el segundo contacto de la misma marca espera tres días, y su cadencia se corre con él', async () => {
  const w = await workspace(4, { contacts: 2, sameCompany: true, minDays: 3 });
  await enroll(w, bogota('2026-09-23', '07:00')); // miércoles
  const fake = fakeChannels();
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(r.sent.length, 1, 'uno sale');
  const gap = r.claim.rescheduled.filter((x) => x.cap === 'company_gap');
  assert.equal(gap.length, 1, 'el otro espera');
  // Miércoles 12:00 + 3 días = sábado: el siguiente hueco es el lunes al abrir.
  assert.equal(localDay(gap[0]!.until), '2026-09-28');
  assert.ok(isInsideWindow(gap[0]!.until, TZ, W));
  const [a, b] = await Promise.all(w.contacts.map(touches));
  const espera = a![0]!.status === 'scheduled' ? a! : b!;
  assert.equal(espera[0]!.id, gap[0]!.touchId);
  assert.equal(espera[0]!.attempt_count, 0, 'sin gastar un intento');
  assert.equal(localDay(espera[1]!.scheduled_for), '2026-09-29', 'el paso 2 un día hábil detrás del 1');
  // El jueves tampoco sale el paso 2 del primero: la marca recibió un mensaje ayer.
  const r2 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-24', '12:00')));
  assert.equal(r2.sent.length, 0);
  assert.ok(r2.claim.rescheduled.length > 0 && r2.claim.rescheduled.every((x) => x.cap === 'company_gap'));
});

test('max_touches_per_company: el mensaje que pasa del tope de la marca se cancela', async () => {
  const w = await workspace(5, { contacts: 2, sameCompany: true, maxPerCompany: 1 });
  await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(r.sent.length, 1);
  assert.equal(r.claim.canceledCompanyCap, 1);
  const estados = (await Promise.all(w.contacts.map(touches))).map((t) => `${t[0]!.status}:${t[0]!.blocked_reason ?? ''}`);
  assert.deepEqual(estados.sort(), ['canceled:max_touches_per_company', 'sent:']);
});

// ---------------------------------------------------------------------
// Direcciones, ventana y asunto
// ---------------------------------------------------------------------

test('una ficha con el correo mal escrito se salta y no tumba el reclamo: la buena sale igual', async () => {
  const w = await workspace(6, { contacts: 2 });
  await enroll(w, bogota('2026-09-23', '07:00'));
  // Después de enrolar, alguien edita la ficha y la deja mal (contact.email no tiene CHECK).
  const [mala, buena] = w.contacts;
  await db.raw.query(`UPDATE contact SET email = 'carla arroba marca.test' WHERE id = $1`, [mala]);
  const fake = fakeChannels();
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(r.claim.skippedInvalidAddress, 1);
  assert.equal(r.sent.length, 1);
  assert.equal(fake.email.sent[0]!.recipient, 'p2.pol6@marca.test');
  assert.deepEqual((await touches(mala!)).map((t) => [t.status, t.blocked_reason])[0], ['skipped', 'invalid_address']);
  assert.equal((await touches(buena!))[0]!.status, 'sent');
  // Y al enrolar, una ficha así nace saltada, sin llegar a la cola.
  const r2 = await enroll(w, bogota('2026-09-23', '12:30'), [mala!]);
  assert.deepEqual(r2.skipped, [{ contactId: mala, reason: 'already_enrolled' }]);
  const otra = await workspace(7);
  await db.raw.query(`UPDATE contact SET email = 'a@b@c' WHERE id = $1`, [otra.contacts[0]]);
  const r3 = await enroll(otra, bogota('2026-09-23', '07:00'));
  assert.deepEqual(r3.enrolled.map((e) => e.skipped), [3]);
  assert.deepEqual((await touches(otra.contacts[0]!)).map((t) => t.blocked_reason), Array(3).fill('invalid_address'));
});

test('lo vencido a las 02:00 de un sábado no sale: pasa al lunes, sin gastar intento', async () => {
  const w = await workspace(8);
  const c = w.contacts[0]!;
  await enroll(w, bogota('2026-09-25', '07:00')); // viernes: pasos el viernes, el lunes y el martes
  const fake = fakeChannels();
  // El worker estuvo caído desde el viernes: el paso 1 sigue vencido el sábado de madrugada.
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-26', '02:00')));
  assert.equal(r.sent.length, 0);
  assert.equal(fake.email.sent.length, 0);
  assert.equal(r.claim.outsideWindow.length, 1);
  const t = await touches(c);
  assert.equal(t[0]!.status, 'scheduled');
  assert.equal(t[0]!.attempt_count, 0);
  assert.equal(localDay(t[0]!.scheduled_for), '2026-09-28', 'el lunes');
  assert.ok(isInsideWindow(t[0]!.scheduled_for, TZ, W));
  assert.ok(t[1]!.scheduled_for > t[0]!.scheduled_for, 'el paso 2 sigue detrás');
});

test('un correo sin asunto no sale: se retiene', async () => {
  const w = await workspace(9);
  await enroll(w, bogota('2026-09-23', '07:00'));
  const [t1] = await touches(w.contacts[0]!);
  await db.raw.query(`UPDATE outbound_touch SET subject = NULL WHERE id = $1`, [t1!.id]);
  const fake = fakeChannels();
  const r = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(r.sent.length, 0);
  assert.deepEqual(r.held.map((h) => h.touchId), [t1!.id]);
  assert.equal(fake.email.sent.length, 0);
  assert.equal((await touches(w.contacts[0]!))[0]!.held_reason, 'El correo no tiene asunto.');
});

// ---------------------------------------------------------------------
// Respuestas
// ---------------------------------------------------------------------

/** Envía los tres pasos de la cadencia (miércoles, jueves y viernes a mediodía). */
async function cadenciaCompleta(w: Ws, fake: ReturnType<typeof fakeChannels>): Promise<void> {
  await enroll(w, bogota('2026-09-23', '07:00'));
  for (const day of ['2026-09-23', '2026-09-24', '2026-09-25']) await runDispatch(motor, deps(w, fake, () => bogota(day, '12:00')));
}

test('la respuesta al último correo, con la cadencia completa, se registra; y su baja se respeta', async () => {
  const w = await workspace(10, { contacts: 2 });
  const fake = fakeChannels();
  await cadenciaCompleta(w, fake);
  assert.equal(fake.email.sent.length, 6);
  const [ana, beto] = w.contacts;
  const estado = (c: string) => scalar<string>(`SELECT status AS v FROM outbound_enrollment WHERE contact_id = $1`, [c]);
  assert.equal(await estado(ana!), 'completed');

  // Ana responde al último correo con interés; Beto, con la baja.
  const hilo = (c: string) => fake.email.sent.filter((m) => m.recipient === (c === ana ? 'p1.pol10@marca.test' : 'p2.pol10@marca.test')).at(-1)!.threadRef!;
  fake.email.reply(hilo(ana!), 'Me interesa, ¿hablamos el lunes?', bogota('2026-09-25', '15:00'));
  fake.email.reply(hilo(beto!), 'Por favor dénme de baja.', bogota('2026-09-25', '15:10'));
  const r = await runReplies(motor, { readers: fake, now: () => bogota('2026-09-25', '16:00'), workspaceId: w.id });
  assert.deepEqual([r.inbound, r.optOuts], [2, 1]);
  assert.equal(await estado(ana!), 'replied');
  assert.equal(await scalar<boolean>(`SELECT opted_out AS v FROM contact WHERE id = $1`, [beto]), true);
  assert.equal(await scalar<number>(`SELECT count(*)::int AS v FROM outbound_message WHERE workspace_id = $1 AND direction = 'inbound'`, [w.id]), 2);

  // Después del «me interesa», Ana pide la baja: se registra y se respeta.
  fake.email.reply(hilo(ana!), 'Lo pensamos mejor: dénme de baja, gracias.', bogota('2026-09-28', '09:00'));
  const r2 = await runReplies(motor, { readers: fake, now: () => bogota('2026-09-28', '10:00'), workspaceId: w.id });
  assert.deepEqual([r2.inbound, r2.optOuts], [1, 1]);
  assert.equal(await scalar<boolean>(`SELECT opted_out AS v FROM contact WHERE id = $1`, [ana]), true);
});

test('el lector de respuestas sigue donde se quedó: con limit=1, la segunda corrida lee el otro hilo', async () => {
  const w = await workspace(11, { contacts: 2 });
  await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  assert.equal(fake.email.sent.length, 2);
  for (const m of fake.email.sent) fake.email.reply(m.threadRef!, 'Gracias, lo reviso.', bogota('2026-09-23', '13:00'));
  const leer = (hhmm: string) => runReplies(motor, { readers: fake, now: () => bogota('2026-09-23', hhmm), workspaceId: w.id, limit: 1 });
  const r1 = await leer('14:00');
  const r2 = await leer('14:05');
  assert.deepEqual([r1.threads, r1.inbound, r2.threads, r2.inbound], [1, 1, 1, 1], 'cada corrida, un hilo distinto');
  assert.equal(
    await scalar<number>(`SELECT count(*)::int AS v FROM outbound_touch WHERE workspace_id = $1 AND replies_checked_at IS NOT NULL`, [w.id]),
    2,
  );
  // La tercera vuelve al primero (el leído hace más tiempo), sin nada nuevo.
  const r3 = await leer('14:10');
  assert.deepEqual([r3.threads, r3.inbound], [1, 0]);
});
