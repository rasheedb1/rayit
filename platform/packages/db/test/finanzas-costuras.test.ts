/**
 * Las costuras de Finanzas con sus vecinos (cierre del módulo FIN).
 *
 * Cada historia tiene sus pruebas en finanzas.test.ts; estas miran lo
 * que ninguna de ellas ve sola: que lo que escribe una la lee la otra
 * con la cifra exacta. Van en un archivo aparte, con su PROPIA base
 * sembrada, porque finanzas.test.ts cobra facturas, cambia la
 * configuración y registra gastos, y aquí las cifras de cada semana
 * tienen que salir del seed 0003 intacto más lo que cada prueba hace.
 *
 *   - FIN-5 + FIN-2 + FIN-7 → FIN-6: el flujo suma los cobros esperados
 *     (lo que queda de cada factura tras un pago), resta los gastos
 *     recurrentes (con uno nuevo registrado hoy) y suma los ingresos de
 *     plataformas; las ocho semanas, cifra por cifra.
 *   - FIN-3 ↔ FIN-2: un pago mueve la factura de tramo de antigüedad o la
 *     saca del cobro, y la vista receivables no se desfasa de invoice.
 *   - FIN-8 → FIN-1: una factura nueva nace con los porcentajes y el plazo
 *     configurados, y cambiar la configuración no toca las viejas.
 *
 * FIN-8 → FIN-2 (la tasa del apartado) está en finanzas.test.ts, «cambiar
 * el porcentaje cambia la reserva de los pagos SIGUIENTES»; FIN-8 → FIN-4
 * en core/test/recordatorios.test.ts y worker/test/recordatorios.test.ts.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  compareDecimal,
  proyectarGastos,
  lunesDeLaSemana,
  mulRateHalfUp,
  projectCashflow,
  semanalDeMensual,
  sumarMeses,
  ultimoDiaDelMes,
  ultimoMesCerrado,
} from '@mc/core';
import {
  createExpense,
  createInvoice,
  createInvoiceFromCampaign,
  createPlatformPayout,
  getCashflowInputs,
  getExpenseMonth,
  getReserveState,
  getFinanceSettings,
  getInvoice,
  getReceivablesKpis,
  listPayoutPlatforms,
  listReceivables,
  recordPayment,
  updateExpense,
  updateFinanceSettings,
  type TextosFinanzas,
} from '../src/queries/finanzas.ts';
import { getDefaultTaxRate } from '../src/queries/cotizar/cotizacion.ts';
import {
  openTestDb, type TestDb,
  WORKSPACE_LAURA, CAMPAIGN_FRESKO, COMPANY_CAFE_ALMA, INVOICE_FV_2026_010,
} from './pglite.ts';

const INVOICE_FV_2026_007 = '00000003-0000-4000-8000-0000fac26007';
const INVOICE_FV_2026_011 = '00000003-0000-4000-8000-0000fac26011';

const TEXTOS: TextosFinanzas = {
  avisoPagoRecibido: (p) => ({ title: `Pago recibido · ${p.invoiceNumber}`, body: `${p.companyName} · ${p.amount}` }),
};

let t: TestDb;

before(async () => {
  t = await openTestDb();
}, { timeout: 300_000 });

after(async () => {
  await t?.close();
});

/** 'YYYY-MM' → su primer y su último día. */
function mesEntero(mes: string): { periodStart: string; periodEnd: string } {
  const [anio, m] = mes.split('-').map(Number) as [number, number];
  return { periodStart: `${mes}-01`, periodEnd: `${mes}-${String(ultimoDiaDelMes(anio, m)).padStart(2, '0')}` };
}

describe('costura FIN-5 + FIN-2 + FIN-7 → FIN-6: el flujo de ocho semanas, cifra por cifra', () => {
  test('un abono, un gasto recurrente nuevo y tres meses de AdSense entran cada uno en su semana', async () => {
    const antes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCashflowInputs(tx));
    const hoy = antes.today;

    await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      // FIN-2: abona 1 000 000 a FV-2026-010 (3 100 000, vence en 7 días).
      await recordPayment(tx, {
        invoiceId: INVOICE_FV_2026_010, amount: '1000000.00', receivedOn: hoy,
        method: 'transferencia', expectedPaidAmount: '0.00',
      }, TEXTOS);
      // FIN-5: una suscripción NUEVA, registrada hoy: entra al ritmo sin
      // esperar a que el mes cierre (serie nueva: software|figma).
      await createExpense(tx, {
        category: 'software', vendor: 'Figma', description: 'Figma Professional',
        amount: '520000', incurredOn: hoy, isRecurring: true, recurrence: 'monthly', deductible: true,
      });
      // FIN-7: 300 000 de AdSense en cada uno de los tres meses cerrados.
      const [adsense] = (await listPayoutPlatforms(tx)).filter((p) => /youtube|adsense/i.test(p.name));
      assert.ok(adsense, 'el catálogo trae la plataforma de YouTube');
      const ultimo = ultimoMesCerrado(hoy);
      for (const k of [0, 1, 2]) {
        const mes = sumarMeses(`${ultimo}-01`, -k).slice(0, 7);
        const r = await createPlatformPayout(tx, {
          platformId: adsense.id, ...mesEntero(mes), amount: '300000.00', currency: 'COP', source: 'manual',
        });
        assert.ok(r.payout, `el pago de ${mes} quedó escrito`);
      }
    });

    const i = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCashflowInputs(tx));
    const c = projectCashflow(i);

    // Las entradas de cada módulo, como las ve el flujo.
    assert.equal(c.gastoMensual, '4220000.00', '3 700 000 del seed (FIN-5) + 520 000 de la serie nueva');
    assert.equal(c.gastoSemanal, '973846.15');
    assert.equal(c.otrosIngresosMensual, '300000.00', 'FIN-7: el promedio de los tres meses cerrados');
    assert.equal(c.otrosIngresosSemanal, '69230.77');
    assert.equal(c.otrosIngresosSemanal, semanalDeMensual('300000.00'));
    assert.deepEqual(c.excluidos.vencidas, { count: 1, amount: '1100000.00' }, 'FV-2026-007 no se promete');

    // Dónde cae cada cobro: la semana (lunes a domingo) de su vencimiento.
    const lunes = lunesDeLaSemana(hoy);
    const semanaDe = (numero: string) => {
      const f = i.facturas.find((x) => x.number === numero);
      assert.ok(f, `${numero} está entre las facturas por cobrar`);
      return Math.floor((Date.parse(f.dueOn) - Date.parse(lunes)) / (7 * 86_400_000));
    };
    const s010 = semanaDe('FV-2026-010');
    const s011 = semanaDe('FV-2026-011');
    assert.ok(s010 !== s011);

    // Las cifras exactas de cada semana. Sin cobro: 69 230,77 − 973 846,15.
    // Con FV-2026-010: lo que queda tras el abono (2 100 000) y su 11 %.
    // Con FV-2026-011: 5 200 000 y su 11 %.
    const esperado = c.semanas.map((_, k) => {
      if (k === s010) return { cobros: '2100000.00', impuestos: '231000.00', neto: '964384.62' };
      if (k === s011) return { cobros: '5200000.00', impuestos: '572000.00', neto: '3723384.62' };
      return { cobros: '0.00', impuestos: '0.00', neto: '-904615.38' };
    });
    let acumulado = 0n;
    c.semanas.forEach((s, k) => {
      const e = esperado[k]!;
      assert.equal(s.inicio, addDays(lunes, k * 7));
      assert.equal(s.cobros, e.cobros, `cobros de la semana ${s.inicio}`);
      assert.equal(s.otrosIngresos, '69230.77', `otros ingresos de la semana ${s.inicio}`);
      assert.equal(s.gastos, '973846.15', `gastos de la semana ${s.inicio}`);
      assert.equal(s.impuestos, e.impuestos, `impuestos de la semana ${s.inicio}`);
      assert.equal(s.neto, e.neto, `neto de la semana ${s.inicio}`);
      acumulado += BigInt(e.neto.replace('.', ''));
      assert.equal(BigInt(s.acumulado.replace('.', '')), acumulado, `acumulado de la semana ${s.inicio}`);
    });
    // 6 × (−904 615,38) + 964 384,62 + 3 723 384,62
    assert.equal(c.proyectado, '-739923.04');
  });
});

describe('costura FIN-3 ↔ FIN-2: un pago mueve la factura en el cobro', () => {
  /** La vista receivables contra la tabla invoice: lo pendiente es total − pagado, siempre. */
  async function sinDesfase(): Promise<void> {
    const todas = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => [
      ...(await listReceivables(tx, { limit: 200 })).rows,
      ...(await listReceivables(tx, { bucket: 'pagada', limit: 200 })).rows,
    ]);
    for (const r of todas) {
      const f = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getInvoice(tx, r.id));
      assert.ok(f);
      assert.equal(r.paidAmount, f.paidAmount, `${r.number}: lo pagado`);
      assert.equal(r.status, f.status, `${r.number}: el estado`);
      const pendiente = (BigInt(f.total.replace('.', '')) - BigInt(f.paidAmount.replace('.', ''))).toString();
      assert.equal(BigInt(r.outstanding.replace('.', '')).toString(), pendiente, `${r.number}: lo pendiente`);
    }
  }

  test('pagar entera la vencida la saca de «vencida» y del cobro, y los KPI se mueven con ella', async () => {
    const antes = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => ({
      kpis: await getReceivablesKpis(tx),
      vencidas: (await listReceivables(tx, { bucket: 'vencida' })).rows,
    }));
    assert.deepEqual(antes.vencidas.map((r) => r.number), ['FV-2026-007']);

    const hoy = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCashflowInputs(tx))).today;
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      recordPayment(tx, {
        invoiceId: INVOICE_FV_2026_007, amount: '1100000.00', receivedOn: hoy,
        method: 'transferencia', expectedPaidAmount: '0.00',
      }, TEXTOS),
    );

    const despues = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => ({
      kpis: await getReceivablesKpis(tx),
      vencidas: (await listReceivables(tx, { bucket: 'vencida' })).rows,
      abiertas: (await listReceivables(tx)).rows,
      pagadas: (await listReceivables(tx, { bucket: 'pagada' })).rows,
    }));
    assert.deepEqual(despues.vencidas, [], 'ya no está vencida');
    assert.ok(!despues.abiertas.some((r) => r.id === INVOICE_FV_2026_007), 'ni en lo que hay que cobrar');
    assert.ok(despues.pagadas.some((r) => r.id === INVOICE_FV_2026_007 && r.status === 'paid'), 'está en «pagada»');
    assert.equal(despues.kpis.overdueCount, 0);
    // «0» y no «0.00»: la suma de getReceivablesKpis sin filas (FIN-3 §0.2).
    assert.equal(compareDecimal(despues.kpis.overdue, '0'), 0);
    assert.equal(despues.kpis.openCount, antes.kpis.openCount - 1);
    await sinDesfase();
  });

  test('un abono deja la factura en su tramo, en «partial», con lo que queda por cobrar', async () => {
    const antes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listReceivables(tx));
    const f011 = antes.rows.find((r) => r.id === INVOICE_FV_2026_011);
    assert.ok(f011);
    const hoy = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCashflowInputs(tx))).today;
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      recordPayment(tx, {
        invoiceId: INVOICE_FV_2026_011, amount: '200000.00', receivedOn: hoy,
        method: 'pse', expectedPaidAmount: f011.paidAmount,
      }, TEXTOS),
    );
    const despues = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listReceivables(tx));
    const ahora = despues.rows.find((r) => r.id === INVOICE_FV_2026_011);
    assert.ok(ahora, 'sigue en el cobro');
    assert.equal(ahora.status, 'partial');
    assert.equal(ahora.bucket, f011.bucket, 'el tramo lo decide el vencimiento, no el abono');
    assert.equal(ahora.outstanding, '5000000.00');
    await sinDesfase();
  });
});

describe('costura FIN-8 → FIN-1: la factura nueva nace con lo configurado', () => {
  test('IVA, retención y plazo salen de settings.finanzas; las facturas viejas no se tocan', async () => {
    const vieja = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getInvoice(tx, INVOICE_FV_2026_010));
    assert.ok(vieja);
    const base = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getFinanceSettings(tx));
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      updateFinanceSettings(tx, { settings: { ...base, ivaPct: '16', retencionPct: '10', plazoDias: 45 } }),
    );

    // A mano, sin porcentajes: los configurados.
    const aMano = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      createInvoice(tx, { companyId: COMPANY_CAFE_ALMA, subtotal: '1000000.00', issuedOn: '2026-10-01', dueOn: '2026-11-15' }),
    );
    assert.equal(aMano.tax, '160000.00', 'IVA 16 %');
    assert.equal(aMano.withholding, '100000.00', 'retención 10 %');

    // Desde una campaña (el «Facturar» de CAM-1): porcentajes y plazo.
    const desdeCampana = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const terms = await tx.query<{ d: number | null }>(
        'SELECT q.payment_terms_days AS d FROM campaign c LEFT JOIN quote q ON q.id = c.quote_id WHERE c.id = $1',
        [CAMPAIGN_FRESKO],
      );
      const inv = await createInvoiceFromCampaign(tx, CAMPAIGN_FRESKO, { issuedOn: '2026-10-01' });
      return { inv, plazo: terms.rows[0]?.d ?? null };
    });
    const { inv } = desdeCampana;
    assert.equal(inv.tax, mulRateHalfUp(inv.subtotal, '0.16'), 'IVA 16 % también desde la campaña');
    assert.equal(inv.withholding, mulRateHalfUp(inv.subtotal, '0.10'), 'retención 10 %');
    // El plazo de la cotización, si lo hay, gana: es lo que se le prometió a esa marca.
    assert.equal(inv.dueOn, addDays('2026-10-01', desdeCampana.plazo ?? 45));

    // Lo ya emitido no se mueve.
    const despues = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getInvoice(tx, INVOICE_FV_2026_010));
    assert.ok(despues);
    for (const campo of ['subtotal', 'tax', 'withholding', 'total', 'dueOn', 'issuedOn'] as const) {
      assert.equal(despues[campo], vieja[campo], `FV-2026-010.${campo}`);
    }
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => updateFinanceSettings(tx, { settings: base }));
  });
});

describe('costura COT → FIN-8: hoy son dos IVA, y guardar Finanzas no toca el de Cotizar', () => {
  test('el IVA de Finanzas no llega a Cotizar, ni lo borra: Cotizar sigue con settings.taxRate', async () => {
    // Estado que ve un creador que puso su IVA en Cotizar antes de FIN-8.
    await t.admin(`UPDATE workspace SET settings = settings || '{"taxRate": "0.19"}'::jsonb WHERE id = '${WORKSPACE_LAURA}';`);
    const base = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getFinanceSettings(tx));
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => updateFinanceSettings(tx, { settings: { ...base, ivaPct: '16' } }));

    const [finanzas, cotizar] = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => [
      await getFinanceSettings(tx),
      await getDefaultTaxRate(tx),
    ]);
    assert.equal(finanzas.ivaPct, '16', 'la factura nueva nace con 16 %');
    assert.equal(cotizar, '0.19', 'la cotización nueva sigue con el 19 % de settings.taxRate');
    // Cuando Rasheed unifique las dos fuentes (CIERRE-FIN.md), esta
    // prueba tiene que fallar y cambiarse a propósito, no por accidente.
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => updateFinanceSettings(tx, { settings: base }));
  });
});

describe('lo que encontró la revisión del cierre', () => {
  test('/finanzas/gastos?mes=0000-01 no revienta: cae en el mes de hoy del workspace', async () => {
    const hoy = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCashflowInputs(tx))).today;
    for (const raro of ['0000-01', '0001-12', '2026-13', 'abc']) {
      const mes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getExpenseMonth(tx, raro));
      assert.equal(mes.month, hoy.slice(0, 7), raro);
      assert.equal(mes.today, hoy, 'el día del workspace, el mismo que usa la proyección');
    }
  });

  test('una suscripción anual no entra al ritmo mensual, y dos sin proveedor no se funden en una', async () => {
    const antes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCashflowInputs(tx));
    const hoy = antes.today;
    const mensualAntes = proyectarGastos(antes).mensual;
    await t.admin(`
      INSERT INTO expense (id, workspace_id, category, vendor, description, amount, currency, incurred_on, is_recurring, recurrence, deductible)
      VALUES ('00000009-0000-4000-8000-0009a5aa0001', '${WORKSPACE_LAURA}', 'software', 'Anual SA', 'Licencia anual',
              1200000.00, 'COP', DATE '${hoy}', true, 'yearly', true);
    `);
    await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      for (const description of ['Canva sin proveedor', 'Notion sin proveedor']) {
        await createExpense(tx, {
          category: 'software', vendor: null, description, amount: '100000', incurredOn: hoy,
          isRecurring: true, recurrence: 'monthly', deductible: true,
        });
      }
    });
    const despues = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCashflowInputs(tx));
    assert.ok(!despues.gastos.some((g) => g.label === 'Licencia anual'), 'la anual no viaja al flujo');
    const p = proyectarGastos(despues);
    assert.equal(p.nuevasDelMes - proyectarGastos(antes).nuevasDelMes, 2, 'las dos sin proveedor son dos series');
    assert.equal(
      BigInt(p.mensual.replace('.', '')) - BigInt(mensualAntes.replace('.', '')),
      20000000n, // 200 000,00 en centavos
    );
    await t.admin(`DELETE FROM expense WHERE id = '00000009-0000-4000-8000-0009a5aa0001';`);
  });

  test('guardar un gasto sin cambios no reescribe la fila ni deja bitácora', async () => {
    const hoy = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCashflowInputs(tx))).today;
    const entrada = {
      category: 'equipo', vendor: 'Sin cambios SAS', description: 'Trípode', amount: '90000', incurredOn: hoy,
      isRecurring: false, deductible: true,
    };
    const g = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createExpense(tx, entrada));
    // xmin cambia con cada UPDATE: si sigue igual, la fila no se reescribió.
    const ver = () => t.db.withWorkspace(WORKSPACE_LAURA, async (tx) =>
      (await tx.query<{ x: string }>('SELECT xmin::text AS x FROM expense WHERE id = $1', [g.id])).rows[0]?.x);
    const antes = await ver();
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => updateExpense(tx, g.id, { ...entrada, amount: '90000.00' }));
    assert.equal(await ver(), antes, 'la misma versión de la fila: no hubo UPDATE');
    const lineas = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) =>
      (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'expense.updated'", [g.id])).rows[0]?.n);
    assert.equal(lineas, 0);
  });

  test('getReserveState dice lo mismo que hará el próximo cobro', async () => {
    const estado = () => t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getReserveState(tx));
    assert.equal(await estado(), 'configurada', 'el seed aparta el 11 %');
    const guardar = (v: string) =>
      t.admin(`UPDATE workspace SET settings = jsonb_set(settings, '{finanzas,reserva_pct}', '${v}'::jsonb) WHERE id = '${WORKSPACE_LAURA}';`);
    await t.admin(`UPDATE workspace SET settings = settings #- '{finanzas,reserva_pct}' WHERE id = '${WORKSPACE_LAURA}';`);
    assert.equal(await estado(), 'sin_configurar', 'sin nada guardado, el cobro no aparta aunque la pantalla sugiera 11 %');
    await guardar('"abc"');
    assert.equal(await estado(), 'invalida', 'un valor roto: el cobro fallará');
    await guardar('11');
    assert.equal(await estado(), 'configurada');
  });
});
