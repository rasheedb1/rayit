/**
 * La ficha de empresa (VEN-5) y la siguiente acción (VEN-4) contra
 * Postgres embebido con las migraciones y el seed aplicados.
 *
 * El «terminado cuando» de las dos historias, en la capa de datos:
 *   - registrar una llamada la pone en la línea de tiempo y mueve
 *     deal.last_contact_at (una nota no lo mueve, y una llamada vieja no
 *     lo hace retroceder);
 *   - la siguiente acción se fija con fecha y hora EN LA ZONA DEL ESPACIO,
 *     y un negocio sin ella se cuenta en «Para hoy»;
 *   - nada de esto cruza de un workspace a otro.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTACT_ACTIVITY_KINDS,
  FichaError,
  completeNextAction,
  getCompanyChain,
  listCompanyActivity,
  listCompanySignals,
  listDueToday,
  listNextActions,
  listNicheNames,
  logActivity,
  setNextAction,
} from '../src/queries/ventas-ficha.ts';
import { CompanyNotFound, DealNotFound, listPipeline } from '../src/queries/ventas.ts';
import type { WorkspaceTx } from '../src/client.ts';
import { CAMPAIGN_CAFE_ALMA, COMPANY_CAFE_ALMA, INVOICE_FV_2026_010, WORKSPACE_LAURA, openTestDb, type TestDb } from './pglite.ts';

/** Negocios y empresas del seed 0002. */
const DEAL_CAFE_RENOVACION = '00000002-0000-4000-8000-0000000dea04';
const DEAL_CAFE_COLD_BREW = '00000002-0000-4000-8000-0000000dea11';
const COMPANY_VITALE = '00000002-0000-4000-8000-0000000000e7';
const DEAL_VITALE_PROPUESTA = '00000002-0000-4000-8000-0000000dea08';
const DEAL_VITALE_SNACKS = '00000002-0000-4000-8000-0000000dea14';
const DEAL_OLLA = '00000002-0000-4000-8000-0000000dea01';
const COMPANY_FRESKO = '00000002-0000-4000-8000-0000000000e2';
/** Valentina (Café Alma), contacto del seed. */
const CONTACT_VALENTINA = '00000002-0000-4000-8000-0000000c0003';
const CONTACT_CAMILA_FRESKO = '00000002-0000-4000-8000-0000000c0001';
const USER_LAURA = '00000002-0000-4000-8000-000000000002';

const WORKSPACE_AJENO = '00000009-0000-4000-8000-00000000fe01';
const COMPANY_AJENA = '00000009-0000-4000-8000-0000000000fe';
const DEAL_AJENO = '00000009-0000-4000-8000-0000000dfe01';
const USER_AJENO = '00000009-0000-4000-8000-0000000000a1';

let t: TestDb;
const laura = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WORKSPACE_LAURA, fn);
const ajeno = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WORKSPACE_AJENO, fn);

/** El día de hoy y el de mañana en Bogotá, la zona del workspace del seed, como «2026-09-23». */
function diaEnBogota(offsetDias = 0): string {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(new Date(Date.now() + offsetDias * 86_400_000));
}

async function lastContact(dealId: string): Promise<string | null> {
  return laura(async (tx) => {
    const { rows } = await tx.query<{ at: string | null }>(
      `SELECT to_char(last_contact_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at FROM deal WHERE id = $1`,
      [dealId],
    );
    return rows[0]?.at ?? null;
  });
}

async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof Error, 'lanza un Error');
    assert.equal((err as { code?: string }).code, code);
    return true;
  });
}

before(async () => {
  t = await openTestDb();
  await t.admin(`
    INSERT INTO workspace (id, slug, name, kind, currency, timezone)
    VALUES ('${WORKSPACE_AJENO}', 'workspace-ajeno-ficha', 'Workspace ajeno', 'creator', 'EUR', 'Europe/Madrid')
    ON CONFLICT DO NOTHING;
    INSERT INTO app_user (id, email, name) VALUES ('${USER_AJENO}', 'ajeno@ficha.test', 'Persona Ajena') ON CONFLICT DO NOTHING;
    INSERT INTO membership (workspace_id, user_id, role) VALUES ('${WORKSPACE_AJENO}', '${USER_AJENO}', 'owner') ON CONFLICT DO NOTHING;
    INSERT INTO company (id, name, domain, owner_workspace_id) VALUES ('${COMPANY_AJENA}', 'Marca de la ficha ajena', 'fichaajena.es', '${WORKSPACE_AJENO}')
    ON CONFLICT DO NOTHING;
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WORKSPACE_AJENO}', '${COMPANY_AJENA}') ON CONFLICT DO NOTHING;
    INSERT INTO deal (id, workspace_id, company_id, name, stage_id, currency, next_action, next_action_due)
    VALUES ('${DEAL_AJENO}', '${WORKSPACE_AJENO}', '${COMPANY_AJENA}', 'Negocio ajeno', 'contactado', 'EUR', 'Llamar', now() - interval '2 days')
    ON CONFLICT DO NOTHING;
    INSERT INTO activity (workspace_id, company_id, deal_id, kind, subject)
    VALUES ('${WORKSPACE_AJENO}', '${COMPANY_AJENA}', '${DEAL_AJENO}', 'note', 'Nota ajena');
  `);
});
after(async () => {
  await t?.close();
});

describe('VEN-5 · registrar una actividad', () => {
  test('una llamada entra en la línea de tiempo y mueve last_contact_at del negocio', async () => {
    const antes = await lastContact(DEAL_CAFE_RENOVACION);
    const res = await laura((tx) =>
      logActivity(tx, {
        companyId: COMPANY_CAFE_ALMA,
        kind: 'call',
        body: 'Valentina confirma que la renovación va por tres meses.',
        dealId: DEAL_CAFE_RENOVACION,
        contactId: CONTACT_VALENTINA,
      }),
    );
    assert.deepEqual(res.touchedDealIds, [DEAL_CAFE_RENOVACION]);

    const { rows } = await laura((tx) => listCompanyActivity(tx, COMPANY_CAFE_ALMA));
    const primera = rows[0];
    assert.ok(primera, 'hay actividad');
    assert.equal(primera.id, res.activityId, 'la llamada es la más reciente');
    assert.equal(primera.kind, 'call');
    assert.equal(primera.dealId, DEAL_CAFE_RENOVACION);
    assert.match(primera.contactName ?? '', /Valentina/);
    assert.match(primera.occurredAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    const despues = await lastContact(DEAL_CAFE_RENOVACION);
    assert.ok(despues, 'tiene último contacto');
    assert.ok(!antes || despues > antes, `last_contact_at avanza (${antes} → ${despues})`);
    assert.ok(Math.abs(Date.parse(despues) - Date.now()) < 60_000, 'y es ahora');
  });

  test('una nota no es contacto: no mueve last_contact_at', async () => {
    const antes = await lastContact(DEAL_CAFE_RENOVACION);
    const res = await laura((tx) =>
      logActivity(tx, { companyId: COMPANY_CAFE_ALMA, kind: 'note', body: 'Prefieren reels a historias.', dealId: DEAL_CAFE_RENOVACION }),
    );
    assert.deepEqual(res.touchedDealIds, []);
    assert.equal(await lastContact(DEAL_CAFE_RENOVACION), antes);
  });

  test('una reunión sin negocio cuenta para todos los abiertos de la empresa, y no para los cerrados', async () => {
    const cerradoAntes = await lastContact(DEAL_CAFE_COLD_BREW);
    const res = await laura((tx) => logActivity(tx, { companyId: COMPANY_VITALE, kind: 'meeting', body: null }));
    assert.deepEqual([...res.touchedDealIds].sort(), [DEAL_VITALE_PROPUESTA, DEAL_VITALE_SNACKS].sort());
    assert.equal(await lastContact(DEAL_CAFE_COLD_BREW), cerradoAntes);
  });

  test('una llamada de un día anterior entra a mediodía de ese día y no hace retroceder last_contact_at', async () => {
    const antes = await lastContact(DEAL_CAFE_RENOVACION);
    const ayer = diaEnBogota(-3);
    const res = await laura((tx) =>
      logActivity(tx, { companyId: COMPANY_CAFE_ALMA, kind: 'call', dealId: DEAL_CAFE_RENOVACION, occurredOn: ayer }),
    );
    const { rows } = await laura((tx) => listCompanyActivity(tx, COMPANY_CAFE_ALMA, 200));
    const llamada = rows.find((r) => r.id === res.activityId);
    // Mediodía en Bogotá son las 17:00 UTC.
    assert.equal(llamada?.occurredAt, `${ayer}T17:00:00Z`);
    assert.equal(await lastContact(DEAL_CAFE_RENOVACION), antes);
  });

  test('lo que no se acepta: nota vacía, día futuro, negocio o contacto de otra empresa, empresa ajena', async () => {
    await rejects(laura((tx) => logActivity(tx, { companyId: COMPANY_CAFE_ALMA, kind: 'note', body: '   ' })), 'InvalidActivityBody');
    await rejects(
      laura((tx) => logActivity(tx, { companyId: COMPANY_CAFE_ALMA, kind: 'call', occurredOn: diaEnBogota(2) })),
      'InvalidActivityDate',
    );
    await rejects(
      laura((tx) => logActivity(tx, { companyId: COMPANY_CAFE_ALMA, kind: 'call', dealId: DEAL_VITALE_PROPUESTA })),
      'DealNotInCompany',
    );
    await rejects(
      laura((tx) => logActivity(tx, { companyId: COMPANY_CAFE_ALMA, kind: 'call', contactId: CONTACT_CAMILA_FRESKO })),
      'ContactNotInCompany',
    );
    await rejects(
      laura((tx) => logActivity(tx, { companyId: COMPANY_CAFE_ALMA, kind: 'stage_change' as never, body: 'x' })),
      'InvalidActivityKind',
    );
    await assert.rejects(laura((tx) => logActivity(tx, { companyId: COMPANY_AJENA, kind: 'call' })), CompanyNotFound);
    // Tampoco el negocio ajeno en una empresa propia.
    await rejects(
      laura((tx) => logActivity(tx, { companyId: COMPANY_CAFE_ALMA, kind: 'call', dealId: DEAL_AJENO })),
      'DealNotInCompany',
    );
  });

  test('las actividades de otro workspace no se ven', async () => {
    const mias = await laura((tx) => listCompanyActivity(tx, COMPANY_AJENA));
    assert.deepEqual(mias.rows, []);
    const suyas = await ajeno((tx) => listCompanyActivity(tx, COMPANY_CAFE_ALMA));
    assert.deepEqual(suyas.rows, []);
  });

  test('CONTACT_ACTIVITY_KINDS son llamada, correo y reunión', () => {
    assert.deepEqual([...CONTACT_ACTIVITY_KINDS].sort(), ['call', 'email_sent', 'meeting']);
  });
});

describe('VEN-4 · la siguiente acción', () => {
  test('se fija con día y hora en la zona del espacio, y el texto nuevo deja de ser «del producto»', async () => {
    const manana = diaEnBogota(1);
    await laura((tx) =>
      setNextAction(tx, DEAL_OLLA, { action: 'Llamar a Sofía', dueDate: manana, dueTime: '09:30', responsibleUserId: USER_LAURA }),
    );
    const fila = (await laura((tx) => listNextActions(tx))).find((r) => r.dealId === DEAL_OLLA);
    assert.ok(fila);
    assert.equal(fila.action, 'Llamar a Sofía');
    assert.equal(fila.dueDate, manana);
    assert.equal(fila.dueTime, '09:30');
    // 9:30 en Bogotá son las 14:30 UTC.
    assert.equal(fila.dueAt, `${manana}T14:30:00Z`);
    assert.equal(fila.responsibleUserId, USER_LAURA);
    assert.equal(fila.dueState, 'futuro');
    const kind = await laura((tx) => tx.query<{ k: string | null }>('SELECT next_action_kind AS k FROM deal WHERE id = $1', [DEAL_OLLA]));
    assert.equal(kind.rows[0]?.k, null, 'el pitch del radar ya no es el pitch: la escribió una persona');
  });

  test('sin hora, vence a las 15:00 locales, como las que pone el producto', async () => {
    const hoy = diaEnBogota();
    await laura((tx) => setNextAction(tx, DEAL_OLLA, { action: 'Enviar el pitch', dueDate: hoy }));
    const fila = (await laura((tx) => listNextActions(tx, { companyId: '00000002-0000-4000-8000-0000000000e8' })))[0];
    assert.equal(fila?.dueTime, '15:00');
    assert.equal(fila?.dueAt, `${hoy}T20:00:00Z`);
  });

  test('lo que no se acepta: sin texto, fecha que ya pasó, hora imposible, responsable de otro espacio, negocio cerrado o ajeno', async () => {
    const manana = diaEnBogota(1);
    await rejects(laura((tx) => setNextAction(tx, DEAL_OLLA, { action: '  ', dueDate: manana })), 'InvalidNextAction');
    await rejects(laura((tx) => setNextAction(tx, DEAL_OLLA, { action: 'x', dueDate: diaEnBogota(-1) })), 'PastDueDate');
    await rejects(laura((tx) => setNextAction(tx, DEAL_OLLA, { action: 'x', dueDate: manana, dueTime: '25:00' })), 'InvalidDueDate');
    await rejects(laura((tx) => setNextAction(tx, DEAL_OLLA, { action: 'x', dueDate: '2026-02-30x' })), 'InvalidDueDate');
    await rejects(
      laura((tx) => setNextAction(tx, DEAL_OLLA, { action: 'x', dueDate: manana, responsibleUserId: USER_AJENO })),
      'InvalidResponsible',
    );
    await rejects(laura((tx) => setNextAction(tx, DEAL_CAFE_COLD_BREW, { action: 'x', dueDate: manana })), 'DealClosed');
    await assert.rejects(laura((tx) => setNextAction(tx, DEAL_AJENO, { action: 'x', dueDate: manana })), DealNotFound);
    await assert.rejects(laura((tx) => setNextAction(tx, 'no-es-un-id', { action: 'x', dueDate: manana })), DealNotFound);
  });

  test('«Hecha» la deja en la historia y el negocio queda sin siguiente acción, contado en «Para hoy»', async () => {
    const antes = await laura((tx) => listDueToday(tx));
    await laura((tx) => completeNextAction(tx, DEAL_OLLA, (a) => `Hecho: ${a}`));
    const fila = (await laura((tx) => listNextActions(tx))).find((r) => r.dealId === DEAL_OLLA);
    assert.equal(fila?.action, null);
    assert.equal(fila?.dueState, 'sin_fecha');
    assert.equal(fila?.responsibleUserId, USER_LAURA, 'el responsable se conserva para la siguiente');
    const despues = await laura((tx) => listDueToday(tx));
    assert.equal(despues.withoutActionCount, antes.withoutActionCount + 1);
    const { rows } = await laura((tx) => listCompanyActivity(tx, '00000002-0000-4000-8000-0000000000e8'));
    assert.equal(rows[0]?.subject, 'Hecho: Enviar el pitch');
    await assert.rejects(laura((tx) => completeNextAction(tx, DEAL_OLLA, (a) => a)), FichaError);
  });

  test('«Para hoy»: lo vencido primero, lo de hoy después, y los conteos salen de SQL', async () => {
    // Un vencido de ayer y uno que vence esta noche, en Bogotá.
    await t.admin(`
      UPDATE deal SET next_action = 'Llamar a Sofía', next_action_due = now() - interval '1 day' WHERE id = '${DEAL_OLLA}';
      UPDATE deal SET next_action_due = ((now() AT TIME ZONE 'America/Bogota')::date + time '23:59:59') AT TIME ZONE 'America/Bogota'
       WHERE id = '${DEAL_VITALE_SNACKS}';
    `);
    const hoy = await laura((tx) => listDueToday(tx, 50));
    const ids = hoy.rows.map((r) => r.dealId);
    assert.ok(ids.includes(DEAL_OLLA));
    assert.ok(ids.includes(DEAL_VITALE_SNACKS));
    assert.ok(ids.indexOf(DEAL_OLLA) < ids.indexOf(DEAL_VITALE_SNACKS), 'el vencido va antes');
    assert.equal(hoy.rows.find((r) => r.dealId === DEAL_OLLA)?.dueState, 'vencido');
    assert.equal(hoy.rows.find((r) => r.dealId === DEAL_VITALE_SNACKS)?.dueState, 'hoy');
    assert.equal(hoy.overdueCount, hoy.rows.filter((r) => r.dueState === 'vencido').length);
    assert.equal(hoy.todayCount, hoy.rows.filter((r) => r.dueState === 'hoy').length);
    assert.ok(!ids.includes(DEAL_AJENO), 'el vencido del vecino no aparece');
    assert.ok(hoy.rows.every((r) => r.dueState === 'vencido' || r.dueState === 'hoy'));

    // Con 0034, el tablero cuenta «Hoy» igual, en la zona del espacio.
    const tablero = await laura((tx) => listPipeline(tx));
    assert.equal(tablero.find((d) => d.id === DEAL_VITALE_SNACKS)?.dueState, 'hoy');

    const suyo = await ajeno((tx) => listDueToday(tx));
    assert.deepEqual(suyo.rows.map((r) => r.dealId), [DEAL_AJENO]);
    assert.equal(suyo.overdueCount, 1);
  });
});

describe('VEN-5 · lo que sabemos y la cadena', () => {
  test('las señales de la empresa, con su fuente, también las descartadas', async () => {
    const senales = await laura((tx) => listCompanySignals(tx, COMPANY_FRESKO));
    assert.ok(senales.length > 0);
    assert.ok(senales.every((s) => s.sourceLabel.length > 0));
    const ordenadas = [...senales].sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
    assert.deepEqual(senales.map((s) => s.id), ordenadas.map((s) => s.id));
    assert.deepEqual(await ajeno((tx) => listCompanySignals(tx, COMPANY_FRESKO)), []);
  });

  test('negocio → cotización → campaña → factura de Café Alma', async () => {
    const chain = await laura((tx) => getCompanyChain(tx, COMPANY_CAFE_ALMA));
    const coldBrew = chain.byDeal[DEAL_CAFE_COLD_BREW];
    assert.ok(coldBrew, 'el negocio ganado tiene su cadena');
    assert.ok(coldBrew.campaigns.some((c) => c.id === CAMPAIGN_CAFE_ALMA), 'con su campaña');
    assert.ok(coldBrew.invoices.some((i) => i.id === INVOICE_FV_2026_010), 'y la factura de la campaña');
    const ajena = await ajeno((tx) => getCompanyChain(tx, COMPANY_CAFE_ALMA));
    assert.deepEqual(ajena, { byDeal: {}, loose: { quotes: [], campaigns: [], invoices: [] } });
  });

  test('los nombres de los nichos salen del catálogo', async () => {
    const nombres = await laura((tx) => listNicheNames(tx, ['cocina']));
    assert.equal(nombres[0]?.slug, 'cocina');
    assert.ok(nombres[0]?.nameEs);
    assert.deepEqual(await laura((tx) => listNicheNames(tx, [])), []);
  });
});
