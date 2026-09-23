import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidTransition, proyeccionDePlataformas } from '@mc/core';
import {
  createInvoice,
  createInvoiceFromCampaign,
  createPlatformPayout,
  getInvoice,
  getPlatformPayoutKpis,
  getPlatformPayoutMonths,
  getReceivablesKpis,
  importPlatformPayouts,
  listPlatformPayouts,
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
    const { rows, months } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPlatformPayouts(tx));
    assert.equal(rows.length, 0);
    assert.equal(months.length, 0);

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

    const { rows, months } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPlatformPayouts(tx));
    assert.equal(rows.length, 3);
    const ultimo = rows[0];
    assert.equal(ultimo?.month, mesAnterior, 'el mes de un pago es el de su period_start');
    assert.equal(ultimo?.amount, '1101500.50');
    assert.equal(ultimo?.platformName, 'YouTube');
    assert.equal(ultimo?.source, 'csv_import');
    assert.equal(ultimo?.creatorId, null);
    assert.equal(ultimo?.periodEnd, periodo(mesAnterior).periodEnd);
    assert.match(ultimo?.createdAt ?? '', /^\d{4}-\d{2}-\d{2}T.*Z$/, 'timestamptz en UTC y como ISO');

    const delMes = months.find((m) => m.month === mesAnterior);
    assert.equal(delMes?.total, '1101500.50');
    assert.equal(delMes?.payouts, 1, 'count(*) llega como número, no como el bigint crudo');
    assert.equal(typeof delMes?.payouts, 'number');
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
    const { months } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPlatformPayouts(tx));
    assert.equal(months.find((m) => m.month === mesAnterior)?.total, '1516751.25', 'la base suma las dos redes');
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

  test('ninguna fila devuelve un id bigserial a la web', async () => {
    const { rows } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPlatformPayouts(tx));
    for (const r of rows) {
      assert.match(r.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'platform_payout.id es uuid');
    }
  });

  test('aislamiento: el workspace ajeno no ve nada y sus pagos no se mezclan', async () => {
    const ajeno = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => listPlatformPayouts(tx));
    assert.equal(ajeno.rows.length, 0);
    assert.equal(ajeno.months.length, 0);
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
    assert.equal(deLaura.rows.length, 5, 'los tres de AdSense, el de TikTok y el de Instagram a mano');
  });

  test('sin workspace fijado, RLS no deja ver ni escribir un solo pago', async () => {
    const vistos = await t.raw<{ n: string }>('SELECT count(*)::text AS n FROM platform_payout');
    assert.equal(vistos[0]?.n, '0', 'la sesión de mc_app sin workspace no ve ninguna fila');
  });
});
