import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  hoyEnZona,
  InvalidTransition,
  InvoiceNotPayable,
  InvoicePaymentConflict,
  PaymentDateInFuture,
  PaymentExceedsOutstanding,
  projectCashflow,
  proyeccionDePlataformas,
  reservePeriod,
  TaxReserveRateInvalid,
  type Cashflow,
  type PaymentMethod,
} from '@mc/core';
import {
  createInvoice,
  createInvoiceFromCampaign,
  createPlatformPayout,
  getInvoice,
  getCashflowInputs,
  getPlatformPayoutKpis,
  getPlatformPayoutMonths,
  getReceivablesKpis,
  importPlatformPayouts,
  listPlatformPayouts,
  listCampaignsForInvoice,
  listCompanies,
  listInvoices,
  listPayments,
  listReminders,
  markReminderSent,
  recordPayment,
  transitionInvoice,
  InvoiceNotFound,
  type TextosFinanzas,
} from '../src/queries/finanzas.ts';
import { assertWorkspaceId } from '../src/index.ts';
import { filasDeBitacora } from './bitacora.ts';
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
  // 300 s y no 120: levantar PGlite (WASM), aplicar las 33 migraciones y
  // los cuatro seeds tarda ~75 s en una máquina ociosa y bastante más en
  // una cargada, y el timeout explícito de un hook GANA sobre el
  // --test-timeout de la línea de órdenes, así que subirlo ahí no
  // alcanza. Cuando este hook se pasa, el archivo entero se cancela y
  // el `after` falla con «Cannot read properties of undefined», que no
  // dice nada de la causa. `ventas.test.ts` ya tenía el precedente con
  // 180 s.
}, { timeout: 300_000 });

after(async () => {
  await t?.close();
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

  test('crear una factura deja su fila en la bitácora: actor de la sesión, before null y after solo con lo permitido (ACC-2)', async () => {
    const USER_LAURA = '00000002-0000-4000-8000-000000000002';
    const creada = await t.db.withWorkspace(
      WORKSPACE_LAURA,
      (tx) => createInvoice(tx, { companyId: COMPANY_CAFE_ALMA, campaignId: CAMPAIGN_CAFE_ALMA, subtotal: '250000.00', issuedOn: '2026-09-23', dueOn: '2026-10-23', externalRef: ' DIAN-77 ' }),
      { userId: USER_LAURA },
    );
    const filas = await filasDeBitacora(t, WORKSPACE_LAURA, creada.id);
    assert.equal(filas.length, 1);
    const [fila] = filas;
    assert.equal(fila?.action, 'invoice.created');
    assert.equal(fila?.entity_type, 'invoice');
    assert.equal(fila?.actor_kind, 'user');
    assert.equal(fila?.actor_user_id, USER_LAURA);
    assert.equal(fila?.before, null);
    assert.deepEqual(fila?.after, {
      number: creada.number, companyId: COMPANY_CAFE_ALMA, campaignId: CAMPAIGN_CAFE_ALMA, quoteId: null, currency: 'COP',
      subtotal: '250000.00', tax: '47500.00', withholding: '27500.00', total: '297500.00',
      issuedOn: '2026-09-23', dueOn: '2026-10-23', status: 'draft', externalRef: 'DIAN-77',
    });
    assert.deepEqual(await filasDeBitacora(t, WORKSPACE_AJENO, creada.id), [], 'desde otro workspace no se ve');
  });

  test('si crear falla después de escribir, no queda ni factura ni bitácora', async () => {
    // Una moneda distinta a la del workspace se rechaza ANTES de escribir; aquí se fuerza el fallo después.
    let id = '';
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
        const inv = await createInvoice(tx, { companyId: COMPANY_CAFE_ALMA, subtotal: '1.00', issuedOn: '2026-09-23', dueOn: '2026-09-23' });
        id = inv.id;
        throw new Error('algo falló después');
      }),
      /algo falló después/,
    );
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getInvoice(tx, id)), null);
    assert.deepEqual(await filasDeBitacora(t, WORKSPACE_LAURA, id), []);
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

    // Cada transición dejó su fila, con el estado anterior y el nuevo; la inválida (paid con 1.00) no.
    const bitacora = await filasDeBitacora(t, WORKSPACE_LAURA, nueva.id);
    assert.deepEqual(bitacora.map((f) => f.action), ['invoice.created', 'invoice.sent', 'invoice.payment_recorded', 'invoice.paid']);
    assert.deepEqual(bitacora[1]?.before, { status: 'draft', paidAmount: '0.00' });
    assert.deepEqual(bitacora[1]?.after, { status: 'sent', paidAmount: '0.00', paidAt: null });
    assert.deepEqual(bitacora[2]?.before, { status: 'sent', paidAmount: '0.00' });
    assert.deepEqual(bitacora[2]?.after, { status: 'partial', paidAmount: '100000.00', paidAt: '2026-09-22T10:00:00Z' });
    // paid sin paidAt fija now(): la bitácora guarda el instante real.
    const pagoTotal = bitacora[3]?.after as { status: string; paidAmount: string; paidAt: string };
    assert.equal(pagoTotal.status, 'paid');
    assert.equal(pagoTotal.paidAmount, '595000.00');
    assert.match(pagoTotal.paidAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.deepEqual((await filasDeBitacora(t, WORKSPACE_LAURA, otra.id)).map((f) => f.action), ['invoice.created', 'invoice.voided']);
  });

  test('una factura inexistente da InvoiceNotFound', async () => {
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => transitionInvoice(tx, '00000000-0000-4000-8000-000000000000', 'sent')),
      InvoiceNotFound,
    );
  });
});

// =====================================================================
// FIN-6 · Flujo de caja proyectado
// =====================================================================

/** Un negocio ganado que la prueba inserta, para el caso que el seed no tiene. */
const DEAL_SIN_FACTURA = '00000009-0000-4000-8000-0000000dea99';
/** Y otro cuya única factura está en borrador. */
const DEAL_CON_BORRADOR = '00000009-0000-4000-8000-0000000dea98';
const CAMPANA_BORRADOR = '00000009-0000-4000-8000-000000ca0098';
const FACTURA_BORRADOR = '00000009-0000-4000-8000-0000fac26098';

/** La semana de `fecha`, o undefined si cae fuera de la ventana. */
function semanaDe(c: Cashflow, fecha: string) {
  return c.semanas.find((s) => s.inicio <= fecha && fecha <= s.fin);
}

describe('FIN-6 · getCashflowInputs con el seed', () => {
  test('trae las tres facturas por cobrar, con lo que cada marca todavía debe', async () => {
    const i = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCashflowInputs(tx));
    const numeros = i.facturas.map((f) => f.number).sort();
    assert.deepEqual(numeros, ['FV-2026-007', 'FV-2026-010', 'FV-2026-011']);
    const porNumero = Object.fromEntries(i.facturas.map((f) => [f.number, f]));
    assert.equal(porNumero['FV-2026-010']?.outstanding, '3100000.00');
    assert.equal(porNumero['FV-2026-010']?.companyName, 'Café Alma');
    assert.equal(porNumero['FV-2026-011']?.outstanding, '5200000.00');
    assert.equal(porNumero['FV-2026-007']?.outstanding, '1100000.00');
    // El dinero llega como string decimal, nunca como number.
    for (const f of i.facturas) assert.equal(typeof f.outstanding, 'string');
  });

  test('trae los cuatro negocios ganados del seed, todos ya facturados', async () => {
    const i = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCashflowInputs(tx));
    assert.equal(i.negocios.length, 4);
    for (const n of i.negocios) {
      assert.equal(n.hasInvoice, true, `${n.name} está enlazado a su campaña y su factura`);
      assert.equal(typeof n.amount, 'string');
    }
    assert.ok(i.negocios.some((n) => n.name === '2 TikTok · septiembre'));
    // Los perdidos y los abiertos no entran: la etapa se mira por is_won.
    assert.ok(!i.negocios.some((n) => n.name.includes('granola')), 'el perdido queda fuera');
  });

  test('trae los gastos recurrentes de la ventana, con su fecha y sin los puntuales', async () => {
    const i = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCashflowInputs(tx));
    // El seed 0003 escribe sus gastos con fechas ABSOLUTAS (julio, agosto
    // y septiembre de 2026), no relativas como las facturas, así que en
    // algún momento se salen de la ventana de 120 días. Cuando eso pase,
    // esta prueba tiene que decirlo con claridad y no callar.
    assert.ok(
      i.gastos.length > 0,
      `Ningún gasto recurrente en la ventana de 120 días desde ${i.today}. Los del seed 0003 ` +
        'están con fechas absolutas de 2026: hay que pasarlos a fechas relativas (CURRENT_DATE) ' +
        'como las facturas, o esta lectura ya no prueba nada.',
    );
    assert.ok(!i.gastos.some((g) => g.label.includes('Micrófono')), 'un gasto puntual no es recurrente');
    assert.ok(!i.gastos.some((g) => g.label.includes('finca')), 'un viaje puntual tampoco');

    // Cinco recurrentes por mes, 3 700 000 cada mes: se comprueba mes a
    // mes sobre lo que vino, sin fijar cuál es el mes.
    const porMes = new Map<string, bigint>();
    for (const g of i.gastos) {
      const mes = g.incurredOn.slice(0, 7);
      porMes.set(mes, (porMes.get(mes) ?? 0n) + BigInt(g.amount.replace('.', '')));
    }
    for (const [mes, suma] of porMes) {
      assert.equal(i.gastos.filter((g) => g.incurredOn.startsWith(mes)).length, 5, `cinco recurrentes en ${mes}`);
      assert.equal(suma, 370000000n, `3 700 000,00 en ${mes}`);
    }
  });

  test('la moneda, el plazo y el 11 % de reserva salen del workspace, no de una constante', async () => {
    const i = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCashflowInputs(tx));
    assert.equal(i.currency, 'COP');
    assert.equal(i.reservaPct, '11');
    assert.equal(i.reservaRate, '0.11');
    assert.equal(i.plazoDias, 30);
  });

  test('hoy sale de la zona del workspace, no de CURRENT_DATE del servidor', async () => {
    const i = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCashflowInputs(tx));
    assert.equal(i.today, hoyEnZona('America/Bogota'));
    assert.match(i.today, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('FIN-6 · el gráfico sale de la función con los datos del seed', () => {
  test('ocho semanas, con la factura de cada marca en la semana en que vence', async () => {
    const i = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCashflowInputs(tx));
    const c = projectCashflow(i);
    assert.equal(c.semanas.length, 8);
    assert.equal(c.vacio, false);

    const porNumero = Object.fromEntries(i.facturas.map((f) => [f.number, f]));
    for (const numero of ['FV-2026-010', 'FV-2026-011']) {
      const f = porNumero[numero]!;
      const s = semanaDe(c, f.dueOn);
      assert.ok(s, `${numero} cae dentro de las ocho semanas`);
      assert.ok(s.detalle.some((d) => d.label === numero), `${numero} está en la semana del ${s.inicio}`);
    }
    const cobrados = c.semanas.reduce((acc, s) => acc + BigInt(s.cobros.replace('.', '')), 0n);
    assert.equal(cobrados, 830000000n, '3 100 000 + 5 200 000: la vencida no suma');
  });

  test('los gastos y la reserva del seed: 853 846,15 por semana y el 11 % de cada cobro', async () => {
    const i = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCashflowInputs(tx));
    const c = projectCashflow(i);
    // El ritmo sale del último mes CERRADO con recurrentes, que es el que
    // haya en la ventana: el seed pone los mismos 3 700 000 en cada uno.
    assert.ok(c.gastoMes !== null && c.gastoMes < i.today.slice(0, 7), `${c.gastoMes} es un mes cerrado`);
    assert.equal(c.gastoMensual, '3700000.00');
    assert.equal(c.gastoSemanal, '853846.15');
    for (const s of c.semanas) {
      assert.equal(s.gastos, '853846.15');
      const esperado = BigInt(s.cobros.replace('.', '')) * 11n / 100n;
      assert.equal(BigInt(s.impuestos.replace('.', '')), esperado, `la reserva de la semana del ${s.inicio}`);
    }
    // El mock: «Gastos e impuestos entre 1,1 y 1,7 M por semana» en las
    // semanas con cobro. Sin cobro es solo el gasto.
    const conCobro = c.semanas.filter((s) => s.cobros !== '0.00');
    assert.equal(conCobro.length, 2);
  });

  test('los cuatro ganados del seed no se cuentan dos veces: ya tienen factura', async () => {
    const i = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCashflowInputs(tx));
    const c = projectCashflow(i);
    assert.equal(c.excluidos.yaFacturados.count, 4);
    for (const s of c.semanas) {
      assert.ok(!s.detalle.some((d) => d.kind === 'negocio'), `ningún negocio en la semana del ${s.inicio}`);
    }
  });

  test('la factura vencida del seed queda fuera de las semanas y se explica aparte', async () => {
    const i = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCashflowInputs(tx));
    const c = projectCashflow(i);
    assert.deepEqual(c.excluidos.vencidas, { count: 1, amount: '1100000.00' });
  });

  test('un negocio ganado SIN factura sí entra, en expected_close_date + plazo', async () => {
    await t.admin(`
      INSERT INTO deal (id, workspace_id, company_id, name, stage_id, amount, currency, expected_close_date, won_at)
      VALUES ('${DEAL_SIN_FACTURA}', '${WORKSPACE_LAURA}', '${COMPANY_CAFE_ALMA}',
              'Serie sin facturar', 'ganado', 7000000.00, 'COP', CURRENT_DATE - 5, now())
      ON CONFLICT (id) DO UPDATE SET expected_close_date = EXCLUDED.expected_close_date;
    `);
    try {
      const i = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCashflowInputs(tx));
      const nuevo = i.negocios.find((n) => n.id === DEAL_SIN_FACTURA);
      assert.ok(nuevo, 'el negocio ganado nuevo viene en la consulta');
      assert.equal(nuevo.hasInvoice, false, 'no tiene campaña ni cotización con factura');

      const c = projectCashflow(i);
      const esperadoEl = addDays(nuevo.expectedCloseDate!, i.plazoDias);
      const s = semanaDe(c, esperadoEl);
      assert.ok(s, `el cobro del ${esperadoEl} cae dentro de las ocho semanas`);
      const linea = s.detalle.find((d) => d.id === DEAL_SIN_FACTURA);
      assert.ok(linea, 'y está en el detalle de su semana');
      assert.equal(linea.kind, 'negocio');
      assert.equal(linea.amount, '7000000.00');
      assert.equal(c.excluidos.yaFacturados.count, 4, 'los cuatro del seed siguen fuera');
    } finally {
      await t.admin(`DELETE FROM deal WHERE id = '${DEAL_SIN_FACTURA}'`);
    }
  });

  test('un ganado cuya ÚNICA factura está en borrador sigue contando: el borrador no debe nada', async () => {
    // El agujero: la factura en borrador no está entre las que deben
    // plata, así que si además marcara el negocio como «ya facturado»,
    // su monto desaparecía de la proyección entre crear la factura y
    // marcarla enviada, que es el camino normal de FIN-1.
    await t.admin(`
      INSERT INTO deal (id, workspace_id, company_id, name, stage_id, amount, currency, expected_close_date, won_at)
      VALUES ('${DEAL_CON_BORRADOR}', '${WORKSPACE_LAURA}', '${COMPANY_CAFE_ALMA}',
              'Ganado con factura en borrador', 'ganado', 2000000.00, 'COP', CURRENT_DATE - 5, now());
      INSERT INTO campaign (id, workspace_id, company_id, deal_id, name, amount, currency, status)
      VALUES ('${CAMPANA_BORRADOR}', '${WORKSPACE_LAURA}', '${COMPANY_CAFE_ALMA}', '${DEAL_CON_BORRADOR}',
              'Campaña del borrador', 2000000.00, 'COP', 'planned');
      INSERT INTO invoice (id, workspace_id, company_id, campaign_id, number, currency,
                           subtotal, tax, withholding, total, issued_on, due_on, status)
      VALUES ('${FACTURA_BORRADOR}', '${WORKSPACE_LAURA}', '${COMPANY_CAFE_ALMA}', '${CAMPANA_BORRADOR}',
              'FV-2026-900', 'COP', 1680672.27, 319327.73, 184873.95, 2000000.00,
              CURRENT_DATE, CURRENT_DATE + 30, 'draft');
    `);
    try {
      const i = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCashflowInputs(tx));
      const n = i.negocios.find((x) => x.id === DEAL_CON_BORRADOR);
      assert.ok(n, 'el negocio viene en la consulta');
      assert.equal(n.hasInvoice, false, 'un borrador no cuenta como facturado');
      assert.ok(!i.facturas.some((f) => f.number === 'FV-2026-900'), 'y tampoco está entre las que deben plata');

      const c = projectCashflow(i);
      const enAlgunaSemana = c.semanas.some((s) => s.detalle.some((d) => d.id === DEAL_CON_BORRADOR));
      assert.ok(enAlgunaSemana, 'su monto sigue en la proyección, no se evapora');

      // Y al marcarla enviada, pasa a contar la factura y no el negocio.
      await t.admin(`UPDATE invoice SET status = 'sent' WHERE id = '${FACTURA_BORRADOR}'`);
      const j = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCashflowInputs(tx));
      assert.equal(j.negocios.find((x) => x.id === DEAL_CON_BORRADOR)?.hasInvoice, true);
      assert.ok(j.facturas.some((f) => f.number === 'FV-2026-900'), 'ahora sí debe plata');
      const d = projectCashflow(j);
      assert.ok(!d.semanas.some((s) => s.detalle.some((x) => x.id === DEAL_CON_BORRADOR)), 'el negocio ya no suma');
      assert.ok(d.semanas.some((s) => s.detalle.some((x) => x.label === 'FV-2026-900')), 'suma la factura');
    } finally {
      await t.admin(`DELETE FROM invoice WHERE id = '${FACTURA_BORRADOR}'`);
      await t.admin(`DELETE FROM campaign WHERE id = '${CAMPANA_BORRADOR}'`);
      await t.admin(`DELETE FROM deal WHERE id = '${DEAL_CON_BORRADOR}'`);
    }
  });
});

describe('FIN-6 · aislamiento', () => {
  test('desde otro workspace no hay facturas, ni negocios, ni gastos: el flujo está vacío', async () => {
    const i = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => getCashflowInputs(tx));
    assert.deepEqual(i.facturas, []);
    assert.deepEqual(i.negocios, []);
    assert.deepEqual(i.gastos, []);
    assert.equal(i.currency, 'COP', 'la moneda es la SUYA, no la del vecino');
    assert.equal(i.reservaPct, null, 'el workspace ajeno no tiene ajustes de finanzas');
    assert.equal(i.reservaRate, '0', 'sin porcentaje configurado no se inventa uno');
    assert.equal(i.plazoDias, 30, 'el plazo por defecto');

    const c = projectCashflow(i);
    assert.equal(c.vacio, true);
    assert.equal(c.semanaMasAjustada, null);
    assert.equal(c.proyectado, '0.00');
    for (const s of c.semanas) {
      assert.equal(s.cobros, '0.00');
      assert.equal(s.gastos, '0.00');
      assert.equal(s.impuestos, '0.00');
      assert.deepEqual(s.detalle, []);
    }
  });
});

describe('bandeja de recordatorios (FIN-4)', () => {
  /** Ids fijos, para poder afirmar el orden sin depender del uuid que sortee la base. */
  const N2 = '00000004-0000-4000-8000-00000000fa02';
  const N3 = '00000004-0000-4000-8000-00000000fa03';
  const N4 = '00000004-0000-4000-8000-00000000fa04';
  const N_SIN_PASO = '00000004-0000-4000-8000-00000000fa09';
  const N_DESCARTADA = '00000004-0000-4000-8000-00000000fa08';
  const N_AJENA = '00000004-0000-4000-8000-00000000fa07';
  /** …f1, no …e1: ese es EMPRESA_SIN_RESERVA de FIN-2, con otro dueño. */
  const EMPRESA_AJENA = '00000009-0000-4000-8000-0000000000f1';
  const FV_007 = '00000003-0000-4000-8000-0000fac26007';

  before(async () => {
    // Una factura del workspace ajeno, para que su recordatorio apunte a
    // algo. La empresa es …f1 y no …e1: ese id es de FIN-2
    // (EMPRESA_SIN_RESERVA) y lo espera con OTRO dueño, así que el
    // primero en insertar decidía de quién era la empresa.
    await t.admin(`
      INSERT INTO company (id, name, owner_workspace_id)
      VALUES ('${EMPRESA_AJENA}', 'Marca Ajena', '${WORKSPACE_AJENO}') ON CONFLICT DO NOTHING;
      INSERT INTO invoice (id, workspace_id, company_id, number, currency, subtotal, tax, withholding, total, issued_on, due_on, status, paid_amount)
      VALUES ('00000009-0000-4000-8000-0000fac26001', '${WORKSPACE_AJENO}', '${EMPRESA_AJENA}',
              'FV-2026-A01', 'COP', 1000000.00, 190000.00, 110000.00, 1190000.00, CURRENT_DATE - 71, CURRENT_DATE - 41, 'sent', 0.00)
      ON CONFLICT DO NOTHING;

      INSERT INTO notification (id, workspace_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url, dismissed_at) VALUES
        ('${N3}', '${WORKSPACE_LAURA}', 'invoice_overdue', 'warning', 'Factura FV-2026-007 pendiente · 41 días de mora',
         'Hola, equipo de Hogar Lindo:', 'invoice', '${FV_007}', '/finanzas/facturas/${FV_007}?recordatorio=3', NULL),
        ('${N2}', '${WORKSPACE_LAURA}', 'invoice_overdue', 'info', 'La factura FV-2026-007 venció el 13 de agosto de 2026',
         'Hola, equipo de Hogar Lindo:', 'invoice', '${FV_007}', '/finanzas/facturas/${FV_007}?recordatorio=2', NULL),
        ('${N4}', '${WORKSPACE_LAURA}', 'invoice_overdue', 'critical', 'Aviso formal de cobro · factura FV-2026-007',
         'Hola, equipo de Hogar Lindo:', 'invoice', '${FV_007}', '/finanzas/facturas/${FV_007}?recordatorio=5', NULL),
        ('${N_SIN_PASO}', '${WORKSPACE_LAURA}', 'invoice_overdue', 'info', 'Aviso viejo sin paso',
         'Cuerpo', 'invoice', '${FV_007}', '/finanzas/facturas/${FV_007}', NULL),
        ('${N_DESCARTADA}', '${WORKSPACE_LAURA}', 'invoice_overdue', 'warning', 'Descartado',
         'Cuerpo', 'invoice', '${FV_007}', '/finanzas/facturas/${FV_007}?recordatorio=4', now()),
        ('${N_AJENA}', '${WORKSPACE_AJENO}', 'invoice_overdue', 'critical', 'Aviso del workspace ajeno',
         'Hola, equipo de Marca Ajena:', 'invoice', '00000009-0000-4000-8000-0000fac26001',
         '/finanzas/facturas/00000009-0000-4000-8000-0000fac26001?recordatorio=5', NULL)
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  test('la bandeja trae el asunto, el cuerpo y el paso, lo más grave primero', async () => {
    const filas = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listReminders(tx));
    assert.deepEqual(filas.map((f) => f.id), [N4, N3, N2], 'critical, warning, info');
    assert.deepEqual(filas.map((f) => f.paso), [5, 3, 2]);
    assert.deepEqual(filas.map((f) => f.etiquetaEs), ['Aviso formal de cobro', 'Primer aviso de mora', 'Aviso de vencimiento']);
    const uno = filas[1]!;
    assert.equal(uno.asunto, 'Factura FV-2026-007 pendiente · 41 días de mora');
    assert.equal(uno.cuerpo, 'Hola, equipo de Hogar Lindo:');
    assert.equal(uno.invoiceNumber, 'FV-2026-007');
    assert.equal(uno.companyName, 'Hogar Lindo');
    assert.equal(uno.currency, 'COP');
    assert.equal(uno.outstanding, '1100000.00');
    assert.equal(uno.daysOverdue, 41);
    assert.equal(uno.sentAt, null);
    assert.match(uno.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test('lo descartado y lo que no lleva paso no entran', async () => {
    const filas = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listReminders(tx));
    const ids = filas.map((f) => f.id);
    assert.ok(!ids.includes(N_DESCARTADA), 'dismissed_at descarta para siempre');
    assert.ok(!ids.includes(N_SIN_PASO), 'sin paso en action_url no es un recordatorio de FIN-4');
  });

  test('otro workspace no ve la bandeja ajena, ni con su id delante', async () => {
    const mios = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listReminders(tx));
    assert.ok(!mios.some((f) => f.id === N_AJENA));
    const ajenos = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => listReminders(tx));
    assert.deepEqual(ajenos.map((f) => f.id), [N_AJENA]);
    assert.equal(ajenos[0]?.companyName, 'Marca Ajena');
  });

  test('se puede pedir la de una sola factura, y un id que no es uuid no consulta', async () => {
    const dela = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listReminders(tx, { invoiceId: FV_007 }));
    assert.equal(dela.length, 3);
    assert.deepEqual(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listReminders(tx, { invoiceId: 'no-es-uuid' })), []);
    assert.deepEqual(
      await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listReminders(tx, { invoiceId: INVOICE_FV_2026_001 })),
      [],
      'una factura sin recordatorios devuelve la lista vacía, no las de otra',
    );
  });

  test('marcar como enviado sella la fecha una sola vez', async () => {
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => markReminderSent(tx, N2)), true);
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => markReminderSent(tx, N2)), false, 'repetir el clic no mueve la fecha');

    const [marcado] = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listReminders(tx, { invoiceId: FV_007, pendingOnly: false }));
    const fila = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listReminders(tx, { invoiceId: FV_007 }))).find((f) => f.id === N2);
    assert.ok(marcado, 'la bandeja completa lo sigue mostrando');
    assert.match(fila!.sentAt ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    const pendientes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listReminders(tx, { pendingOnly: true }));
    assert.deepEqual(pendientes.map((f) => f.id), [N4, N3], 'el marcado sale de los pendientes');
  });

  test('una factura pagada saca sus recordatorios de la bandeja, pero los deja en su ficha', async () => {
    const pendientesAntes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listReminders(tx, { pendingOnly: true }));
    assert.ok(pendientesAntes.some((r) => r.invoiceId === FV_007), 'antes de pagar sí está en la bandeja');

    await t.admin(`UPDATE invoice SET status = 'paid', paid_amount = total, paid_at = now() WHERE id = '${FV_007}'`);
    try {
      const pendientes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listReminders(tx, { pendingOnly: true }));
      assert.ok(!pendientes.some((r) => r.invoiceId === FV_007), 'nadie tiene que cobrarle a quien ya pagó');
      const enLaFicha = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listReminders(tx, { invoiceId: FV_007 }));
      assert.equal(enLaFicha.length, 3, 'la ficha sigue siendo el historial del cobro');
    } finally {
      await t.admin(`UPDATE invoice SET status = 'sent', paid_amount = 0, paid_at = NULL WHERE id = '${FV_007}'`);
    }
  });

  test('los días de mora salen de la zona del workspace, no de la del servidor', async () => {
    const [r] = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listReminders(tx, { invoiceId: FV_007 }));
    const { rows } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      tx.query<{ esperado: number }>(
        `SELECT (((now() AT TIME ZONE w.timezone)::date) - i.due_on)::int AS esperado
           FROM invoice i JOIN workspace w ON w.id = i.workspace_id WHERE i.id = $1`,
        [FV_007],
      ),
    );
    assert.equal(r?.daysOverdue, rows[0]?.esperado);
  });

  test('no se marca el recordatorio de otro workspace', async () => {
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => markReminderSent(tx, N_AJENA)), false);
    const ajenos = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => listReminders(tx));
    assert.equal(ajenos[0]?.sentAt, null, 'sigue intacto en su workspace');
  });

  test('un id que no es uuid, o que no existe, devuelve false sin lanzar', async () => {
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => markReminderSent(tx, 'no-es-uuid')), false);
    assert.equal(
      await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => markReminderSent(tx, '00000000-0000-4000-8000-000000000000')),
      false,
    );
  });
});


// =====================================================================
// FIN-2 · Pagos y reserva de impuestos
// ---------------------------------------------------------------------
// Van al final del archivo a propósito: cobran FV-2026-010, y tanto los
// KPI de arriba como las pruebas de FIN-6 la leen con las cifras del
// seed. node:test corre las pruebas de un archivo en orden, así que
// primero se comprueba el seed intacto y después se mueve.
// =====================================================================

/**
 * Las frases del aviso las pone la web (TextosFinanzas): este paquete no
 * tiene idioma. Aquí van las mínimas para comprobar que llegan tal cual.
 */
const TEXTOS: TextosFinanzas = {
  avisoPagoRecibido: (p) => ({
    title: `Pago recibido · ${p.invoiceNumber}`,
    body:
      p.status === 'paid'
        ? `${p.companyName} pagó ${p.currency} ${p.amount}. La factura queda pagada.`
        : `${p.companyName} abonó ${p.currency} ${p.amount}. Quedan ${p.currency} ${p.outstanding}.`,
  }),
};

/** La persona del seed 0002, para que la bitácora tenga actor. */
const USUARIO_LAURA = '00000002-0000-4000-8000-000000000002';

/** Un espacio sin `settings.finanzas.reserva_pct`, con su propia empresa y factura. */
const WORKSPACE_SIN_RESERVA = '00000009-0000-4000-8000-000000000002';
const EMPRESA_SIN_RESERVA = '00000009-0000-4000-8000-0000000000e1';
const FACTURA_SIN_RESERVA = '00000009-0000-4000-8000-0000fac00001';

/** Hoy en la zona del espacio: es el día que la pantalla propone y el que acepta el cobro. */
async function hoyEnElEspacio(workspaceId = WORKSPACE_LAURA): Promise<string> {
  const rows = await t.db.withWorkspace(workspaceId, async (tx) => {
    const r = await tx.query<{ hoy: string }>(
      `SELECT to_char((now() AT TIME ZONE coalesce(nullif(w.timezone, ''), 'UTC'))::date, 'YYYY-MM-DD') AS hoy
         FROM workspace w WHERE w.id = current_workspace_id()`,
    );
    return r.rows;
  });
  return rows[0]?.hoy ?? '';
}

/** Cuántas filas hay de cada tabla que toca un cobro, para comprobar que un rechazo no deja nada. */
async function conteos(workspaceId = WORKSPACE_LAURA): Promise<Record<string, number>> {
  const rows = await t.db.withWorkspace(workspaceId, async (tx) => {
    const r = await tx.query<{ pagos: number; reservas: number; bitacora: number; avisos: number }>(`
      SELECT (SELECT count(*)::int FROM payment) AS pagos,
             (SELECT count(*)::int FROM tax_reserve) AS reservas,
             (SELECT count(*)::int FROM audit_log WHERE action = 'invoice.payment_recorded') AS bitacora,
             (SELECT count(*)::int FROM notification WHERE kind = 'payment_received') AS avisos
    `);
    return r.rows;
  });
  const c = rows[0];
  return { pagos: c?.pagos ?? -1, reservas: c?.reservas ?? -1, bitacora: c?.bitacora ?? -1, avisos: c?.avisos ?? -1 };
}

/** Una factura enviada, recién creada, para no ensuciar las del seed. */
async function facturaEnviada(subtotal: string): Promise<{ id: string; total: string }> {
  const nueva = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
    createInvoice(tx, { companyId: COMPANY_CAFE_ALMA, subtotal, issuedOn: '2026-09-01', dueOn: '2026-10-01' }),
  );
  const enviada = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => transitionInvoice(tx, nueva.id, 'sent'));
  return { id: enviada.id, total: enviada.total };
}

describe('pagos (FIN-2)', () => {
  test('un pago parcial deja FV-2026-010 en partial y aparta el 11 % del espacio', async () => {
    const hoy = await hoyEnElEspacio();
    const { invoice, payment } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      recordPayment(tx, {
        invoiceId: INVOICE_FV_2026_010,
        amount: '1000000',
        receivedOn: hoy,
        method: 'transferencia',
        reference: 'TRF-260923-CAFEALMA',
        expectedPaidAmount: '0.00',
      }, TEXTOS),
    );

    assert.equal(invoice.status, 'partial');
    assert.equal(invoice.paidAmount, '1000000.00');
    assert.equal(invoice.outstanding, '2100000.00');
    assert.equal(invoice.paidAt, null, 'un abono no es «pagada el …»');
    assert.equal(invoice.bucket, 'vence_pronto');

    assert.equal(payment.amount, '1000000.00');
    assert.equal(payment.currency, 'COP');
    assert.equal(payment.method, 'transferencia');
    assert.equal(payment.receivedOn, hoy);
    assert.equal(payment.reserved, '110000.00', '11 % de 1 000 000');
    assert.equal(payment.reserveRate, '0.1100', 'la tasa del momento queda en la fila');
    assert.equal(payment.reservePeriod, reservePeriod(hoy));

    const pagos = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPayments(tx, INVOICE_FV_2026_010));
    assert.equal(pagos.rows.length, 1);
    assert.equal(pagos.reservedTotal, '110000.00');
    assert.equal(pagos.reserveRate, '0.1100');
  });

  test('el resto la pasa a pagada, con paid_at, y suma el apartado', async () => {
    const hoy = await hoyEnElEspacio();
    const { invoice } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      recordPayment(tx, {
        invoiceId: INVOICE_FV_2026_010,
        amount: '2100000',
        receivedOn: hoy,
        method: 'pse',
        expectedPaidAmount: '1000000.00',
      }, TEXTOS),
    );

    assert.equal(invoice.status, 'paid');
    assert.equal(invoice.paidAmount, '3100000.00');
    assert.equal(invoice.outstanding, '0.00');
    assert.equal(invoice.bucket, 'pagada');
    assert.ok(invoice.paidAt !== null, 'al quedar pagada sí se fija paid_at');
    assert.match(invoice.paidAt ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    const pagos = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPayments(tx, INVOICE_FV_2026_010));
    assert.equal(pagos.rows.length, 2);
    assert.equal(pagos.reservedTotal, '341000.00', '110 000 + 231 000');
    assert.equal(pagos.rows[0]?.method, 'pse', 'el más reciente primero');
  });

  test('y los KPI de Finanzas se mueven con el cobro', async () => {
    const k = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getReceivablesKpis(tx));
    // Eran 9 400 000 con 3 facturas abiertas; FV-2026-010 (3 100 000) ya está cobrada.
    assert.equal(k.outstanding, '6300000.00');
    assert.equal(k.openCount, 2);
    // Y el apartado subió en los 341 000 de los dos cobros.
    assert.equal(k.taxReserved, '4587000.00', '4 246 000 del seed + 341 000');
  });

  test('una factura ya pagada no admite otro cobro', async () => {
    const hoy = await hoyEnElEspacio();
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
        recordPayment(tx, {
          invoiceId: INVOICE_FV_2026_010, amount: '1', receivedOn: hoy, method: 'efectivo', expectedPaidAmount: '3100000.00',
        }, TEXTOS),
      ),
      (e: unknown) => e instanceof InvoiceNotPayable && /pagada/i.test(e.messageEs),
    );
  });

  test('un cobro mayor que el saldo se rechaza y no deja NADA escrito', async () => {
    const hoy = await hoyEnElEspacio();
    const { id } = await facturaEnviada('100000.00');
    const antes = await conteos();
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
        recordPayment(tx, { invoiceId: id, amount: '200000', receivedOn: hoy, method: 'transferencia', expectedPaidAmount: '0.00' }, TEXTOS),
      ),
      PaymentExceedsOutstanding,
    );
    assert.deepEqual(await conteos(), antes, 'la transacción se deshizo entera');
    const factura = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getInvoice(tx, id));
    assert.equal(factura?.status, 'sent');
    assert.equal(factura?.paidAmount, '0.00');
  });

  test('una factura en borrador o anulada no se cobra', async () => {
    const hoy = await hoyEnElEspacio();
    const borrador = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createInvoice(tx, { companyId: COMPANY_CAFE_ALMA, subtotal: '50000.00', issuedOn: '2026-09-01', dueOn: '2026-10-01' }),
    );
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
        recordPayment(tx, { invoiceId: borrador.id, amount: '1000', receivedOn: hoy, method: 'efectivo', expectedPaidAmount: '0.00' }, TEXTOS),
      ),
      (e: unknown) => e instanceof InvoiceNotPayable && /Márcala enviada/.test(e.messageEs),
    );
    const anulada = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => transitionInvoice(tx, borrador.id, 'void'));
    assert.equal(anulada.status, 'void');
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
        recordPayment(tx, { invoiceId: borrador.id, amount: '1000', receivedOn: hoy, method: 'efectivo', expectedPaidAmount: '0.00' }, TEXTOS),
      ),
      InvoiceNotPayable,
    );
  });

  test('un cobro fechado mañana no se registra', async () => {
    const hoy = await hoyEnElEspacio();
    const { id } = await facturaEnviada('100000.00');
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
        recordPayment(tx, { invoiceId: id, amount: '1000', receivedOn: addDays(hoy, 1), method: 'efectivo', expectedPaidAmount: '0.00' }, TEXTOS),
      ),
      PaymentDateInFuture,
    );
  });

  test('desde otro workspace no se puede cobrar una factura ajena', async () => {
    const hoy = await hoyEnElEspacio();
    const antes = await conteos();
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_AJENO, (tx) =>
        recordPayment(tx, {
          invoiceId: INVOICE_FV_2026_001, amount: '1000', receivedOn: hoy, method: 'transferencia', expectedPaidAmount: '4700000.00',
        }, TEXTOS),
      ),
      InvoiceNotFound,
      'RLS deja la consulta en cero filas y eso es un 404, no un 403',
    );
    assert.deepEqual(await conteos(), antes);
    // Y la factura de Laura sigue como estaba.
    const intacta = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getInvoice(tx, INVOICE_FV_2026_001));
    assert.equal(intacta?.paidAmount, '4700000.00');
  });

  test('el mismo formulario enviado dos veces registra UN pago', async () => {
    const hoy = await hoyEnElEspacio();
    const { id } = await facturaEnviada('1000000.00');

    const registrar = () =>
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
        recordPayment(tx, {
          invoiceId: id, amount: '100000', receivedOn: hoy, method: 'transferencia', expectedPaidAmount: '0.00',
        }, TEXTOS),
      );

    const primero = await registrar();
    assert.equal(primero.invoice.paidAmount, '100000.00');
    // El segundo envío lleva el mismo paid_amount que vio la pantalla.
    await assert.rejects(registrar(), (e: unknown) => {
      assert.ok(e instanceof InvoicePaymentConflict);
      assert.equal(e.expected, '0.00');
      assert.equal(e.actual, '100000.00');
      assert.match(e.messageEs, /Recarga la página/);
      return true;
    });
    const pagos = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPayments(tx, id));
    assert.equal(pagos.rows.length, 1, 'un doble envío no duplica el cobro');

    // Con el saldo actualizado —que es lo que la pantalla ve tras
    // revalidar— el segundo abono sí entra.
    const segundo = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      recordPayment(tx, {
        invoiceId: id, amount: '100000', receivedOn: hoy, method: 'transferencia', expectedPaidAmount: '100000.00',
      }, TEXTOS),
    );
    assert.equal(segundo.invoice.paidAmount, '200000.00');
  });

  test('cada cobro deja bitácora con actor y before/after, y un aviso', async () => {
    const hoy = await hoyEnElEspacio();
    const { id, total } = await facturaEnviada('200000.00');
    await t.db.withWorkspace(
      WORKSPACE_LAURA,
      (tx) =>
        recordPayment(tx, {
          invoiceId: id, amount: total, receivedOn: hoy, method: 'tarjeta',
          reference: 'AUTH-998877', notes: 'pago en línea', expectedPaidAmount: '0.00',
        }, TEXTOS),
      { userId: USUARIO_LAURA },
    );

    const { bitacora, aviso } = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const b = await tx.query<{
        actor_user_id: string | null; actor_kind: string; entity_type: string; before: Record<string, unknown>; after: Record<string, unknown>;
      }>(
        `SELECT actor_user_id, actor_kind, entity_type, before, after
           FROM audit_log WHERE action = 'invoice.payment_recorded' AND entity_id = $1`,
        [id],
      );
      const a = await tx.query<{ kind: string; severity: string; title_es: string; body_es: string; action_url: string; entity_type: string }>(
        `SELECT kind, severity, title_es, body_es, action_url, entity_type
           FROM notification WHERE kind = 'payment_received' AND entity_id = $1`,
        [id],
      );
      return { bitacora: b.rows, aviso: a.rows };
    });

    assert.equal(bitacora.length, 1, 'una fila por cobro');
    const fila = bitacora[0];
    assert.equal(fila?.actor_user_id, USUARIO_LAURA, 'el actor sale de current_user_id(), no de un parámetro');
    assert.equal(fila?.actor_kind, 'user');
    assert.equal(fila?.entity_type, 'invoice');
    assert.deepEqual(fila?.before, { status: 'sent', paidAmount: '0.00' });
    assert.equal(fila?.after?.status, 'paid');
    assert.equal(fila?.after?.paidAmount, total);

    // Ni la referencia del banco, ni las notas, ni el nombre de la marca.
    const texto = JSON.stringify({ before: fila?.before, after: fila?.after });
    for (const prohibido of ['AUTH-998877', 'pago en línea', 'Café Alma', 'reference', 'notes']) {
      assert.equal(texto.includes(prohibido), false, `la bitácora no debe llevar «${prohibido}»`);
    }

    assert.equal(aviso.length, 1);
    assert.equal(aviso[0]?.severity, 'success');
    assert.equal(aviso[0]?.entity_type, 'invoice');
    assert.equal(aviso[0]?.action_url, `/finanzas/facturas/${id}`);
    assert.equal(aviso[0]?.title_es, `Pago recibido · ${(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getInvoice(tx, id)))?.number}`);
    assert.match(aviso[0]?.body_es ?? '', /La factura queda pagada/);
  });

  test('sin identidad en la transacción, la bitácora dice «system» y no inventa una persona', async () => {
    const hoy = await hoyEnElEspacio();
    const { id, total } = await facturaEnviada('30000.00');
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      recordPayment(tx, { invoiceId: id, amount: total, receivedOn: hoy, method: 'efectivo', expectedPaidAmount: '0.00' }, TEXTOS),
    );
    const rows = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const r = await tx.query<{ actor_user_id: string | null; actor_kind: string }>(
        `SELECT actor_user_id, actor_kind FROM audit_log WHERE action = 'invoice.payment_recorded' AND entity_id = $1`,
        [id],
      );
      return r.rows;
    });
    assert.equal(rows[0]?.actor_user_id, null);
    assert.equal(rows[0]?.actor_kind, 'system');
  });

  test('un espacio sin reserva_pct cobra igual y no aparta nada', async () => {
    await t.admin(`
      INSERT INTO workspace (id, slug, name, kind, currency, timezone)
      VALUES ('${WORKSPACE_SIN_RESERVA}', 'espacio-sin-reserva', 'Sin reserva', 'creator', 'COP', 'America/Bogota')
      ON CONFLICT DO NOTHING;
      INSERT INTO company (id, name, owner_workspace_id)
      VALUES ('${EMPRESA_SIN_RESERVA}', 'Marca sin reserva', '${WORKSPACE_SIN_RESERVA}')
      ON CONFLICT DO NOTHING;
      INSERT INTO company_link (workspace_id, company_id)
      VALUES ('${WORKSPACE_SIN_RESERVA}', '${EMPRESA_SIN_RESERVA}')
      ON CONFLICT DO NOTHING;
      INSERT INTO invoice (id, workspace_id, company_id, number, currency, subtotal, tax, withholding, total,
                           issued_on, due_on, status, paid_amount)
      VALUES ('${FACTURA_SIN_RESERVA}', '${WORKSPACE_SIN_RESERVA}', '${EMPRESA_SIN_RESERVA}', 'FV-2026-001', 'COP',
              1000000.00, 190000.00, 110000.00, 1190000.00, CURRENT_DATE - 10, CURRENT_DATE + 20, 'sent', 0.00)
      ON CONFLICT DO NOTHING;
    `);
    // settings es '{}' por defecto (0001): no hay finanzas.reserva_pct.
    const hoy = await hoyEnElEspacio(WORKSPACE_SIN_RESERVA);
    const { invoice, payment } = await t.db.withWorkspace(WORKSPACE_SIN_RESERVA, (tx) =>
      recordPayment(tx, {
        invoiceId: FACTURA_SIN_RESERVA, amount: '1190000', receivedOn: hoy, method: 'transferencia', expectedPaidAmount: '0.00',
      }, TEXTOS),
    );
    assert.equal(invoice.status, 'paid', 'no apartar no impide cobrar');
    assert.equal(payment.reserved, null, 'una ausencia no es un cero');
    assert.equal(payment.reserveRate, null);
    const pagos = await t.db.withWorkspace(WORKSPACE_SIN_RESERVA, (tx) => listPayments(tx, FACTURA_SIN_RESERVA));
    assert.equal(pagos.reservedTotal, '0.00', 'un monto siempre tiene dos decimales');
    assert.equal(pagos.reserveRate, null);
  });

  test('un reserva_pct roto se ve: falla y no escribe nada', async () => {
    await t.admin(`
      UPDATE workspace SET settings = '{"finanzas": {"reserva_pct": "once"}}'::jsonb
       WHERE id = '${WORKSPACE_SIN_RESERVA}';
      INSERT INTO invoice (id, workspace_id, company_id, number, currency, subtotal, tax, withholding, total,
                           issued_on, due_on, status, paid_amount)
      VALUES ('00000009-0000-4000-8000-0000fac00002', '${WORKSPACE_SIN_RESERVA}', '${EMPRESA_SIN_RESERVA}', 'FV-2026-002', 'COP',
              100000.00, 19000.00, 11000.00, 119000.00, CURRENT_DATE - 10, CURRENT_DATE + 20, 'sent', 0.00)
      ON CONFLICT DO NOTHING;
    `);
    const hoy = await hoyEnElEspacio(WORKSPACE_SIN_RESERVA);
    const antes = await conteos(WORKSPACE_SIN_RESERVA);
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_SIN_RESERVA, (tx) =>
        recordPayment(tx, {
          invoiceId: '00000009-0000-4000-8000-0000fac00002', amount: '119000', receivedOn: hoy,
          method: 'transferencia', expectedPaidAmount: '0.00',
        }, TEXTOS),
      ),
      TaxReserveRateInvalid,
    );
    assert.deepEqual(await conteos(WORKSPACE_SIN_RESERVA), antes);
  });

  test('un método de pago que no está en la lista no llega a la base', async () => {
    const hoy = await hoyEnElEspacio();
    const { id } = await facturaEnviada('10000.00');
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
        recordPayment(tx, {
          invoiceId: id, amount: '1000', receivedOn: hoy,
          method: 'bitcoin' as PaymentMethod, expectedPaidAmount: '0.00',
        }, TEXTOS),
      ),
      /Método de pago desconocido/,
    );
  });
});

// ---------------------------------------------------------------------
// FIN-7 · Ingresos de plataformas
// ---------------------------------------------------------------------

describe('ingresos de plataformas (FIN-7)', () => {
  /** Los periodos se construyen desde el día que dice la BASE, no desde el reloj de Node. */
  let hoy: string;
  let mesAnterior: string;
  let dosAntes: string;
  let tresAntes: string;

  const periodo = (mes: string) => ({
    periodStart: `${mes}-01`,
    periodEnd: `${mes}-${String(ultimoDia(mes)).padStart(2, '0')}`,
  });
  const ultimoDia = (mes: string) => {
    const [a, m] = mes.split('-').map(Number);
    return new Date(Date.UTC(a!, m!, 0)).getUTCDate();
  };
  const desplazar = (mes: string, n: number) => {
    const [a, m] = mes.split('-').map(Number);
    const total = a! * 12 + (m! - 1) + n;
    return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
  };

  before(async () => {
    const kpis = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getPlatformPayoutKpis(tx));
    hoy = kpis.today;
    mesAnterior = desplazar(hoy.slice(0, 7), -1);
    dosAntes = desplazar(hoy.slice(0, 7), -2);
    tresAntes = desplazar(hoy.slice(0, 7), -3);
  });

  test('el seed no trae ninguno: la lista arranca vacía y el estimado es null, no cero', async () => {
    const { rows } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPlatformPayouts(tx));
    assert.equal(rows.length, 0);

    const kpis = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getPlatformPayoutKpis(tx));
    assert.equal(kpis.ytd, '0');
    assert.equal(kpis.lastMonth, null, 'un mes sin pago no vale cero');
    assert.equal(kpis.currency, 'COP');

    const meses = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getPlatformPayoutMonths(tx));
    assert.deepEqual(meses, []);
    assert.equal(proyeccionDePlataformas(meses, { hoy, currency: 'COP' }).estimado, null);
  });

  test('un CSV de AdSense entra y aparece como ingreso de su mes', async () => {
    const lote = [
      { platformId: 'youtube', ...periodo(tresAntes), amount: '900000.00', currency: 'COP', source: 'csv_import' as const },
      { platformId: 'youtube', ...periodo(dosAntes), amount: '770000.00', currency: 'COP', source: 'csv_import' as const },
      { platformId: 'youtube', ...periodo(mesAnterior), amount: '1101500.50', currency: 'COP', source: 'csv_import' as const },
    ];
    const r = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => importPlatformPayouts(tx, lote));
    assert.deepEqual(r, { inserted: 3, duplicated: 0, conflicting: [] });

    const { rows } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPlatformPayouts(tx));
    assert.equal(rows.length, 3);
    const ultimo = rows[0];
    assert.equal(ultimo?.month, mesAnterior, 'el mes de un pago es el de su period_start');
    assert.equal(ultimo?.amount, '1101500.50');
    assert.equal(ultimo?.platformName, 'YouTube');
    assert.equal(ultimo?.source, 'csv_import');
    assert.equal(ultimo?.creatorId, null);
    assert.equal(ultimo?.periodEnd, periodo(mesAnterior).periodEnd);
    assert.match(ultimo?.createdAt ?? '', /^\d{4}-\d{2}-\d{2}T.*Z$/, 'timestamptz en UTC y como ISO');

    const meses = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getPlatformPayoutMonths(tx));
    assert.equal(meses.find((m) => m.mes === mesAnterior)?.monto, '1101500.50');
  });

  test('repetir la importación no duplica: las tres ya estaban', async () => {
    const lote = [
      { platformId: 'youtube', ...periodo(tresAntes), amount: '900000.00', currency: 'COP', source: 'csv_import' as const },
      { platformId: 'youtube', ...periodo(dosAntes), amount: '770000.00', currency: 'COP', source: 'csv_import' as const },
      { platformId: 'youtube', ...periodo(mesAnterior), amount: '1101500.50', currency: 'COP', source: 'csv_import' as const },
    ];
    const r = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => importPlatformPayouts(tx, lote));
    assert.deepEqual(r, { inserted: 0, duplicated: 3, conflicting: [] });
    const { rows } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPlatformPayouts(tx));
    assert.equal(rows.length, 3, 'siguen siendo tres');
  });

  test('el mismo periodo con OTRO monto no se escribe ni se pisa', async () => {
    const r = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      importPlatformPayouts(tx, [
        { platformId: 'youtube', ...periodo(mesAnterior), amount: '1250000.00', currency: 'COP', source: 'csv_import' },
      ]),
    );
    assert.equal(r.inserted, 0);
    assert.equal(r.conflicting.length, 1);
    assert.deepEqual(r.conflicting[0], {
      platformId: 'youtube',
      platformName: 'YouTube',
      ...periodo(mesAnterior),
      currency: 'COP',
      amount: '1250000.00',
      existingAmount: '1101500.50',
    });
    const { rows } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPlatformPayouts(tx));
    assert.equal(rows.length, 3, 'no se creó una cuarta fila que doblaría el mes');
    assert.equal(rows[0]?.amount, '1101500.50', 'el monto guardado no se pisó');
  });

  test('otra red en el mismo periodo sí es otro pago', async () => {
    const r = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      importPlatformPayouts(tx, [
        { platformId: 'tiktok', ...periodo(mesAnterior), amount: '415250.75', currency: 'COP', source: 'csv_import' },
      ]),
    );
    assert.equal(r.inserted, 1);
    const meses = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getPlatformPayoutMonths(tx));
    assert.equal(meses.find((m) => m.mes === mesAnterior)?.monto, '1516751.25', 'la base suma las dos redes');
  });

  test('una moneda que no es la del espacio y una red que no existe se rechazan con una frase que nombra la fila', async () => {
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
        importPlatformPayouts(tx, [
          { platformId: 'youtube', ...periodo(tresAntes), amount: '900000.00', currency: 'COP', source: 'csv_import' },
          { platformId: 'youtube', ...periodo(dosAntes), amount: '210.40', currency: 'USD', source: 'csv_import' },
        ]),
      ),
      /Fila 2: .*moneda del espacio \(COP\); recibió USD/,
    );
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
        importPlatformPayouts(tx, [
          { platformId: 'twitch', ...periodo(dosAntes), amount: '100000.00', currency: 'COP', source: 'csv_import' },
        ]),
      ),
      /Fila 1: «twitch» no es una red conocida/,
    );
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
        importPlatformPayouts(tx, [
          { platformId: 'youtube', periodStart: `${dosAntes}-28`, periodEnd: `${dosAntes}-01`, amount: '1.00', currency: 'COP', source: 'csv_import' },
        ]),
      ),
      /Fila 1: el fin del periodo no puede ser anterior/,
    );
    const { rows } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPlatformPayouts(tx));
    assert.equal(rows.length, 4, 'un lote que se rechaza no escribe la parte buena');
  });

  test('«agregar a mano» distingue escrito, ya estaba y choca', async () => {
    const entrada = {
      platformId: 'instagram' as const,
      ...periodo(mesAnterior),
      amount: '260000.00',
      currency: 'COP',
      source: 'manual' as const,
    };
    const nuevo = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createPlatformPayout(tx, entrada));
    assert.equal(nuevo.duplicated, false);
    assert.equal(nuevo.conflicting, null);
    assert.equal(nuevo.payout?.platformName, 'Instagram');
    assert.equal(nuevo.payout?.source, 'manual');
    assert.equal(nuevo.payout?.month, mesAnterior);

    const otraVez = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createPlatformPayout(tx, entrada));
    assert.equal(otraVez.duplicated, true);
    assert.equal(otraVez.payout?.id, nuevo.payout?.id, 'devuelve la que ya estaba, no una nueva');

    const choque = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createPlatformPayout(tx, { ...entrada, amount: '300000.00' }),
    );
    assert.equal(choque.payout, null);
    assert.equal(choque.conflicting?.existingAmount, '260000.00');
  });

  test('los meses alimentan el promedio de core y el estimado sale de ahí', async () => {
    const meses = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getPlatformPayoutMonths(tx));
    // El contrato de MesConIngreso: { mes, monto }, sin rellenar los vacíos.
    assert.deepEqual(Object.keys(meses[0] ?? {}).sort(), ['mes', 'monto']);
    const p = proyeccionDePlataformas(meses, { hoy, currency: 'COP' });
    // mesAnterior: 1 101 500,50 + 415 250,75 + 260 000 = 1 776 751,25
    // dosAntes:      770 000,00 · tresAntes: 900 000,00 → /3
    assert.equal(p.estimado, '1148917.08');
    assert.equal(p.mesesConDatos, 3);
    assert.equal(p.hasta, mesAnterior);
    assert.equal(p.currency, 'COP');
  });

  test('los KPI los suma la base, y el último mes cerrado tiene su total', async () => {
    const kpis = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getPlatformPayoutKpis(tx));
    assert.equal(kpis.lastMonthLabel, mesAnterior);
    assert.equal(kpis.lastMonth, '1776751.25');
    assert.equal(typeof kpis.ytdPayouts, 'number');
    assert.match(kpis.today, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('la bitácora: el lote deja una fila sin entityId y el pago a mano deja la suya', async () => {
    const { rows } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      tx.query<{ action: string; entity_type: string; entity_id: string | null; after: Record<string, unknown> }>(
        `SELECT action, entity_type, entity_id::text, after
           FROM audit_log
          WHERE entity_type = 'platform_payout'
          ORDER BY created_at, action`,
      ),
    );
    const lotes = rows.filter((r) => r.action === 'platform_payout.imported');
    const aMano = rows.filter((r) => r.action === 'platform_payout.created');

    // Tres importaciones escribieron algo: las tres de AdSense, la de
    // TikTok y (desde el espacio ajeno, que no se ve aquí) ninguna. La
    // segunda vez del mismo lote NO dejó fila: no se escribió nada.
    assert.equal(lotes.length, 2, 'el lote repetido no deja una segunda fila');
    for (const fila of lotes) {
      assert.equal(fila.entity_id, null, 'un lote son n pagos y ninguno es «el» pago');
      assert.equal(fila.after.source, 'csv_import');
      assert.equal(fila.after.currency, 'COP');
      assert.ok(Array.isArray(fila.after.platforms));
      assert.ok(typeof fila.after.inserted === 'number');
      // Ni un monto en la bitácora: el dinero de cada pago está en su fila.
      assert.equal(Object.keys(fila.after).includes('amount'), false);
    }

    assert.equal(aMano.length, 1, 'el pago a mano repetido tampoco deja una segunda fila');
    assert.match(aMano[0]?.entity_id ?? '', /^[0-9a-f-]{36}$/, 'el pago a mano nombra SU fila');
    assert.equal(aMano[0]?.after.source, 'manual');
  });

  test('el ON CONFLICT nombra sus columnas: sobre una base sin 0036 falla, no deduplica en silencio', async () => {
    // Un `ON CONFLICT DO NOTHING` a secas NO falla cuando el índice no
    // existe: se limita a no deduplicar. Sobre una base sin 0036 eso
    // duplicaría el dinero y la pantalla diría «listo». Con el objetivo
    // escrito, Postgres exige el índice y lanza 42P10.
    await t.admin('DROP INDEX platform_payout_natural_uidx');
    try {
      await assert.rejects(
        t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
          importPlatformPayouts(tx, [
            { platformId: 'facebook', ...periodo(tresAntes), amount: '1.00', currency: 'COP', source: 'csv_import' },
          ]),
        ),
        (err: unknown) => (err as { code?: string }).code === '42P10',
      );
      const { rows } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPlatformPayouts(tx));
      assert.equal(rows.length, 5, 'y no escribió nada');
    } finally {
      await t.admin(`
        CREATE UNIQUE INDEX IF NOT EXISTS platform_payout_natural_uidx
          ON platform_payout (workspace_id, platform_id,
            coalesce(creator_id, '00000000-0000-0000-0000-000000000000'::uuid),
            period_start, period_end, currency, amount);
      `);
    }
  });

  test('un periodo fechado en el año que viene no se suma al «recibido en este año»', async () => {
    const elAnioQueViene = `${+hoy.slice(0, 4) + 1}-01`;
    const antes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getPlatformPayoutKpis(tx));
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      importPlatformPayouts(tx, [
        { platformId: 'facebook', ...periodo(elAnioQueViene), amount: '999999.00', currency: 'COP', source: 'manual' },
      ]),
    );
    const despues = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getPlatformPayoutKpis(tx));
    assert.equal(despues.ytd, antes.ytd, 'el año tiene tope por arriba, no solo por abajo');
    assert.equal(despues.ytdPayouts, antes.ytdPayouts);
  });

  test('ninguna fila devuelve un id bigserial a la web', async () => {
    const { rows } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPlatformPayouts(tx));
    for (const r of rows) {
      assert.match(r.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'platform_payout.id es uuid');
    }
  });

  test('aislamiento: el workspace ajeno no ve nada y sus pagos no se mezclan', async () => {
    const ajeno = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => listPlatformPayouts(tx));
    assert.equal(ajeno.rows.length, 0);

    assert.deepEqual(await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => getPlatformPayoutMonths(tx)), []);
    const kpisAjeno = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => getPlatformPayoutKpis(tx));
    assert.equal(kpisAjeno.ytd, '0');
    assert.equal(kpisAjeno.lastMonth, null);

    // El MISMO pago, desde el otro workspace: no choca con el de Laura
    // (el UNIQUE abre por workspace_id) y sigue sin verse desde el suyo.
    const suyo = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) =>
      importPlatformPayouts(tx, [
        { platformId: 'youtube', ...periodo(mesAnterior), amount: '1101500.50', currency: 'COP', source: 'csv_import' },
      ]),
    );
    assert.equal(suyo.inserted, 1, 'dos espacios pueden tener el mismo pago sin saber el uno del otro');
    assert.equal((await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => listPlatformPayouts(tx))).rows.length, 1);
    const deLaura = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPlatformPayouts(tx));
    assert.equal(
      deLaura.rows.length,
      6,
      'los tres de AdSense, el de TikTok, el de Instagram a mano y el fechado en el año que viene',
    );
  });

  test('sin workspace fijado, RLS no deja ver ni escribir un solo pago', async () => {
    const vistos = await t.raw<{ n: string }>('SELECT count(*)::text AS n FROM platform_payout');
    assert.equal(vistos[0]?.n, '0', 'la sesión de mc_app sin workspace no ve ninguna fila');
  });
});
