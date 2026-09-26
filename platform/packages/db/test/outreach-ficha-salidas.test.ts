/**
 * VEN-10 · las salidas de la ficha para una cadencia que se quedó parada:
 *
 *   · una respuesta en el hilo a un correo que no salió (reply_without_thread)
 *     no se «aprueba»: releaseHeldTouch responde no_thread, y la salida
 *     es saltar el paso; el paso de detrás sale;
 *   · una cadencia en pausa porque otra persona de la marca respondió
 *     (0059) se reanuda: vuelve a 'active' y lo vencido sale desde ahora;
 *   · la alerta «no sale nada» no cuenta lo que espera a una persona (lo
 *     de una cadencia en pausa, lo que va detrás de un retenido);
 *   · resolver un intento sin confirmar es del equipo, no de un cliente
 *     (outreach_resolve_unconfirmed es SECURITY DEFINER: las políticas no
 *     la frenan);
 *   · el aviso de un retenido se repite si se retiene por OTRO motivo.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readAlertSignalCounts } from '../src/queries/entregabilidad.ts';
import { skipQueuedTouch } from '../src/queries/bandejas.ts';
import { notifyTouchHeld, releaseHeldTouch, resolveUnconfirmedTouch, resumeEnrollment } from '../src/queries/outreach.ts';
import { openTestDb, SETUP_TIMEOUT, type TestDb } from './pglite.ts';

const id = (kind: string) => `00000069-0000-4000-8000-${kind.padStart(12, '0')}`;
const WS = id('a');
const CO = id('c1');
const ANA = id('d1');
const PEDRO = id('d2');
const SEQ = id('5e');
const STEP = { uno: id('51'), dos: id('52'), tres: id('53') };
const ENR = { ana: id('e1'), pedro: id('e2') };
const T = { uno: id('71'), dos: id('72'), tres: id('73'), pedro: id('74'), ambiguo: id('75') };
const DUENA = id('f1');
const CLIENTE = id('f2');

let t: TestDb;

before(async () => {
  t = await openTestDb({ seeds: false });
  await t.admin(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS}', 'salidas', 'Salidas', 'America/Bogota');
    INSERT INTO outbound_policy (workspace_id, postal_address) VALUES ('${WS}', 'Calle 93 # 11-26, Bogotá');
    INSERT INTO app_user (id, email, name) VALUES ('${DUENA}', 'duena@salidas.test', 'Dueña'),
                                                  ('${CLIENTE}', 'cliente@salidas.test', 'Cliente');
    INSERT INTO membership (workspace_id, user_id, role) VALUES ('${WS}', '${DUENA}', 'owner'), ('${WS}', '${CLIENTE}', 'client');
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${CO}', 'Vitalé', '${WS}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS}', '${CO}');
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source) VALUES
      ('${ANA}', '${CO}', '${WS}', 'Ana Vitalé', 'ana@vitale.test', 'user_provided'),
      ('${PEDRO}', '${CO}', '${WS}', 'Pedro Vitalé', 'pedro@vitale.test', 'user_provided');
    INSERT INTO outbound_sequence (id, workspace_id, name, channel, status) VALUES ('${SEQ}', '${WS}', 'Tres correos', 'email', 'active');
    INSERT INTO outbound_step (id, workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time, subject_template, body_template)
    VALUES ('${STEP.uno}', '${WS}', '${SEQ}', 0, 0, 'email', 'email', '10:00', 'Hola', 'Una idea.'),
           ('${STEP.dos}', '${WS}', '${SEQ}', 2, 0, 'email_reply', 'email', '10:00', NULL, 'Sigo por aquí.'),
           ('${STEP.tres}', '${WS}', '${SEQ}', 4, 0, 'email', 'email', '10:00', 'Otra idea', 'Una más.');
    INSERT INTO outbound_enrollment (id, workspace_id, sequence_id, contact_id, status) VALUES
      ('${ENR.ana}', '${WS}', '${SEQ}', '${ANA}', 'active'),
      ('${ENR.pedro}', '${WS}', '${SEQ}', '${PEDRO}', 'paused');
    -- Ana: el primer correo lo rechazó el proveedor para siempre; la respuesta en su hilo quedó retenida sin hilo,
    -- y el tercero venció hace unas horas detrás de ella.
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, sequence_id, step_index, enrollment_id, step_id, channel,
                                subject, body, status, scheduled_for, held_reason, blocked_reason) VALUES
      ('${T.uno}', '${WS}', '${CO}', '${ANA}', '${SEQ}', 1, '${ENR.ana}', '${STEP.uno}', 'email', 'Hola', 'Una idea.',
       'failed', now() - interval '4 days', NULL, 'rejected'),
      ('${T.dos}', '${WS}', '${CO}', '${ANA}', '${SEQ}', 2, '${ENR.ana}', '${STEP.dos}', 'email', NULL, 'Sigo por aquí.',
       'held', now() - interval '2 days', 'reply_without_thread', NULL),
      ('${T.tres}', '${WS}', '${CO}', '${ANA}', '${SEQ}', 3, '${ENR.ana}', '${STEP.tres}', 'email', 'Otra idea', 'Una más.',
       'scheduled', now() - interval '5 hours', NULL, NULL),
      -- Pedro: su cadencia se pausó cuando Ana respondió en otra; lo suyo venció en la pausa.
      ('${T.pedro}', '${WS}', '${CO}', '${PEDRO}', '${SEQ}', 1, '${ENR.pedro}', '${STEP.uno}', 'email', 'Hola', 'Una idea.',
       'scheduled', now() - interval '6 hours', NULL, NULL),
      ('${T.ambiguo}', '${WS}', '${CO}', '${PEDRO}', NULL, NULL, NULL, NULL, 'email', 'Suelto', 'Un mensaje suelto.',
       'held', now() + interval '1 day', 'unconfirmed_attempt:1', NULL);
    UPDATE outbound_touch SET unconfirmed_attempt = 1 WHERE id = '${T.ambiguo}';
  `);
}, SETUP_TIMEOUT);
after(async () => {
  // Contra un Postgres que se queda (TEST_DATABASE_URL), se lleva lo suyo: la prueba se puede volver a correr.
  if (t?.kind === 'postgres') {
    await t.admin(`DELETE FROM workspace WHERE id = '${WS}'; DELETE FROM company WHERE id = '${CO}';
                   DELETE FROM app_user WHERE id IN ('${DUENA}', '${CLIENTE}');`);
  }
  await t?.close();
});

const web = <R>(fn: Parameters<typeof t.db.withWorkspace<R>>[1], userId?: string) =>
  t.db.withWorkspace(WS, fn, userId ? { userId } : undefined);
const estado = async (touch: string) =>
  t.db.asWorker(async (tx) =>
    (await tx.query<{ status: string; due: Date }>(
      `SELECT status, coalesce(next_retry_at, scheduled_for) AS due FROM outbound_touch WHERE id = $1`, [touch],
    )).rows[0]!,
  );
const debidos = () => t.db.asWorker(async (tx) => (await readAlertSignalCounts(tx, WS, new Date())).dueToSend);

test('una respuesta sin hilo no se aprueba: se salta, y el paso de detrás sale', async () => {
  // Lo que espera a una persona no es «el envío no sale»: ni lo de Pedro (en pausa) ni el tercero de Ana (detrás de un retenido).
  assert.equal(await debidos(), 0);
  assert.deepEqual(
    await web((tx) => releaseHeldTouch(tx, T.dos, { subject: null, body: 'Sigo por aquí.' })),
    { ok: false, code: 'no_thread' },
    'aprobarla la devolvía a la cola y el despachador la retenía otra vez, para siempre',
  );
  assert.equal((await estado(T.dos)).status, 'held');
  assert.deepEqual(await web((tx) => skipQueuedTouch(tx, T.dos, new Date())), { ok: true, recipientName: 'Ana Vitalé' });
  assert.equal((await estado(T.dos)).status, 'skipped');
  const [enr] = await t.db.asWorker(async (tx) =>
    (await tx.query<{ status: string; current_step_id: string }>(
      `SELECT status, current_step_id FROM outbound_enrollment WHERE id = $1`, [ENR.ana],
    )).rows,
  );
  assert.deepEqual({ ...enr }, { status: 'active', current_step_id: STEP.tres }, 'la cadencia sigue con el tercero');
  assert.equal(await debidos(), 1, 'ahora el tercero sí espera al envío');
});

test('una cadencia en pausa se reanuda desde la ficha: lo vencido sale desde ahora', async () => {
  const antes = Date.now();
  assert.deepEqual(await web((tx) => resumeEnrollment(tx, ENR.pedro, new Date())), { ok: true, rescheduled: 1 });
  const [enr] = await t.db.asWorker(async (tx) =>
    (await tx.query<{ status: string }>(`SELECT status FROM outbound_enrollment WHERE id = $1`, [ENR.pedro])).rows,
  );
  assert.equal(enr?.status, 'active');
  const pedro = await estado(T.pedro);
  assert.equal(pedro.status, 'scheduled');
  assert.ok(new Date(pedro.due).getTime() >= antes - 1000, 'sale desde ahora, no con la hora de antes de la pausa');
  assert.deepEqual(await web((tx) => resumeEnrollment(tx, ENR.pedro, new Date())), { ok: false, code: 'not_paused' });
  assert.deepEqual(await web((tx) => resumeEnrollment(tx, ENR.ana, new Date())), { ok: false, code: 'not_paused' });
});

test('a quien pidió la baja no se le reanuda', async () => {
  await t.admin(`UPDATE outbound_enrollment SET status = 'paused' WHERE id = '${ENR.pedro}';
                 UPDATE contact SET opted_out = true, opted_out_at = now() WHERE id = '${PEDRO}'`);
  assert.deepEqual(await web((tx) => resumeEnrollment(tx, ENR.pedro, new Date())), { ok: false, code: 'opted_out' });
  await t.admin(`UPDATE contact SET opted_out = false, opted_out_at = NULL WHERE id = '${PEDRO}'`);
});

test('resolver un intento sin confirmar es del equipo: un cliente no, la dueña sí', async () => {
  await assert.rejects(
    web((tx) => resolveUnconfirmedTouch(tx, T.ambiguo, 'was_sent'), CLIENTE),
    (e: { code?: string; message?: string }) => e.code === '42501' && /es del equipo del workspace/.test(e.message ?? ''),
  );
  assert.equal((await estado(T.ambiguo)).status, 'held');
  assert.deepEqual(await web((tx) => resolveUnconfirmedTouch(tx, T.ambiguo, 'was_sent'), DUENA), { ok: true });
  assert.equal((await estado(T.ambiguo)).status, 'sent');
});

test('el aviso de un retenido: uno por motivo, y otro si vuelve a retenerse por otra cosa', async () => {
  const avisos = async () =>
    t.db.asWorker(async (tx) =>
      (await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM notification WHERE entity_type = 'outbound_touch_held' AND entity_id = $1`, [T.tres],
      )).rows[0]!.n,
    );
  const avisar = (motivo: string) => t.db.asWorker((tx) => notifyTouchHeld(tx, T.tres, motivo, new Date()));
  assert.equal(await avisar('no_postal_address'), true);
  assert.equal(await avisar('no_postal_address'), false, 'el mismo motivo no se repite');
  assert.equal(await avisar('unconfirmed_attempt:1'), true, 'otro motivo, que pide mirar la carpeta de enviados, sí');
  assert.equal(await avisos(), 2);
});
