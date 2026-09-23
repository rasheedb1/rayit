import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidTransition, mulRateHalfUp, pctToRate } from '@mc/core';
import {
  createInvoice,
  createInvoiceFromCampaign,
  getInvoice,
  getReceivablesKpis,
  listCampaignsForInvoice,
  listCompanies,
  listInvoices,
  transitionInvoice,
  countInvoicesInOtherCurrency,
  getFinanceSettings,
  updateFinanceSettings,
  InvoiceNotFound,
} from '../src/queries/finanzas.ts';
import { getWorkspaceSettings } from '../src/queries/cimientos.ts';
import { assertWorkspaceId } from '../src/index.ts';
import {
  openTestDb, type TestDb,
  WORKSPACE_LAURA, CAMPAIGN_CAFE_ALMA, COMPANY_CAFE_ALMA, INVOICE_FV_2026_001, INVOICE_FV_2026_010,
} from './pglite.ts';

/** Un workspace ajeno, sin filas de finanzas, para las pruebas de aislamiento. */
const WORKSPACE_AJENO = '00000009-0000-4000-8000-000000000001';

let t: TestDb;

before(async () => {
  t = await openTestDb();
  await t.admin(`
    INSERT INTO workspace (id, slug, name, kind, currency)
    VALUES ('${WORKSPACE_AJENO}', 'workspace-ajeno-pruebas', 'Workspace ajeno', 'creator', 'COP')
    ON CONFLICT DO NOTHING;
  `);
}, { timeout: 120_000 });

after(async () => {
  await t.close();
});

describe('aislamiento por workspace', () => {
  test('listar devuelve las 3 facturas por cobrar del workspace del seed', async () => {
    const { rows } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      listInvoices(tx, { status: ['sent', 'partial', 'overdue'] }),
    );
    assert.equal(rows.length, 3);
    const porNumero = Object.fromEntries(rows.map((r) => [r.number, r]));
    assert.equal(porNumero['FV-2026-011']?.bucket, 'al_dia');
    assert.equal(porNumero['FV-2026-011']?.companyName, 'Fresko Market');
    assert.equal(porNumero['FV-2026-010']?.bucket, 'vence_pronto');
    assert.equal(porNumero['FV-2026-010']?.campaignName, 'Lanzamiento cold brew');
    assert.equal(porNumero['FV-2026-007']?.bucket, 'vencida');
    assert.equal(porNumero['FV-2026-007']?.derivedStatus, 'overdue');
    assert.equal(porNumero['FV-2026-007']?.status, 'sent', 'overdue se deriva, no se persiste');
    assert.equal(porNumero['FV-2026-007']?.daysToDue, -41);
    const total = rows.reduce((acc, r) => acc + BigInt(r.outstanding.replace('.', '')), 0n);
    assert.equal(total, 940000000n, '9 400 000,00');
  });

  test('la lista completa incluye pagadas y, de existir, borradores; más recientes primero', async () => {
    const { rows, nextCursor } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listInvoices(tx, { limit: 5 }));
    assert.equal(rows.length, 5);
    assert.equal(nextCursor !== null, true, 'hay más de 5 facturas');
    for (let i = 1; i < rows.length; i++) {
      assert.ok((rows[i - 1]?.issuedOn ?? '') >= (rows[i]?.issuedOn ?? ''), 'orden por emisión descendente');
    }
    const segunda = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listInvoices(tx, { limit: 5, cursor: nextCursor }));
    assert.equal(segunda.rows.length, 5);
    const ids = new Set([...rows, ...segunda.rows].map((r) => r.id));
    assert.equal(ids.size, 10, 'las páginas no se solapan');
  });

  test('con otro workspace_id, todo devuelve cero', async () => {
    const { rows } = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => listInvoices(tx));
    assert.equal(rows.length, 0);
    const detalle = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => getInvoice(tx, INVOICE_FV_2026_010));
    assert.equal(detalle, null);
    const empresas = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => listCompanies(tx));
    assert.equal(empresas.length, 0);
    const campanas = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => listCampaignsForInvoice(tx));
    assert.equal(campanas.length, 0);
    const kpis = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => getReceivablesKpis(tx));
    assert.equal(kpis.outstanding, '0');
    assert.equal(kpis.openCount, 0);
  });

  test('desde otro workspace no se puede transicionar ni crear sobre lo ajeno', async () => {
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_AJENO, (tx) => transitionInvoice(tx, INVOICE_FV_2026_010, 'void')),
      InvoiceNotFound,
    );
    const intacta = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getInvoice(tx, INVOICE_FV_2026_010));
    assert.equal(intacta?.status, 'sent');

    // La empresa existe (company no tiene RLS) pero no está vinculada al
    // workspace ajeno: company_link sí tiene RLS.
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_AJENO, (tx) =>
        createInvoice(tx, { companyId: COMPANY_CAFE_ALMA, subtotal: '1000000', issuedOn: '2026-09-21', dueOn: '2026-10-21' }),
      ),
      /no existe en este workspace/,
    );
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_AJENO, (tx) => createInvoiceFromCampaign(tx, CAMPAIGN_CAFE_ALMA)),
      /no existe en este workspace/,
    );
  });

  test('el workspace se valida antes de abrir la transacción', () => {
    assert.throws(() => assertWorkspaceId('laura'), /UUID/);
    assert.throws(() => assertWorkspaceId("'; DROP TABLE invoice; --"), /UUID/);
  });
});

describe('los KPIs de Finanzas salen de la vista receivables', () => {
  test('por cobrar, vencido, cobrado en el año y apartado', async () => {
    const k = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getReceivablesKpis(tx));
    assert.equal(k.outstanding, '9400000.00');
    assert.equal(k.openCount, 3);
    assert.equal(k.overdue, '1100000.00');
    assert.equal(k.overdueCount, 1);
    assert.equal(k.maxDaysOverdue, 41);
    assert.equal(k.taxReserved, '4246000.00');
    assert.equal(k.taxRate, '0.1100');
    // Cobrado en 2026: 38,6 M mientras el año de la máquina sea 2026 (el seed es fijo).
    if (new Date().getUTCFullYear() === 2026) {
      assert.equal(k.collectedYtd, '38600000.00');
      assert.equal(k.collectedPrevYtd, '29500000.00');
      assert.equal(k.collectedDelta, 0.308);
    }
  });
});

describe('crear facturas', () => {
  test('dos creaciones en paralelo producen números consecutivos distintos', async () => {
    const crear = () =>
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
        createInvoice(tx, {
          companyId: COMPANY_CAFE_ALMA,
          subtotal: '1000000.00',
          issuedOn: '2026-09-21',
          dueOn: '2026-10-21',
        }),
      );
    const [a, b] = await Promise.all([crear(), crear()]);
    assert.notEqual(a.number, b.number);
    const seqs = [a, b].map((i) => parseInt(i.number.slice(-3), 10)).sort((x, y) => x - y);
    assert.equal(seqs[1], (seqs[0] ?? 0) + 1, 'consecutivos');
    assert.match(a.number, /^FV-2026-\d{3,}$/);
    assert.equal(a.status, 'draft');
    assert.equal(a.bucket, 'borrador');
    assert.equal(a.tax, '190000.00');
    assert.equal(a.withholding, '110000.00');
    assert.equal(a.total, '1190000.00');
    assert.equal(a.net, '1080000.00');
    assert.equal(a.companyName, 'Café Alma');
  });

  test('la numeración sigue a la última del seed (FV-2026-011) y no la reinicia', async () => {
    const { rows } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listInvoices(tx, { status: 'draft' }));
    const seqs = rows.map((r) => parseInt(r.number.slice(-3), 10));
    assert.ok(Math.min(...seqs) >= 12, `los borradores nuevos empiezan en 012, no en 001: ${rows.map((r) => r.number)}`);
  });

  test('las reglas de entrada están en español', async () => {
    const base = { companyId: COMPANY_CAFE_ALMA, subtotal: '1000000.00', issuedOn: '2026-09-21', dueOn: '2026-09-20' };
    await assert.rejects(t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createInvoice(tx, base)), /anterior a la emisión/);
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createInvoice(tx, { ...base, dueOn: '2026-10-21', currency: 'USD' })),
      /moneda del workspace \(COP\)/,
    );
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createInvoice(tx, { ...base, dueOn: '2026-10-21', subtotal: '-5' })),
      /negativo/,
    );
  });

  test('desde una campaña del seed (Café Alma) trae empresa, campaña y monto sin escribirlos', async () => {
    const inv = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createInvoiceFromCampaign(tx, CAMPAIGN_CAFE_ALMA, { issuedOn: '2026-09-21' }),
    );
    assert.equal(inv.companyName, 'Café Alma');
    assert.equal(inv.campaignId, CAMPAIGN_CAFE_ALMA);
    assert.equal(inv.campaignName, 'Lanzamiento cold brew');
    assert.equal(inv.subtotal, '2605042.02');
    assert.equal(inv.tax, '494957.98');
    assert.equal(inv.total, '3100000.00', 'el monto acordado de la campaña, con IVA incluido');
    assert.equal(inv.withholding, '286554.62');
    assert.equal(inv.status, 'draft');
    assert.equal(inv.issuedOn, '2026-09-21');
    assert.equal(inv.dueOn, '2026-10-21', 'la cotización acordó pago a 30 días');
    // La campaña viene de COT-2026-003 (seed 0004): la factura la cita.
    assert.equal(inv.quoteId, '00000004-0000-4000-8000-0000000c0703');
  });
});

describe('transiciones', () => {
  test('una transición inválida lanza y no modifica la fila', async () => {
    const antes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getInvoice(tx, INVOICE_FV_2026_001));
    assert.equal(antes?.status, 'paid');
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => transitionInvoice(tx, INVOICE_FV_2026_001, 'sent')),
      (e: unknown) => e instanceof InvalidTransition && /«Pagada» a «Enviada»/.test(e.message),
    );
    const despues = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getInvoice(tx, INVOICE_FV_2026_001));
    assert.deepEqual(despues, antes);
  });

  test('draft → sent → void, y paid exige el total', async () => {
    const nueva = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createInvoice(tx, { companyId: COMPANY_CAFE_ALMA, subtotal: '500000.00', issuedOn: '2026-09-21', dueOn: '2026-10-21' }),
    );
    const enviada = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => transitionInvoice(tx, nueva.id, 'sent'));
    assert.equal(enviada.status, 'sent');
    assert.equal(enviada.bucket, 'al_dia');
    assert.equal(enviada.paidAt, null);

    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => transitionInvoice(tx, nueva.id, 'paid', { paidAmount: '1.00' })),
      /igual al total/,
    );
    const parcial = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      transitionInvoice(tx, nueva.id, 'partial', { paidAmount: '100000.00', paidAt: '2026-09-22T10:00:00Z' }),
    );
    assert.equal(parcial.status, 'partial');
    assert.equal(parcial.paidAmount, '100000.00');
    assert.equal(parcial.outstanding, '495000.00');
    assert.equal(parcial.paidAt, '2026-09-22T10:00:00Z');

    const pagada = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => transitionInvoice(tx, nueva.id, 'paid'));
    assert.equal(pagada.status, 'paid');
    assert.equal(pagada.paidAmount, '595000.00');
    assert.equal(pagada.outstanding, '0.00');
    assert.equal(pagada.bucket, 'pagada');

    const otra = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createInvoice(tx, { companyId: COMPANY_CAFE_ALMA, subtotal: '10.00', issuedOn: '2026-09-21', dueOn: '2026-09-21' }),
    );
    const anulada = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => transitionInvoice(tx, otra.id, 'void'));
    assert.equal(anulada.status, 'void');
    assert.equal(anulada.bucket, 'anulada');
  });

  test('una factura inexistente da InvoiceNotFound', async () => {
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => transitionInvoice(tx, '00000000-0000-4000-8000-000000000000', 'sent')),
      InvoiceNotFound,
    );
  });
});

// ------------------------------------------- configuración financiera (FIN-8)

/**
 * Leer una tabla con RLS hay que hacerlo DENTRO de una transacción con
 * el workspace fijado: `t.raw` corre como mc_app sin
 * `app.workspace_id`, así que `current_workspace_id()` es NULL y las
 * políticas de 0010 y 0024 devuelven cero filas sin avisar. Es
 * exactamente lo que estas pruebas comprueban en otras, así que aquí se
 * usa la puerta buena.
 */
function leer<T extends Record<string, unknown>>(workspaceId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return t.db.withWorkspace(workspaceId, async (tx) => (await tx.query<T>(sql, params)).rows);
}

describe('configuración financiera (FIN-8)', () => {
  test('el bloque del seed se lee con la misma función que usarán FIN-1, FIN-2, FIN-4 y FIN-6', async () => {
    const s = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getFinanceSettings(tx));
    assert.equal(s.ivaPct, '19');
    assert.equal(s.retencionPct, '11');
    assert.equal(s.reservaPct, '11');
    assert.equal(s.plazoDias, 30);
    assert.equal(s.razonSocial, null, 'el seed no trae datos fiscales: es una ausencia, no ""');
  });

  test('un workspace sin bloque devuelve los valores por defecto de Colombia, no un error', async () => {
    const s = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => getFinanceSettings(tx));
    assert.equal(s.ivaPct, '19');
    assert.equal(s.plazoDias, 30);
    // Y su settings sigue siendo '{}': leer no escribe nada.
    const [fila] = await leer<{ settings: unknown }>(WORKSPACE_AJENO, 'SELECT settings FROM workspace WHERE id = current_workspace_id()');
    assert.deepEqual(fila?.settings, {});
  });

  test('guardar hace MERGE por llave: no borra lo que otro módulo dejó en settings', async () => {
    // Cotizar guarda settings.taxRate en la RAÍZ (queries/cotizar/cotizacion.ts,
    // getDefaultTaxRate). Un reemplazo del jsonb entero lo borraría.
    await t.admin(`
      UPDATE workspace
      SET settings = settings || '{"taxRate": "0.19", "otroModulo": {"a": 1}}'::jsonb
      WHERE id = '${WORKSPACE_AJENO}';
    `);
    const base = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => getFinanceSettings(tx));
    await t.db.withWorkspace(WORKSPACE_AJENO, (tx) =>
      updateFinanceSettings(tx, { settings: { ...base, ivaPct: '16', razonSocial: 'Ajeno S.A. de C.V.' } }),
    );
    const [fila] = await leer<{ settings: Record<string, unknown> }>(
      WORKSPACE_AJENO, 'SELECT settings FROM workspace WHERE id = current_workspace_id()');
    assert.equal(fila?.settings['taxRate'], '0.19', 'la llave de Cotizar sigue ahí');
    assert.deepEqual(fila?.settings['otroModulo'], { a: 1 });
    const guardado = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => getFinanceSettings(tx));
    assert.equal(guardado.ivaPct, '16');
    assert.equal(guardado.razonSocial, 'Ajeno S.A. de C.V.');
  });

  test('guardar deja su fila en audit_log, con before y after y sin el id bigserial', async () => {
    const [previo] = await leer<{ n: number }>(WORKSPACE_LAURA,
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'workspace.settings_updated'`);
    const base = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getFinanceSettings(tx));
    const salida = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      updateFinanceSettings(tx, { settings: { ...base, retencionPct: '10' } }),
    );
    // La función no devuelve ningún id de audit_log (CIM-2 §3).
    assert.deepEqual(Object.keys(salida).sort(), ['currency', 'invoicesInOtherCurrency', 'settings']);

    const despues = await leer<{ n: number }>(WORKSPACE_LAURA,
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'workspace.settings_updated'`);
    assert.equal((despues[0]?.n ?? 0) - (previo?.n ?? 0), 1, 'un guardado, una fila');

    const [fila] = await leer<{
      actor_user_id: string | null; actor_kind: string; entity_type: string; entity_id: string;
      before: Record<string, unknown>; after: Record<string, unknown>;
    }>(WORKSPACE_LAURA,
      `SELECT actor_user_id, actor_kind, entity_type, entity_id, before, after FROM audit_log
       WHERE action = 'workspace.settings_updated' ORDER BY created_at DESC, id DESC LIMIT 1`);
    assert.ok(fila, 'hay fila de bitácora');
    assert.equal(fila.actor_kind, 'system', 'sin identidad en la transacción no se dice "user"');
    assert.equal(fila.actor_user_id, null);
    assert.equal(fila.entity_type, 'workspace');
    assert.equal(fila.entity_id, WORKSPACE_LAURA);
    const antes = fila.before['finanzas'] as Record<string, unknown>;
    const ahora = fila.after['finanzas'] as Record<string, unknown>;
    assert.equal(antes['retencion_pct'], '11');
    assert.equal(ahora['retencion_pct'], '10');
    assert.equal(fila.before['currency'], 'COP');
    assert.equal(fila.after['currency'], 'COP');
    // Deshacer, para no arrastrar el cambio a las otras pruebas del archivo.
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => updateFinanceSettings(tx, { settings: base }));
  });

  test('con identidad, la bitácora guarda el actor que fijó la transacción, no un parámetro', async () => {
    const [persona] = await leer<{ id: string }>(WORKSPACE_LAURA,
      `SELECT u.id FROM app_user u JOIN membership m ON m.user_id = u.id
       WHERE m.workspace_id = current_workspace_id() LIMIT 1`);
    assert.ok(persona, 'el seed trae una persona en el workspace');
    const base = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getFinanceSettings(tx));
    await t.db.withWorkspace(
      WORKSPACE_LAURA,
      (tx) => updateFinanceSettings(tx, { settings: { ...base, banco: 'Bancolombia' } }),
      { userId: persona.id },
    );
    const [fila] = await leer<{ actor_user_id: string; actor_kind: string }>(WORKSPACE_LAURA,
      `SELECT actor_user_id, actor_kind FROM audit_log
       WHERE action = 'workspace.settings_updated' ORDER BY created_at DESC, id DESC LIMIT 1`);
    assert.equal(fila?.actor_user_id, persona.id);
    assert.equal(fila?.actor_kind, 'user');
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => updateFinanceSettings(tx, { settings: base }));
  });

  test('un workspace no puede leer ni escribir la configuración de otro', async () => {
    // Leer: dentro de la transacción del ajeno sale SU bloque (16 %, de
    // la prueba del merge), no el de Laura (19 %).
    const ajeno = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => getFinanceSettings(tx));
    const laura = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getFinanceSettings(tx));
    assert.equal(ajeno.ivaPct, '16');
    assert.equal(laura.ivaPct, '19');

    // Escribir desde el ajeno no mueve la de Laura: el UPDATE filtra por
    // current_workspace_id() y la política workspace_update (0024) aísla
    // la fila.
    await t.db.withWorkspace(WORKSPACE_AJENO, (tx) =>
      updateFinanceSettings(tx, { settings: { ...ajeno, reservaPct: '0' } }),
    );
    const lauraDespues = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getFinanceSettings(tx));
    assert.equal(lauraDespues.reservaPct, '11', 'la configuración de Laura no se movió');

    // Y nombrar la fila de Laura a pelo desde el workspace ajeno no toca
    // ninguna fila.
    const tocadas = await t.db.withWorkspace(WORKSPACE_AJENO, async (tx) => {
      const r = await tx.query<{ id: string }>(
        `UPDATE workspace SET settings = settings || '{"finanzas": {"reserva_pct": "99"}}'::jsonb
         WHERE id = $1 RETURNING id`,
        [WORKSPACE_LAURA],
      );
      return r.rows.length;
    });
    assert.equal(tocadas, 0, 'RLS: cero filas');
    const lauraIntacta = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getFinanceSettings(tx));
    assert.equal(lauraIntacta.reservaPct, '11');

    // Ni su bitácora se ve desde el otro espacio.
    const [ajenoVe] = await leer<{ n: number }>(WORKSPACE_AJENO,
      `SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1`, [WORKSPACE_LAURA]);
    assert.equal(ajenoVe?.n, 0, 'la bitácora de Laura no se lee desde el workspace ajeno');
  });

  test('la moneda se puede cambiar, no convierte nada, y dice cuántas facturas quedaron en otra', async () => {
    const base = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getFinanceSettings(tx));
    const antes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => countInvoicesInOtherCurrency(tx, 'COP'));
    assert.equal(antes, 0, 'el seed factura todo en la moneda del workspace');

    const salida = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      updateFinanceSettings(tx, { settings: base, currency: 'mxn' }),
    );
    assert.equal(salida.currency, 'MXN', 'se normaliza a mayúsculas');
    assert.ok(salida.invoicesInOtherCurrency > 0, 'avisa que hay facturas en COP que nadie convirtió');

    // Los montos de las facturas no se tocaron: cambiar la moneda del
    // workspace no es una conversión (FIN-8 §0.3 F).
    const factura = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getInvoice(tx, INVOICE_FV_2026_010));
    assert.equal(factura?.currency, 'COP');

    // Y volver atrás deja el aviso en cero.
    const vuelta = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      updateFinanceSettings(tx, { settings: base, currency: 'COP' }),
    );
    assert.equal(vuelta.currency, 'COP');
    assert.equal(vuelta.invoicesInOtherCurrency, 0);
    const ws = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getWorkspaceSettings(tx));
    assert.equal(ws.currency, 'COP');
  });

  test('una moneda que no es ISO-4217 de tres letras se rechaza antes de tocar la base', async () => {
    const base = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getFinanceSettings(tx));
    for (const mala of ['PESOS', 'C0P', '', 'co ']) {
      await assert.rejects(
        t.db.withWorkspace(WORKSPACE_LAURA, (tx) => updateFinanceSettings(tx, { settings: base, currency: mala })),
        /ISO-4217/,
        `«${mala}» no es una moneda`,
      );
    }
    const intacta = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getWorkspaceSettings(tx));
    assert.equal(intacta.currency, 'COP');
  });

  test('cambiar el porcentaje cambia la reserva de los pagos SIGUIENTES, no la de los anteriores', async () => {
    // El contrato que FIN-8 le deja a FIN-2: la tasa que se estampa en
    // tax_reserve es pctToRate(getFinanceSettings(tx).reservaPct) EN EL
    // MOMENTO DEL PAGO, y la fila la guarda para siempre
    // (tax_reserve.rate, numeric(6,4), 0008).
    const base = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getFinanceSettings(tx));
    assert.equal(base.reservaPct, '11', 'el seed arranca en 11 %');

    // 1 · Un cobro con la configuración de hoy.
    const primera = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const s = await getFinanceSettings(tx);
      const { rows } = await tx.query<{ id: string; rate: string; amount: string }>(
        `INSERT INTO tax_reserve (workspace_id, rate, amount, currency, period)
         VALUES (current_workspace_id(), $1::numeric, $2::numeric, 'COP', '2026-Q3')
         RETURNING id, rate::text, amount::text`,
        [pctToRate(s.reservaPct), mulRateHalfUp('1000000.00', pctToRate(s.reservaPct))],
      );
      return rows[0]!;
    });
    assert.equal(primera.rate, '0.1100');
    assert.equal(primera.amount, '110000.00');

    // 2 · El creador sube la reserva al 15 % en /finanzas/configuracion.
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      updateFinanceSettings(tx, { settings: { ...base, reservaPct: '15' } }),
    );

    // 3 · El cobro siguiente aparta el 15 %.
    const segunda = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const s = await getFinanceSettings(tx);
      assert.equal(s.reservaPct, '15');
      const { rows } = await tx.query<{ id: string; rate: string; amount: string }>(
        `INSERT INTO tax_reserve (workspace_id, rate, amount, currency, period)
         VALUES (current_workspace_id(), $1::numeric, $2::numeric, 'COP', '2026-Q4')
         RETURNING id, rate::text, amount::text`,
        [pctToRate(s.reservaPct), mulRateHalfUp('1000000.00', pctToRate(s.reservaPct))],
      );
      return rows[0]!;
    });
    assert.equal(segunda.rate, '0.1500');
    assert.equal(segunda.amount, '150000.00');

    // 4 · LO QUE IMPORTA: la primera sigue en 0.1100.
    const [revisada] = await leer<{ rate: string; amount: string }>(WORKSPACE_LAURA,
      'SELECT rate::text, amount::text FROM tax_reserve WHERE id = $1', [primera.id]);
    assert.equal(revisada?.rate, '0.1100', 'el pago anterior conserva SU tasa');
    assert.equal(revisada?.amount, '110000.00', 'y su monto');

    // Limpieza: el KPI «Apartado para impuestos» de otras pruebas suma
    // tax_reserve, así que estas dos filas no se quedan.
    await t.admin(`DELETE FROM tax_reserve WHERE id IN ('${primera.id}', '${segunda.id}');`);
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => updateFinanceSettings(tx, { settings: base }));
    const final = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getFinanceSettings(tx));
    assert.equal(final.reservaPct, '11');
  });
});
