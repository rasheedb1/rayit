/**
 * ACC-6 · Alcance en queries/finanzas.ts: un miembro con alcance a Laura
 * no ve las facturas, los pagos ni la marca de Sofía en NINGUNA función
 * exportada, y no puede facturar nada de Sofía. Ver test/alcance.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as finanzas from '../src/queries/finanzas.ts';
import { ScopeError } from '../src/scope.ts';
import { CAMPAIGN_CAFE_ALMA, COMPANY_CAFE_ALMA } from './pglite.ts';
import {
  CAMPAIGN_LAURA_PRUEBA, CAMPAIGN_SOFIA, definirPruebasDeAlcance, EMPRESA_SOFIA, INVOICE_SOFIA, QUOTE_SOFIA, USER_MIEMBRO_CAMPANA,
  USER_MIEMBRO_MARCA, type CasoDeAlcance,
} from './alcance.ts';

const {
  listInvoices, getInvoice, listCompanies, listCampaignsForInvoice, getReceivablesKpis, createInvoice, transitionInvoice,
  createInvoiceFromCampaign, InvoiceNotFound,
} = finanzas;

const noExiste = (e: unknown) => e instanceof Error && /no existe en este workspace/.test(e.message);

const CASOS: Record<string, CasoDeAlcance> = {
  listInvoices: { run: (tx) => listInvoices(tx, { limit: 200 }), duena: 'nombra', miembro: 'nada' },
  getInvoice: { run: (tx) => getInvoice(tx, INVOICE_SOFIA), duena: 'nombra', miembro: 'nada' },
  listCompanies: { run: (tx) => listCompanies(tx), duena: 'nombra', miembro: 'nada' },
  listCampaignsForInvoice: { run: (tx) => listCampaignsForInvoice(tx), duena: 'nombra', miembro: 'nada' },
  // Los KPI no llevan ids: el control es que la dueña suma más (prueba propia, abajo).
  getReceivablesKpis: { run: (tx) => getReceivablesKpis(tx), duena: 'pasa', miembro: 'nada' },
  createInvoice: {
    run: (tx) => createInvoice(tx, { companyId: EMPRESA_SOFIA, campaignId: CAMPAIGN_SOFIA, subtotal: '100000.00', issuedOn: '2026-09-20', dueOn: '2026-10-20' }),
    duena: 'nombra',
    miembro: { rechazaSi: noExiste },
  },
  transitionInvoice: { run: (tx) => transitionInvoice(tx, INVOICE_SOFIA, 'void'), duena: 'nombra', miembro: { rechaza: InvoiceNotFound } },
  createInvoiceFromCampaign: { run: (tx) => createInvoiceFromCampaign(tx, CAMPAIGN_SOFIA), duena: 'nombra', miembro: { rechazaSi: noExiste } },
};

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
});
