/**
 * VEN-16 · pulido r6 · los gestos a mano no se quedan para siempre en la cola.
 *
 * Los pasos que hace una persona (TEXTLESS_STEP_TYPES: comentario o
 * reacción en una red, tarea a mano) nacen como borradores que el
 * despachador nunca reclama. Aquí se comprueba que:
 *   · «Cola · N» no los cuenta, aunque la lista los enseñe;
 *   · markManualTouchDone los pasa a 'skipped' con DONE_BY_HAND y su
 *     fecha, y la cadencia se completa (antes quedaba 'active' para siempre);
 *   · un mensaje que On Cue envía no se marca a mano, y otro workspace no
 *     ve el toque.
 */
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { DONE_BY_HAND, getQueueFacets, listOutboundQueue, markManualTouchDone } from '../src/queries/actividad.ts';
import { openTestDb, SETUP_TIMEOUT, type TestDb } from './pglite.ts';

const WS = randomUUID();
const WS_OTRO = randomUUID();
const MARCA = randomUUID();
const PERSONA = randomUUID();
const SEQ = randomUUID();
const PASO_CORREO = randomUUID();
const PASO_COMENTARIO = randomUUID();
const ENROL = randomUUID();
const CORREO = randomUUID();
const COMENTARIO = randomUUID();

let t: TestDb;

before(async () => {
  t = await openTestDb({ seeds: false });
  const slug = `a-mano-${WS.slice(0, 8)}`;
  await t.admin(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES
      ('${WS}', '${slug}', 'Gestos a mano', 'America/Bogota'), ('${WS_OTRO}', '${slug}-otro', 'Otro', 'America/Bogota');
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${MARCA}', 'Vitalé', '${WS}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS}', '${MARCA}');
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, linkedin_url, source)
    VALUES ('${PERSONA}', '${MARCA}', '${WS}', 'Sofía Cárdenas', 'sofia@vitale.test', 'https://www.linkedin.com/in/sofia-${slug}', 'user_provided');
    INSERT INTO outbound_sequence (id, workspace_id, name, channel, status) VALUES ('${SEQ}', '${WS}', 'Con un comentario', 'email', 'active');
    INSERT INTO outbound_step (id, workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time, body_template, generate_with_ai)
    VALUES ('${PASO_CORREO}', '${WS}', '${SEQ}', 0, 0, 'email', 'email', '10:00', 'Hola', false),
           ('${PASO_COMENTARIO}', '${WS}', '${SEQ}', 2, 0, 'linkedin_comment', 'linkedin', '10:00', NULL, false);
    INSERT INTO outbound_enrollment (id, workspace_id, sequence_id, contact_id, status, current_step_id)
    VALUES ('${ENROL}', '${WS}', '${SEQ}', '${PERSONA}', 'active', '${PASO_COMENTARIO}');
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, sequence_id, enrollment_id, step_id, channel, subject, body,
                                status, scheduled_for, sent_at, recipient_address, provider_message_id, status_changed_at)
    VALUES ('${CORREO}', '${WS}', '${MARCA}', '${PERSONA}', '${SEQ}', '${ENROL}', '${PASO_CORREO}', 'email', 'Hola', 'Hola, Sofía.',
            'sent', now() - interval '2 days', now() - interval '2 days', 'sofia@vitale.test', 'prov-a-mano', now() - interval '2 days'),
           ('${COMENTARIO}', '${WS}', '${MARCA}', '${PERSONA}', '${SEQ}', '${ENROL}', '${PASO_COMENTARIO}', 'linkedin', NULL, '',
            'draft', now() + interval '1 day', NULL, NULL, NULL, now() - interval '2 days');
  `);
}, SETUP_TIMEOUT);

after(async () => {
  await t?.close();
});

test('«Cola · N» no cuenta un gesto a mano por hacer, aunque la lista lo enseñe', async () => {
  const facets = await t.db.withWorkspace(WS, (tx) => getQueueFacets(tx, {}));
  assert.equal(facets.counts.queue, 0);
  const cola = await t.db.withWorkspace(WS, (tx) => listOutboundQueue(tx, { bucket: 'queue' }));
  assert.deepEqual(cola.rows.map((r) => [r.touchId, r.status, r.stepType]), [[COMENTARIO, 'draft', 'linkedin_comment']]);
});

test('«Hecho» pasa el gesto a mano a saltado con su motivo, y la cadencia se completa', async () => {
  assert.deepEqual(await t.db.withWorkspace(WS, (tx) => markManualTouchDone(tx, CORREO)), { ok: false, code: 'not_manual' });
  assert.deepEqual(await t.db.withWorkspace(WS_OTRO, (tx) => markManualTouchDone(tx, COMENTARIO)), { ok: false, code: 'not_found' });
  assert.deepEqual(await t.db.withWorkspace(WS, (tx) => markManualTouchDone(tx, 'no-es-un-id')), { ok: false, code: 'not_found' });

  assert.deepEqual(await t.db.withWorkspace(WS, (tx) => markManualTouchDone(tx, COMENTARIO)), { ok: true });
  const { rows } = await t.db.asWorker((tx) =>
    tx.query<{ status: string; blocked_reason: string; reciente: boolean; enrol: string }>(
      `SELECT t.status, t.blocked_reason, t.status_changed_at > now() - interval '1 minute' AS reciente, e.status AS enrol
         FROM outbound_touch t JOIN outbound_enrollment e ON e.id = t.enrollment_id WHERE t.id = $1::uuid`,
      [COMENTARIO],
    ),
  );
  assert.deepEqual({ ...rows[0] }, { status: 'skipped', blocked_reason: DONE_BY_HAND, reciente: true, enrol: 'completed' });

  // Ya no está por hacer: una segunda vez no hace nada, y el historial lo tiene con su motivo.
  assert.deepEqual(await t.db.withWorkspace(WS, (tx) => markManualTouchDone(tx, COMENTARIO)), { ok: false, code: 'not_manual' });
  const historial = await t.db.withWorkspace(WS, (tx) => listOutboundQueue(tx, { bucket: 'history' }));
  assert.ok(historial.rows.some((r) => r.touchId === COMENTARIO && r.reason === DONE_BY_HAND));
});
