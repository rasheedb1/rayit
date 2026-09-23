/**
 * VEN-4 · sales.follow_ups sobre Postgres embebido con las migraciones
 * del repo, como mc_worker.
 *
 * El «terminado cuando»: correr el job con un negocio vencido crea la
 * notificación y volver a correrlo no la duplica. Además: lo que vence
 * hoy avisa como 'deal_due'; lo cerrado, lo futuro y lo que no tiene
 * acción no avisan; cada aviso va al espacio de su negocio y a su
 * responsable; «cada mañana» es la mañana de cada espacio, y lo vencido
 * se avisa la mañana siguiente, no la misma noche; una zona mal escrita
 * en un espacio no deja sin avisos a los demás.
 *
 * deal.next_action_set_at (0036) lo pone un disparador con el reloj
 * real; las pruebas corren con un `now` fijo, así que cada negocio lo
 * fija a mano (al insertarlo, y en `tocar` cuando cambia la acción) para
 * que «la acción se escribió hoy» no dependa del día en que corren.
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
const DEAL_ESCRITO_HOY = '0000000a-0000-4000-8000-000000000d08';
const WS_ROTO = '0000000a-0000-4000-8000-000000000004';
const COMPANY_ROTO = '0000000a-0000-4000-8000-0000000000c4';
const DEAL_ROTO = '0000000a-0000-4000-8000-000000000d09';
const DEAL_BOGOTA_2 = '0000000a-0000-4000-8000-000000000d0a';
const DEAL_LLAMADA = '0000000a-0000-4000-8000-000000000d0b';
const DEAL_RESP_FUERA = '0000000a-0000-4000-8000-000000000d0c';
const DEAL_NADIE = '0000000a-0000-4000-8000-000000000d0d';
const DEAL_659 = '0000000a-0000-4000-8000-000000000d0e';
/** Alguien que tuvo negocios en Bogotá y ya no es del espacio (sin membership). */
const USER_EX = '0000000a-0000-4000-8000-0000000000a3';

/** Antes de todas las corridas de la prueba: nadie tocó los negocios «hoy». */
const TOCADO_ANTES = '2026-09-01T00:00:00Z';

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

/**
 * Cambia un negocio fijando updated_at, sin el disparador que lo pone con
 * el reloj real. Si `set` cambia la acción o su fecha, fija también
 * next_action_set_at: si no, el disparador de 0036 pondría el reloj real.
 */
async function tocar(id: string, set: string, updatedAt: string): Promise<void> {
  await db.raw.exec(`
    ALTER TABLE deal DISABLE TRIGGER deal_updated;
    UPDATE deal SET ${set}, updated_at = '${updatedAt}' WHERE id = '${id}';
    ALTER TABLE deal ENABLE TRIGGER deal_updated;
  `);
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
    INSERT INTO deal (id, workspace_id, company_id, owner_user_id, next_action_user_id, name, stage_id, currency, next_action, next_action_due, updated_at, next_action_set_at) VALUES
      ('${DEAL_VENCIDO}',    '${WS_BOGOTA}', '${COMPANY}', '${USER_LAURA}', '${USER_ANA}', 'Renovación Q4', 'conversacion', 'COP', 'Llamar a Valentina', '2026-09-22T20:00:00Z', '${TOCADO_ANTES}', '${TOCADO_ANTES}'),
      ('${DEAL_HOY}',        '${WS_BOGOTA}', '${COMPANY}', '${USER_LAURA}', NULL, 'Lanzamiento', 'propuesta', 'COP', 'Seguimiento a la cotización', '2026-09-23T20:00:00Z', '${TOCADO_ANTES}', '${TOCADO_ANTES}'),
      ('${DEAL_FUTURO}',     '${WS_BOGOTA}', '${COMPANY}', NULL, NULL, 'Navidad', 'nuevo', 'COP', 'Enviar pitch', '2026-10-26T20:00:00Z', '${TOCADO_ANTES}', '${TOCADO_ANTES}'),
      ('${DEAL_GANADO}',     '${WS_BOGOTA}', '${COMPANY}', NULL, NULL, 'Cold brew', 'ganado', 'COP', 'Cobrar la factura', '2026-09-20T20:00:00Z', '${TOCADO_ANTES}', '${TOCADO_ANTES}'),
      ('${DEAL_SIN_ACCION}', '${WS_BOGOTA}', '${COMPANY}', NULL, NULL, 'Sin plan', 'contactado', 'COP', NULL, '2026-09-20T20:00:00Z', '${TOCADO_ANTES}', '${TOCADO_ANTES}'),
      ('${DEAL_MADRID}',     '${WS_MADRID}', '${COMPANY_MADRID}', NULL, NULL, 'Otoño', 'contactado', 'EUR', 'Enviar propuesta', '2026-09-21T09:00:00Z', '${TOCADO_ANTES}', '${TOCADO_ANTES}'),
      ('${DEAL_HONOLULU}',   '${WS_HONOLULU}', '${COMPANY_HONOLULU}', NULL, NULL, 'Verano', 'contactado', 'USD', 'Escribir a la marca', '2026-09-21T09:00:00Z', '${TOCADO_ANTES}', '${TOCADO_ANTES}');
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

test('una zona mal escrita en un espacio se cuenta en UTC y no deja sin avisos a los demás', async () => {
  // Un dato de antes de 0035: el disparador ya no deja guardarlo, así que
  // se escribe con el disparador apagado, como estaría en una base vieja.
  await db.raw.exec(`
    ALTER TABLE workspace DISABLE TRIGGER workspace_timezone_check;
    INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS_ROTO}', 'seg-roto', 'Zona mal escrita', 'Bogota');
    ALTER TABLE workspace ENABLE TRIGGER workspace_timezone_check;
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${COMPANY_ROTO}', 'Marca rota', '${WS_ROTO}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS_ROTO}', '${COMPANY_ROTO}');
    INSERT INTO deal (id, workspace_id, company_id, name, stage_id, currency, next_action, next_action_due, updated_at, next_action_set_at) VALUES
      ('${DEAL_ROTO}',     '${WS_ROTO}',   '${COMPANY_ROTO}', 'Con zona rota', 'contactado', 'COP', 'Llamar', '2026-09-22T20:00:00Z', '${TOCADO_ANTES}', '${TOCADO_ANTES}'),
      ('${DEAL_BOGOTA_2}', '${WS_BOGOTA}', '${COMPANY}',      'Segundo',       'contactado', 'COP', 'Escribir a Juan', '2026-09-22T20:00:00Z', '${TOCADO_ANTES}', '${TOCADO_ANTES}');
  `);
  // 15:00 UTC: 10:00 en Bogotá. Antes, «time zone "Bogota" not recognized»
  // tumbaba la corrida entera y el espacio de Bogotá tampoco recibía nada.
  const r = await runSeguimientos(db, new Date('2026-09-23T15:00:00Z'));
  assert.deepEqual([...r.dealIds].sort(), [DEAL_ROTO, DEAL_BOGOTA_2].sort());
  const roto = (await avisos()).find((a) => a.entity_id === DEAL_ROTO);
  assert.equal(roto?.workspace_id, WS_ROTO);
});

test('0035 no deja guardar una zona que Postgres no conoce, y sí una IANA', async () => {
  await assert.rejects(
    db.raw.exec(`UPDATE workspace SET timezone = 'Bogota' WHERE id = '${WS_BOGOTA}'`),
    /zona horaria desconocida: «Bogota»/,
  );
  await assert.rejects(
    db.raw.exec(`INSERT INTO workspace (id, slug, name, timezone) VALUES (gen_random_uuid(), 'seg-otra', 'Otra', 'UTC-5')`),
    /zona horaria desconocida/,
  );
  // Un espacio con una zona vieja mal escrita puede cambiar otras cosas…
  await db.raw.exec(`UPDATE workspace SET name = 'Zona mal escrita (renombrada)' WHERE id = '${WS_ROTO}'`);
  // …y arreglar la zona.
  await db.raw.exec(`UPDATE workspace SET timezone = 'America/Bogota' WHERE id = '${WS_ROTO}'`);
  const { rows } = await db.raw.query<{ timezone: string }>(`SELECT timezone FROM workspace WHERE id = '${WS_ROTO}'`);
  assert.equal(rows[0]?.timezone, 'America/Bogota');
});

test('lo vencido se avisa la mañana siguiente, nunca la misma tarde ni la misma noche', async () => {
  // «Lanzamiento» vence hoy a las 15:00 de Bogotá (20:00 UTC) y ya recibió
  // «Vence hoy» a las 9:00. A las 16:00 y a las 21:00 no se avisa otra vez.
  for (const hora of ['2026-09-23T21:00:00Z', '2026-09-24T02:00:00Z']) {
    const r = await runSeguimientos(db, new Date(hora));
    assert.deepEqual(r.dealIds, [], hora);
  }
  // Entre medianoche y las 7:00 locales tampoco.
  assert.deepEqual((await runSeguimientos(db, new Date('2026-09-24T10:00:00Z'))).dealIds, []);
  // A las 7:05 de Bogotá del día siguiente (12:05 UTC), sí.
  const manana = await runSeguimientos(db, new Date('2026-09-24T12:05:00Z'));
  assert.deepEqual(manana, { dueToday: 0, overdue: 1, dealIds: [DEAL_HOY] });
});

test('una acción escrita hoy para hoy no avisa «Vence hoy»; si sigue ahí, avisa vencida a la mañana siguiente', async () => {
  // Escrita a las 10:00 de Bogotá (15:00 UTC) para hoy a las 17:00.
  await db.raw.exec(`
    INSERT INTO deal (id, workspace_id, company_id, name, stage_id, currency, next_action, next_action_due, updated_at, next_action_set_at) VALUES
      ('${DEAL_ESCRITO_HOY}', '${WS_BOGOTA}', '${COMPANY}', 'Escrito hoy', 'contactado', 'COP', 'Mandar el brief', '2026-09-24T22:00:00Z', '2026-09-24T15:00:00Z', '2026-09-24T15:00:00Z');
  `);
  const r = await runSeguimientos(db, new Date('2026-09-24T16:05:00Z'));
  assert.deepEqual(r.dealIds, [], 'quien la acaba de escribir no necesita el recordatorio');
  // La corrida a mano con --ya sí la avisa: quiere ver todo lo pendiente.
  const ya = await runSeguimientos(db, new Date('2026-09-24T16:10:00Z'), { horaLocal: 0 });
  assert.deepEqual(ya, { dueToday: 1, overdue: 0, dealIds: [DEAL_ESCRITO_HOY] });
  const siguiente = await runSeguimientos(db, new Date('2026-09-25T12:05:00Z'));
  assert.deepEqual(siguiente, { dueToday: 0, overdue: 1, dealIds: [DEAL_ESCRITO_HOY] });
});

test('leer o descartar el aviso no lo resucita; reprogramar y volver a vencer sí avisa otra vez', async () => {
  await db.raw.exec(`UPDATE notification SET read_at = now(), dismissed_at = now() WHERE entity_id = '${DEAL_VENCIDO}'`);
  assert.equal((await runSeguimientos(db, new Date('2026-09-25T13:05:00Z'))).overdue, 0);

  // El 25 por la tarde le movieron la fecha al 26 a las 10:00 de Bogotá.
  await tocar(DEAL_VENCIDO, `next_action_due = '2026-09-26T15:00:00Z', next_action_set_at = '2026-09-25T20:00:00Z'`, '2026-09-25T20:00:00Z');
  // La mañana del 26: «Vence hoy», no vencido.
  const dia = await runSeguimientos(db, new Date('2026-09-26T12:05:00Z'));
  assert.deepEqual(dia, { dueToday: 1, overdue: 0, dealIds: [DEAL_VENCIDO] });
  // A las 11:00 ya pasó su hora, pero el vencido espera a la mañana.
  assert.deepEqual((await runSeguimientos(db, new Date('2026-09-26T16:05:00Z'))).dealIds, []);
  // La mañana del 27 sigue sin hacerse: aviso nuevo de vencido, es otro compromiso.
  const despues = await runSeguimientos(db, new Date('2026-09-27T12:05:00Z'));
  assert.deepEqual(despues, { dueToday: 0, overdue: 1, dealIds: [DEAL_VENCIDO] });
  const otra = await runSeguimientos(db, new Date('2026-09-27T13:05:00Z'));
  assert.deepEqual(otra.dealIds, []);
});

test('lo cerrado, lo futuro y lo que no tiene acción nunca avisan', async () => {
  const ids = new Set((await avisos()).map((a) => a.entity_id));
  for (const id of [DEAL_FUTURO, DEAL_GANADO, DEAL_SIN_ACCION]) assert.ok(!ids.has(id), id);
});

test('0036: next_action_set_at lo mueve la acción o su fecha, no una llamada ni la etapa', async () => {
  const leer = async () =>
    (await db.raw.query<{ at: string | null }>(`SELECT next_action_set_at::text AS at FROM deal WHERE id = '${DEAL_FUTURO}'`)).rows[0]?.at;
  const antes = await leer();
  assert.ok(antes, 'la fila del seed de la prueba lo trae fijado');
  // Lo que hace logActivity al registrar una llamada, y un cambio de etapa.
  await db.raw.exec(`UPDATE deal SET last_contact_at = now(), updated_at = now() WHERE id = '${DEAL_FUTURO}'`);
  await db.raw.exec(`UPDATE deal SET stage_id = 'contactado', amount = 1000 WHERE id = '${DEAL_FUTURO}'`);
  assert.equal(await leer(), antes, 'una llamada o la etapa no son escribir la acción');
  // Mover la fecha sí: el disparador pone el reloj de la base.
  await db.raw.exec(`UPDATE deal SET next_action_due = next_action_due + interval '1 day' WHERE id = '${DEAL_FUTURO}'`);
  const despues = await leer();
  assert.notEqual(despues, antes);
  // Un negocio que nace con acción también lo trae, sin decirlo.
  await db.raw.exec(`
    INSERT INTO deal (id, workspace_id, company_id, name, stage_id, currency, next_action, next_action_due)
    VALUES (gen_random_uuid(), '${WS_BOGOTA}', '${COMPANY}', 'Nace con acción', 'nuevo', 'COP', 'Enviar pitch', now() + interval '3 days')`);
  const { rows } = await db.raw.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM deal WHERE name = 'Nace con acción' AND next_action_set_at IS NOT NULL`,
  );
  assert.equal(rows[0]?.n, 1);
  await db.raw.exec(`DELETE FROM deal WHERE name = 'Nace con acción'`);
});

test('una llamada registrada a las 8:00 no borra el «Vence hoy» de una corrida atrasada', async () => {
  // La acción se escribió el 27; vence el 28 a las 18:00 de Bogotá (23:00 UTC).
  await db.raw.exec(`
    INSERT INTO deal (id, workspace_id, company_id, owner_user_id, name, stage_id, currency, next_action, next_action_due, updated_at, next_action_set_at) VALUES
      ('${DEAL_LLAMADA}', '${WS_BOGOTA}', '${COMPANY}', '${USER_LAURA}', 'Con llamada', 'conversacion', 'COP', 'Mandar la propuesta', '2026-09-28T23:00:00Z', '2026-09-27T17:00:00Z', '2026-09-27T17:00:00Z');
  `);
  // El worker estuvo caído de 7:00 a 9:00. A las 8:00 de Bogotá (13:00
  // UTC) alguien registra una llamada: logActivity mueve last_contact_at
  // y updated_at del negocio, no su acción.
  await tocar(DEAL_LLAMADA, `last_contact_at = '2026-09-28T13:00:00Z'`, '2026-09-28T13:00:00Z');
  // La corrida de las 9:05 pone al día lo que faltaba.
  const r = await runSeguimientos(db, new Date('2026-09-28T14:05:00Z'));
  assert.deepEqual(r, { dueToday: 1, overdue: 0, dealIds: [DEAL_LLAMADA] });
  const aviso = (await avisos()).find((a) => a.entity_id === DEAL_LLAMADA);
  assert.equal(aviso?.kind, 'deal_due');
  assert.equal(aviso?.user_id, USER_LAURA);
});

test('un responsable que ya no es del espacio no recibe el aviso: pasa al del negocio y, si tampoco, a todo el espacio', async () => {
  await db.raw.exec(`
    INSERT INTO app_user (id, email, name) VALUES ('${USER_EX}', 'ex@seguimientos.test', 'Se fue');
    INSERT INTO deal (id, workspace_id, company_id, owner_user_id, next_action_user_id, name, stage_id, currency, next_action, next_action_due, updated_at, next_action_set_at) VALUES
      ('${DEAL_RESP_FUERA}', '${WS_BOGOTA}', '${COMPANY}', '${USER_ANA}', '${USER_EX}', 'Responsable ido', 'contactado', 'COP', 'Escribir a Pedro', '2026-09-29T22:00:00Z', '${TOCADO_ANTES}', '${TOCADO_ANTES}'),
      ('${DEAL_NADIE}',      '${WS_BOGOTA}', '${COMPANY}', '${USER_EX}', '${USER_EX}', 'Todos idos',      'contactado', 'COP', 'Escribir a Marta', '2026-09-29T22:00:00Z', '${TOCADO_ANTES}', '${TOCADO_ANTES}');
  `);
  const r = await runSeguimientos(db, new Date('2026-09-29T12:05:00Z'));
  assert.ok(r.dealIds.includes(DEAL_RESP_FUERA) && r.dealIds.includes(DEAL_NADIE), r.dealIds.join(', '));
  const lista = await avisos();
  assert.equal(lista.find((a) => a.entity_id === DEAL_RESP_FUERA)?.user_id, USER_ANA, 'al responsable del negocio, que sigue');
  assert.equal(lista.find((a) => a.entity_id === DEAL_NADIE)?.user_id, null, 'a todo el espacio');
  assert.ok(!lista.some((a) => a.user_id === USER_EX), 'nunca a quien se fue');
});

test('lo que vence hoy antes de la hora de aviso (6:59) avisa «Seguimiento vencido», no «Vence hoy», y una sola vez', async () => {
  // Como las acciones del seed en Supabase: vence el 30 a las 6:59 de
  // Bogotá (11:59 UTC). A las 7:05 «Para hoy» y el tablero ya la pintan
  // «Vencido»; el aviso no puede decir otra cosa del mismo negocio.
  await db.raw.exec(`
    INSERT INTO deal (id, workspace_id, company_id, owner_user_id, name, stage_id, currency, next_action, next_action_due, updated_at, next_action_set_at) VALUES
      ('${DEAL_659}', '${WS_BOGOTA}', '${COMPANY}', '${USER_LAURA}', 'Antes de las 7', 'contactado', 'COP', 'Llamar temprano', '2026-09-30T11:59:00Z', '${TOCADO_ANTES}', '${TOCADO_ANTES}');
  `);
  const delNegocio = async () => (await avisos()).filter((a) => a.entity_id === DEAL_659);

  const r = await runSeguimientos(db, new Date('2026-09-30T12:05:00Z'));
  assert.ok(r.dealIds.includes(DEAL_659));
  const [aviso, ...otros] = await delNegocio();
  assert.deepEqual(otros, []);
  assert.equal(aviso?.kind, 'deal_overdue');
  assert.equal(aviso?.severity, 'warning');
  assert.equal(aviso?.title_es, 'Seguimiento vencido: Llamar temprano · Café Alma');

  // Ni la corrida de la hora siguiente ni la de la mañana siguiente lo repiten.
  await runSeguimientos(db, new Date('2026-09-30T13:05:00Z'));
  await runSeguimientos(db, new Date('2026-10-01T12:05:00Z'));
  assert.equal((await delNegocio()).length, 1);
});
