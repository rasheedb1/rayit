import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, hoyEnZona, projectCashflow, InvalidTransition, type Cashflow } from '@mc/core';
import {
  createInvoice,
  createInvoiceFromCampaign,
  getInvoice,
  getCashflowInputs,
  getReceivablesKpis,
  listCampaignsForInvoice,
  listCompanies,
  listInvoices,
  transitionInvoice,
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
// FIN-6 · Flujo de caja proyectado
// =====================================================================

/** Un negocio ganado que la prueba inserta, para el caso que el seed no tiene. */
const DEAL_SIN_FACTURA = '00000009-0000-4000-8000-0000000dea99';

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

  test('trae los gastos recurrentes de los últimos meses, con su fecha y sin los puntuales', async () => {
    const i = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCashflowInputs(tx));
    // Cinco recurrentes por mes; los dos puntuales (micrófono, viaje) no están.
    assert.ok(i.gastos.length >= 5, `esperaba al menos los cinco del mes, vinieron ${i.gastos.length}`);
    assert.ok(!i.gastos.some((g) => g.label.includes('Micrófono')), 'un gasto puntual no es recurrente');
    const septiembre = i.gastos.filter((g) => g.incurredOn.startsWith('2026-09'));
    assert.equal(septiembre.length, 5);
    const suma = septiembre.reduce((acc, g) => acc + BigInt(g.amount.replace('.', '')), 0n);
    assert.equal(suma, 370000000n, '3 700 000,00 al mes');
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
