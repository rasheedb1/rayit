import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidTransition } from '@mc/core';
import { GastosEnVariasMonedas, proyectarGastosRecurrentes, seriesDeGastosRecurrentes } from '@mc/core';
import {
  createExpense,
  createInvoice,
  createInvoiceFromCampaign,
  getExpense,
  getExpenseMonth,
  getInvoice,
  getReceivablesKpis,
  listCampaignsForInvoice,
  listCompanies,
  listInvoices,
  listRecurringExpenses,
  transitionInvoice,
  updateExpense,
  ExpenseNotFound,
  InvalidExpenseError,
  InvoiceNotFound,
} from '../src/queries/finanzas.ts';
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

// =====================================================================
// Gastos (FIN-5)
// =====================================================================

/** La creadora del seed 0002: la persona que la bitácora tiene que anotar. */
const USER_LAURA = '00000002-0000-4000-8000-000000000002';
/** El gasto recurrente de edición de septiembre (seed 0003 §7). */
const GASTO_EDICION_SEP = '00000003-0000-4000-8000-0009a5090001';

interface LineaBitacora {
  action: string;
  actor_kind: string;
  actor_user_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
}

/**
 * Las líneas de bitácora de un gasto, más recientes primero. Se leen
 * DENTRO de withWorkspace porque audit_log también tiene RLS (0010): con
 * t.raw(), fuera de transacción y sin workspace, la tabla devuelve cero
 * filas sin avisar y la prueba pasaría por la razón equivocada. El id
 * (bigserial) se usa para ordenar y no se devuelve (CIM-2 §3).
 */
async function bitacoraDe(workspaceId: string, expenseId: string): Promise<LineaBitacora[]> {
  return t.db.withWorkspace(workspaceId, async (tx) => {
    const { rows } = await tx.query<LineaBitacora>(
      `SELECT action, actor_kind, actor_user_id, before, after
       FROM audit_log
       WHERE entity_type = 'expense' AND entity_id = $1::uuid
       ORDER BY created_at DESC, id DESC`,
      [expenseId],
    );
    return rows;
  });
}

describe('gastos · lista por mes', () => {
  test('septiembre de 2026 del seed: 3,7 M, los cinco recurrentes y su desglose por categoría', async () => {
    const mes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getExpenseMonth(tx, '2026-09'));
    assert.equal(mes.month, '2026-09');
    assert.equal(mes.from, '2026-09-01');
    assert.equal(mes.to, '2026-09-30');
    assert.equal(mes.currency, 'COP');
    assert.equal(mes.totals.total, '3700000.00', 'lo que dice la cabecera del seed');
    assert.equal(mes.totals.recurring, '3700000.00', 'en septiembre no hay ningún gasto puntual');
    assert.equal(mes.totals.deductible, '3700000.00', 'el seed los marca todos deducibles');
    assert.equal(mes.totals.count, 5);
    assert.equal(mes.rows.length, 5);
    assert.equal(mes.otherCurrencyCount, 0);
    assert.deepEqual(
      mes.byCategory.map((c) => [c.category, c.total, c.count]),
      [
        ['edicion', '1800000.00', 1],
        ['equipo', '900000.00', 1],
        ['contabilidad', '400000.00', 1],
        ['software', '380000.00', 1],
        ['servicios', '220000.00', 1],
      ],
      'de mayor a menor, y el total sale del GROUP BY',
    );
    // La suma de las categorías es el total: la pantalla no vuelve a sumar.
    const suma = mes.byCategory.reduce((acc, c) => acc + BigInt(c.total.replace('.', '')), 0n);
    assert.equal(suma, 370000000n);
    // Las fechas salen como 'YYYY-MM-DD' (to_char), no como Date del driver.
    for (const r of mes.rows) assert.match(r.incurredOn, /^2026-09-\d{2}$/);
  });

  test('agosto trae el puntual del viaje, y el desglose lo separa', async () => {
    const mes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getExpenseMonth(tx, '2026-08'));
    assert.equal(mes.totals.count, 6);
    assert.equal(mes.totals.total, '4160000.00', '3,7 M recurrentes + 460 000 del viaje');
    assert.equal(mes.totals.recurring, '3700000.00');
    const viaje = mes.rows.find((r) => r.category === 'viajes');
    assert.equal(viaje?.isRecurring, false);
    assert.equal(viaje?.recurrence, null, 'un puntual no tiene recurrencia: null, no cadena vacía');
    assert.equal(viaje?.amount, '460000.00');
    assert.equal(viaje?.incurredOn, '2026-08-06');
  });

  test('un mes sin gastos no da cero filas mal contadas: total en cero y ninguna fila', async () => {
    const mes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getExpenseMonth(tx, '2026-01'));
    assert.equal(mes.rows.length, 0);
    assert.equal(mes.totals.count, 0);
    assert.equal(mes.totals.total, '0.00');
    assert.deepEqual(mes.byCategory, []);
    assert.equal(mes.from, '2026-01-01');
    assert.equal(mes.to, '2026-01-31');
  });

  test('sin mes, o con un mes que no existe, el mes de CURRENT_DATE (no un 500)', async () => {
    const [porDefecto, basura, fueraDeRango] = await Promise.all([
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getExpenseMonth(tx)),
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getExpenseMonth(tx, 'septiembre; DROP TABLE expense')),
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getExpenseMonth(tx, '2026-13')),
    ]);
    assert.equal(porDefecto.month, porDefecto.today.slice(0, 7));
    assert.equal(basura.month, porDefecto.month);
    assert.equal(fueraDeRango.month, porDefecto.month);
    // La tabla sigue ahí.
    const mes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getExpenseMonth(tx, '2026-09'));
    assert.equal(mes.rows.length, 5);
  });

  test('febrero de un año bisiesto termina el 29', async () => {
    const mes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getExpenseMonth(tx, '2024-02'));
    assert.equal(mes.from, '2024-02-01');
    assert.equal(mes.to, '2024-02-29');
  });
});

describe('gastos · recurrentes y proyección', () => {
  test('las plantillas del seed proyectan 3,7 M al mes en las ocho semanas siguientes', async () => {
    const rec = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listRecurringExpenses(tx));
    assert.equal(rec.currency, 'COP');
    assert.equal(rec.otherCurrencyCount, 0);
    assert.equal(rec.rows.length, 15, 'cinco series × tres meses registrados');
    assert.ok(rec.rows.every((r) => r.isRecurring && r.recurrence === 'monthly'));

    // La deduplicación por serie vive en core y está probada allí; aquí
    // se comprueba que lo que la consulta entrega encaja con ella.
    const p = proyectarGastosRecurrentes(rec.rows, '2026-09-23');
    assert.equal(p.total, '7400000.00', 'dos meses de 3,7 M, no quince filas sumadas');
    assert.deepEqual(p.semanas.filter((s) => s.total !== '0.00').map((s) => s.total), ['3700000.00', '3700000.00']);
    assert.equal(seriesDeGastosRecurrentes(rec.rows).length, 5);
  });

  test('un gasto recurrente que se registra hoy aparece proyectado el mes que viene', async () => {
    const creado = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createExpense(tx, {
        category: 'servicios', vendor: 'Vigilancia Andes', description: 'Monitoreo del estudio',
        amount: '150000', incurredOn: '2026-09-10', isRecurring: true, recurrence: 'monthly', deductible: true,
      }),
    );
    const rec = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listRecurringExpenses(tx));
    const p = proyectarGastosRecurrentes(rec.rows, '2026-09-23');
    const mias = p.semanas.flatMap((s) => s.ocurrencias).filter((o) => o.expenseId === creado.id);
    assert.deepEqual(mias.map((o) => o.date), ['2026-10-10', '2026-11-10']);
    assert.equal(mias[0]?.amount, '150000.00');
  });

  test('un gasto en otra moneda se cuenta, no se suma', async () => {
    const antes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getExpenseMonth(tx, '2026-09'));
    assert.equal(antes.otherCurrencyCount, 0);
    // Una fila en otra moneda no puede entrar por createExpense (la
    // rechaza), así que se inserta como superusuario: es el caso de una
    // importación o de un espacio que cambió de moneda.
    await t.admin(`
      INSERT INTO expense (id, workspace_id, category, vendor, amount, currency, incurred_on, is_recurring, recurrence, deductible)
      VALUES ('00000009-0000-4000-8000-0009a5990001', '${WORKSPACE_LAURA}', 'software', 'Figma',
              20.00, 'USD', DATE '2026-09-05', true, 'monthly', true)
      ON CONFLICT (id) DO NOTHING;
    `);
    const mes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getExpenseMonth(tx, '2026-09'));
    assert.equal(mes.otherCurrencyCount, 1);
    assert.ok(mes.rows.some((r) => r.currency === 'USD'), 'la fila se lista: la lista no miente');
    assert.equal(mes.totals.total, antes.totals.total, 'el total en COP no cambia al aparecer una fila en USD');
    assert.deepEqual(mes.byCategory, antes.byCategory, 'el desglose tampoco');

    const rec = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listRecurringExpenses(tx));
    assert.equal(rec.otherCurrencyCount, 1);
    assert.ok(rec.rows.every((r) => r.currency === 'COP'), 'la proyección solo recibe una moneda');
    // Y por si algún día llegara una mezcla, core lanza en vez de sumar.
    assert.throws(
      () => proyectarGastosRecurrentes(
        [...rec.rows, { id: 'x', category: 'software', vendor: 'Figma', description: null, amount: '20.00', currency: 'USD', incurredOn: '2026-09-05', recurrence: 'monthly' }],
        '2026-09-23',
      ),
      GastosEnVariasMonedas,
    );
    await t.admin(`DELETE FROM expense WHERE id = '00000009-0000-4000-8000-0009a5990001';`);
  });
});

describe('gastos · alta, edición y bitácora', () => {
  test('crear un gasto deja su línea de bitácora con la persona que lo registró', async () => {
    const gasto = await t.db.withWorkspace(
      WORKSPACE_LAURA,
      (tx) => createExpense(tx, {
        category: 'equipo', vendor: 'DJI', description: 'Trípode', amount: '250000.50',
        incurredOn: '2026-09-18', isRecurring: false, deductible: true,
        receiptUrl: 'https://drive.example.com/recibo-123',
      }),
      { userId: USER_LAURA },
    );
    assert.equal(gasto.amount, '250000.50');
    assert.equal(gasto.currency, 'COP', 'la moneda por defecto es la del espacio');
    assert.equal(gasto.recurrence, null, 'sin recurrente, la recurrencia no se guarda');
    assert.equal(gasto.receiptUrl, 'https://drive.example.com/recibo-123');

    const lineas = await bitacoraDe(WORKSPACE_LAURA, gasto.id);
    assert.equal(lineas.length, 1);
    assert.equal(lineas[0]?.action, 'expense.created');
    assert.equal(lineas[0]?.actor_kind, 'user');
    assert.equal(lineas[0]?.actor_user_id, USER_LAURA);
    assert.equal(lineas[0]?.before, null, 'una fila nueva no tiene «antes»');
    assert.equal(lineas[0]?.after?.amount, '250000.50');
    assert.equal(lineas[0]?.after?.vendor, 'DJI');
    // El enlace del recibo es una credencial de ese archivo: en la
    // bitácora va si lo hay, no cuál es.
    assert.equal(lineas[0]?.after?.receipt, true);
    assert.equal(JSON.stringify(lineas[0]).includes('drive.example.com'), false);
  });

  test('sin identidad en la transacción, la bitácora dice «system», no una persona inventada', async () => {
    const gasto = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createExpense(tx, { category: 'otros', amount: '1000', incurredOn: '2026-09-19', isRecurring: false, deductible: false }),
    );
    const lineas = await bitacoraDe(WORKSPACE_LAURA, gasto.id);
    assert.equal(lineas[0]?.actor_kind, 'system');
    assert.equal(lineas[0]?.actor_user_id, null);
  });

  test('editar deja before/after SOLO con lo que cambió', async () => {
    const gasto = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createExpense(tx, { category: 'software', vendor: 'Notion', amount: '90000', incurredOn: '2026-09-02', isRecurring: false, deductible: true }),
    );
    const editado = await t.db.withWorkspace(
      WORKSPACE_LAURA,
      (tx) => updateExpense(tx, gasto.id, {
        category: 'software', vendor: 'Notion', amount: '95000', incurredOn: '2026-09-02',
        isRecurring: true, recurrence: 'monthly', deductible: true,
      }),
      { userId: USER_LAURA },
    );
    assert.equal(editado.amount, '95000.00');
    assert.equal(editado.isRecurring, true);
    assert.equal(editado.recurrence, 'monthly');

    const lineas = await bitacoraDe(WORKSPACE_LAURA, gasto.id);
    assert.equal(lineas.length, 2);
    const edicion = lineas[0];
    assert.equal(edicion?.action, 'expense.updated');
    assert.deepEqual(Object.keys(edicion?.after ?? {}).sort(), ['amount', 'isRecurring', 'recurrence']);
    assert.deepEqual(edicion?.before, { amount: '90000.00', isRecurring: false, recurrence: null });
    assert.deepEqual(edicion?.after, { amount: '95000.00', isRecurring: true, recurrence: 'monthly' });
  });

  test('guardar el mismo formulario dos veces no deja dos líneas', async () => {
    const gasto = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createExpense(tx, { category: 'viajes', vendor: 'Taxi', amount: '30000', incurredOn: '2026-09-03', isRecurring: false, deductible: true }),
    );
    const igual = { category: 'viajes', vendor: 'Taxi', amount: '30000.00', incurredOn: '2026-09-03', isRecurring: false, deductible: true };
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => updateExpense(tx, gasto.id, igual));
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => updateExpense(tx, gasto.id, igual));
    const lineas = await bitacoraDe(WORKSPACE_LAURA, gasto.id);
    assert.deepEqual(lineas.map((l) => l.action), ['expense.created'], 'idempotente: nada cambió, nada se anota');
  });

  test('marcar como error es editar: quitar el recurrente lo saca de la proyección', async () => {
    const gasto = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createExpense(tx, { category: 'contabilidad', vendor: 'Duplicado', amount: '400000', incurredOn: '2026-09-04', isRecurring: true, recurrence: 'monthly', deductible: true }),
    );
    const antes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listRecurringExpenses(tx));
    assert.ok(antes.rows.some((r) => r.id === gasto.id));
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      updateExpense(tx, gasto.id, {
        category: 'contabilidad', vendor: 'Duplicado', description: 'Error de registro: se anuló',
        amount: '400000', incurredOn: '2026-09-04', isRecurring: false, deductible: false,
      }),
    );
    const despues = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listRecurringExpenses(tx));
    assert.ok(!despues.rows.some((r) => r.id === gasto.id));
    const gastoFinal = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getExpense(tx, gasto.id));
    assert.equal(gastoFinal?.recurrence, null, 'dejar de ser recurrente borra la recurrencia');
  });

  test('las reglas de un gasto se rechazan con su campo y su frase', async () => {
    const base = { category: 'software', amount: '1000', incurredOn: '2026-09-01', isRecurring: false, deductible: true };
    const casos: [Partial<typeof base> & Record<string, unknown>, string, string][] = [
      [{ category: 'criptomonedas' }, 'category', /no está en la lista/.source],
      [{ incurredOn: '01/09/2026' }, 'incurredOn', /YYYY-MM-DD/.source],
      [{ incurredOn: '2026-02-30' }, 'incurredOn', /YYYY-MM-DD/.source],
      [{ amount: 'mucho' }, 'amount', /decimal válido/.source],
      [{ amount: '0' }, 'amount', /mayor que cero/.source],
      [{ amount: '-500' }, 'amount', /mayor que cero/.source],
      [{ isRecurring: true }, 'recurrence', /cada cuánto se repite/.source],
      [{ isRecurring: true, recurrence: 'daily' }, 'recurrence', /cada cuánto se repite/.source],
      [{ currency: 'USD' }, 'currency', /moneda del espacio/.source],
      [{ receiptUrl: 'javascript:alert(1)' }, 'receiptUrl', /http:\/\/ o https:\/\//.source],
      [{ receiptUrl: '/recibos/1.pdf' }, 'receiptUrl', /http:\/\/ o https:\/\//.source],
    ];
    for (const [over, field, frase] of casos) {
      await assert.rejects(
        t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createExpense(tx, { ...base, ...over } as never)),
        (e: unknown) => e instanceof InvalidExpenseError && e.field === field && new RegExp(frase).test(e.messageEs),
        `${field}: ${JSON.stringify(over)}`,
      );
    }
  });

  test('un gasto que no existe da ExpenseNotFound, y un id que no es UUID no llega a la base', async () => {
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getExpense(tx, 'no-es-un-uuid')), null);
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
        updateExpense(tx, '00000000-0000-4000-8000-000000000000', { category: 'otros', amount: '1', incurredOn: '2026-09-01', isRecurring: false, deductible: true }),
      ),
      ExpenseNotFound,
    );
  });
});

describe('gastos · aislamiento por espacio', () => {
  test('desde otro espacio no se ve ni se edita ningún gasto del seed', async () => {
    const mes = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => getExpenseMonth(tx, '2026-09'));
    assert.equal(mes.rows.length, 0);
    assert.equal(mes.totals.total, '0.00');
    assert.deepEqual(mes.byCategory, []);
    assert.equal(mes.otherCurrencyCount, 0);

    const rec = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => listRecurringExpenses(tx));
    assert.equal(rec.rows.length, 0);

    assert.equal(await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => getExpense(tx, GASTO_EDICION_SEP)), null);
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_AJENO, (tx) =>
        updateExpense(tx, GASTO_EDICION_SEP, { category: 'otros', amount: '1', incurredOn: '2026-09-01', isRecurring: false, deductible: true }),
      ),
      ExpenseNotFound,
      'RLS no deja ni leer la fila para editarla',
    );
    // Y el gasto del seed sigue intacto.
    const intacto = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getExpense(tx, GASTO_EDICION_SEP));
    assert.equal(intacto?.amount, '1800000.00');
    assert.equal(intacto?.category, 'edicion');
  });

  test('un gasto creado en otro espacio no se mezcla, y su bitácora va a su espacio', async () => {
    const ajeno = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) =>
      createExpense(tx, { category: 'otros', vendor: 'Ajeno', amount: '777', incurredOn: '2026-09-15', isRecurring: false, deductible: true }),
    );
    const mesAjeno = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => getExpenseMonth(tx, '2026-09'));
    assert.equal(mesAjeno.totals.total, '777.00');
    const mesLaura = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getExpenseMonth(tx, '2026-09'));
    assert.ok(!mesLaura.rows.some((r) => r.id === ajeno.id));
    // La bitácora vive en SU espacio: se ve desde el ajeno y no desde el de Laura.
    assert.equal((await bitacoraDe(WORKSPACE_AJENO, ajeno.id)).length, 1);
    assert.deepEqual(await bitacoraDe(WORKSPACE_LAURA, ajeno.id), []);
  });

  test('la moneda del espacio manda: el espacio ajeno también rechaza otra', async () => {
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_AJENO, (tx) =>
        createExpense(tx, { category: 'otros', amount: '10', incurredOn: '2026-09-15', isRecurring: false, deductible: true, currency: 'EUR' }),
      ),
      (e: unknown) => e instanceof InvalidExpenseError && /COP/.test(e.messageEs),
    );
  });
});
