/**
 * VEN-4 · sales.follow_ups sobre Postgres embebido con las migraciones
 * del repo, como mc_worker.
 *
 * El «terminado cuando»: correr el job con un negocio vencido crea la
 * notificación y volver a correrlo no la duplica. Además: lo que vence
 * hoy avisa como 'deal_due'; lo cerrado, lo futuro y lo que no tiene
 * acción no avisan; cada aviso va al espacio de su negocio y a su
 * responsable; y «cada mañana» es la mañana de cada espacio.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { allJobs } from '../src/jobs/index.ts';
import { runSeguimientos, SEGUIMIENTOS_HORA_LOCAL, SEGUIMIENTOS_JOB_ID } from '../src/jobs/ventas/seguimientos.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { openTestDatabase } from './helpers/harness.ts';

/** 9:00 en Bogotá, 16:00 en Madrid, 4:00 en Honolulu. */
const NOW = new Date('2026-09-23T14:00:00Z');

const WS_BOGOTA = '0000000a-0000-4000-8000-000000000001';
const WS_MADRID = '0000000a-0000-4000-8000-000000000002';
const WS_HONOLULU = '0000000a-0000-4000-8000-000000000003';
const USER_LAURA = '0000000a-0000-4000-8000-0000000000a1';
const USER_ANA = '0000000a-0000-4000-8000-0000000000a2';
const COMPANY = '0000000a-0000-4000-8000-0000000000c1';
const COMPANY_MADRID = '0000000a-0000-4000-8000-0000000000c2';
const COMPANY_HONOLULU = '0000000a-0000-4000-8000-0000000000c3';

const DEAL_VENCIDO = '0000000a-0000-4000-8000-000000000d01';
const DEAL_HOY = '0000000a-0000-4000-8000-000000000d02';
const DEAL_FUTURO = '0000000a-0000-4000-8000-000000000d03';
const DEAL_GANADO = '0000000a-0000-4000-8000-000000000d04';
const DEAL_SIN_ACCION = '0000000a-0000-4000-8000-000000000d05';
const DEAL_MADRID = '0000000a-0000-4000-8000-000000000d06';
const DEAL_HONOLULU = '0000000a-0000-4000-8000-000000000d07';

let db: PgliteDatabase;

interface Aviso extends Record<string, unknown> {
  workspace_id: string;
  user_id: string | null;
  kind: string;
  severity: string;
  title_es: string;
  body_es: string | null;
  entity_type: string;
  entity_id: string;
  action_url: string;
}

async function avisos(): Promise<Aviso[]> {
  const { rows } = await db.raw.query<Aviso>(
    `SELECT workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url
       FROM notification WHERE kind IN ('deal_due', 'deal_overdue') ORDER BY created_at, entity_id, kind`,
  );
  return rows;
}

before(async () => {
  db = await openTestDatabase();
  await db.raw.exec(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES
      ('${WS_BOGOTA}', 'seg-bogota', 'Laura', 'America/Bogota'),
      ('${WS_MADRID}', 'seg-madrid', 'Agencia Madrid', 'Europe/Madrid'),
      ('${WS_HONOLULU}', 'seg-honolulu', 'Creadora Honolulu', 'Pacific/Honolulu');
    INSERT INTO app_user (id, email, name) VALUES
      ('${USER_LAURA}', 'laura@seguimientos.test', 'Laura'),
      ('${USER_ANA}', 'ana@seguimientos.test', 'Ana');
    INSERT INTO membership (workspace_id, user_id, role) VALUES
      ('${WS_BOGOTA}', '${USER_LAURA}', 'owner'),
      ('${WS_BOGOTA}', '${USER_ANA}', 'member');
    INSERT INTO company (id, name, owner_workspace_id) VALUES
      ('${COMPANY}', 'Café Alma', '${WS_BOGOTA}'),
      ('${COMPANY_MADRID}', 'Marca de Madrid', '${WS_MADRID}'),
      ('${COMPANY_HONOLULU}', 'Marca de Honolulu', '${WS_HONOLULU}');
    INSERT INTO company_link (workspace_id, company_id) VALUES
      ('${WS_BOGOTA}', '${COMPANY}'), ('${WS_MADRID}', '${COMPANY_MADRID}'), ('${WS_HONOLULU}', '${COMPANY_HONOLULU}');
    INSERT INTO deal (id, workspace_id, company_id, owner_user_id, next_action_user_id, name, stage_id, currency, next_action, next_action_due) VALUES
      ('${DEAL_VENCIDO}',    '${WS_BOGOTA}', '${COMPANY}', '${USER_LAURA}', '${USER_ANA}', 'Renovación Q4', 'conversacion', 'COP', 'Llamar a Valentina', '2026-09-22T20:00:00Z'),
      ('${DEAL_HOY}',        '${WS_BOGOTA}', '${COMPANY}', '${USER_LAURA}', NULL, 'Lanzamiento', 'propuesta', 'COP', 'Seguimiento a la cotización', '2026-09-23T20:00:00Z'),
      ('${DEAL_FUTURO}',     '${WS_BOGOTA}', '${COMPANY}', NULL, NULL, 'Navidad', 'nuevo', 'COP', 'Enviar pitch', '2026-09-26T20:00:00Z'),
      ('${DEAL_GANADO}',     '${WS_BOGOTA}', '${COMPANY}', NULL, NULL, 'Cold brew', 'ganado', 'COP', 'Cobrar la factura', '2026-09-20T20:00:00Z'),
      ('${DEAL_SIN_ACCION}', '${WS_BOGOTA}', '${COMPANY}', NULL, NULL, 'Sin plan', 'contactado', 'COP', NULL, '2026-09-20T20:00:00Z'),
      ('${DEAL_MADRID}',     '${WS_MADRID}', '${COMPANY_MADRID}', NULL, NULL, 'Otoño', 'contactado', 'EUR', 'Enviar propuesta', '2026-09-21T09:00:00Z'),
      ('${DEAL_HONOLULU}',   '${WS_HONOLULU}', '${COMPANY_HONOLULU}', NULL, NULL, 'Verano', 'contactado', 'USD', 'Escribir a la marca', '2026-09-21T09:00:00Z');
  `);
});
after(async () => {
  await db?.close();
});

test('el job está registrado y programado cada hora (0034)', async () => {
  assert.ok(allJobs.some((j) => j.id === SEGUIMIENTOS_JOB_ID));
  const { rows } = await db.raw.query<{ queue: string; default_cron: string; enabled: boolean }>(
    'SELECT queue, default_cron, enabled FROM job_definition WHERE id = $1',
    [SEGUIMIENTOS_JOB_ID],
  );
  assert.deepEqual(rows[0], { queue: 'sales', default_cron: '5 * * * *', enabled: true });
});

test('corre como mc_worker', async () => {
  const who = await db.whoAmI();
  assert.equal(who.currentUser, 'mc_worker');
  assert.equal(who.bypassRls, true);
});

test('un negocio vencido crea su aviso, lo de hoy avisa como deal_due, y volver a correrlo no duplica', async () => {
  const r1 = await runSeguimientos(db, NOW);
  assert.equal(r1.overdue, 2, 'el vencido de Bogotá y el de Madrid');
  assert.equal(r1.dueToday, 1, 'el que vence esta tarde en Bogotá');
  assert.deepEqual([...r1.dealIds].sort(), [DEAL_VENCIDO, DEAL_HOY, DEAL_MADRID].sort());

  const lista = await avisos();
  assert.equal(lista.length, 3);
  const vencido = lista.find((a) => a.entity_id === DEAL_VENCIDO);
  assert.deepEqual(
    { ...vencido },
    {
      workspace_id: WS_BOGOTA,
      user_id: USER_ANA,
      kind: 'deal_overdue',
      severity: 'warning',
      title_es: 'Seguimiento vencido: Llamar a Valentina · Café Alma',
      body_es: 'Negocio «Renovación Q4». Abre la ficha para registrar lo que pasó o moverle la fecha.',
      entity_type: 'deal',
      entity_id: DEAL_VENCIDO,
      action_url: `/ventas/empresas/${COMPANY}`,
    },
    'va al responsable de la acción, en el espacio del negocio',
  );
  const hoy = lista.find((a) => a.entity_id === DEAL_HOY);
  assert.equal(hoy?.kind, 'deal_due');
  assert.equal(hoy?.user_id, USER_LAURA, 'sin responsable de la acción, al del negocio');
  assert.equal(hoy?.title_es, 'Vence hoy: Seguimiento a la cotización · Café Alma');
  const madrid = lista.find((a) => a.entity_id === DEAL_MADRID);
  assert.equal(madrid?.workspace_id, WS_MADRID);
  assert.equal(madrid?.user_id, null, 'sin responsable, a todo el espacio');

  const r2 = await runSeguimientos(db, NOW);
  assert.deepEqual(r2, { dueToday: 0, overdue: 0, dealIds: [] });
  const r3 = await runSeguimientos(db, new Date(NOW.getTime() + 60 * 60 * 1000));
  assert.deepEqual(r3, { dueToday: 0, overdue: 0, dealIds: [] }, 'la corrida de la hora siguiente tampoco');
  assert.equal((await avisos()).length, 3);
});

test('«cada mañana» es la de cada espacio: Honolulu (4:00) espera a sus 7:00', async () => {
  assert.equal(SEGUIMIENTOS_HORA_LOCAL, 7);
  assert.ok(!(await avisos()).some((a) => a.workspace_id === WS_HONOLULU));
  // 7:00 en Honolulu son las 17:00 UTC.
  const r = await runSeguimientos(db, new Date('2026-09-23T17:00:00Z'));
  assert.deepEqual(r.dealIds, [DEAL_HONOLULU]);
  // Una corrida a mano con --ya (hora 0) no repite nada.
  const ya = await runSeguimientos(db, new Date('2026-09-23T17:30:00Z'), { horaLocal: 0 });
  assert.deepEqual(ya.dealIds, []);
});

test('leer o descartar el aviso no lo resucita; reprogramar y volver a vencer sí avisa otra vez', async () => {
  await db.raw.exec(`UPDATE notification SET read_at = now(), dismissed_at = now() WHERE entity_id = '${DEAL_VENCIDO}'`);
  assert.equal((await runSeguimientos(db, new Date('2026-09-23T18:00:00Z'))).overdue, 0);

  // Le movieron la fecha a mañana a las 10:00 y mañana a las 11:00 sigue sin hacerse.
  await db.raw.exec(`UPDATE deal SET next_action_due = '2026-09-24T15:00:00Z' WHERE id = '${DEAL_VENCIDO}'`);
  const manana = await runSeguimientos(db, new Date('2026-09-24T16:00:00Z'));
  // El reprogramado vence otra vez; el de «vence hoy» de ayer ya venció y avisa como vencido.
  assert.deepEqual([...manana.dealIds].sort(), [DEAL_VENCIDO, DEAL_HOY].sort());
  assert.equal(manana.overdue, 2);
  const otra = await runSeguimientos(db, new Date('2026-09-24T16:00:00Z'));
  assert.deepEqual(otra.dealIds, []);
});

test('lo cerrado, lo futuro y lo que no tiene acción nunca avisan', async () => {
  const ids = new Set((await avisos()).map((a) => a.entity_id));
  for (const id of [DEAL_FUTURO, DEAL_GANADO, DEAL_SIN_ACCION]) assert.ok(!ids.has(id), id);
});
