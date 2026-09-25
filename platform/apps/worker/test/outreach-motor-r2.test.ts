/**
 * VEN-10 r2 · lo que la revisión encontró en el motor, caso por caso,
 * sobre Postgres embebido con las migraciones del repo, como mc_worker,
 * con el canal falso y un reloj falso. Sin red.
 *
 * Cada caso vive en su propio workspace (el despachador filtra por
 * workspaceId), para que ninguno dependa del orden de los demás:
 *
 *   · un contacto de otro workspace no se enrola ni entra por la base;
 *   · la ventana manda al despachar: a las 03:00 no sale nada;
 *   · el reintento del viernes a las 16:50 sale el lunes;
 *   · el tope corre los pasos de detrás, y un paso no sale antes que el anterior;
 *   · la respuesta en el hilo sin correo anterior se retiene;
 *   · lo reclamado que no se intentó vuelve a la cola, con su plaza;
 *   · un intento ambiguo se comprueba antes de reenviar (o se retiene);
 *   · con la cuenta caída los mensajes esperan, con un solo aviso;
 *   · un rebote cancela ese canal y termina la cadencia en 'bounced';
 *   · la baja que llega después de una respuesta se respeta en todo;
 *   · los avisos hablan el idioma del workspace.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { isInsideWindow, zonedParts } from '@mc/core';
import { claimDueTouches, enrollContacts } from '@mc/db/queries/outreach';
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

/** Un workspace de prueba con su Gmail, su política encendida y una secuencia de tres correos (día 0, respuesta el día 1, día 2). */
interface Ws {
  n: number;
  id: string;
  gmail: string;
  seq: string;
  steps: [string, string, string];
  contacts: string[];
  company: string;
}

function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, '0');
}

async function workspace(n: number, opts: { contacts?: number; locale?: string } = {}): Promise<Ws> {
  const base = `0000010c-${hex(n, 4)}-4000-8000-`;
  const w: Ws = {
    n,
    id: `${base}000000000001`,
    gmail: `${base}0000000ac001`,
    seq: `${base}0000005e0001`,
    steps: [`${base}0000005e0101`, `${base}0000005e0102`, `${base}0000005e0103`],
    contacts: Array.from({ length: opts.contacts ?? 2 }, (_, i) => `${base}0000000c${hex(i + 1, 4)}`),
    company: `${base}0000000000c1`,
  };
  const user = `${base}0000000000a1`;
  const contactos = w.contacts
    .map((c, i) => `('${c}', '${w.company}', '${w.id}', 'Persona ${i + 1} Prueba', 'p${i + 1}.ws${n}@marca.test', 'user_provided')`)
    .join(', ');
  await db.raw.exec(`
    INSERT INTO workspace (id, slug, name, timezone, locale) VALUES ('${w.id}', 'motor-r2-${n}', 'Creadora ${n}', '${TZ}', '${opts.locale ?? 'es-CO'}');
    INSERT INTO app_user (id, email, name) VALUES ('${user}', 'creadora${n}@motor.test', 'Creadora ${n}');
    INSERT INTO membership (workspace_id, user_id, role) VALUES ('${w.id}', '${user}', 'owner');
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${w.company}', 'Marca ${n}', '${w.id}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${w.id}', '${w.company}');
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source) VALUES ${contactos};
    -- Esta cadencia sale sola: la secuencia es 'auto' y el workspace apagó
    -- la revisión humana; sus pasos son diarios, así que la separación
    -- con la marca va a cero y el tope por marca alto. La revisión, la
    -- separación y el tope tienen su propia prueba (outreach-politica).
    INSERT INTO outbound_policy (workspace_id, enabled, postal_address, max_emails_per_day,
                                 require_human_review, min_days_between_touches, max_touches_per_company)
    VALUES ('${w.id}', false, 'Calle 93 # 11-26, Bogotá, Colombia', 100, false, 0, 50);
    INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, display_name, status, daily_cap, weekly_cap)
    VALUES ('${w.gmail}', '${w.id}', 'email', 'gmail_oauth', 'creadora${n}@gmail.test', 'Creadora ${n}', 'connected', 40, 200);
    INSERT INTO outbound_sequence (id, workspace_id, name, channel, status, automation_mode)
    VALUES ('${w.seq}', '${w.id}', 'Tres correos', 'email', 'active', 'auto');
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

async function enroll(w: Ws, at: Date, contacts: readonly string[] = w.contacts): Promise<Map<string, string>> {
  const r = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: w.seq, contactIds: contacts, now: at }));
  assert.equal(r.skipped.length, 0, JSON.stringify(r.skipped));
  return new Map(r.enrolled.map((e) => [e.contactId, e.enrollmentId]));
}

function deps(w: Ws, fake: Record<string, ChannelSender>, clock: () => Date, extra: Partial<DispatchDeps> = {}): DispatchDeps {
  return { senders: fake, now: clock, appUrl: 'https://oncue.test', workspaceId: w.id, ...extra };
}

interface TouchRow {
  id: string;
  step_id: string;
  status: string;
  attempt_count: number;
  scheduled_for: Date;
  next_retry_at: Date | null;
  blocked_reason: string | null;
  held_reason: string | null;
  unconfirmed_attempt: number | null;
  provider_message_id: string | null;
}

/** Los tres toques de un contacto, en el orden de sus pasos. */
async function touches(contactId: string): Promise<TouchRow[]> {
  const { rows } = await db.raw.query<TouchRow>(
    `SELECT t.id, t.step_id, t.status, t.attempt_count, t.scheduled_for, t.next_retry_at, t.blocked_reason, t.held_reason,
            t.unconfirmed_attempt, t.provider_message_id
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

function localClock(at: Date): string {
  const { seconds } = zonedParts(at, TZ);
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`;
}

/** Mueve la hora de un toque (lo que haría una reprogramación de la web). */
async function setDue(touchId: string, at: Date): Promise<void> {
  await db.raw.query(`UPDATE outbound_touch SET scheduled_for = $2 WHERE id = $1`, [touchId, at.toISOString()]);
}

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

test('la ventana manda al despachar: a las 03:00 no sale nada y el toque pasa a la apertura', async () => {
  const w = await workspace(3, { contacts: 1 });
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
  const w = await workspace(4, { contacts: 1 });
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
  const w = await workspace(5, { contacts: 1 });
  const c = w.contacts[0]!;
  await enroll(w, bogota('2026-09-25', '07:00')); // viernes: pasos el viernes, el lunes y el martes
  const antes = await touches(c);
  assert.deepEqual(antes.map((t) => localDay(t.scheduled_for)), ['2026-09-25', '2026-09-28', '2026-09-29']);
  // El tope diario de la cuenta ya está lleno hoy (el contador cuenta con el día real de la base).
  await db.raw.query(`UPDATE outreach_channel_account SET daily_cap = 1 WHERE id = $1`, [w.gmail]);
  await db.raw.query(
    `INSERT INTO outbound_counter (workspace_id, channel_account_id, period, period_start, action_type, count)
     VALUES ($1, $2, 'day', outreach_local_date($1, now()), 'email', 1)`,
    [w.id, w.gmail],
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
  await db.raw.exec(`DELETE FROM outbound_counter WHERE workspace_id = '${w.id}'; UPDATE outreach_channel_account SET daily_cap = 40 WHERE id = '${w.gmail}';`);
  await setDue(despues[1]!.id, bogota('2026-09-28', '10:00'));
  const r2 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-28', '11:00')));
  assert.equal(r2.claim.claimed, 0, 'el paso 2 espera al 1');
  assert.equal(fake.email.sent.length, 0);
  const r3 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-28', '12:30')));
  assert.deepEqual(r3.sent, [despues[0]!.id], 'primero el 1: en esta corrida el 2 todavía lo espera');
  const r4 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-28', '12:32')));
  assert.deepEqual(r4.sent, [despues[1]!.id], 'y en la siguiente, en el hilo, el 2');
  assert.deepEqual(fake.email.sent.map((m) => m.stepType), ['email', 'email_reply']);
  assert.equal(fake.email.sent[1]!.subject, 'Re: Hola, Persona');
  assert.equal(fake.email.sent[1]!.reply?.threadRef, fake.email.sent[0]!.threadRef);
});

test('la respuesta en el hilo cuyo correo no salió se retiene: nunca huérfana ni sin asunto', async () => {
  const w = await workspace(6, { contacts: 1 });
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
  assert.match(t2!.held_reason ?? '', /no salió/);
  assert.equal(fake.email.sent.length, 0);
});

test('lo reclamado que no se llegó a intentar vuelve a la cola, sin su enlace y con su plaza', async () => {
  const w = await workspace(7, { contacts: 3 });
  await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  const ac = new AbortController();
  // El proveedor responde al primero y entonces la corrida se corta (timeout o apagado).
  const cortaDespuesDelPrimero: ChannelSender = {
    channel: 'email',
    configured: () => true,
    send: async (m) => {
      const r = await fake.email.send(m);
      ac.abort(new Error('timeout del job'));
      return r;
    },
  };
  const r = await runDispatch(motor, deps(w, { email: cortaDespuesDelPrimero }, () => bogota('2026-09-23', '12:00'), { signal: ac.signal }));
  assert.equal(r.claim.claimed, 3);
  assert.equal(r.sent.length, 1);
  assert.equal(r.released.length, 2);
  const devueltos = await db.raw.query<{ status: string; attempt_count: number; claimed_at: Date | null; links: number }>(
    `SELECT t.status, t.attempt_count, t.claimed_at, (SELECT count(*)::int FROM outbound_optout_link l WHERE l.touch_id = t.id) AS links
       FROM outbound_touch t WHERE t.id = ANY($1::uuid[])`, [r.released],
  );
  for (const d of devueltos.rows) assert.deepEqual({ ...d }, { status: 'scheduled', attempt_count: 0, claimed_at: null, links: 0 });
  const plazas = await db.raw.query<{ channel_account_id: string | null; period: string; count: number }>(
    `SELECT channel_account_id, period, count FROM outbound_counter WHERE workspace_id = $1 ORDER BY channel_account_id NULLS LAST, period`, [w.id],
  );
  assert.deepEqual(plazas.rows.map((p) => p.count), [1, 1, 1], 'día y semana de la cuenta y día del workspace: solo el que salió');
  // Nada queda en processing para que la siguiente corrida lo tome por zombi; salen después, sin avisos.
  const r2 = await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:10')));
  assert.equal(r2.zombies.failed + r2.zombies.released, 0);
  assert.deepEqual([...r2.sent].sort(), [...r.released].sort());
  assert.equal(await scalar<number>(`SELECT count(*)::int AS v FROM notification WHERE workspace_id = $1 AND kind = 'outreach_failed'`, [w.id]), 0);
});

test('un intento ambiguo que el proveedor sí envió no se reenvía: se confirma', async () => {
  const w = await workspace(8, { contacts: 1 });
  const c = w.contacts[0]!;
  await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  // Sale, pero la respuesta se corta (el timeout después del POST).
  fake.email.deliverThenFail(1);
  let clock = bogota('2026-09-23', '12:00');
  const r = await runDispatch(motor, deps(w, fake, () => clock));
  assert.equal(r.retried.length, 1);
  const tocado = r.retried[0]!;
  let [t] = await touches(c);
  assert.equal(t!.unconfirmed_attempt, 1, 'queda anotado el intento sin confirmar');
  assert.equal(fake.email.sent.length, 1, 'el proveedor sí lo envió');
  const plaza = await scalar<number>(`SELECT count::int AS v FROM outbound_counter WHERE workspace_id = $1 AND period = 'day' AND channel_account_id IS NOT NULL`, [w.id]);
  assert.equal(plaza, 1, 'la plaza de un envío que pudo salir no se devuelve');

  clock = new Date(t!.next_retry_at!.getTime() + 1000);
  const r2 = await runDispatch(motor, deps(w, fake, () => clock));
  assert.deepEqual(r2.confirmed, [tocado]);
  assert.equal(fake.email.sent.length, 1, 'no se reenvió');
  [t] = await touches(c);
  assert.deepEqual([t!.status, t!.provider_message_id, t!.unconfirmed_attempt], ['sent', fake.email.sent[0]!.providerMessageId, null]);
  const links = await db.raw.query<{ attempt: number; sent: boolean }>(
    `SELECT attempt, sent_at IS NOT NULL AS sent FROM outbound_optout_link WHERE touch_id = $1 ORDER BY attempt`, [tocado],
  );
  assert.deepEqual(links.rows.map((l) => [l.attempt, l.sent]), [[1, true], [2, false]], 'el enlace que salió es el del intento 1');
  const plazaDespues = await scalar<number>(`SELECT count::int AS v FROM outbound_counter WHERE workspace_id = $1 AND period = 'day' AND channel_account_id IS NOT NULL`, [w.id]);
  assert.equal(plazaDespues, 1, 'el segundo reclamo devolvió su plaza: un solo envío, una sola plaza');
});

test('un intento ambiguo que el canal no sabe comprobar se retiene para una persona', async () => {
  const w = await workspace(14, { contacts: 1 });
  const c = w.contacts[0]!;
  await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  fake.email.deliverThenFail(1);
  fake.email.unverifiable = true;
  let clock = bogota('2026-09-23', '12:00');
  const r = await runDispatch(motor, deps(w, fake, () => clock));
  assert.equal(r.retried.length, 1);
  let [t] = await touches(c);
  clock = new Date(t!.next_retry_at!.getTime() + 1000);
  const r2 = await runDispatch(motor, deps(w, fake, () => clock));
  assert.equal(r2.held.length, 1);
  [t] = await touches(c);
  assert.equal(t!.status, 'held');
  assert.match(t!.held_reason ?? '', /No se pudo comprobar si el intento 1 salió/);
  assert.equal(fake.email.sent.length, 1, 'ni un envío de más');
});

test('con la cuenta caída los mensajes esperan, con un solo aviso, y salen al reconectar', async () => {
  const w = await workspace(9, { contacts: 3 });
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

test('un rebote cancela lo pendiente de ese canal y la cadencia termina en bounced', async () => {
  const w = await workspace(10, { contacts: 1 });
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
  assert.equal(aviso.rows[0]!.title_es, 'Un mensaje a Marca 10 no salió');
  assert.equal(aviso.rows[0]!.body_es, 'El mensaje a Persona 1 Prueba por correo no se envió: el correo rebotó. Revisa la cola de Ventas.');
});

test('la baja que llega después de una respuesta se respeta, y cancela lo de las otras secuencias', async () => {
  const w = await workspace(11, { contacts: 1 });
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

test('los avisos hablan el idioma del workspace', async () => {
  const w = await workspace(12, { contacts: 1, locale: 'en-US' });
  await enroll(w, bogota('2026-09-23', '07:00'));
  const fake = fakeChannels();
  fake.email.failNext(1, { kind: 'permanent', code: 'invalid_recipient', message: 'invalid To header' });
  await runDispatch(motor, deps(w, fake, () => bogota('2026-09-23', '12:00')));
  const aviso = await db.raw.query<{ title_es: string; body_es: string }>(
    `SELECT title_es, body_es FROM notification WHERE workspace_id = $1 AND kind = 'outreach_failed'`, [w.id],
  );
  assert.equal(aviso.rows[0]!.title_es, 'A message to Marca 12 was not sent');
  assert.equal(aviso.rows[0]!.body_es, 'The message to Persona 1 Prueba over email was not sent: the address is not valid. Check the Sales queue.');
});

test('el reclamo no toca lo de otro workspace aunque corra para todos', async () => {
  const w = await workspace(13, { contacts: 1 });
  await enroll(w, bogota('2026-09-23', '07:00'));
  const claim = await motor.transaction((tx) => claimDueTouches(tx, { now: bogota('2026-09-23', '12:00'), channels: ['email'], workspaceId: w.id }));
  assert.ok(claim.claimed.every((t) => t.workspaceId === w.id));
  // Y lo deja en processing con su cuenta, de su workspace y de su canal.
  const row = await db.raw.query<{ channel_account_id: string }>(`SELECT channel_account_id FROM outbound_touch WHERE id = $1`, [claim.claimed[0]!.id]);
  assert.equal(row.rows[0]!.channel_account_id, w.gmail);
});
