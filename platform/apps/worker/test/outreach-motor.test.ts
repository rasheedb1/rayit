/**
 * VEN-10 · el motor de cadencias de punta a punta, sobre Postgres
 * embebido con las migraciones del repo, como mc_worker, con el canal
 * falso y un reloj falso. Sin red.
 *
 * La historia: una creadora en Bogotá con su Gmail conectado enrola a
 * dos marcas en una secuencia de tres correos (día 0, respuesta en el
 * hilo el día 1, día 2). El reloj avanza:
 *
 *   · con el interruptor apagado no sale nada;
 *   · encendido, salen los dos primeros correos con su pie de baja, su
 *     enlace guardado y la cadencia avanza;
 *   · una marca responde y lo pendiente de su cadencia se cancela;
 *   · un fallo transitorio se reintenta con espera y sale en el hilo;
 *   · el límite diario reprograma al siguiente día hábil;
 *   · un reclamo caído: lo que no llegó al proveedor vuelve a la cola y
 *     sale; lo que estaba en vuelo es un zombi: failed, sin reenviar;
 *   · una respuesta que pide la baja marca la ficha;
 *   · apagar el interruptor cancela lo pendiente y el despachador no toma nada;
 *   · volver a encenderlo devuelve lo cancelado a la cola: las cadencias
 *     siguen donde iban, con sus días entre pasos y sus textos.
 *
 * Los contadores de 0037 cuentan el día con now() de la BASE, que el
 * reloj falso no mueve: por eso la prueba del límite vacía
 * outbound_counter antes de «cambiar de día», que es lo que haría el
 * calendario real.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { zonedParts } from '@mc/core';
import { claimDueTouches, disableOutreach, enableOutreach, enrollContacts, markSendStarted } from '@mc/db/queries/outreach';
import { allJobs } from '../src/jobs/index.ts';
import { fakeChannels, type FakeChannel } from '../src/jobs/ventas/canales/fake.ts';
import { DISPATCH_JOB_ID, runDispatch, type DispatchDeps } from '../src/jobs/ventas/outbound.dispatch.ts';
import { REPLIES_JOB_ID, runReplies } from '../src/jobs/ventas/outbound.replies.ts';
import { motorDbFromJob, type MotorDb } from '../src/jobs/ventas/motor-db.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { openTestDatabase, SETUP_TIMEOUT } from './helpers/harness.ts';
import { motorKit } from './helpers/motor-kit.ts';

const TZ = 'America/Bogota';
const WS = '0000000b-0000-4000-8000-000000000001';
const USER = '0000000b-0000-4000-8000-0000000000a1';
const CO_VITALE = '0000000b-0000-4000-8000-0000000000c1';
const CO_SABORES = '0000000b-0000-4000-8000-0000000000c2';
const CO_OLLA = '0000000b-0000-4000-8000-0000000000c3';
const SOFIA = '0000000b-0000-4000-8000-0000000c0001';
const DANIEL = '0000000b-0000-4000-8000-0000000c0002';
const CAROLINA = '0000000b-0000-4000-8000-0000000c0003';
const PEDRO = '0000000b-0000-4000-8000-0000000c0004';
const GMAIL = '0000000b-0000-4000-8000-0000000ac001';
const SEQ = '0000000b-0000-4000-8000-0000005e0001';
const STEP1 = '0000000b-0000-4000-8000-0000005e0101';
const STEP2 = '0000000b-0000-4000-8000-0000005e0102';
const STEP3 = '0000000b-0000-4000-8000-0000005e0103';

/** Un instante a una hora local de Bogotá (UTC−5, sin horario de verano). */
const bogota = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-05:00`);

let db: PgliteDatabase;
let motor: MotorDb;
let fake: Record<'email' | 'linkedin' | 'instagram_dm', FakeChannel>;
let clock = bogota('2026-09-23', '07:00'); // miércoles
const enrollments = new Map<string, string>();

function deps(extra: Partial<DispatchDeps> = {}): DispatchDeps {
  return { senders: fake, now: () => clock, appUrl: 'https://oncue.test', ...extra };
}

interface TouchRow extends Record<string, unknown> {
  id: string;
  contact_id: string;
  step_id: string;
  status: string;
  attempt_count: number;
  scheduled_for: Date;
  next_retry_at: Date | null;
  subject: string | null;
  provider_message_id: string | null;
  thread_ref: string | null;
  message_id_rfc: string | null;
  recipient_address: string | null;
  channel_account_id: string | null;
  blocked_reason: string | null;
}

async function touches(contactId: string): Promise<TouchRow[]> {
  const { rows } = await db.raw.query<TouchRow>(
    `SELECT t.id, t.contact_id, t.step_id, t.status, t.attempt_count, t.scheduled_for, t.next_retry_at, t.subject,
            t.provider_message_id, t.thread_ref, t.message_id_rfc, t.recipient_address::text AS recipient_address,
            t.channel_account_id, t.blocked_reason
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

before(async () => {
  db = await openTestDatabase();
  motor = motorDbFromJob(db);
  fake = fakeChannels();
  await db.raw.exec(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS}', 'motor-laura', 'Laura · Cocina fácil', '${TZ}');
    INSERT INTO app_user (id, email, name) VALUES ('${USER}', 'laura@motor.test', 'Laura');
    INSERT INTO membership (workspace_id, user_id, role) VALUES ('${WS}', '${USER}', 'owner');
    INSERT INTO company (id, name, owner_workspace_id) VALUES
      ('${CO_VITALE}', 'Vitalé', '${WS}'), ('${CO_SABORES}', 'Sabores Caseros', '${WS}'), ('${CO_OLLA}', 'Olla Fácil', '${WS}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS}', '${CO_VITALE}'), ('${WS}', '${CO_SABORES}'), ('${WS}', '${CO_OLLA}');
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source) VALUES
      ('${SOFIA}', '${CO_VITALE}', '${WS}', 'Sofía Cárdenas', 'sofia@vitale.test', 'user_provided'),
      ('${DANIEL}', '${CO_SABORES}', '${WS}', 'Daniel Restrepo', 'daniel@sabores.test', 'user_provided'),
      ('${CAROLINA}', '${CO_OLLA}', '${WS}', 'Carolina Ruiz', 'carolina@olla.test', 'user_provided'),
      ('${PEDRO}', '${CO_OLLA}', '${WS}', 'Pedro Gómez', 'pedro@olla.test', 'user_provided');
    -- Nace apagada, como en producción, con su dirección postal. Sin
    -- revisión humana (la secuencia es 'auto' y sus plantillas, fijas) y
    -- sin la separación de tres días con la marca: esta prueba mira el
    -- motor, no la política de la marca (la prueba outreach-motor-politica-marca).
    INSERT INTO outbound_policy (workspace_id, enabled, postal_address, max_emails_per_day, require_human_review,
                                 max_touches_per_company, min_days_between_touches)
    VALUES ('${WS}', false, 'Calle 93 # 11-26, Bogotá, Colombia', 20, false, 20, 0);
    INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, display_name, status, daily_cap, weekly_cap)
    VALUES ('${GMAIL}', '${WS}', 'email', 'gmail_oauth', 'laura@cocina-facil.test', 'Laura · Cocina fácil', 'connected', 40, 200);
    INSERT INTO outbound_sequence (id, workspace_id, name, channel, status, automation_mode)
    VALUES ('${SEQ}', '${WS}', 'Tres correos', 'email', 'active', 'auto');
    INSERT INTO outbound_step (id, workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time,
                               subject_template, body_template, generate_with_ai) VALUES
      ('${STEP1}', '${WS}', '${SEQ}', 0, 0, 'email', 'email', '09:30', 'Hola, {{first_name}}',
       'Hola, {{first_name}}: te escribo por {{company}}. ¿Hablamos?', false),
      ('${STEP2}', '${WS}', '${SEQ}', 1, 0, 'email_reply', 'email', '10:00', NULL,
       'Te dejo una idea concreta para {{company}}.', false),
      ('${STEP3}', '${WS}', '${SEQ}', 2, 0, 'email', 'email', '10:00', 'Una última idea',
       'Cierro con mi media kit, {{first_name}}.', false);
  `);
}, SETUP_TIMEOUT);
after(async () => {
  await db?.close();
});

test('los dos jobs están registrados con su cron (0051)', async () => {
  for (const id of [DISPATCH_JOB_ID, REPLIES_JOB_ID]) assert.ok(allJobs.some((j) => j.id === id), id);
  const { rows } = await db.raw.query<{ id: string; default_cron: string }>(
    `SELECT id, default_cron FROM job_definition WHERE id IN ('outbound.dispatch', 'outbound.replies') ORDER BY id`,
  );
  assert.deepEqual(rows, [{ id: 'outbound.dispatch', default_cron: '*/2 * * * *' }, { id: 'outbound.replies', default_cron: '*/5 * * * *' }]);
});

test('enrolar crea el enrolamiento y los tres toques, en días hábiles y dentro de la ventana', async () => {
  const r = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: SEQ, contactIds: [SOFIA, DANIEL], enrolledBy: USER, now: clock }));
  assert.equal(r.enrolled.length, 2);
  for (const e of r.enrolled) {
    assert.equal(e.scheduled, 3);
    enrollments.set(e.contactId, e.enrollmentId);
  }
  const t = await touches(SOFIA);
  assert.deepEqual(t.map((x) => localDay(x.scheduled_for)), ['2026-09-23', '2026-09-24', '2026-09-25']);
  for (const x of t) {
    const { seconds } = zonedParts(x.scheduled_for, TZ);
    assert.ok(seconds >= 9 * 3600 && seconds < 17 * 3600, `fuera de la ventana: ${x.scheduled_for.toISOString()}`);
  }
  assert.equal(t[0]!.subject, 'Hola, Sofía', 'la plantilla se rinde con el nombre de pila');
  const otra = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: SEQ, contactIds: [SOFIA], now: clock }));
  assert.deepEqual(otra.skipped, [{ contactId: SOFIA, reason: 'already_enrolled' }]);
});

test('con el interruptor apagado el despachador no toma nada', async () => {
  clock = bogota('2026-09-23', '12:00');
  const r = await runDispatch(motor, deps());
  assert.equal(r.claim.claimed, 0);
  assert.equal(fake.email.sent.length, 0);
  assert.equal((await touches(SOFIA))[0]!.status, 'scheduled');
});

test('encendido, salen los dos correos del día 0 con su pie de baja, su enlace y sus pruebas', async () => {
  await db.raw.exec(`SELECT enable_outreach('${WS}')`);
  const r = await runDispatch(motor, deps());
  assert.equal(r.sent.length, 2, JSON.stringify(r));
  assert.equal(fake.email.sent.length, 2);
  const msg = fake.email.sent.find((m) => m.recipient === 'sofia@vitale.test')!;
  assert.equal(msg.subject, 'Hola, Sofía');
  assert.match(msg.body, /Calle 93 # 11-26/);
  assert.match(msg.body, /https:\/\/oncue\.test\/baja\/[A-Za-z0-9_-]{43}/);
  // El pie lleva la página de baja; la cabecera List-Unsubscribe, la de un clic (VEN-15, RFC 8058).
  const pagina = msg.body.match(/https:\/\/oncue\.test\/baja\/\S+/)![0];
  assert.ok(!pagina.endsWith('/un-clic'));
  assert.equal(msg.unsubscribeUrl, `${pagina}/un-clic`);

  const [t1] = await touches(SOFIA);
  assert.equal(t1!.status, 'sent');
  assert.equal(t1!.attempt_count, 1);
  assert.equal(t1!.recipient_address, 'sofia@vitale.test');
  assert.equal(t1!.channel_account_id, GMAIL);
  assert.equal(t1!.provider_message_id, msg.providerMessageId);
  assert.equal(t1!.message_id_rfc, msg.messageIdRfc);
  assert.ok(t1!.thread_ref);
  const link = await db.raw.query<{ attempt: number; sent_at: Date | null; recipient_address: string }>(
    `SELECT attempt, sent_at, recipient_address::text FROM outbound_optout_link WHERE touch_id = $1`, [t1!.id],
  );
  assert.equal(link.rows.length, 1);
  assert.equal(link.rows[0]!.attempt, 1);
  assert.ok(link.rows[0]!.sent_at, 'el enlace del intento anota el envío');
  assert.equal(await scalar<string>(`SELECT current_step_id::text AS v FROM outbound_enrollment WHERE id = $1`, [enrollments.get(SOFIA)]), STEP2);
  assert.equal(await scalar<number>(`SELECT count(*)::int AS v FROM outbound_message WHERE direction = 'outbound'`), 2);

  const otra = await runDispatch(motor, deps());
  assert.equal(otra.claim.claimed, 0, 'volver a correrlo no reenvía nada');
});

test('una respuesta cancela lo pendiente de su cadencia y avisa', async () => {
  const sofia = fake.email.sent.find((m) => m.recipient === 'sofia@vitale.test')!;
  clock = bogota('2026-09-23', '15:00');
  fake.email.reply(sofia.threadRef, 'Hola, Laura. Sí, me interesa. ¿Hablamos el jueves?', bogota('2026-09-23', '14:30'));
  const r = await runReplies(motor, { readers: fake, now: () => clock });
  assert.equal(r.inbound, 1);
  assert.equal(r.optOuts, 0);
  assert.equal(r.canceled, 2);
  const t = await touches(SOFIA);
  assert.deepEqual(t.map((x) => x.status), ['sent', 'canceled', 'canceled']);
  assert.deepEqual(t.slice(1).map((x) => x.blocked_reason), ['replied', 'replied']);
  assert.equal(await scalar<string>(`SELECT status AS v FROM outbound_enrollment WHERE id = $1`, [enrollments.get(SOFIA)]), 'replied');
  assert.equal(await scalar<number>(`SELECT count(*)::int AS v FROM notification WHERE kind = 'outreach_reply'`), 1);
  const again = await runReplies(motor, { readers: fake, now: () => clock });
  assert.equal(again.inbound, 0, 'releer el hilo no duplica ni vuelve a cancelar');
});

test('un fallo transitorio se reintenta con espera y sale después, en el mismo hilo', async () => {
  clock = bogota('2026-09-24', '11:00');
  fake.email.failNext(1, { kind: 'transient', code: 'network', message: 'ECONNRESET' });
  const r1 = await runDispatch(motor, deps());
  assert.deepEqual(r1.retried.length, 1);
  let [, t2] = await touches(DANIEL);
  assert.equal(t2!.status, 'scheduled');
  assert.equal(t2!.attempt_count, 1);
  assert.ok(t2!.next_retry_at && t2!.next_retry_at.getTime() > clock.getTime(), 'espera antes de reintentar');

  const still = await runDispatch(motor, deps());
  assert.equal(still.claim.claimed, 0, 'antes de su hora no se reintenta');

  clock = new Date(t2!.next_retry_at!.getTime() + 1000);
  const r2 = await runDispatch(motor, deps());
  assert.equal(r2.sent.length, 1);
  [, t2] = await touches(DANIEL);
  assert.equal(t2!.status, 'sent');
  assert.equal(t2!.attempt_count, 2);
  const links = await scalar<number>(`SELECT count(*)::int AS v FROM outbound_optout_link WHERE touch_id = $1`, [t2!.id]);
  assert.equal(links, 2, 'cada intento lleva su propio enlace');

  const first = fake.email.sent.find((m) => m.recipient === 'daniel@sabores.test')!;
  const reply = fake.email.sent.at(-1)!;
  assert.equal(reply.stepType, 'email_reply');
  assert.equal(reply.subject, 'Re: Hola, Daniel');
  assert.deepEqual(reply.reply, { threadRef: first.threadRef, messageIdRfc: first.messageIdRfc });
});

test('el límite diario reprograma al siguiente día hábil', async () => {
  clock = bogota('2026-09-25', '07:00'); // viernes
  const r = await motor.transaction((tx) => enrollContacts(tx, { sequenceId: SEQ, contactIds: [CAROLINA, PEDRO], now: clock }));
  for (const e of r.enrolled) enrollments.set(e.contactId, e.enrollmentId);
  // Un día nuevo: contadores nuevos (ver arriba), y la cuenta con un solo envío al día.
  await db.raw.exec(`DELETE FROM outbound_counter; UPDATE outreach_channel_account SET daily_cap = 1 WHERE id = '${GMAIL}';`);
  clock = bogota('2026-09-25', '12:00');
  const sentBefore = fake.email.sent.length;
  const d = await runDispatch(motor, deps());
  assert.equal(d.sent.length, 1, 'solo cabe uno');
  assert.equal(d.claim.rescheduled.length, 2);
  for (const x of d.claim.rescheduled) {
    assert.equal(x.cap, 'account_day');
    assert.equal(localDay(x.until), '2026-09-28', 'el lunes');
  }
  assert.equal(fake.email.sent.length, sentBefore + 1);
  const pendientes = await db.raw.query<{ status: string; attempt_count: number }>(
    `SELECT status, attempt_count FROM outbound_touch WHERE id = ANY($1::uuid[])`, [d.claim.rescheduled.map((x) => x.touchId)],
  );
  assert.deepEqual(pendientes.rows.map((x) => [x.status, x.attempt_count]), [['scheduled', 0], ['scheduled', 0]], 'sin gastar un intento');
});

test('un reclamo caído: lo que nunca llegó al proveedor vuelve a la cola; lo que llegó es un zombi, sin reenviar', async () => {
  await db.raw.exec(`DELETE FROM outbound_counter; UPDATE outreach_channel_account SET daily_cap = 40 WHERE id = '${GMAIL}';`);
  clock = bogota('2026-09-28', '12:00');
  // El despachador reclama, marca el primero como «voy a enviar» y se cae.
  const claimed = await motor.transaction((tx) => claimDueTouches(tx, { now: clock, channels: ['email'] }));
  assert.ok(claimed.claimed.length >= 2, JSON.stringify(claimed));
  const [enVuelo, ...nunca] = claimed.claimed;
  assert.equal(await motor.transaction((tx) => markSendStarted(tx, enVuelo!.id, enVuelo!.claimedAt, clock)), true);
  const sentBefore = fake.email.sent.length;
  const avisosAntes = await scalar<number>(`SELECT count(*)::int AS v FROM notification WHERE kind = 'outreach_failed'`);

  clock = bogota('2026-09-28', '12:10');
  const r = await runDispatch(motor, deps());
  assert.equal(r.zombies.released, nunca.length, 'lo que no llegó al proveedor vuelve a la cola');
  assert.equal(r.zombies.failed, 1, 'solo el que estaba en vuelo es un zombi');
  // Lo devuelto sale en esta misma corrida, con su intento descontado y vuelto a contar.
  for (const t of nunca) assert.ok(r.sent.includes(t.id), `${t.id} salió`);
  assert.equal(fake.email.sent.length - sentBefore, nunca.length, 'el zombi no se reenvía');
  const zombi = await db.raw.query<{ status: string; blocked_reason: string; attempt_count: number }>(
    `SELECT status, blocked_reason, attempt_count FROM outbound_touch WHERE id = $1`, [enVuelo!.id],
  );
  assert.deepEqual({ ...zombi.rows[0] }, { status: 'failed', blocked_reason: 'zombie', attempt_count: 1 });
  const reenviados = await db.raw.query<{ attempt_count: number; links: number }>(
    `SELECT t.attempt_count, (SELECT count(*)::int FROM outbound_optout_link l WHERE l.touch_id = t.id) AS links
       FROM outbound_touch t WHERE t.id = ANY($1::uuid[])`, [nunca.map((t) => t.id)],
  );
  for (const x of reenviados.rows) assert.deepEqual({ ...x }, { attempt_count: 1, links: 1 }, 'un solo intento y un solo enlace');
  assert.equal(
    (await scalar<number>(`SELECT count(*)::int AS v FROM notification WHERE kind = 'outreach_failed'`)) - avisosAntes, 1,
    'un aviso, el del zombi; ninguno por lo devuelto',
  );
});

test('una respuesta que pide la baja marca la ficha y cancela todo lo suyo', async () => {
  const daniel = fake.email.sent.find((m) => m.recipient === 'daniel@sabores.test')!;
  clock = bogota('2026-09-28', '15:00');
  fake.email.reply(daniel.threadRef, 'Por favor, dénme de baja de su lista.', bogota('2026-09-28', '14:00'));
  const r = await runReplies(motor, { readers: fake, now: () => clock });
  assert.equal(r.optOuts, 1);
  assert.equal(await scalar<boolean>(`SELECT opted_out AS v FROM contact WHERE id = $1`, [DANIEL]), true);
  assert.equal(
    await scalar<number>(`SELECT count(*)::int AS v FROM outbound_touch WHERE contact_id = $1 AND status IN ('draft', 'scheduled', 'held')`, [DANIEL]),
    0,
  );
  // Un enrolamiento vivo pasa a opted_out; uno que ya había terminado se queda como estaba.
  assert.ok(['opted_out', 'completed'].includes(await scalar<string>(`SELECT status AS v FROM outbound_enrollment WHERE id = $1`, [enrollments.get(DANIEL)])));
});

test('apagar el interruptor cancela lo pendiente y el despachador no toma nada', async () => {
  const pending = await scalar<number>(`SELECT count(*)::int AS v FROM outbound_touch WHERE workspace_id = '${WS}' AND status = 'scheduled'`);
  assert.ok(pending > 0, 'quedaba algo en la cola');
  const canceled = await motor.transaction(async (tx) => (await tx.query<{ n: number }>(`SELECT disable_outreach('${WS}', 'prueba') AS n`)).rows[0]!.n);
  assert.equal(canceled, pending);
  clock = bogota('2026-09-30', '12:00');
  const sentBefore = fake.email.sent.length;
  const r = await runDispatch(motor, deps());
  assert.equal(r.claim.claimed, 0);
  assert.equal(fake.email.sent.length, sentBefore);
  assert.equal(await scalar<number>(`SELECT count(*)::int AS v FROM outbound_touch WHERE blocked_reason = 'outreach_disabled'`), pending);
});

// ---------------------------------------------------------------------
// Apagar y volver a encender: las cadencias siguen donde iban
// ---------------------------------------------------------------------

const kit = motorKit({ db: () => db, motor: () => motor, prefix: '0000011a', slug: 'motor-interruptor' });

test('apagar y volver a encender: lo cancelado vuelve a la cola y los pasos salen en orden, un día hábil entre cada uno', async () => {
  const w = await kit.workspace(1, { contacts: 1 });
  const [c] = w.contacts as [string];
  const enr = await kit.enroll(w, bogota('2026-09-23', '07:00'));
  const f = fakeChannels();
  await runDispatch(motor, kit.deps(w, f, () => bogota('2026-09-23', '12:00')));
  assert.equal(f.email.sent.length, 1, 'el paso 1 sale el miércoles');

  const cancelados = await motor.transaction((tx) => disableOutreach(tx, 'vacaciones', w.id));
  assert.equal(cancelados, 2);
  // Casi una semana apagado: no sale nada.
  for (const dia of ['2026-09-24', '2026-09-25', '2026-09-28']) await runDispatch(motor, kit.deps(w, f, () => bogota(dia, '11:00')));
  assert.equal(f.email.sent.length, 1);

  const plan = await motor.transaction((tx) => enableOutreach(tx, w.id, bogota('2026-09-28', '12:00')));
  assert.deepEqual(plan, { enrollments: 1, scheduled: 2, held: 0 });
  assert.equal(await kit.scalar<string>(`SELECT status AS v FROM outbound_enrollment WHERE id = $1`, [enr.get(c)]), 'active');
  assert.deepEqual((await kit.touches(c)).map((t) => t.status), ['sent', 'scheduled', 'scheduled']);

  for (const dia of ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']) {
    await runDispatch(motor, kit.deps(w, f, () => bogota(dia, '16:30')));
  }
  assert.equal(f.email.sent.length, 3, 'salen los dos pasos que faltaban');
  const [, dos, tres] = await kit.touches(c);
  assert.equal(localDay(dos!.scheduled_for), '2026-09-29', 'el paso 2, el siguiente día hábil (su hora del lunes ya había pasado)');
  assert.equal(localDay(tres!.scheduled_for), '2026-09-30', 'el paso 3, un día hábil después del 2, como en la secuencia');
  assert.match(f.email.sent[1]!.subject ?? '', /^Re: /, 'el paso 2 sigue en el hilo del 1');
  assert.equal(f.email.sent[1]!.threadRef, f.email.sent[0]!.threadRef);
  assert.equal(await kit.scalar<string>(`SELECT status AS v FROM outbound_enrollment WHERE id = $1`, [enr.get(c)]), 'completed');
});

test('encender devuelve a revisión lo que esperaba revisión, con el texto que la persona ya había editado', async () => {
  const w = await kit.workspace(2, { contacts: 1, humanReview: true });
  const [c] = w.contacts as [string];
  await kit.enroll(w, bogota('2026-09-23', '07:00'));
  const [uno] = await kit.touches(c);
  await db.raw.query(`UPDATE outbound_touch SET body = 'Hola, Persona: lo escribí yo.' WHERE id = $1`, [uno!.id]);
  await motor.transaction((tx) => disableOutreach(tx, 'vacaciones', w.id));
  assert.deepEqual((await kit.touches(c)).map((t) => t.status), ['canceled', 'canceled', 'canceled']);

  // Encendido el mismo día, antes de su hora: cada uno conserva la suya.
  const plan = await motor.transaction((tx) => enableOutreach(tx, w.id, bogota('2026-09-23', '08:00')));
  assert.deepEqual(plan, { enrollments: 1, scheduled: 0, held: 3 });
  const despues = await kit.touches(c);
  assert.deepEqual(despues.map((t) => [t.status, t.held_reason]), [['held', 'needs_review'], ['held', 'needs_review'], ['held', 'needs_review']]);
  assert.equal(despues[0]!.scheduled_for.getTime(), uno!.scheduled_for.getTime());
  assert.equal(await kit.scalar<string>(`SELECT body AS v FROM outbound_touch WHERE id = $1`, [uno!.id]), 'Hola, Persona: lo escribí yo.');
});

test('encender no devuelve a la cola lo de una ficha que se dio de baja mientras estaba apagado', async () => {
  const w = await kit.workspace(3, { contacts: 2 });
  const [c1, c2] = w.contacts as [string, string];
  await kit.enroll(w, bogota('2026-09-23', '07:00'));
  await motor.transaction((tx) => disableOutreach(tx, 'vacaciones', w.id));
  await db.raw.query(`UPDATE contact SET opted_out = true, opted_out_at = now() WHERE id = $1`, [c1]);
  const plan = await motor.transaction((tx) => enableOutreach(tx, w.id, bogota('2026-09-24', '12:00')));
  assert.equal(plan.scheduled, 3, 'solo los de la otra ficha');
  assert.deepEqual((await kit.touches(c1)).map((t) => t.status), ['canceled', 'canceled', 'canceled']);
  assert.deepEqual((await kit.touches(c2)).map((t) => t.status), ['scheduled', 'scheduled', 'scheduled']);
});
