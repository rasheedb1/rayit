/**
 * La fórmula del tarifario (COT-1) y los totales de una cotización
 * (COT-3). Pura: sin base, sin red, sin reloj.
 *
 * Las entradas son de ejemplo, escritas a mano: 84.000 views por pieza
 * y el CPM de cocina en Colombia del seed (45.000 – 70.000 COP,
 * db/seed/0001_catalog.sql). Lo que sale con las views REALES del seed
 * (la mediana que calcula creator_baseline) lo comprueba
 * packages/db/test/cotizar.test.ts, que sí tiene base.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calcularItem, calcularPaquete, calcularTarifario, calcularTotalesCotizacion, precioPorViews, redondearAUnidad,
  plazoConIncluido, sumarPct, terminosDeModificadores, unidadDePrecio, validarRangoPrecio, MODIFICADORES_POR_DEFECTO,
  TarifaError, type EntradaTarifa,
} from '../src/tarifas.ts';

/** Un TikTok dedicado de ejemplo (84.000 views a mano, CPM de cocina del seed), sin modificadores. */
function tiktokDeEjemplo(over: Partial<EntradaTarifa> = {}): EntradaTarifa {
  return {
    deliverable: 'tiktok',
    platformId: 'tiktok',
    cantidad: 1,
    views: 84_000,
    viewsSource: 'baseline',
    viewsSample: 20,
    viewsCutHours: 168,
    cpmLow: '45000',
    cpmHigh: '70000',
    cpmSource: 'manual',
    nicheSlug: 'cocina',
    country: 'CO',
    ...over,
  };
}

// ------------------------------------------------------------ la fórmula

test('views ÷ 1000 × CPM, al centavo y mitad hacia arriba', () => {
  assert.equal(precioPorViews('45000', 84_000), '3780000.00');
  assert.equal(precioPorViews('70000', 84_000), '5880000.00');
  // Nada de perder los restos: 999 views no son «cero coma algo».
  assert.equal(precioPorViews('45000', 999), '44955.00');
  assert.equal(precioPorViews('45000', 0), '0.00');
  // El medio centavo sube.
  assert.equal(precioPorViews('1', 1), '0.00');
  assert.equal(precioPorViews('1', 5), '0.01');
  assert.throws(() => precioPorViews('45000', 1.5), TarifaError);
  assert.throws(() => precioPorViews('45000', -1), TarifaError);
});

test('con 84.000 views y el CPM de cocina del seed (45.000 – 70.000) sale el rango de la fórmula', () => {
  const item = calcularItem(tiktokDeEjemplo());
  assert.equal(item.priceLow, '3780000.00');
  assert.equal(item.priceHigh, '5880000.00');
  assert.equal(item.modificadorTotalPct, '0');
});

test('cambiar el CPM cambia el rango, y la explicación lo dice', () => {
  const antes = calcularItem(tiktokDeEjemplo());
  const despues = calcularItem(tiktokDeEjemplo({ cpmLow: '60000', cpmHigh: '90000' }));

  assert.equal(despues.priceLow, '5040000.00');
  assert.equal(despues.priceHigh, '7560000.00');
  assert.notEqual(antes.priceLow, despues.priceLow);

  const cpm = despues.pasos.find((p) => p.tipo === 'cpm');
  assert.deepEqual(cpm, {
    tipo: 'cpm', cpmLow: '60000.00', cpmHigh: '90000.00', fuente: 'manual',
    nicheSlug: 'cocina', country: 'CO', platformId: 'tiktok',
  });
  const total = despues.pasos.at(-1);
  assert.deepEqual(total, { tipo: 'total', low: '5040000.00', high: '7560000.00' });
});

test('la explicación lleva el paso de views con su procedencia', () => {
  const baseline = calcularItem(tiktokDeEjemplo()).pasos[0];
  assert.deepEqual(baseline, { tipo: 'views', views: 84_000, cantidad: 1, fuente: 'baseline', muestra: 20, corteHoras: 168 });

  // A mano: sin muestra ni corte, porque no los hay.
  const manual = calcularItem(tiktokDeEjemplo({ viewsSource: 'manual', viewsSample: undefined, viewsCutHours: undefined })).pasos[0];
  assert.deepEqual(manual, { tipo: 'views', views: 84_000, cantidad: 1, fuente: 'manual' });
});

test('la cantidad multiplica al final y deja su propio paso', () => {
  const historias = calcularItem(tiktokDeEjemplo({
    deliverable: 'historias', platformId: 'instagram', cantidad: 3, views: 12_000,
    cpmLow: '55000', cpmHigh: '85000',
  }));
  // Una historia: 12.000 ÷ 1000 × 55.000 = 660.000
  assert.deepEqual(historias.pasos.find((p) => p.tipo === 'base'), { tipo: 'base', low: '660000.00', high: '1020000.00' });
  assert.deepEqual(historias.pasos.find((p) => p.tipo === 'cantidad'), { tipo: 'cantidad', cantidad: 3, low: '1980000.00', high: '3060000.00' });
  assert.equal(historias.priceLow, '1980000.00');
  assert.equal(historias.priceHigh, '3060000.00');
});

test('un solo entregable no imprime el paso de cantidad', () => {
  assert.equal(calcularItem(tiktokDeEjemplo()).pasos.some((p) => p.tipo === 'cantidad'), false);
});

test('los modificadores se suman sobre la misma base: el orden no cambia el total', () => {
  const derechos = { id: 'derechos_uso_30d', pct: '0.35' };
  const exclusividad = { id: 'exclusividad_30d', pct: '0.50' };

  const a = calcularItem(tiktokDeEjemplo({ modificadores: [derechos, exclusividad] }));
  const b = calcularItem(tiktokDeEjemplo({ modificadores: [exclusividad, derechos] }));

  // 3.780.000 × (1 + 0,85) = 6.993.000
  assert.equal(a.priceLow, '6993000.00');
  assert.equal(a.priceHigh, '10878000.00');
  assert.equal(a.priceLow, b.priceLow);
  assert.equal(a.priceHigh, b.priceHigh);
  assert.equal(a.modificadorTotalPct, '0.85');

  // Cada paso muestra lo que APORTA, no el acumulado.
  assert.deepEqual(a.pasos.filter((p) => p.tipo === 'modificador'), [
    { tipo: 'modificador', id: 'derechos_uso_30d', pct: '0.35', low: '1323000.00', high: '2058000.00' },
    { tipo: 'modificador', id: 'exclusividad_30d', pct: '0.5', low: '1890000.00', high: '2940000.00' },
  ]);
});

test('el descuento del paquete se resta al final, sobre el total ya modificado', () => {
  const paquete = calcularItem(tiktokDeEjemplo({
    deliverable: 'paquete',
    modificadores: [{ id: 'derechos_uso_30d', pct: '0.35' }],
    descuentoPct: '0.10',
  }));
  // 3.780.000 × 1,35 = 5.103.000 · −10 % = 4.592.700
  assert.deepEqual(paquete.pasos.find((p) => p.tipo === 'descuento'), { tipo: 'descuento', pct: '0.1', low: '510300.00', high: '793800.00' });
  assert.equal(paquete.priceLow, '4592700.00');
});

test('un rango de CPM invertido es un error, no un precio al revés', () => {
  assert.throws(() => calcularItem(tiktokDeEjemplo({ cpmLow: '70000', cpmHigh: '45000' })), /RangoCpmInvertido|no puede ser mayor/);
  assert.throws(() => calcularItem(tiktokDeEjemplo({ cantidad: 0 })), TarifaError);
});

test('sumarPct trabaja en fracciones, no en porcentajes', () => {
  assert.equal(sumarPct([]), '0');
  assert.equal(sumarPct(['0.35', '0.5']), '0.85');
  assert.equal(sumarPct(['0.1', '0.2']), '0.3'); // el clásico que float rompe
  assert.throws(() => sumarPct(['35']), /Porcentaje inválido|35/);
  assert.throws(() => sumarPct(['-0.1']), TarifaError);
});

test('el catálogo de modificadores tiene ids únicos y fracciones válidas', () => {
  const ids = MODIFICADORES_POR_DEFECTO.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const m of MODIFICADORES_POR_DEFECTO) assert.match(m.pct, /^0\.\d{1,6}$/);
});

test('calcularTarifario respeta el orden de entrada', () => {
  const items = calcularTarifario([
    tiktokDeEjemplo(),
    tiktokDeEjemplo({ deliverable: 'reel', platformId: 'instagram', views: 61_000, cpmLow: '55000', cpmHigh: '85000' }),
  ]);
  assert.deepEqual(items.map((i) => i.deliverable), ['tiktok', 'reel']);
  assert.equal(items[1]!.priceLow, '3355000.00');
});

// -------------------------------------------------- totales de la cotización

test('subtotal, descuento, impuesto y total, en ese orden', () => {
  const t = calcularTotalesCotizacion({
    items: [
      { quantity: 1, unitPrice: '5000000' },
      { quantity: 3, unitPrice: '700000' },
    ],
    discount: '600000',
    taxRate: '0.19',
  });
  assert.deepEqual(t.lineTotals, ['5000000.00', '2100000.00']);
  assert.equal(t.subtotal, '7100000.00');
  assert.equal(t.discount, '600000.00');
  // (7.100.000 − 600.000) × 0,19 = 1.235.000
  assert.equal(t.tax, '1235000.00');
  assert.equal(t.total, '7735000.00');
});

test('sin impuesto ni descuento, el total es el subtotal', () => {
  const t = calcularTotalesCotizacion({ items: [{ quantity: 2, unitPrice: '1500000.50' }] });
  assert.equal(t.subtotal, '3000001.00');
  assert.equal(t.discount, '0.00');
  assert.equal(t.tax, '0.00');
  assert.equal(t.total, '3000001.00');
});

test('una cotización sin ítems vale cero, y el descuento no puede pasarse', () => {
  assert.equal(calcularTotalesCotizacion({ items: [] }).total, '0.00');
  assert.throws(() => calcularTotalesCotizacion({ items: [{ quantity: 1, unitPrice: '100' }], discount: '200' }), /DescuentoMayorQueSubtotal|mayor que el subtotal/);
  assert.throws(() => calcularTotalesCotizacion({ items: [{ quantity: 0, unitPrice: '100' }] }), TarifaError);
});

// ------------------------------------------------------ unidad de precio

test('en pesos el tarifario no lleva centavos; en dólares sí', () => {
  assert.equal(unidadDePrecio('COP'), '1.00');
  assert.equal(unidadDePrecio('cop'), '1.00');
  assert.equal(unidadDePrecio('USD'), '0.01');
  assert.equal(unidadDePrecio(undefined), '0.01');
  assert.equal(redondearAUnidad('7013344.50', '1.00'), '7013345.00');
  assert.equal(redondearAUnidad('7013344.49', '1.00'), '7013344.00');
  assert.equal(redondearAUnidad('7013344.49', '0.01'), '7013344.49');

  // 1.001 views × 45.000 da 45.045 exactos, pero con un modificador de
  // +35 % el aporte sería 15.765,75: en COP sube al peso.
  const cop = calcularItem(tiktokDeEjemplo({
    views: 1_001, currency: 'COP', modificadores: [{ id: 'derechos_uso_30d', pct: '0.35' }],
  }));
  const aporte = cop.pasos.find((p) => p.tipo === 'modificador');
  assert.equal(aporte?.tipo === 'modificador' && aporte.low, '15766.00');
  assert.match(cop.priceLow, /\.00$/);
  assert.match(cop.priceHigh, /\.00$/);

  const usd = calcularItem(tiktokDeEjemplo({
    views: 1_001, cpmLow: '10.37', cpmHigh: '12.41', currency: 'USD',
  }));
  assert.equal(usd.priceLow, '10.38');
});

// --------------------------------------------------------------- paquetes

test('un paquete suma sus entregables y descuenta al final', () => {
  const tiktok = calcularItem(tiktokDeEjemplo({ currency: 'COP' }));
  const paquete = calcularPaquete({
    componentes: [
      { deliverable: 'tiktok', cantidad: 1, priceLow: tiktok.priceLow, priceHigh: tiktok.priceHigh },
      { deliverable: 'historias', cantidad: 3, priceLow: '500000', priceHigh: '700000' },
    ],
    descuentoPct: '0.12',
    currency: 'COP',
  });
  // 3.780.000 + 1.500.000 = 5.280.000 → −12 % = 4.646.400
  assert.equal(paquete.priceLow, '4646400.00');
  // 5.880.000 + 2.100.000 = 7.980.000 → −12 % = 7.022.400
  assert.equal(paquete.priceHigh, '7022400.00');
  assert.deepEqual(paquete.pasos.map((p) => p.tipo), ['componente', 'componente', 'subtotal', 'descuento', 'total']);
  const desc = paquete.pasos.find((p) => p.tipo === 'descuento');
  assert.equal(desc?.tipo === 'descuento' && desc.pct, '0.12');
});

test('un paquete sin descuento no inventa un paso de descuento, y uno vacío no existe', () => {
  const p = calcularPaquete({ componentes: [{ deliverable: 'reel', cantidad: 2, priceLow: '100', priceHigh: '200' }], descuentoPct: '0' });
  assert.equal(p.priceLow, '200.00');
  assert.equal(p.priceHigh, '400.00');
  assert.equal(p.pasos.some((x) => x.tipo === 'descuento'), false);
  assert.throws(() => calcularPaquete({ componentes: [], descuentoPct: '0.1' }), TarifaError);
  assert.throws(() => calcularPaquete({ componentes: [{ deliverable: 'reel', cantidad: 1, priceLow: '1', priceHigh: '2' }], descuentoPct: '1.5' }), TarifaError);
});

test('en pesos el impuesto de la cotización tampoco lleva centavos', () => {
  const cop = calcularTotalesCotizacion({ items: [{ quantity: 1, unitPrice: '5195070' }], taxRate: '0.19', currency: 'COP' });
  assert.equal(cop.tax, '987063.00');
  assert.equal(cop.total, '6182133.00');
  const usd = calcularTotalesCotizacion({ items: [{ quantity: 1, unitPrice: '5195.07' }], taxRate: '0.19', currency: 'USD' });
  assert.equal(usd.tax, '987.06');
  // Sin moneda, como hasta ahora: al centavo.
  assert.equal(calcularTotalesCotizacion({ items: [{ quantity: 1, unitPrice: '5195070' }], taxRate: '0.19' }).tax, '987063.30');
});

// ------------------------------------------------ el rango escrito a mano

test('un rango a mano vale si está en orden y el alto no es cero', () => {
  assert.equal(validarRangoPrecio('1000000.00', '2000000.00'), null);
  assert.equal(validarRangoPrecio('1500000', '1500000'), null, 'un precio fijo (bajo = alto) es un rango válido');
  assert.equal(validarRangoPrecio('0', '500000.50'), null, 'el bajo puede ser cero');
});

test('un rango a mano al revés, vacío, en cero o que no es un número no vale', () => {
  assert.equal(validarRangoPrecio('9000000.00', '1000000.00'), 'invertido');
  assert.equal(validarRangoPrecio('', '1000000.00'), 'vacio');
  assert.equal(validarRangoPrecio('1000000.00', '  '), 'vacio');
  assert.equal(validarRangoPrecio(null, undefined), 'vacio');
  assert.equal(validarRangoPrecio('0', '0.00'), 'cero');
  assert.equal(validarRangoPrecio('-5', '10'), 'no_numero');
  assert.equal(validarRangoPrecio('1.000.000', '2000000'), 'no_numero');
  assert.equal(validarRangoPrecio('1.234', '2000000'), 'no_numero', 'más de dos decimales no es un precio');
});

test('los modificadores que son una condición llegan a «Lo acordado»: derechos y exclusividad, con sus días', () => {
  assert.deepEqual(terminosDeModificadores([]), { usageRightsDays: null, exclusivityDays: null });
  assert.deepEqual(terminosDeModificadores(['derechos_uso_30d', 'exclusividad_30d', 'entrega_express']), {
    usageRightsDays: 30,
    exclusivityDays: 30,
  });
  // Pauta pagada y entrega exprés no tienen campo propio en la cotización.
  assert.deepEqual(terminosDeModificadores(['uso_en_pauta_90d', 'entrega_express', 'inventado']), {
    usageRightsDays: null,
    exclusivityDays: null,
  });
  // Todo modificador del catálogo que tenga término es uno del catálogo.
  for (const id of ['derechos_uso_30d', 'exclusividad_30d']) {
    assert.ok(MODIFICADORES_POR_DEFECTO.some((m) => m.id === id), id);
  }
});

test('un plazo acordado sube hasta lo incluido y nunca baja', () => {
  assert.equal(plazoConIncluido(null, 30), 30);
  assert.equal(plazoConIncluido(10, 30), 30);
  assert.equal(plazoConIncluido(60, 30), 60);
  assert.equal(plazoConIncluido(null, null), null);
  assert.equal(plazoConIncluido(15, null), 15);
});
