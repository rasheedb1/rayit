/**
 * La fórmula del tarifario (COT-1) y los totales de una cotización
 * (COT-3). Pura: sin base, sin red, sin reloj.
 *
 * Los números del mock que se comprueban aquí son los de la creadora
 * del seed: 84.000 views de mediana en TikTok y el CPM de cocina en
 * Colombia (45.000 – 70.000 COP, db/seed/0001_catalog.sql).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calcularItem, calcularTarifario, calcularTotalesCotizacion, precioPorViews, sumarPct,
  MODIFICADORES_POR_DEFECTO, TarifaError, type EntradaTarifa,
} from '../src/tarifas.ts';

/** TikTok dedicado de la creadora del seed, sin modificadores. */
function tiktokDelSeed(over: Partial<EntradaTarifa> = {}): EntradaTarifa {
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

test('con las views del seed salen los rangos del mock', () => {
  const item = calcularItem(tiktokDelSeed());
  assert.equal(item.priceLow, '3780000.00');
  assert.equal(item.priceHigh, '5880000.00');
  assert.equal(item.modificadorTotalPct, '0');
});

test('cambiar el CPM cambia el rango, y la explicación lo dice', () => {
  const antes = calcularItem(tiktokDelSeed());
  const despues = calcularItem(tiktokDelSeed({ cpmLow: '60000', cpmHigh: '90000' }));

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
  const baseline = calcularItem(tiktokDelSeed()).pasos[0];
  assert.deepEqual(baseline, { tipo: 'views', views: 84_000, cantidad: 1, fuente: 'baseline', muestra: 20, corteHoras: 168 });

  // A mano: sin muestra ni corte, porque no los hay.
  const manual = calcularItem(tiktokDelSeed({ viewsSource: 'manual', viewsSample: undefined, viewsCutHours: undefined })).pasos[0];
  assert.deepEqual(manual, { tipo: 'views', views: 84_000, cantidad: 1, fuente: 'manual' });
});

test('la cantidad multiplica al final y deja su propio paso', () => {
  const historias = calcularItem(tiktokDelSeed({
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
  assert.equal(calcularItem(tiktokDelSeed()).pasos.some((p) => p.tipo === 'cantidad'), false);
});

test('los modificadores se suman sobre la misma base: el orden no cambia el total', () => {
  const derechos = { id: 'derechos_uso_30d', pct: '0.35' };
  const exclusividad = { id: 'exclusividad_30d', pct: '0.50' };

  const a = calcularItem(tiktokDelSeed({ modificadores: [derechos, exclusividad] }));
  const b = calcularItem(tiktokDelSeed({ modificadores: [exclusividad, derechos] }));

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
  const paquete = calcularItem(tiktokDelSeed({
    deliverable: 'paquete',
    modificadores: [{ id: 'derechos_uso_30d', pct: '0.35' }],
    descuentoPct: '0.10',
  }));
  // 3.780.000 × 1,35 = 5.103.000 · −10 % = 4.592.700
  assert.deepEqual(paquete.pasos.find((p) => p.tipo === 'descuento'), { tipo: 'descuento', pct: '0.1', low: '510300.00', high: '793800.00' });
  assert.equal(paquete.priceLow, '4592700.00');
});

test('un rango de CPM invertido es un error, no un precio al revés', () => {
  assert.throws(() => calcularItem(tiktokDelSeed({ cpmLow: '70000', cpmHigh: '45000' })), /RangoCpmInvertido|no puede ser mayor/);
  assert.throws(() => calcularItem(tiktokDelSeed({ cantidad: 0 })), TarifaError);
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
    tiktokDelSeed(),
    tiktokDelSeed({ deliverable: 'reel', platformId: 'instagram', views: 61_000, cpmLow: '55000', cpmHigh: '85000' }),
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
