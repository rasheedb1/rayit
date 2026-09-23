import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidTransition } from '@mc/core';
import {
  createInvoice,
  createInvoiceFromCampaign,
  getInvoice,
  getReceivablesKpis,
  listCampaignsForInvoice,
  listCompanies,
  listInvoices,
  listReceivables,
  transitionInvoice,
  InvoiceNotFound,
  RECEIVABLE_BUCKETS,
  type ReceivableRow,
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
