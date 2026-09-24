/**
 * ACC-6 · Alcance en queries/finanzas.ts: un miembro con alcance a Laura
 * no ve las facturas, los pagos, los recordatorios, los pagos de
 * plataforma ni la marca de Sofía en NINGUNA función exportada, no puede
 * facturar ni cobrar nada de Sofía, y no ve ni toca los gastos ni la
 * configuración del espacio (son de todos). Ver test/alcance.ts.
 *
 * Las filas de Sofía que solo usa Finanzas (un gasto, pagos de
 * plataforma, un recordatorio, un negocio ganado) las siembra
 * `sembrarFinanzas`. Como el gasto y el negocio no nombran ningún id de
 * SOFIA_IDS, y la huella común no mira expense, platform_payout ni
 * notification, las pruebas propias de abajo lo comprueban a mano.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceTx } from '../src/client.ts';
import * as finanzas from '../src/queries/finanzas.ts';
import { ScopeError } from '../src/scope.ts';
import { CAMPAIGN_CAFE_ALMA, COMPANY_CAFE_ALMA, WORKSPACE_LAURA, type TestDb } from './pglite.ts';
import {
  CAMPAIGN_LAURA_PRUEBA, CAMPAIGN_SOFIA, CREATOR_LAURA, CREATOR_SOFIA, definirPruebasDeAlcance, EMPRESA_SOFIA, INVOICE_SOFIA,
  PAYMENT_SOFIA, QUOTE_SOFIA, USER_MIEMBRO, USER_MIEMBRO_CAMPANA, USER_MIEMBRO_MARCA, type CasoDeAlcance,
} from './alcance.ts';

const {
  listInvoices, getInvoice, listCompanies, listCampaignsForInvoice, getReceivablesKpis, createInvoice, transitionInvoice,
  createInvoiceFromCampaign, InvoiceNotFound, listReceivables, getReserveState, getFinanceSettings, updateFinanceSettings,
  countInvoicesInOtherCurrency, countLiveInvoicesInCurrency, recordPayment, getPayment, listPayments, getCashflowInputs,
  listPayoutPlatforms, getWorkspaceToday, listPlatformPayouts, getPlatformPayoutMonths, getPlatformPayoutKpis,
  importPlatformPayouts, createPlatformPayout, listReminders, markReminderSent, getExpense, getExpenseMonth, createExpense,
  updateExpense,
} = finanzas;

/** Filas de Sofía propias de Finanzas (prefijo 0000000a-…) y un pago de plataforma de Laura (0000000b-…). */
const EXPENSE_SOFIA = '0000000a-0000-4000-8000-00000e170001';
const PAYOUT_SOFIA = '0000000a-0000-4000-8000-0000fa700001';
const PAYOUT_SIN_CREADOR = '0000000a-0000-4000-8000-0000fa700002';
const PAYOUT_LAURA = '0000000b-0000-4000-8000-0000fa700001';
const REMINDER_SOFIA = '0000000a-0000-4000-8000-00000070e001';
const DEAL_SOFIA = '0000000a-0000-4000-8000-0000de500001';

/** El día de hoy en la zona del espacio de Laura (America/Bogota), en SQL. */
const HOY_BOGOTA = `(now() AT TIME ZONE 'America/Bogota')::date`;
/** El primer día del último mes cerrado, en SQL. */
const MES_PASADO = `(date_trunc('month', ${HOY_BOGOTA}) - interval '1 month')::date`;

async function sembrarFinanzas(t: TestDb): Promise<void> {
  await t.admin(`
    INSERT INTO expense (id, workspace_id, category, vendor, description, amount, currency, incurred_on, is_recurring, recurrence, deductible)
    VALUES ('${EXPENSE_SOFIA}', '${WORKSPACE_LAURA}', 'software', 'Proveedor de Sofía', 'Suscripción de Sofía', 777777.00, 'COP',
            ${HOY_BOGOTA}, true, 'monthly', true)
    ON CONFLICT DO NOTHING;

    INSERT INTO platform_payout (id, workspace_id, creator_id, platform_id, period_start, period_end, amount, currency, source)
    VALUES ('${PAYOUT_SOFIA}', '${WORKSPACE_LAURA}', '${CREATOR_SOFIA}', 'tiktok', ${MES_PASADO},
            (${MES_PASADO} + interval '1 month' - interval '1 day')::date, 333333.00, 'COP', 'manual'),
           ('${PAYOUT_SIN_CREADOR}', '${WORKSPACE_LAURA}', NULL, 'youtube', ${MES_PASADO},
            (${MES_PASADO} + interval '1 month' - interval '1 day')::date, 111111.00, 'COP', 'manual'),
           ('${PAYOUT_LAURA}', '${WORKSPACE_LAURA}', '${CREATOR_LAURA}', 'instagram', ${MES_PASADO},
            (${MES_PASADO} + interval '1 month' - interval '1 day')::date, 222222.00, 'COP', 'manual')
    ON CONFLICT DO NOTHING;

    INSERT INTO notification (id, workspace_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url)
    VALUES ('${REMINDER_SOFIA}', '${WORKSPACE_LAURA}', 'invoice_overdue', 'info', 'Recordatorio FV-2026-901', 'Hola, …',
            'invoice', '${INVOICE_SOFIA}', '/finanzas/facturas/${INVOICE_SOFIA}?recordatorio=1')
    ON CONFLICT DO NOTHING;

    INSERT INTO deal (id, workspace_id, company_id, creator_id, name, stage_id, amount, currency, expected_close_date, won_at)
    VALUES ('${DEAL_SOFIA}', '${WORKSPACE_LAURA}', '${EMPRESA_SOFIA}', '${CREATOR_SOFIA}', 'Segunda playa con Marca de Sofía',
            'ganado', 555555.00, 'COP', ${HOY_BOGOTA} + 20, now())
    ON CONFLICT DO NOTHING;
  `);
}

const TEXTOS: finanzas.TextosFinanzas = {
  avisoPagoRecibido: (p) => ({ title: `Pago recibido · ${p.invoiceNumber}`, body: `${p.companyName} · ${p.amount}` }),
};

const GASTO: finanzas.CreateExpenseInput = {
  category: 'software', vendor: 'Proveedor de Sofía', description: 'Corregido', amount: '777777.00', incurredOn: '2026-09-01',
  isRecurring: true, recurrence: 'monthly', deductible: true,
};

/** Un pago de plataforma de Sofía de hace tres meses, que no choca con los sembrados. */
const payoutDeSofia = (amount: string, source: finanzas.PayoutSource): finanzas.PlatformPayoutInput => ({
  platformId: 'tiktok', creatorId: CREATOR_SOFIA, periodStart: '2026-06-01', periodEnd: '2026-06-30', amount, currency: 'COP', source,
});

const noExiste = (e: unknown) => e instanceof Error && /no existe en este workspace/.test(e.message);
/** Para lo que no lleva ningún id de SOFIA_IDS: el control de la dueña busca el id propio de Finanzas. */
const nombraId = (id: string) => (r: unknown) => JSON.stringify(r ?? null).includes(id);

const CASOS: Record<string, CasoDeAlcance> = {
  listInvoices: { run: (tx) => listInvoices(tx, { limit: 200 }), duena: 'nombra', miembro: 'nada' },
  getInvoice: { run: (tx) => getInvoice(tx, INVOICE_SOFIA), duena: 'nombra', miembro: 'nada' },
  listCompanies: { run: (tx) => listCompanies(tx), duena: 'nombra', miembro: 'nada' },
  listCampaignsForInvoice: { run: (tx) => listCampaignsForInvoice(tx), duena: 'nombra', miembro: 'nada' },
  // Los KPI no llevan ids: el control es que la dueña suma más (prueba propia, abajo).
  getReceivablesKpis: { run: (tx) => getReceivablesKpis(tx), duena: 'pasa', miembro: 'nada' },
  listReceivables: { run: (tx) => listReceivables(tx, { limit: 200 }), duena: 'nombra', miembro: 'nada' },
  receivablesSearchTerm: 'pura',
  bloqueParaBitacora: 'pura',
  // Sin alcance: es configuración del espacio (settings.finanzas), no un dato de ninguna creadora.
  getReserveState: { run: (tx) => getReserveState(tx), duena: 'pasa', miembro: 'nada' },
  // Sin alcance: la configuración financiera es del espacio; quien tiene alcance la necesita para facturar.
  getFinanceSettings: { run: (tx) => getFinanceSettings(tx), duena: 'pasa', miembro: 'nada' },
  // Sin alcance: solo la llama updateFinanceSettings, que ya exigió una persona sin alcance (assertUnscoped).
  countInvoicesInOtherCurrency: { run: (tx) => countInvoicesInOtherCurrency(tx, 'COP'), duena: 'pasa', miembro: 'nada' },
  // Con alcance (la pinta la pantalla de configuración): el conteo propio va abajo.
  countLiveInvoicesInCurrency: { run: (tx) => countLiveInvoicesInCurrency(tx, 'COP'), duena: (n) => typeof n === 'number' && n >= 1, miembro: 'nada' },
  getPayment: { run: (tx) => getPayment(tx, PAYMENT_SOFIA), duena: 'nombra', miembro: 'nada' },
  listPayments: { run: (tx) => listPayments(tx, INVOICE_SOFIA), duena: 'nombra', miembro: 'nada' },
  // Los negocios, gastos y pagos de plataforma del flujo se comprueban en su prueba propia, abajo.
  getCashflowInputs: { run: (tx) => getCashflowInputs(tx), duena: 'nombra', miembro: 'nada' },
  // Sin alcance: es el catálogo global de redes (platform), no un dato de nadie.
  listPayoutPlatforms: { run: (tx) => listPayoutPlatforms(tx), duena: 'pasa', miembro: 'nada' },
  // Sin alcance: es la fecha del espacio, no un dato de nadie.
  getWorkspaceToday: { run: (tx) => getWorkspaceToday(tx), duena: 'pasa', miembro: 'nada' },
  listPlatformPayouts: { run: (tx) => listPlatformPayouts(tx), duena: 'nombra', miembro: 'nada' },
  // Agregados sin ids: las sumas se comparan en la prueba propia de pagos de plataforma.
  getPlatformPayoutMonths: { run: (tx) => getPlatformPayoutMonths(tx), duena: 'pasa', miembro: 'nada' },
  getPlatformPayoutKpis: { run: (tx) => getPlatformPayoutKpis(tx), duena: 'pasa', miembro: 'nada' },
  listReminders: { run: (tx) => listReminders(tx, { limit: 200 }), duena: 'nombra', miembro: 'nada' },
  // Los gastos no nombran a Sofía: la dueña busca el id del gasto sembrado y la prueba propia exige que el miembro no.
  getExpense: { run: (tx) => getExpense(tx, EXPENSE_SOFIA), duena: nombraId(EXPENSE_SOFIA), miembro: 'nada' },
  getExpenseMonth: { run: (tx) => getExpenseMonth(tx), duena: nombraId(EXPENSE_SOFIA), miembro: 'nada' },
  // --- Escrituras. El orden importa para la pasada de control de la dueña: cobrar antes de anular.
  // El miembro recibe false (como si no existiera); que no selló read_at lo mira la prueba propia.
  markReminderSent: { run: (tx) => markReminderSent(tx, REMINDER_SOFIA), duena: (r) => r === true, miembro: 'nada' },
  recordPayment: {
    run: async (tx) => recordPayment(
      tx,
      { invoiceId: INVOICE_SOFIA, amount: '1000.00', receivedOn: await getWorkspaceToday(tx), method: 'transferencia', expectedPaidAmount: '400000.00' },
      TEXTOS,
    ),
    duena: 'nombra',
    miembro: { rechaza: InvoiceNotFound },
  },
  createInvoice: {
    run: (tx) => createInvoice(tx, { companyId: EMPRESA_SOFIA, campaignId: CAMPAIGN_SOFIA, subtotal: '100000.00', issuedOn: '2026-09-20', dueOn: '2026-10-20' }),
    duena: 'nombra',
    miembro: { rechazaSi: noExiste },
  },
  // A 'overdue' y no a 'void': la pasada de control de recordPayment (arriba) la deja en 'partial', que no se puede anular.
  transitionInvoice: { run: (tx) => transitionInvoice(tx, INVOICE_SOFIA, 'overdue'), duena: 'nombra', miembro: { rechaza: InvoiceNotFound } },
  createInvoiceFromCampaign: { run: (tx) => createInvoiceFromCampaign(tx, CAMPAIGN_SOFIA), duena: 'nombra', miembro: { rechazaSi: noExiste } },
  // Cambia algo de todo el espacio: quien tiene alcance no lo toca. La dueña guarda lo mismo que había.
  updateFinanceSettings: {
    run: async (tx) => updateFinanceSettings(tx, { settings: await getFinanceSettings(tx) }),
    duena: 'pasa',
    miembro: { rechaza: ScopeError },
  },
  createExpense: {
    run: (tx) => createExpense(tx, { category: 'software', amount: '1000.00', incurredOn: '2026-09-01', isRecurring: false, deductible: false }),
    duena: 'pasa',
    miembro: { rechaza: ScopeError },
  },
  updateExpense: { run: (tx) => updateExpense(tx, EXPENSE_SOFIA, GASTO), duena: nombraId(EXPENSE_SOFIA), miembro: { rechaza: ScopeError } },
  importPlatformPayouts: {
    run: (tx) => importPlatformPayouts(tx, [payoutDeSofia('1000.00', 'csv_import')]),
    duena: (r) => (r as finanzas.ImportPlatformPayoutsResult).inserted === 1,
    miembro: { rechaza: ScopeError },
  },
  // Otro periodo que el del import de arriba: el mismo con otro monto sería un «conflicting» y no escribiría.
  createPlatformPayout: {
    run: (tx) => createPlatformPayout(tx, { ...payoutDeSofia('2000.00', 'manual'), periodStart: '2026-07-01', periodEnd: '2026-07-31' }),
    duena: 'nombra',
    miembro: { rechaza: ScopeError },
  },
};

/** Una huella de las tablas que Finanzas escribe y que la huella común no mira, leída como la dueña. */
async function huellaFinanzas(tx: WorkspaceTx): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const tabla of ['expense', 'platform_payout', 'notification', 'workspace', 'audit_log']) {
    const { rows } = await tx.query<{ h: string | null }>(
      `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${tabla} x`,
    );
    out[tabla] = rows[0]?.h ?? null;
  }
  return out;
}

definirPruebasDeAlcance('finanzas', finanzas, CASOS, ({ duena, miembro, como }) => {
  test('los KPI siguen al alcance: con alcance a la marca de Sofía suman exactamente lo suyo; con alcance a Laura, lo mismo que su lista', async () => {
    const cents = (s: string) => BigInt(s.replace('.', ''));
    // El miembro con alcance a la marca de Sofía solo ve su factura: 1 190 000 − 400 000
    // por cobrar, el pago de 400 000 y su reserva de 44 000.
    const deSofia = await como(USER_MIEMBRO_MARCA, (tx) => getReceivablesKpis(tx));
    assert.equal(deSofia.outstanding, '790000.00');
    assert.equal(deSofia.openCount, 1);
    assert.equal(deSofia.collectedYtd, '400000.00');
    assert.equal(deSofia.taxReserved, '44000.00');

    // Para la dueña y el miembro con alcance a Laura, «por cobrar» es la suma de SU lista:
    // los KPI no ven nada que la lista no enseñe.
    const porCobrarDeLaLista = async (fn: typeof duena) => {
      const { rows } = await fn((tx) => listInvoices(tx, { limit: 200 }));
      return rows.filter((r) => !['paid', 'void', 'draft'].includes(r.status)).reduce((acc, r) => acc + cents(r.outstanding), 0n);
    };
    const todo = await duena((tx) => getReceivablesKpis(tx));
    const suyo = await miembro((tx) => getReceivablesKpis(tx));
    assert.equal(cents(todo.outstanding), await porCobrarDeLaLista(duena));
    assert.equal(cents(suyo.outstanding), await porCobrarDeLaLista(miembro));
    assert.ok(cents(todo.outstanding) - cents(suyo.outstanding) >= 79000000n, 'la dueña suma al menos la factura de Sofía');
    assert.ok(cents(todo.collectedYtd) - cents(suyo.collectedYtd) >= 40000000n, 'y su pago');
    assert.ok(cents(todo.taxReserved) - cents(suyo.taxReserved) >= 4400000n, 'y su reserva');
  });

  test('con alcance a Laura, el miembro ve las facturas de las campañas de Laura y ninguna sin campaña (DECISIÓN PENDIENTE: «solo el cobro de sus campañas»)', async () => {
    const todas = await duena((tx) => listInvoices(tx, { limit: 200 }));
    const suyas = await miembro((tx) => listInvoices(tx, { limit: 200 }));
    const deCampanasDeLaura = todas.rows.filter((r) => r.campaignId !== null && r.id !== INVOICE_SOFIA);
    assert.deepEqual(suyas.rows.map((r) => r.id).sort(), deCampanasDeLaura.map((r) => r.id).sort());
    assert.ok(todas.rows.some((r) => r.campaignId === null), 'el seed tiene facturas sin campaña: la regla se está probando');
    assert.ok(suyas.rows.every((r) => r.campaignId !== null));
    const marcas = await miembro((tx) => listCompanies(tx));
    assert.ok(marcas.some((m) => m.id === COMPANY_CAFE_ALMA), 'Café Alma tiene campañas de Laura');
    assert.ok(!marcas.some((m) => m.id === EMPRESA_SOFIA));
    const creada = await miembro((tx) => createInvoiceFromCampaign(tx, CAMPAIGN_LAURA_PRUEBA));
    assert.equal(creada.campaignId, CAMPAIGN_LAURA_PRUEBA);
    assert.ok(await miembro((tx) => getInvoice(tx, creada.id)), 'y la ve');
  });

  test('con alcance por creador, una factura SIN campaña no es de ninguna creadora: se rechaza antes de escribir', async () => {
    const antes = await duena((tx) => listInvoices(tx, { limit: 200 }));
    await assert.rejects(
      miembro((tx) => createInvoice(tx, { companyId: COMPANY_CAFE_ALMA, subtotal: '100000.00', issuedOn: '2026-09-20', dueOn: '2026-10-20' })),
      (e: unknown) => e instanceof ScopeError && /fuera de tu alcance/.test(e.messageEs),
    );
    const despues = await duena((tx) => listInvoices(tx, { limit: 200 }));
    assert.equal(despues.rows.length, antes.rows.length, 'no quedó factura');
    // La dueña sí puede: sin alcance no hay nada que acotar.
    const manual = await duena((tx) => createInvoice(tx, { companyId: COMPANY_CAFE_ALMA, subtotal: '100000.00', issuedOn: '2026-09-20', dueOn: '2026-10-20' }));
    assert.equal(manual.campaignId, null);
    assert.equal(await miembro((tx) => getInvoice(tx, manual.id)), null, 'y el miembro no la ve');
  });

  test('una factura de una campaña de Laura no puede enlazar la cotización de Sofía', async () => {
    await assert.rejects(
      miembro((tx) => createInvoice(tx, { companyId: COMPANY_CAFE_ALMA, campaignId: CAMPAIGN_LAURA_PRUEBA, quoteId: QUOTE_SOFIA, subtotal: '100000.00', issuedOn: '2026-09-20', dueOn: '2026-10-20' })),
      /La cotización no existe en este workspace/,
    );
  });

  test('alcance por MARCA: solo lo de la marca de Sofía; alcance por CAMPAÑA: solo lo de Café Alma', async () => {
    const porMarca = await como(USER_MIEMBRO_MARCA, (tx) => listInvoices(tx, { limit: 200 }));
    assert.ok(porMarca.rows.length >= 1 && porMarca.rows.every((r) => r.companyId === EMPRESA_SOFIA));
    assert.deepEqual((await como(USER_MIEMBRO_MARCA, (tx) => listCompanies(tx))).map((m) => m.id), [EMPRESA_SOFIA]);
    assert.deepEqual((await como(USER_MIEMBRO_MARCA, (tx) => listCampaignsForInvoice(tx))).map((c) => c.id), [CAMPAIGN_SOFIA]);

    const porCampana = await como(USER_MIEMBRO_CAMPANA, (tx) => listInvoices(tx, { limit: 200 }));
    assert.ok(porCampana.rows.length >= 1 && porCampana.rows.every((r) => r.campaignId === CAMPAIGN_CAFE_ALMA));
    assert.deepEqual((await como(USER_MIEMBRO_CAMPANA, (tx) => listCampaignsForInvoice(tx))).map((c) => c.id), [CAMPAIGN_CAFE_ALMA]);
    // La marca de esa campaña sí se ve (camino campaign → company_link); la de Sofía no.
    assert.deepEqual((await como(USER_MIEMBRO_CAMPANA, (tx) => listCompanies(tx))).map((m) => m.id), [COMPANY_CAFE_ALMA]);
  });

  test('countLiveInvoicesInCurrency cuenta solo lo que el alcance ve', async () => {
    assert.equal(await como(USER_MIEMBRO_MARCA, (tx) => countLiveInvoicesInCurrency(tx, 'COP')), 1, 'con alcance a la marca de Sofía, solo su factura');
    const todo = await duena((tx) => countLiveInvoicesInCurrency(tx, 'COP'));
    const suyo = await miembro((tx) => countLiveInvoicesInCurrency(tx, 'COP'));
    assert.ok(todo - suyo >= 1, `la dueña cuenta al menos la factura de Sofía (${todo} vs ${suyo})`);
  });

  test('pagos y recordatorios siguen a su factura: con alcance a la marca de Sofía se ven; con alcance a Laura, no', async () => {
    assert.equal((await como(USER_MIEMBRO_MARCA, (tx) => getPayment(tx, PAYMENT_SOFIA)))?.id, PAYMENT_SOFIA);
    assert.deepEqual((await como(USER_MIEMBRO_MARCA, (tx) => listPayments(tx, INVOICE_SOFIA))).rows.map((p) => p.id), [PAYMENT_SOFIA]);
    const deLaMarca = await como(USER_MIEMBRO_MARCA, (tx) => listReminders(tx, { limit: 200 }));
    assert.deepEqual(deLaMarca.map((r) => r.id), [REMINDER_SOFIA]);
    assert.deepEqual(await miembro((tx) => listPayments(tx, INVOICE_SOFIA)), { rows: [], reservedTotal: '0.00', reserveRate: null });
    assert.ok(!(await miembro((tx) => listReminders(tx, { limit: 200 }))).some((r) => r.id === REMINDER_SOFIA));
    assert.ok(!(await miembro((tx) => listReceivables(tx, { limit: 200 }))).rows.some((r) => r.id === INVOICE_SOFIA));
    // El miembro no pudo sellar el recordatorio: sigue pendiente para la dueña.
    assert.equal(await miembro((tx) => markReminderSent(tx, REMINDER_SOFIA)), false);
    const suyo = (await duena((tx) => listReminders(tx, { invoiceId: INVOICE_SOFIA }))).find((r) => r.id === REMINDER_SOFIA);
    assert.equal(suyo?.sentAt, null);
  });

  test('los gastos son del espacio: nadie con alcance los ve, ni los de Laura', async () => {
    const todos = await duena((tx) => getExpenseMonth(tx));
    assert.ok(todos.rows.some((g) => g.id === EXPENSE_SOFIA), 'el escenario siembra un gasto este mes');
    for (const usuario of [USER_MIEMBRO, USER_MIEMBRO_MARCA, USER_MIEMBRO_CAMPANA]) {
      assert.equal(await como(usuario, (tx) => getExpense(tx, EXPENSE_SOFIA)), null);
      const mes = await como(usuario, (tx) => getExpenseMonth(tx));
      assert.deepEqual(mes.rows, []);
      assert.deepEqual(mes.byCategory, []);
      assert.equal(mes.totals.count, 0);
      assert.equal(mes.totals.total, '0.00');
      assert.equal(mes.otherCurrencyCount, 0);
    }
  });

  test('pagos de plataforma: por creadora; sin creadora o con alcance por marca o campaña, no se ven', async () => {
    const ids = (r: finanzas.ListPlatformPayoutsResult) => r.rows.map((p) => p.id);
    const deLaDuena = ids(await duena((tx) => listPlatformPayouts(tx)));
    assert.ok([PAYOUT_SOFIA, PAYOUT_SIN_CREADOR, PAYOUT_LAURA].every((id) => deLaDuena.includes(id)));
    const delMiembro = ids(await miembro((tx) => listPlatformPayouts(tx)));
    assert.ok(delMiembro.includes(PAYOUT_LAURA), 'el de Laura sí');
    assert.ok(!delMiembro.includes(PAYOUT_SOFIA) && !delMiembro.includes(PAYOUT_SIN_CREADOR), 'ni el de Sofía ni el que no es de nadie');
    assert.deepEqual(ids(await como(USER_MIEMBRO_MARCA, (tx) => listPlatformPayouts(tx))), []);
    assert.deepEqual(ids(await como(USER_MIEMBRO_CAMPANA, (tx) => listPlatformPayouts(tx))), []);

    // Los agregados: el mes pasado suma 666 666 para la dueña y 222 222 (solo Laura) para el miembro.
    const kDuena = await duena((tx) => getPlatformPayoutKpis(tx));
    const kMiembro = await miembro((tx) => getPlatformPayoutKpis(tx));
    assert.equal(kDuena.lastMonth, '666666.00');
    assert.equal(kMiembro.lastMonth, '222222.00');
    assert.equal((await como(USER_MIEMBRO_MARCA, (tx) => getPlatformPayoutKpis(tx))).lastMonth, null, 'un mes sin nada visible no vale cero');
    const mes = kDuena.lastMonthLabel;
    assert.equal((await duena((tx) => getPlatformPayoutMonths(tx))).find((m) => m.mes === mes)?.monto, '666666.00');
    assert.equal((await miembro((tx) => getPlatformPayoutMonths(tx))).find((m) => m.mes === mes)?.monto, '222222.00');
    assert.deepEqual(await como(USER_MIEMBRO_CAMPANA, (tx) => getPlatformPayoutMonths(tx)), []);

    // Escribir: el miembro carga los de Laura, pero no los de Sofía ni los «sin creadora»;
    // con alcance por marca no carga ninguno (un pago de plataforma no es de ninguna marca).
    const deLaura = await miembro((tx) => createPlatformPayout(tx, { ...payoutDeSofia('5000.00', 'manual'), creatorId: CREATOR_LAURA, periodStart: '2026-05-01', periodEnd: '2026-05-31' }));
    assert.equal(deLaura.payout?.creatorId, CREATOR_LAURA);
    await assert.rejects(miembro((tx) => createPlatformPayout(tx, { ...payoutDeSofia('5000.00', 'manual'), creatorId: null })), ScopeError);
    await assert.rejects(como(USER_MIEMBRO_MARCA, (tx) => importPlatformPayouts(tx, [payoutDeSofia('5000.00', 'csv_import')])), ScopeError);
  });

  test('flujo de caja: el miembro no recibe ni la factura, ni el negocio, ni los gastos, ni los pagos de plataforma de Sofía', async () => {
    const todo = await duena((tx) => getCashflowInputs(tx));
    const suyo = await miembro((tx) => getCashflowInputs(tx));
    assert.ok(todo.facturas.some((f) => f.id === INVOICE_SOFIA) && !suyo.facturas.some((f) => f.id === INVOICE_SOFIA));
    assert.ok(todo.negocios.some((d) => d.id === DEAL_SOFIA), 'el escenario siembra un negocio ganado de Sofía');
    assert.ok(!suyo.negocios.some((d) => d.id === DEAL_SOFIA));
    assert.ok(todo.gastos.some((g) => g.id === EXPENSE_SOFIA));
    assert.deepEqual(suyo.gastos, [], 'los gastos son del espacio: nadie con alcance los ve');
    // Los pagos de plataforma llegan agregados: el total de la ventana no incluye los 444 444 de Sofía y del «sin creadora».
    assert.equal(todo.otrosIngresos.total !== null && suyo.otrosIngresos.total !== null, true);
    assert.notEqual(todo.otrosIngresos.total, suyo.otrosIngresos.total);
    const marca = await como(USER_MIEMBRO_MARCA, (tx) => getCashflowInputs(tx));
    assert.deepEqual(marca.facturas.map((f) => f.id), [INVOICE_SOFIA]);
    assert.deepEqual(marca.negocios.map((d) => d.id), [DEAL_SOFIA]);
    assert.equal(marca.otrosIngresos.estimado, null, 'con alcance por marca no hay ningún pago de plataforma que promediar');
  });

  test('las escrituras de Finanzas rechazadas no dejan fila en gastos, pagos de plataforma, avisos, espacio ni bitácora', async () => {
    const antes = await duena(huellaFinanzas);
    for (const [fn, caso] of Object.entries(CASOS)) {
      if (caso === 'pura' || caso.miembro === 'nada') continue;
      await assert.rejects(miembro(caso.run), `${fn} debería rechazar al miembro`);
    }
    assert.equal(await miembro((tx) => markReminderSent(tx, REMINDER_SOFIA)), false);
    assert.deepEqual(await duena(huellaFinanzas), antes);
  });
}, sembrarFinanzas);
