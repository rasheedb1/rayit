import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  reservePeriod,
  InvalidTransition,
  InvoiceNotPayable,
  InvoicePaymentConflict,
  PaymentDateInFuture,
  PaymentExceedsOutstanding,
  TaxReserveRateInvalid,
  type PaymentMethod,
} from '@mc/core';
import {
  createInvoice,
  createInvoiceFromCampaign,
  getInvoice,
  getReceivablesKpis,
  listCampaignsForInvoice,
  listCompanies,
  listInvoices,
  listPayments,
  recordPayment,
  transitionInvoice,
  InvoiceNotFound,
  type TextosFinanzas,
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
// FIN-2 · Pagos y reserva de impuestos
// ---------------------------------------------------------------------
// Van al final del archivo a propósito: cobran FV-2026-010, que las
// pruebas de KPI de arriba leen con las cifras del seed. node:test corre
// las pruebas de un archivo en orden, así que primero se comprueba el
// seed intacto y después se mueve.
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
    assert.equal(pagos.reservedTotal, '0');
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
