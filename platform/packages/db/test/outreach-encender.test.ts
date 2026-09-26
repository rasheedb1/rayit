/**
 * VEN-10 · apagar y volver a encender el envío desde la web, con la RLS
 * del workspace (mc_app): enableOutreach devuelve a la cola lo que
 * disable_outreach canceló (replanOutreach), en su estado de antes y con
 * su texto, y no toca lo de otro workspace.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkerSql, WorkspaceTx } from '../src/client.ts';
import { readSendReadiness } from '../src/queries/entregabilidad.ts';
import { disableOutreach, enableOutreach } from '../src/queries/outreach.ts';
import { openTestDb, SETUP_TIMEOUT, type TestDb } from './pglite.ts';

const id = (kind: string) => `00000054-0000-4000-8000-${kind.padStart(12, '0')}`;
const WS_A = id('a');
const WS_B = id('b');
const CO = id('c1');
const CONTACT = id('d1');
const SEQ = id('5e');
const STEP = { uno: id('5e01'), dos: id('5e02') };
const ENR = id('e1');
const T = { programado: id('71'), retenido: id('72') };

let t: TestDb;

before(async () => {
  t = await openTestDb({ seeds: false });
  await t.admin(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS_A}', 'encender-a', 'Encender A', 'America/Bogota'),
                                                          ('${WS_B}', 'encender-b', 'Encender B', 'America/Bogota');
    INSERT INTO outbound_policy (workspace_id, postal_address, enabled) VALUES ('${WS_A}', 'Calle 93 # 11-26, Bogotá', true),
                                                                               ('${WS_B}', 'Calle 1 # 2-3, Bogotá', true);
    -- Sin un canal conectado no se enciende (0037 §8.5).
    INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, status)
    VALUES ('${WS_A}', 'email', 'gmail_oauth', 'laura@encender-a.test', 'connected'),
           ('${WS_B}', 'email', 'gmail_oauth', 'laura@encender-b.test', 'connected');
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${CO}', 'Vitalé', '${WS_A}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_A}', '${CO}');
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source)
    VALUES ('${CONTACT}', '${CO}', '${WS_A}', 'Sofía Cárdenas', 'sofia@vitale.test', 'user_provided');
    INSERT INTO outbound_sequence (id, workspace_id, name, channel, status) VALUES ('${SEQ}', '${WS_A}', 'Dos correos', 'email', 'active');
    INSERT INTO outbound_step (id, workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time, subject_template, body_template)
    VALUES ('${STEP.uno}', '${WS_A}', '${SEQ}', 0, 0, 'email', 'email', '10:00', 'Hola', 'Una idea.'),
           ('${STEP.dos}', '${WS_A}', '${SEQ}', 2, 0, 'email', 'email', '10:00', 'Sigo', 'Otra idea.');
    INSERT INTO outbound_enrollment (id, workspace_id, sequence_id, contact_id, status) VALUES ('${ENR}', '${WS_A}', '${SEQ}', '${CONTACT}', 'active');
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, sequence_id, step_index, enrollment_id, step_id, channel,
                                subject, body, status, scheduled_for, held_reason) VALUES
      ('${T.programado}', '${WS_A}', '${CO}', '${CONTACT}', '${SEQ}', 1, '${ENR}', '${STEP.uno}', 'email', 'Hola', 'Una idea.',
       'scheduled', now() + interval '1 day', NULL),
      ('${T.retenido}', '${WS_A}', '${CO}', '${CONTACT}', '${SEQ}', 2, '${ENR}', '${STEP.dos}', 'email', 'Sigo', 'Lo escribí yo.',
       'held', now() + interval '3 days', 'needs_review');
  `);
}, SETUP_TIMEOUT);
after(async () => {
  await t?.close();
});

async function estado(touch: string): Promise<{ status: string; held_reason: string | null; blocked_reason: string | null; body: string }> {
  return t.db.asWorker(async (tx) =>
    (await tx.query<{ status: string; held_reason: string | null; blocked_reason: string | null; body: string }>(
      `SELECT status, held_reason, blocked_reason, body FROM outbound_touch WHERE id = $1`, [touch],
    )).rows[0]!,
  );
}

test('desde la web, encender devuelve lo que el apagado canceló, en su estado y con su texto', async () => {
  assert.equal(await t.db.withWorkspace(WS_A, (tx) => disableOutreach(tx, 'vacaciones')), 2);
  assert.equal((await estado(T.retenido)).blocked_reason, 'outreach_disabled');
  // Lo que la confirmación de /ventas/politica dice antes de encender es lo que vuelve.
  const antes = await t.db.withWorkspace(WS_A, (tx) => readSendReadiness(tx));
  assert.deepEqual(antes.replannable, { touches: 2, people: 1 });
  assert.deepEqual((await t.db.withWorkspace(WS_B, (tx) => readSendReadiness(tx))).replannable, { touches: 0, people: 0 });

  const plan = await t.db.withWorkspace(WS_A, (tx) => enableOutreach(tx));
  assert.deepEqual(plan, { enrollments: 1, scheduled: 1, held: 1 });
  assert.deepEqual({ ...(await estado(T.programado)) }, { status: 'scheduled', held_reason: null, blocked_reason: null, body: 'Una idea.' });
  assert.deepEqual({ ...(await estado(T.retenido)) }, {
    status: 'held', held_reason: 'needs_review', blocked_reason: null, body: 'Lo escribí yo.',
  });
  assert.deepEqual((await t.db.withWorkspace(WS_A, (tx) => readSendReadiness(tx))).replannable, { touches: 0, people: 0 });
  // Encender otra vez no cambia nada: ya no hay nada cancelado por el apagado.
  assert.deepEqual(await t.db.withWorkspace(WS_A, (tx) => enableOutreach(tx)), { enrollments: 0, scheduled: 0, held: 0 });
});

test('encender B no devuelve lo de A', async () => {
  await t.db.withWorkspace(WS_A, (tx) => disableOutreach(tx, 'vacaciones'));
  assert.deepEqual(await t.db.withWorkspace(WS_B, (tx) => enableOutreach(tx)), { enrollments: 0, scheduled: 0, held: 0 });
  assert.equal((await estado(T.programado)).status, 'canceled');
});

test('enableOutreach: el worker dice su workspace y la web no, y el error sale al compilar', async () => {
  // Solo tipos: tsc (pnpm typecheck) falla si alguna de estas líneas deja de ser un error.
  const soloTipos = (worker: WorkerSql, web: WorkspaceTx) => {
    // @ts-expect-error: con una transacción del worker hay que decir el workspace
    void enableOutreach(worker);
    // @ts-expect-error: la firma vieja (el reloj en el lugar del workspace) ya no compila
    void enableOutreach(worker, new Date());
    // @ts-expect-error: la web no lo dice: lo fija withWorkspace
    void enableOutreach(web, { workspaceId: WS_A });
    void enableOutreach(worker, { workspaceId: WS_A, now: new Date() });
    void enableOutreach(web, { now: new Date() });
  };
  assert.equal(typeof soloTipos, 'function');
  // Y en ejecución, el mismo error si alguien lo salta con un cast.
  await assert.rejects(
    t.db.asWorker((tx) => enableOutreach(tx as unknown as WorkspaceTx)),
    /con una transacción del worker hay que decir el workspace/,
  );
});
