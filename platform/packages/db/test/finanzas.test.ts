import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  hoyEnZona,
  InvalidTransition,
  InvoiceNotPayable,
  InvoicePaymentConflict,
  mulRateHalfUp,
  PaymentDateInFuture,
  PaymentExceedsOutstanding,
  pctToRate,
  projectCashflow,
  reservePeriod,
  TaxReserveRateInvalid,
  type Cashflow,
  type PaymentMethod,
} from '@mc/core';
import {
  countInvoicesInOtherCurrency,
  createInvoice,
  createInvoiceFromCampaign,
  getCashflowInputs,
  getFinanceSettings,
  getInvoice,
  getReceivablesKpis,
  InvoiceNotFound,
  listCampaignsForInvoice,
  listCompanies,
  listInvoices,
  listPayments,
  listReceivables,
  RECEIVABLE_BUCKETS,
  recordPayment,
  transitionInvoice,
  updateFinanceSettings,
  type ReceivableRow,
  type TextosFinanzas,
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

describe('FIN-3 · cuentas por cobrar (vista receivables)', () => {
  const laura = <T,>(fn: (tx: Parameters<Parameters<typeof t.db.withWorkspace>[1]>[0]) => Promise<T>) =>
    t.db.withWorkspace(WORKSPACE_LAURA, fn);

  test('sin filtro devuelve las 3 abiertas del seed, con su campaña y su mora', async () => {
    const { rows, nextCursor } = await laura((tx) => listReceivables(tx));
    assert.equal(rows.length, 3);
    assert.equal(nextCursor, null);

    const porNumero = Object.fromEntries(rows.map((r) => [r.number, r]));
    const vencida = porNumero['FV-2026-007'];
    assert.equal(vencida?.companyName, 'Hogar Lindo');
    assert.equal(vencida?.campaignName, '3 historias · jun');
    assert.equal(vencida?.bucket, 'vencida');
    assert.equal(vencida?.daysOverdue, 41, 'vencida hace 41 días, como el mock');
    assert.equal(vencida?.outstanding, '1100000.00');
    assert.equal(vencida?.status, 'sent', 'overdue no se persiste');

    assert.equal(porNumero['FV-2026-010']?.bucket, 'vence_pronto');
    assert.equal(porNumero['FV-2026-010']?.daysOverdue, -7, 'vence en 7 días');
    assert.equal(porNumero['FV-2026-011']?.bucket, 'al_dia');
    assert.equal(porNumero['FV-2026-011']?.daysOverdue, -23);

    // El KPI «Por cobrar» del mock: 9,4 M en tres facturas. La tabla y el
    // KPI leen la misma vista, así que tienen que sumar lo mismo.
    const centavos = rows.reduce((acc, r) => acc + BigInt(r.outstanding.replace('.', '')), 0n);
    assert.equal(centavos, 940000000n, '9 400 000,00');
    const kpis = await laura((tx) => getReceivablesKpis(tx));
    assert.equal(kpis.outstanding, '9400000.00');
    assert.equal(kpis.openCount, rows.length);
  });

  test('la forma de la fila es la que espera la pantalla: si la vista cambia, esto falla', async () => {
    const { rows } = await laura((tx) => listReceivables(tx, { bucket: 'vencida' }));
    const fila = rows[0];
    assert.ok(fila);
    assert.deepEqual(
      Object.keys(fila).sort(),
      [
        'bucket', 'campaignId', 'campaignName', 'companyId', 'companyName', 'currency',
        'daysOverdue', 'dueOn', 'id', 'number', 'outstanding', 'paidAmount', 'status', 'total',
      ],
      'ni una columna de más ni de menos',
    );
    // Los tipos de verdad, no los de TypeScript: el dinero es texto y
    // los días son un número. Un driver que devolviera numeric como
    // number, o date como Date, rompe aquí y no en la pantalla.
    assert.equal(typeof fila.outstanding, 'string');
    assert.equal(typeof fila.total, 'string');
    assert.equal(typeof fila.paidAmount, 'string');
    assert.equal(typeof fila.daysOverdue, 'number');
    assert.match(fila.dueOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(RECEIVABLE_BUCKETS.includes(fila.bucket));
    // Ningún bigserial cruza a la web (CIM-2 §3): la vista no trae ninguno.
    assert.equal('rank' in fila, false);
  });

  test('cada bucket por su cuenta, y «pagada» solo si se pide', async () => {
    const conteo = async (bucket: ReceivableRow['bucket']) =>
      (await laura((tx) => listReceivables(tx, { bucket }))).rows;

    const vencidas = await conteo('vencida');
    assert.equal(vencidas.length, 1);
    assert.equal(vencidas[0]?.number, 'FV-2026-007');
    assert.equal((await conteo('vence_pronto')).length, 1);
    assert.equal((await conteo('al_dia')).length, 1);

    const pagadas = await conteo('pagada');
    assert.equal(pagadas.length, 14, 'seis de 2025 y ocho de 2026');
    assert.equal(pagadas.every((r) => r.status === 'paid' && r.outstanding === '0.00'), true);

    // Sin bucket NO salen las pagadas: la pantalla de cobro no las lista.
    const abiertas = await laura((tx) => listReceivables(tx));
    assert.equal(abiertas.rows.some((r) => r.bucket === 'pagada'), false);

    // Y los borradores y las anuladas no están en ningún bucket: la
    // vista los excluye. Esa es la diferencia con /finanzas/facturas.
    const todos = (await Promise.all(RECEIVABLE_BUCKETS.map(conteo))).flat();
    assert.equal(todos.some((r) => r.status === 'draft' || r.status === 'void'), false);
    const archivo = await laura((tx) => listInvoices(tx, { limit: 200 }));
    assert.ok(archivo.rows.length >= todos.length, 'el archivo es al menos tan grande');
  });

  test('el orden es el de cobro: lo vencido primero, y dentro lo más viejo', async () => {
    const { rows } = await laura((tx) => listReceivables(tx));
    assert.deepEqual(
      rows.map((r) => r.number),
      ['FV-2026-007', 'FV-2026-010', 'FV-2026-011'],
      'vencida → vence pronto → al día (al revés que el mock, a propósito)',
    );

    // Con las pagadas incluidas, el criterio dentro del grupo es
    // due_on ascendente, que es days_overdue descendente.
    const pagadas = await laura((tx) => listReceivables(tx, { bucket: 'pagada' }));
    for (let i = 1; i < pagadas.rows.length; i++) {
      const previo = pagadas.rows[i - 1];
      const actual = pagadas.rows[i];
      assert.ok(previo && actual);
      assert.ok(previo.dueOn <= actual.dueOn, 'due_on ascendente');
      assert.ok(previo.daysOverdue >= actual.daysOverdue, 'y por tanto days_overdue descendente');
    }
  });

  test('el buscador encuentra por empresa y por número, desde el tercer carácter', async () => {
    const porEmpresa = await laura((tx) => listReceivables(tx, { q: 'Hogar' }));
    assert.deepEqual(porEmpresa.rows.map((r) => r.number), ['FV-2026-007']);

    const minusculas = await laura((tx) => listReceivables(tx, { q: 'hogar lindo' }));
    assert.deepEqual(minusculas.rows.map((r) => r.number), ['FV-2026-007']);

    const porNumero = await laura((tx) => listReceivables(tx, { q: '2026-011' }));
    assert.deepEqual(porNumero.rows.map((r) => r.number), ['FV-2026-011']);

    // Con una o dos letras no filtra: devuelve la lista entera y lo dice
    // la pantalla, no una lista recortada al azar.
    const corta = await laura((tx) => listReceivables(tx, { q: 'ho' }));
    assert.equal(corta.rows.length, 3);

    // Un comodín de LIKE es texto, no un patrón: si no se escapara,
    // '%' devolvería las tres y parecería que el filtro no sirve.
    const comodin = await laura((tx) => listReceivables(tx, { q: '%%%' }));
    assert.equal(comodin.rows.length, 0);

    // El filtro por bucket y la búsqueda se acumulan.
    const juntos = await laura((tx) => listReceivables(tx, { bucket: 'al_dia', q: 'Hogar' }));
    assert.equal(juntos.rows.length, 0);
  });

  test('la paginación no salta ni repite filas', async () => {
    const enteras = await laura((tx) => listReceivables(tx, { bucket: 'pagada', limit: 200 }));
    const numeros: string[] = [];
    let cursor: string | null = null;
    for (let pagina = 0; pagina < 10; pagina++) {
      const r: Awaited<ReturnType<typeof listReceivables>> = await laura((tx) =>
        listReceivables(tx, { bucket: 'pagada', limit: 3, cursor }),
      );
      numeros.push(...r.rows.map((x) => x.number));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    assert.equal(cursor, null, 'termina');
    assert.deepEqual(numeros, enteras.rows.map((r) => r.number), 'mismo orden, sin huecos ni repetidos');
    assert.equal(new Set(numeros).size, numeros.length);

    await assert.rejects(
      laura((tx) => listReceivables(tx, { cursor: 'no-es-un-cursor' })),
      /cursor de paginación/,
    );
  });

  test('desde otro workspace no hay ni una fila, ni con bucket ni con búsqueda', async () => {
    const vacio = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => listReceivables(tx));
    assert.deepEqual(vacio.rows, []);
    assert.equal(vacio.nextCursor, null);
    for (const bucket of RECEIVABLE_BUCKETS) {
      const r = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => listReceivables(tx, { bucket }));
      assert.deepEqual(r.rows, [], `bucket ${bucket}`);
    }
    const buscando = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => listReceivables(tx, { q: 'Hogar' }));
    assert.deepEqual(buscando.rows, [], 'la búsqueda no es una rendija a otro workspace');

    // Y los KPIs no inventan una cifra: cero facturas, y lo que de
    // verdad se desconoce (la tasa de reserva, la comparación con el
    // año anterior) viaja como null, no como 0.
    const kpis = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => getReceivablesKpis(tx));
    assert.equal(kpis.openCount, 0);
    assert.equal(kpis.overdueCount, 0);
    assert.equal(kpis.taxRate, null);
    assert.equal(kpis.collectedDelta, null);
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
    assert.equal(salida.previousCurrency, 'COP', 'sin cambiar la moneda, la anterior es la misma');
    // La función no devuelve ningún id de audit_log (CIM-2 §3).
    assert.deepEqual(
      Object.keys(salida).sort(),
      ['currency', 'invoicesInOtherCurrency', 'previousCurrency', 'settings'],
    );

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
    assert.equal(salida.previousCurrency, 'COP', 'la anterior vuelve: es la moneda en la que están esas facturas');
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
    assert.equal(vuelta.previousCurrency, 'MXN');
    assert.equal(vuelta.invoicesInOtherCurrency, 0);
    const ws = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getWorkspaceSettings(tx));
    assert.equal(ws.currency, 'COP');
  });

  test('un guardado que NO toca la moneda no saca el aviso, aunque haya facturas en otra', async () => {
    const base = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getFinanceSettings(tx));

    // Escenario: el workspace pasa a MXN y sus facturas siguen en COP.
    // Sin la guardia, cualquier guardado POSTERIOR volvería a sacar el
    // aviso —y etiquetado con previousCurrency, que ya es MXN: nombraría
    // la moneda en la que esas facturas NO están—.
    //
    // Todo se mide primero y se restaura la moneda ANTES de afirmar
    // nada: una aserción que falla a mitad dejaría el workspace en MXN y
    // tumbaría las pruebas siguientes, que es justo lo que pasó la
    // primera vez que se escribió.
    const cambio = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      updateFinanceSettings(tx, { settings: base, currency: 'MXN' }),
    );
    const soloElIva = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      updateFinanceSettings(tx, { settings: { ...base, ivaPct: '16' }, currency: 'MXN' }),
    );
    const sinMoneda = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      updateFinanceSettings(tx, { settings: base }),
    );
    // Las de COP siguen ahí: nadie las convirtió. El número exacto
    // depende de cuántas hayan creado las pruebas de arriba, así que se
    // compara con la cuenta real, no con una constante.
    const enCop = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => countInvoicesInOtherCurrency(tx, 'MXN'));

    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => updateFinanceSettings(tx, { settings: base, currency: 'COP' }));

    assert.ok(enCop > 0, 'hay facturas en COP que el cambio de moneda dejó atrás');
    assert.equal(cambio.invoicesInOtherCurrency, enCop, 'el cambio de moneda sí avisa, y de todas');
    assert.equal(soloElIva.previousCurrency, 'MXN');
    assert.equal(soloElIva.invoicesInOtherCurrency, 0, 'la moneda no cambió: no hay nada que advertir');
    assert.equal(sinMoneda.currency, 'MXN', 'sin moneda se conserva la que había');
    assert.equal(sinMoneda.invoicesInOtherCurrency, 0);

    const final = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getWorkspaceSettings(tx));
    assert.equal(final.currency, 'COP', 'la prueba deja el workspace como lo encontró');
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
