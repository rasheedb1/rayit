/**
 * VEN-10 · pulido r5 · ganar o perder un negocio detiene su cadencia (0076).
 *
 * El hallazgo: Sofía Cárdenas (Vitalé) aceptó COT-2026-007 desde el
 * enlace público, el negocio quedó «Ganado» y /ventas/aprobaciones seguía
 * ofreciendo aprobar el paso 4 de la prospección, con el paso de LinkedIn
 * «Programado» en la ficha. Aquí se comprueba:
 *   · aceptar por el enlace (mc_public_share) deja cero toques vivos de
 *     esa marca, cancelados con deal_won, y su cadencia cerrada;
 *   · perder un negocio cierra la cadencia de ESE negocio (deal_lost) y
 *     no la de otro negocio de la misma marca; ganar el otro, sí;
 *   · el reclamo del despachador cancela un toque de un negocio que ya
 *     estaba ganado cuando se programó (la red de seguridad).
 *
 * Ids nuevos en cada corrida: contra un Postgres que se queda, la prueba
 * se puede repetir.
 */
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceTx } from '../src/client.ts';
import { createSequenceFromTemplate, setSequenceStatus } from '../src/queries/cadencias/index.ts';
import { claimDueTouches } from '../src/queries/outreach.ts';
import { enrollContacts } from '../src/queries/outreach/enroll.ts';
import { listApprovalQueue } from '../src/queries/bandejas.ts';
import { acceptPublicQuote } from '../src/queries/cotizar.ts';
import { createDeal, moveDeal } from '../src/queries/ventas.ts';
import { openTestDb, SETUP_TIMEOUT, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

const VITALE = '00000002-0000-4000-8000-0000000000e7';
const ENROLAMIENTO_VITALE = '00000005-0000-4000-8000-0000000e0001';
const FIRMA = { name: 'Sofía Cárdenas', email: 'sofia@vitale.co' };

const WS = randomUUID();
const CREADORA = randomUUID();
const MARCA = randomUUID();
const MARCA_GANADA = randomUUID();
const ANA = randomUUID();
const LUIS = randomUUID();
const PEPE = randomUUID();
/** Un miércoles a mediodía en Bogotá: dentro de la ventana laboral. */
const CLOCK = new Date('2026-09-23T12:00:00-05:00');

let t: TestDb;
const enWs = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WS, fn);

/** Los toques de cadencia que todavía pueden salir (borrador, retenido, programado), por contacto o marca. */
async function vivos(ws: string, where: string, arg: string): Promise<number> {
  const { rows } = await t.db.asWorker((tx) =>
    tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbound_touch
        WHERE workspace_id = $1::uuid AND enrollment_id IS NOT NULL
          AND status IN ('draft', 'held', 'scheduled') AND ${where} = $2::uuid`,
      [ws, arg],
    ),
  );
  return rows[0]!.n;
}

async function motivos(ws: string, where: string, arg: string): Promise<string[]> {
  const { rows } = await t.db.asWorker((tx) =>
    tx.query<{ blocked_reason: string | null }>(
      `SELECT DISTINCT blocked_reason FROM outbound_touch
        WHERE workspace_id = $1::uuid AND enrollment_id IS NOT NULL AND status = 'canceled' AND ${where} = $2::uuid
        ORDER BY 1`,
      [ws, arg],
    ),
  );
  return rows.map((r) => r.blocked_reason ?? '');
}

async function estadoDe(enrollmentId: string): Promise<string> {
  const { rows } = await t.db.asWorker((tx) =>
    tx.query<{ status: string }>('SELECT status FROM outbound_enrollment WHERE id = $1::uuid', [enrollmentId]),
  );
  return rows[0]!.status;
}

before(async () => {
  t = await openTestDb();
  const slug = `cerrado-${WS.slice(0, 8)}`;
  await t.admin(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS}', '${slug}', 'Negocios cerrados', 'America/Bogota');
    INSERT INTO creator_profile (id, workspace_id, display_name, country) VALUES ('${CREADORA}', '${WS}', 'Creadora', 'CO');
    INSERT INTO company (id, name, industry, owner_workspace_id) VALUES
      ('${MARCA}', 'Granola Andina', 'alimentos', '${WS}'),
      ('${MARCA_GANADA}', 'Té del Valle', 'alimentos', '${WS}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS}', '${MARCA}'), ('${WS}', '${MARCA_GANADA}');
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source) VALUES
      ('${ANA}', '${MARCA}', '${WS}', 'Ana Ríos', 'ana.${slug}@granola.test', 'user_provided'),
      ('${LUIS}', '${MARCA}', '${WS}', 'Luis Mora', 'luis.${slug}@granola.test', 'user_provided'),
      ('${PEPE}', '${MARCA_GANADA}', '${WS}', 'Pepe Díaz', 'pepe.${slug}@te.test', 'user_provided');
    INSERT INTO outbound_policy (workspace_id, enabled, postal_address, require_human_review, max_touches_per_company, min_days_between_touches)
    VALUES ('${WS}', true, 'Calle 93 # 11-26, Bogotá', false, 10, 0);
  `);
}, SETUP_TIMEOUT);

after(async () => {
  await t?.close();
});

test('aceptar la cotización de Vitalé por el enlace deja cero toques vivos de la marca y fuera de aprobaciones', async () => {
  const antes = await vivos(WORKSPACE_LAURA, 'company_id', VITALE);
  assert.ok(antes >= 3, `la demo trae la cadencia de Vitalé viva (programado, retenido, borrador): ${antes}`);
  const cola = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listApprovalQueue(tx));
  assert.ok(cola.items.some((i) => i.companyId === VITALE), 'antes de aceptar, el paso retenido de Vitalé espera en aprobaciones');

  const { rows } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
    tx.query<{ slug: string }>(
      `SELECT slug FROM quote WHERE company_id = $1::uuid AND status IN ('sent', 'viewed') AND slug IS NOT NULL
        ORDER BY number DESC LIMIT 1`,
      [VITALE],
    ),
  );
  assert.ok(rows[0], 'la demo trae una cotización de Vitalé por aceptar');
  const r = await t.db.withPublicShare((tx) => acceptPublicQuote(tx, rows[0]!.slug, FIRMA));
  assert.equal(r.status, 'ok');

  assert.equal(await vivos(WORKSPACE_LAURA, 'company_id', VITALE), 0, 'ni el programado, ni el retenido, ni el borrador');
  assert.ok((await motivos(WORKSPACE_LAURA, 'company_id', VITALE)).includes('deal_won'));
  assert.equal(await estadoDe(ENROLAMIENTO_VITALE), 'completed');
  const despues = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listApprovalQueue(tx));
  assert.ok(!despues.items.some((i) => i.companyId === VITALE), 'aprobaciones ya no ofrece escribirle a una marca que firmó');
});

test('perder un negocio cierra su cadencia (deal_lost) y no la de otro negocio de la misma marca; ganar el otro, sí', async () => {
  const seq = await enWs((tx) => createSequenceFromTemplate(tx, 'marca-con-campana-activa'));
  await enWs((tx) => setSequenceStatus(tx, seq, 'active'));
  const perdido = await enWs((tx) => createDeal(tx, { companyId: MARCA, name: 'Serie de otoño', amount: '4000000', now: CLOCK }));
  const otro = await enWs((tx) => createDeal(tx, { companyId: MARCA, name: 'Línea de snacks', amount: '6000000', now: CLOCK }));
  const a = await enWs((tx) => enrollContacts(tx, { sequenceId: seq, contactIds: [ANA], dealId: perdido, now: CLOCK }));
  const l = await enWs((tx) => enrollContacts(tx, { sequenceId: seq, contactIds: [LUIS], dealId: otro, now: CLOCK }));
  const [enrAna, enrLuis] = [a.enrolled[0]!.enrollmentId, l.enrolled[0]!.enrollmentId];
  const deLuis = await vivos(WS, 'contact_id', LUIS);
  assert.ok((await vivos(WS, 'contact_id', ANA)) > 0 && deLuis > 0, 'las dos cadencias nacen con toques por salir');

  await enWs((tx) => moveDeal(tx, perdido, 'perdido', { lostReason: 'precio' }));
  assert.equal(await vivos(WS, 'contact_id', ANA), 0);
  assert.deepEqual(await motivos(WS, 'contact_id', ANA), ['deal_lost']);
  assert.equal(await estadoDe(enrAna), 'completed');
  assert.equal(await vivos(WS, 'contact_id', LUIS), deLuis, 'la cadencia del otro negocio de la misma marca sigue');
  assert.equal(await estadoDe(enrLuis), 'active');

  await enWs((tx) => moveDeal(tx, otro, 'ganado'));
  assert.equal(await vivos(WS, 'contact_id', LUIS), 0);
  assert.deepEqual(await motivos(WS, 'contact_id', LUIS), ['deal_won']);
  assert.equal(await estadoDe(enrLuis), 'completed');
});

test('el reclamo cancela el toque de una cadencia cuyo negocio ya estaba ganado (red de seguridad)', async () => {
  const seq = await enWs((tx) => createSequenceFromTemplate(tx, 'marca-con-campana-activa'));
  await enWs((tx) => setSequenceStatus(tx, seq, 'active'));
  const ganado = await enWs((tx) => createDeal(tx, { companyId: MARCA_GANADA, name: 'Té de invierno', amount: '3000000', now: CLOCK }));
  await enWs((tx) => moveDeal(tx, ganado, 'ganado'));
  // La cadencia se programa DESPUÉS de ganar (un script, un enrolamiento a mano): el disparador no la vio.
  const enr = randomUUID();
  const toque = randomUUID();
  await t.admin(`
    INSERT INTO outbound_enrollment (id, workspace_id, sequence_id, contact_id, deal_id, status, started_at)
    VALUES ('${enr}', '${WS}', '${seq}', '${PEPE}', '${ganado}', 'active', '${CLOCK.toISOString()}');
    INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, deal_id, sequence_id, step_index, enrollment_id, step_id,
                                channel, subject, body, status, scheduled_for)
    SELECT '${toque}', '${WS}', '${MARCA_GANADA}', '${PEPE}', '${ganado}', '${seq}', 1, '${enr}', st.id,
           'email', 'Hola, Pepe', 'Una idea para Té del Valle.', 'scheduled', '${new Date(CLOCK.getTime() - 60_000).toISOString()}'
      FROM outbound_step st WHERE st.sequence_id = '${seq}' ORDER BY st.day_offset, st.order_in_day LIMIT 1;
  `);
  const r = await t.db.asWorker((tx) => claimDueTouches(tx, { now: CLOCK, channels: ['email'], workspaceId: WS, limit: 5 }));
  assert.ok(!r.claimed.some((c) => c.id === toque), 'no se reclama');
  assert.ok(r.canceledFinished >= 1);
  const { rows } = await t.db.asWorker((tx) =>
    tx.query<{ status: string; blocked_reason: string | null }>('SELECT status, blocked_reason FROM outbound_touch WHERE id = $1', [toque]),
  );
  assert.deepEqual({ ...rows[0] }, { status: 'canceled', blocked_reason: 'deal_won' });
});
