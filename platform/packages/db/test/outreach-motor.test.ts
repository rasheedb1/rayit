/**
 * VEN-10 r2 · lo que la migración 0051 le pone al esquema del motor,
 * probado contra la base (embebida, o TEST_DATABASE_URL en el CI):
 *
 *   · los avisos de notification son la UNIÓN de las ramas y coinciden
 *     con NOTIFICATION_KINDS; los estados del enrolamiento, con
 *     ENROLLMENT_STATUSES (la lista que se aplique última no borra nada);
 *   · el contacto de un enrolamiento o de un toque es del workspace,
 *     también para el worker (contact_visible_to);
 *   · send_started_at y unconfirmed_attempt son solo del despachador;
 *   · outbound_counter_release devuelve una plaza y nunca baja de cero.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTIFICATION_KINDS } from '../src/schema/cimientos.ts';
import { ENROLLMENT_STATUSES } from '../src/schema/outreach.ts';
import { openTestDb, type TestDb } from './pglite.ts';

const WS_A = '00000041-0000-4000-8000-00000000000a';
const WS_B = '00000041-0000-4000-8000-00000000000b';
const CO_A = '00000041-0000-4000-8000-0000000000c1';
const CO_PUBLICA = '00000041-0000-4000-8000-0000000000c2';
const CONTACT_A = '00000041-0000-4000-8000-0000000000a1';
const CONTACT_B = '00000041-0000-4000-8000-0000000000b1';
const CONTACT_PUBLICO = '00000041-0000-4000-8000-0000000000d1';
const SEQ_A = '00000041-0000-4000-8000-0000000005a1';
const ACC_A = '00000041-0000-4000-8000-00000000aca1';
const TOUCH_A = '00000041-0000-4000-8000-0000000070a1';

let t: TestDb;

before(async () => {
  t = await openTestDb({ seeds: false });
  await t.admin(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES
      ('${WS_A}', 'motor-0041-a', 'Motor A', 'America/Bogota'),
      ('${WS_B}', 'motor-0041-b', 'Motor B', 'America/Bogota');
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${CO_A}', 'Marca de A', '${WS_A}'), ('${CO_PUBLICA}', 'Marca pública', NULL);
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_A}', '${CO_A}'), ('${WS_B}', '${CO_A}');
    INSERT INTO contact (id, company_id, full_name, email, source, owner_workspace_id) VALUES
      ('${CONTACT_A}', '${CO_A}', 'De A', 'a@marca.test', 'user_provided', '${WS_A}'),
      ('${CONTACT_B}', '${CO_A}', 'De B', 'b@marca.test', 'user_provided', '${WS_B}'),
      ('${CONTACT_PUBLICO}', '${CO_PUBLICA}', 'Prensa', 'prensa@publica.test', 'press', NULL);
    INSERT INTO outbound_sequence (id, workspace_id, name, channel, status) VALUES ('${SEQ_A}', '${WS_A}', 'Secuencia A', 'email', 'active');
    INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, status, daily_cap, weekly_cap)
    VALUES ('${ACC_A}', '${WS_A}', 'email', 'gmail_oauth', 'a@gmail.test', 'connected', 40, 200);
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, body, status, scheduled_for)
    VALUES ('${TOUCH_A}', '${WS_A}', '${CO_A}', '${CONTACT_A}', 'email', 'Hola', 'scheduled', now());
  `);
});
after(async () => {
  await t?.close();
});

/** Los valores de un CHECK (col IN (...)) tal como los guarda la base. */
async function checkValues(constraint: string): Promise<string[]> {
  const rows = await t.db.asWorker(async (tx) =>
    (await tx.query<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, [constraint])).rows,
  );
  assert.equal(rows.length, 1, constraint);
  return [...rows[0]!.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!).sort();
}

test('los avisos de la base son NOTIFICATION_KINDS: la unión de main, VEN-15 y el motor', async () => {
  assert.deepEqual(await checkValues('notification_kind_check'), [...NOTIFICATION_KINDS].sort());
  for (const kind of ['outreach_failed', 'outreach_reply', 'outreach_account_down', 'connection_added']) {
    assert.ok((NOTIFICATION_KINDS as readonly string[]).includes(kind), kind);
  }
});

test('los estados del enrolamiento son ENROLLMENT_STATUSES, con bounced', async () => {
  assert.deepEqual(await checkValues('outbound_enrollment_status_check'), [...ENROLLMENT_STATUSES].sort());
  assert.ok((ENROLLMENT_STATUSES as readonly string[]).includes('bounced'));
});

test('el contacto de un enrolamiento es del workspace, también para el worker', async () => {
  const enrolar = (contact: string) =>
    t.db.asWorker((tx) =>
      tx.query(`INSERT INTO outbound_enrollment (workspace_id, sequence_id, contact_id, status) VALUES ($1, $2, $3, 'active') RETURNING id`, [WS_A, SEQ_A, contact]),
    );
  await assert.rejects(enrolar(CONTACT_B), (e: { code?: string; message?: string }) => e.code === '23514' && /no es del workspace/.test(e.message ?? ''));
  // Una ficha pública solo si su empresa está en el embudo del workspace.
  await assert.rejects(enrolar(CONTACT_PUBLICO), /no es del workspace/);
  await t.admin(`INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_A}', '${CO_PUBLICA}')`);
  assert.equal((await enrolar(CONTACT_PUBLICO)).rows.length, 1);
  assert.equal((await enrolar(CONTACT_A)).rows.length, 1);
  const visible = await t.db.asWorker(async (tx) =>
    (await tx.query<{ a: boolean; b: boolean }>(`SELECT contact_visible_to($1, $3) AS a, contact_visible_to($2, $3) AS b`, [CONTACT_A, CONTACT_B, WS_A])).rows[0]!,
  );
  assert.deepEqual({ ...visible }, { a: true, b: false });
  // Y un toque no puede cambiar de contacto a uno ajeno.
  await assert.rejects(
    t.db.asWorker((tx) => tx.query(`UPDATE outbound_touch SET contact_id = $2 WHERE id = $1`, [TOUCH_A, CONTACT_B])),
    /no es del workspace/,
  );
});

test('send_started_at y unconfirmed_attempt los escribe solo el despachador', async () => {
  await assert.rejects(
    t.db.withWorkspace(WS_A, (tx) => tx.query(`UPDATE outbound_touch SET send_started_at = now() WHERE id = $1`, [TOUCH_A])),
    (e: { code?: string }) => e.code === '42501',
  );
  await assert.rejects(
    t.db.withWorkspace(WS_A, (tx) => tx.query(`UPDATE outbound_touch SET unconfirmed_attempt = 1 WHERE id = $1`, [TOUCH_A])),
    (e: { code?: string }) => e.code === '42501',
  );
  // La web sigue pudiendo tocar lo suyo del toque.
  await t.db.withWorkspace(WS_A, (tx) => tx.query(`UPDATE outbound_touch SET body = 'Hola otra vez' WHERE id = $1`, [TOUCH_A]));
  await t.db.asWorker((tx) => tx.query(`UPDATE outbound_touch SET unconfirmed_attempt = 1 WHERE id = $1`, [TOUCH_A]));
});

test('outbound_counter_release devuelve la plaza de hoy y de la semana, sin bajar de cero', async () => {
  const cuenta = async () =>
    t.db.asWorker(async (tx) =>
      (await tx.query<{ period: string; count: number }>(
        `SELECT period, count FROM outbound_counter WHERE workspace_id = $1 AND channel_account_id = $2 ORDER BY period`, [WS_A, ACC_A],
      )).rows.map((r) => `${r.period}:${r.count}`),
    );
  await t.db.asWorker(async (tx) => {
    for (let i = 0; i < 2; i++) {
      await tx.query(`SELECT increment_if_under_cap($1::uuid, $2::uuid, 'email', 10), increment_weekly($1::uuid, $2::uuid, 'email', 50)`, [WS_A, ACC_A]);
    }
  });
  assert.deepEqual(await cuenta(), ['day:2', 'week:2']);
  await t.db.asWorker((tx) => tx.query(`SELECT outbound_counter_release($1, $2, 'email')`, [WS_A, ACC_A]));
  assert.deepEqual(await cuenta(), ['day:1', 'week:1']);
  await t.db.asWorker(async (tx) => {
    for (let i = 0; i < 3; i++) await tx.query(`SELECT outbound_counter_release($1, $2, 'email')`, [WS_A, ACC_A]);
  });
  assert.deepEqual(await cuenta(), ['day:0', 'week:0'], 'nunca por debajo de cero');
  // La web no la llama: es del despachador.
  await assert.rejects(
    t.db.withWorkspace(WS_A, (tx) => tx.query(`SELECT outbound_counter_release($1, $2, 'email')`, [WS_A, ACC_A])),
    (e: { code?: string }) => e.code === '42501',
  );
});
