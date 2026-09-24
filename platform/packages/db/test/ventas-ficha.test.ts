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
  listChainInvoices,
  listCompanyActivity,
  listCompanySignals,
  listDueToday,
  listNicheNames,
  logActivity,
  nextActionOf,
  setNextAction,
} from '../src/queries/ventas-ficha.ts';
import { CompanyNotFound, DealNotFound, listPipeline } from '../src/queries/ventas.ts';
import type { WorkspaceTx } from '../src/client.ts';
import { CAMPAIGN_CAFE_ALMA, COMPANY_CAFE_ALMA, INVOICE_FV_2026_010, WORKSPACE_LAURA, openTestDb, type TestDb, SETUP_TIMEOUT } from './pglite.ts';

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
/** Granos del Valle y Mateo Giraldo, que pidió la baja (seed 0002). */
const COMPANY_GRANOS = '00000002-0000-4000-8000-0000000000e6';
const CONTACT_MATEO_BAJA = '00000002-0000-4000-8000-0000000c0010';
const DEAL_GRANOS = '00000002-0000-4000-8000-0000000dea02';
const USER_LAURA = '00000002-0000-4000-8000-000000000002';

const WORKSPACE_AJENO = '00000009-0000-4000-8000-00000000fe01';
const COMPANY_AJENA = '00000009-0000-4000-8000-0000000000fe';
const DEAL_AJENO = '00000009-0000-4000-8000-0000000dfe01';
const USER_AJENO = '00000009-0000-4000-8000-0000000000a1';
/** Alguien que fue responsable en el espacio de Laura y ya no tiene membresía en ninguno. */
const USER_EX = '00000009-0000-4000-8000-0000000000a2';

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
    INSERT INTO app_user (id, email, name) VALUES ('${USER_EX}', 'ex@ficha.test', 'Se fue') ON CONFLICT DO NOTHING;
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
}, SETUP_TIMEOUT);
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

  test('el pipeline dice hace cuántos días fue el último contacto, contado en SQL', async () => {
    // La llamada de la prueba anterior fue ahora mismo.
    const fila = (await laura((tx) => listPipeline(tx, { companyId: COMPANY_CAFE_ALMA }))).find((d) => d.id === DEAL_CAFE_RENOVACION);
    assert.equal(fila?.lastContactDays, 0, 'hoy');
    assert.match(fila?.lastContactAt ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'ISO en UTC, como los demás instantes');
    // Un negocio abierto que no ha hablado con nadie: sin fecha y sin días.
    const olla = (await laura((tx) => listPipeline(tx))).find((d) => d.id === DEAL_OLLA);
    assert.equal(olla?.lastContactAt, null);
    assert.equal(olla?.lastContactDays, null);
  });

  test('registrar una llamada en un negocio con la acción vencida la propone para marcarla hecha', async () => {
    const antes = (await laura((tx) => listPipeline(tx, { companyId: COMPANY_GRANOS }))).find((d) => d.id === DEAL_GRANOS);
    assert.equal(antes?.dueState, 'vencido', 'el seed deja vencida «Llamar a Laura Quintero por la propuesta»');
    assert.ok((antes?.lastContactDays ?? 0) > 0);
    const res = await laura((tx) => logActivity(tx, { companyId: COMPANY_GRANOS, kind: 'call', dealId: DEAL_GRANOS }));
    assert.deepEqual(res.pendingActions, [{ dealId: DEAL_GRANOS, action: 'Llamar a Laura Quintero por la propuesta' }]);
    // La llamada cuenta como contacto de hoy, y la acción sigue ahí: nada se marca solo.
    const despues = (await laura((tx) => listPipeline(tx, { companyId: COMPANY_GRANOS }))).find((d) => d.id === DEAL_GRANOS);
    assert.equal(despues?.lastContactDays, 0);
    assert.equal(despues?.nextAction, 'Llamar a Laura Quintero por la propuesta');
    // Una nota no es contacto: no propone nada.
    const nota = await laura((tx) => logActivity(tx, { companyId: COMPANY_GRANOS, kind: 'note', body: 'Laura sale de vacaciones.', dealId: DEAL_GRANOS }));
    assert.deepEqual(nota.pendingActions, []);
    // Un negocio con la acción para dentro de días tampoco.
    const futura = await laura((tx) => logActivity(tx, { companyId: COMPANY_VITALE, kind: 'email_sent', dealId: DEAL_VITALE_SNACKS }));
    assert.deepEqual(futura.pendingActions, []);
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
    const { rows } = await laura((tx) => listCompanyActivity(tx, COMPANY_CAFE_ALMA, { limit: 200 }));
    const llamada = rows.find((r) => r.id === res.activityId);
    // Mediodía en Bogotá son las 17:00 UTC.
    assert.equal(llamada?.occurredAt, `${ayer}T17:00:00Z`);
    // Esa hora la puso el producto, no la persona: la pantalla pinta solo el día.
    assert.equal(llamada?.meta.timeUnknown, true);
    assert.equal(rows.find((r) => r.kind === 'call' && r.id !== res.activityId)?.meta.timeUnknown, false, 'la de hoy sí tiene hora');
    assert.equal(await lastContact(DEAL_CAFE_RENOVACION), antes);
  });

  test('a quien pidió la baja no se le registra una llamada, un correo ni una reunión; una nota sí', async () => {
    for (const kind of ['call', 'email_sent', 'meeting'] as const) {
      await rejects(
        laura((tx) => logActivity(tx, { companyId: COMPANY_GRANOS, kind, contactId: CONTACT_MATEO_BAJA })),
        'ContactOptedOut',
      );
    }
    const nota = await laura((tx) =>
      logActivity(tx, { companyId: COMPANY_GRANOS, kind: 'note', body: 'Mateo pidió la baja en marzo.', contactId: CONTACT_MATEO_BAJA }),
    );
    assert.ok(nota.activityId);
  });

  test('la línea de tiempo se lee por páginas, sin saltarse ni repetir ninguna', async () => {
    const todas = await laura((tx) => listCompanyActivity(tx, COMPANY_CAFE_ALMA, { limit: 200 }));
    assert.ok(todas.rows.length >= 4, 'Café Alma tiene historia de sobra');
    assert.equal(todas.nextCursor, null);

    const vistas: string[] = [];
    let before: string | null = null;
    do {
      const pagina = await laura((tx) => listCompanyActivity(tx, COMPANY_CAFE_ALMA, { limit: 3, before }));
      assert.ok(pagina.rows.length <= 3);
      vistas.push(...pagina.rows.map((r) => r.id));
      assert.equal(pagina.hasMore, pagina.nextCursor !== null);
      before = pagina.nextCursor;
    } while (before);
    assert.deepEqual(vistas, todas.rows.map((r) => r.id));

    // Un cursor que no se entiende no vuelve a dar la primera página.
    assert.deepEqual((await laura((tx) => listCompanyActivity(tx, COMPANY_CAFE_ALMA, { before: 'basura' }))).rows, []);
  });

  test('lo que no se acepta: nota vacía, día futuro, negocio o contacto de otra empresa, empresa ajena', async () => {
    await rejects(laura((tx) => logActivity(tx, { companyId: COMPANY_CAFE_ALMA, kind: 'note', body: '   ' })), 'InvalidActivityBody');
    await rejects(
      laura((tx) => logActivity(tx, { companyId: COMPANY_CAFE_ALMA, kind: 'call', occurredOn: diaEnBogota(2) })),
      'InvalidActivityDate',
    );
    // Un día que no existe es su error de campo, no uno de Postgres.
    await rejects(
      laura((tx) => logActivity(tx, { companyId: COMPANY_CAFE_ALMA, kind: 'call', occurredOn: '2026-02-30' })),
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
  /** La siguiente acción de cada negocio abierto, leída como la leen el tablero y la ficha: de listPipeline. */
  const acciones = async (companyId?: string) =>
    (await laura((tx) => listPipeline(tx, companyId ? { companyId } : {}))).flatMap((d) => nextActionOf(d) ?? []);

  test('listPipeline trae lo que el editor necesita, y un negocio cerrado no tiene siguiente acción', async () => {
    const tablero = await laura((tx) => listPipeline(tx));
    const cerrado = tablero.find((d) => d.id === DEAL_CAFE_COLD_BREW);
    assert.ok(cerrado && (cerrado.isWon || cerrado.isLost));
    assert.equal(nextActionOf(cerrado), null);
    const abierto = tablero.find((d) => d.id === DEAL_CAFE_RENOVACION);
    assert.ok(abierto);
    assert.match(abierto.nextActionDue ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'el instante sale como ISO en UTC');
  });

  test('se fija con día y hora en la zona del espacio, y el texto nuevo deja de ser «del producto»', async () => {
    const manana = diaEnBogota(1);
    await laura((tx) =>
      setNextAction(tx, DEAL_OLLA, { action: 'Llamar a Sofía', dueDate: manana, dueTime: '09:30', responsibleUserId: USER_LAURA }),
    );
    const fila = (await acciones()).find((r) => r.dealId === DEAL_OLLA);
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
    const manana = diaEnBogota(1);
    const r = await laura((tx) => setNextAction(tx, DEAL_OLLA, { action: 'Enviar el pitch', dueDate: manana }));
    const fila = (await acciones('00000002-0000-4000-8000-0000000000e8'))[0];
    assert.equal(fila?.dueTime, '15:00');
    assert.equal(fila?.dueAt, `${manana}T20:00:00Z`);
    assert.equal(r.dueAt, fila?.dueAt, 'devuelve el instante guardado');
  });

  test('hoy y sin hora: las 15:00 si no han pasado; si ya pasaron, la próxima hora en punto. Nunca nace vencida', async () => {
    const hoy = diaEnBogota();
    const r = await laura((tx) => setNextAction(tx, DEAL_OLLA, { action: 'Enviar el pitch', dueDate: hoy }));
    assert.ok(Date.parse(r.dueAt) > Date.now(), `${r.dueAt} es futuro`);
    assert.match(r.dueAt, /T\d{2}:00:00Z$/, 'en punto');
    const fila = (await acciones('00000002-0000-4000-8000-0000000000e8'))[0];
    assert.notEqual(fila?.dueState, 'vencido');
  });

  test('hoy con una hora que ya pasó: «Esa hora ya pasó», no una acción que nace vencida', async () => {
    // Las 00:00 de hoy en Bogotá ya pasaron a cualquier hora del día.
    await rejects(
      laura((tx) => setNextAction(tx, DEAL_OLLA, { action: 'Llamar a Carolina', dueDate: diaEnBogota(), dueTime: '00:00' })),
      'PastDueTime',
    );
  });

  test('lo que no se acepta: sin texto, fecha que ya pasó, hora imposible, responsable de otro espacio, negocio cerrado o ajeno', async () => {
    const manana = diaEnBogota(1);
    await rejects(laura((tx) => setNextAction(tx, DEAL_OLLA, { action: '  ', dueDate: manana })), 'InvalidNextAction');
    await rejects(laura((tx) => setNextAction(tx, DEAL_OLLA, { action: 'x', dueDate: diaEnBogota(-1) })), 'PastDueDate');
    await rejects(laura((tx) => setNextAction(tx, DEAL_OLLA, { action: 'x', dueDate: diaEnBogota(-1), dueTime: '23:00' })), 'PastDueDate');
    await rejects(laura((tx) => setNextAction(tx, DEAL_OLLA, { action: 'x', dueDate: manana, dueTime: '25:00' })), 'InvalidDueDate');
    await rejects(laura((tx) => setNextAction(tx, DEAL_OLLA, { action: 'x', dueDate: '2026-02-30x' })), 'InvalidDueDate');
    // V8 acepta Date.parse('2026-02-30T00:00:00Z') y Postgres no: tiene que
    // volver InvalidDueDate, no «date/time field value out of range».
    for (const imposible of ['2026-02-30', '2027-02-31', '2026-04-31']) {
      await rejects(laura((tx) => setNextAction(tx, DEAL_OLLA, { action: 'x', dueDate: imposible })), 'InvalidDueDate');
    }
    await rejects(
      laura((tx) => setNextAction(tx, DEAL_OLLA, { action: 'x', dueDate: manana, responsibleUserId: USER_AJENO })),
      'InvalidResponsible',
    );
    await rejects(laura((tx) => setNextAction(tx, DEAL_CAFE_COLD_BREW, { action: 'x', dueDate: manana })), 'DealClosed');
    await assert.rejects(laura((tx) => setNextAction(tx, DEAL_AJENO, { action: 'x', dueDate: manana })), DealNotFound);
    await assert.rejects(laura((tx) => setNextAction(tx, 'no-es-un-id', { action: 'x', dueDate: manana })), DealNotFound);
  });

  test('«Marcarla hecha» de un aviso viejo no cierra la acción nueva: ActionChanged y el negocio queda como estaba', async () => {
    // El guion del revisor en Olla Fácil: el aviso del registro preguntaba
    // por «Llamar a Sofía», esa se cerró desde la línea y alguien escribió
    // otra. Pulsar el aviso viejo cerraba la NUEVA y la historia decía
    // «Hecho: …» de algo que nadie hizo.
    const empresa = '00000002-0000-4000-8000-0000000000e8';
    const antes = (await acciones(empresa)).find((r) => r.dealId === DEAL_OLLA);
    assert.equal(antes?.action, 'Enviar el pitch');
    const historia = async () => (await laura((tx) => listCompanyActivity(tx, empresa))).rows.map((r) => r.id);
    const idsAntes = await historia();

    await assert.rejects(laura((tx) => completeNextAction(tx, DEAL_OLLA, (a) => `Hecho: ${a}`, 'Llamar a Sofía')), (err: unknown) => {
      assert.ok(err instanceof FichaError);
      assert.equal(err.code, 'ActionChanged');
      assert.deepEqual(err.params, { current: 'Enviar el pitch', companyId: empresa }, 'dice cuál es ahora, para explicarlo');
      return true;
    });
    const despues = (await acciones(empresa)).find((r) => r.dealId === DEAL_OLLA);
    assert.equal(despues?.action, 'Enviar el pitch', 'la acción nueva sigue ahí');
    assert.equal(despues?.dueAt, antes?.dueAt);
    assert.deepEqual(await historia(), idsAntes, 'y la historia no ganó un «Hecho»');
    // Una acción que ya no existe tampoco se «cierra» desde un aviso que la nombraba.
    await rejects(laura((tx) => completeNextAction(tx, DEAL_OLLA, (a) => a, '')), 'ActionChanged');
  });

  test('«Hecha» la deja en la historia y el negocio queda sin siguiente acción, contado en «Para hoy»', async () => {
    const antes = await laura((tx) => listDueToday(tx));
    // Con la acción que se vio (los espacios de los bordes no cuentan, como en nextActionOf).
    await laura((tx) => completeNextAction(tx, DEAL_OLLA, (a) => `Hecho: ${a}`, ' Enviar el pitch '));
    const fila = (await acciones()).find((r) => r.dealId === DEAL_OLLA);
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

  test('una fecha sin texto no es un seguimiento vencido: cuenta solo como «sin siguiente acción»', async () => {
    const antes = await laura((tx) => listDueToday(tx, 50));
    await t.admin(`UPDATE deal SET next_action = '   ', next_action_due = now() - interval '2 days' WHERE id = '${DEAL_GRANOS}'`);
    const despues = await laura((tx) => listDueToday(tx, 50));
    assert.ok(!despues.rows.some((r) => r.dealId === DEAL_GRANOS), 'no sale en la lista');
    const eraVencido = antes.rows.some((r) => r.dealId === DEAL_GRANOS && r.dueState === 'vencido');
    assert.equal(despues.overdueCount, antes.overdueCount - (eraVencido ? 1 : 0), 'ni en los vencidos');
    assert.equal(despues.withoutActionCount, antes.withoutActionCount + 1, 'sí en los que hay que arreglar');
    // Y cuadra con la lista: los conteos son los de las filas.
    assert.equal(despues.overdueCount + despues.todayCount, despues.rows.length + despues.moreCount);
  });

  test('el pipeline se filtra en SQL: por empresa y por lo que pide «Para hoy»', async () => {
    const deVitale = await laura((tx) => listPipeline(tx, { companyId: COMPANY_VITALE }));
    assert.deepEqual(deVitale.map((d) => d.id).sort(), [DEAL_VITALE_PROPUESTA, DEAL_VITALE_SNACKS].sort());
    assert.deepEqual(await laura((tx) => listPipeline(tx, { companyId: 'no-es-un-id' })), []);
    assert.deepEqual(await laura((tx) => listPipeline(tx, { companyId: COMPANY_AJENA })), []);

    const hoy = await laura((tx) => listDueToday(tx, 50));
    const sinAccion = await laura((tx) => listPipeline(tx, { seguimiento: 'sin_accion' }));
    assert.equal(sinAccion.length, hoy.withoutActionCount, 'los mismos que cuenta «Para hoy»');
    assert.ok(sinAccion.some((d) => d.id === DEAL_GRANOS));
    assert.ok(sinAccion.every((d) => !d.isWon && !d.isLost));

    const paraHoy = await laura((tx) => listPipeline(tx, { seguimiento: 'para_hoy' }));
    assert.deepEqual(paraHoy.map((d) => d.id).sort(), hoy.rows.map((r) => r.dealId).sort());
    assert.ok(paraHoy.every((d) => d.dueState === 'vencido' || d.dueState === 'hoy'));
  });

  test('un responsable que ya dejó el espacio se conserva al cambiar solo la fecha; uno nuevo tiene que ser del espacio', async () => {
    const manana = diaEnBogota(1);
    await t.admin(`UPDATE deal SET next_action = 'Llamar a Sofía', next_action_user_id = '${USER_EX}' WHERE id = '${DEAL_OLLA}'`);
    // El formulario manda el responsable que ya tenía: guardar no falla en «Quién» ni lo borra.
    await laura((tx) => setNextAction(tx, DEAL_OLLA, { action: 'Llamar a Sofía', dueDate: manana, dueTime: '10:00', responsibleUserId: USER_EX }));
    const fila = (await laura((tx) => listPipeline(tx))).find((d) => d.id === DEAL_OLLA);
    assert.equal(fila?.nextActionUserId, USER_EX);
    assert.equal(fila?.nextActionDueDate, manana);
    // Pasárselo a alguien que no es del espacio, no.
    await rejects(
      laura((tx) => setNextAction(tx, DEAL_OLLA, { action: 'Llamar a Sofía', dueDate: manana, responsibleUserId: USER_AJENO })),
      'InvalidResponsible',
    );
    // Y cambiarlo por alguien del espacio, sí.
    await laura((tx) => setNextAction(tx, DEAL_OLLA, { action: 'Llamar a Sofía', dueDate: manana, responsibleUserId: USER_LAURA }));
    const ahora = (await laura((tx) => listPipeline(tx))).find((d) => d.id === DEAL_OLLA);
    assert.equal(ahora?.nextActionUserId, USER_LAURA);
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
    // El estado de la campaña llega tipado (CampaignStatus), sin cast en la pantalla.
    assert.ok(coldBrew.campaigns.every((c) => c.status !== null));
  });

  test('la cadena trae el estado de Finanzas de TODAS sus facturas, aunque la marca tenga más de 200', async () => {
    // Una agencia con un cliente recurrente: 250 facturas sueltas más las del seed.
    await t.admin(`
      INSERT INTO invoice (workspace_id, company_id, number, currency, subtotal, total, issued_on, due_on, status)
      SELECT '${WORKSPACE_LAURA}', '${COMPANY_CAFE_ALMA}', 'REC-' || lpad(n::text, 4, '0'), 'COP', 100, 100,
             DATE '2024-01-01' + n, DATE '2024-01-31' + n, 'paid'
        FROM generate_series(1, 250) AS n;
    `);
    try {
      const { chain, invoices } = await laura(async (tx) => {
        const c = await getCompanyChain(tx, COMPANY_CAFE_ALMA);
        return { chain: c, invoices: await listChainInvoices(tx, COMPANY_CAFE_ALMA, c) };
      });
      const enCadena = [chain.loose, ...Object.values(chain.byDeal)].flatMap((l) => l.invoices.map((i) => i.id));
      assert.ok(enCadena.length > 250);
      assert.equal(invoices.missing, 0, 'no se descarta ninguna en silencio');
      assert.equal(invoices.byId.size, enCadena.length);
      assert.ok(invoices.byId.get(INVOICE_FV_2026_010), 'la de la campaña, que es de las más recientes');
      assert.ok([...invoices.byId.values()].some((i) => i.number === 'REC-0001'), 'y la más vieja, que caía fuera de la primera página');
    } finally {
      await t.admin(`DELETE FROM invoice WHERE number LIKE 'REC-%'`);
    }
  });

  test('los nombres de los nichos salen del catálogo', async () => {
    const nombres = await laura((tx) => listNicheNames(tx, ['cocina']));
    assert.equal(nombres[0]?.slug, 'cocina');
    assert.ok(nombres[0]?.nameEs);
    assert.deepEqual(await laura((tx) => listNicheNames(tx, [])), []);
  });
});

describe('0035 · las zonas mal escritas que ya estaban se corrigen al migrar', () => {
  test('«Bogota» pasa a America/Bogota, una ambigua o inventada a UTC, y ninguna lectura con AT TIME ZONE vuelve a fallar', async (ctx) => {
    // Sin esto, la vista deal_pipeline (0034) y WORKSPACE_TZ hacían
    // `AT TIME ZONE` con la zona tal cual, y un espacio en 'Bogota' perdía
    // el tablero, «Para hoy» y la ficha enteros. La base se reconstruye tal
    // como estaba antes de 0035, se siembran las zonas malas y se migra con
    // el mismo rol que en Supabase (dueño de la tabla, con RLS forzada).
    if (t.kind !== 'pglite') return ctx.skip('reconstruir una base a medio migrar solo se puede sobre pglite');
    const { createEmbeddedDb } = await import('../src/embedded.ts');
    const antes = await createEmbeddedDb({ seeds: false, hasta: '0034_seguimientos.sql' });
    try {
      const casos: Record<string, [string, string]> = {
        'zona-sin-region': ['Bogota', 'America/Bogota'],
        'zona-minusculas': ['america/bogota', 'America/Bogota'],
        'zona-madrid': [' Madrid ', 'Europe/Madrid'],
        'zona-inventada': ['Marte/Olimpo', 'UTC'],
        'zona-ambigua': ['Central', 'UTC'],
        'zona-vacia': ['', 'UTC'],
        'zona-buena': ['America/Mexico_City', 'America/Mexico_City'],
      };
      await antes.execAsSuperuser(
        `INSERT INTO workspace (slug, name, timezone) VALUES ${Object.entries(casos)
          .map(([slug, [zona]]) => `('${slug}', '${slug}', '${zona}')`)
          .join(', ')}`,
      );
      // Antes de 0035, así fallaban las pantallas de Ventas.
      await assert.rejects(
        antes.queryAsSuperuser(`SELECT now() AT TIME ZONE timezone FROM workspace WHERE slug = 'zona-sin-region'`),
        /time zone "Bogota" not recognized/,
      );

      assert.deepEqual(await antes.migrar('0035_zona_del_espacio_valida.sql'), ['0035_zona_del_espacio_valida.sql']);
      const { rows } = await antes.queryAsSuperuser<{ slug: string; timezone: string }>(
        `SELECT slug, timezone FROM workspace WHERE slug LIKE 'zona-%' ORDER BY slug`,
      );
      assert.deepEqual(
        Object.fromEntries(rows.map((r) => [r.slug, r.timezone])),
        Object.fromEntries(Object.entries(casos).map(([slug, [, despues]]) => [slug, despues])),
      );
      const forzada = await antes.queryAsSuperuser<{ f: boolean }>(`SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = 'workspace'::regclass`);
      assert.equal(forzada.rows[0]?.f, true, 'la RLS forzada vuelve a quedar como estaba');
      await antes.queryAsSuperuser(`SELECT now() AT TIME ZONE timezone FROM workspace`);
    } finally {
      await antes.close();
    }
  });
});
