import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIAS_GASTO, CATEGORIA_GASTO_IDS, RECURRENCIAS, RECURRENCIA_IDS,
  esCategoriaGasto, esRecurrencia, labelCategoria, labelRecurrencia,
  lunesDe, sumarMeses, primerDiaDelMes, ultimoDiaDelMes,
  proyectarGastosRecurrentes, seriesDeGastosRecurrentes, GastosEnVariasMonedas,
  SEMANAS_PROYECCION, type GastoRecurrente,
} from '../src/flujo-caja.ts';

// ------------------------------------------------------- listas cerradas

test('cada categoría y cada recurrencia tiene etiqueta en español, y la lista no repite ids', () => {
  for (const c of CATEGORIAS_GASTO) assert.ok(c.labelEs.length > 0, c.id);
  assert.equal(new Set(CATEGORIA_GASTO_IDS).size, CATEGORIAS_GASTO.length);
  assert.deepEqual([...CATEGORIA_GASTO_IDS], ['edicion', 'software', 'equipo', 'contabilidad', 'servicios', 'viajes', 'otros']);
  // Las seis del seed 0003 §7 están todas: una lista que las perdiera
  // dejaría las filas del seed fuera del formulario.
  for (const delSeed of ['edicion', 'software', 'equipo', 'contabilidad', 'servicios', 'viajes']) {
    assert.ok(esCategoriaGasto(delSeed), delSeed);
  }
  assert.deepEqual([...RECURRENCIA_IDS], ['monthly']);
  assert.equal(RECURRENCIAS[0]?.labelEs, 'Cada mes');
  assert.equal(esRecurrencia('weekly'), false, 'weekly todavía no está en el MVP');
});

test('una categoría desconocida se muestra tal cual, no se rompe', () => {
  assert.equal(labelCategoria('software'), 'Software y suscripciones');
  assert.equal(labelCategoria('importada-de-otro-sitio'), 'importada-de-otro-sitio');
  assert.equal(labelRecurrencia('monthly'), 'Cada mes');
  assert.equal(labelRecurrencia('yearly'), 'yearly');
});

// -------------------------------------------------------------- fechas

test('lunesDe devuelve el lunes de la semana, y el lunes es él mismo', () => {
  assert.equal(lunesDe('2026-09-23'), '2026-09-21', 'miércoles');
  assert.equal(lunesDe('2026-09-21'), '2026-09-21', 'lunes');
  assert.equal(lunesDe('2026-09-27'), '2026-09-21', 'domingo: el lunes anterior, no el siguiente');
  assert.equal(lunesDe('2026-01-01'), '2025-12-29', 'cruza el año');
});

test('sumarMeses cae al último día del mes que no tiene el día, y siempre cuenta desde el original', () => {
  assert.equal(sumarMeses('2026-01-31', 1), '2026-02-28', 'febrero de 28');
  assert.equal(sumarMeses('2024-01-31', 1), '2024-02-29', 'febrero bisiesto');
  assert.equal(sumarMeses('2026-01-31', 2), '2026-03-31', 'no 28-feb + 1 mes = 28-mar');
  assert.equal(sumarMeses('2026-01-31', 3), '2026-04-30');
  assert.equal(sumarMeses('2026-11-30', 1), '2026-12-30');
  assert.equal(sumarMeses('2026-12-15', 1), '2027-01-15', 'cruza el año');
  assert.equal(sumarMeses('2026-03-15', -1), '2026-02-15', 'hacia atrás');
  assert.throws(() => sumarMeses('2026-02-30', 1), /YYYY-MM-DD real/);
});

test('el primer y el último día del mes', () => {
  assert.equal(primerDiaDelMes('2026-09'), '2026-09-01');
  assert.equal(primerDiaDelMes('2026-09-17'), '2026-09-01');
  assert.equal(ultimoDiaDelMes('2026-09'), '2026-09-30');
  assert.equal(ultimoDiaDelMes('2026-02'), '2026-02-28');
  assert.equal(ultimoDiaDelMes('2024-02'), '2024-02-29');
  assert.equal(ultimoDiaDelMes('2026-12'), '2026-12-31');
  assert.throws(() => primerDiaDelMes('septiembre'), /YYYY-MM/);
});

// ---------------------------------------------------------- proyección

function gasto(over: Partial<GastoRecurrente> & Pick<GastoRecurrente, 'id' | 'amount' | 'incurredOn'>): GastoRecurrente {
  return {
    category: 'software',
    vendor: 'Adobe',
    description: null,
    currency: 'COP',
    recurrence: 'monthly',
    ...over,
  };
}

/** Los cinco recurrentes del seed 0003 §7, en su fila de septiembre. */
const SEED_SEPTIEMBRE: GastoRecurrente[] = [
  gasto({ id: 'e1', category: 'edicion', vendor: 'Mateo R. (freelance)', amount: '1800000.00', incurredOn: '2026-09-01' }),
  gasto({ id: 'e2', category: 'software', vendor: 'Adobe · CapCut · Notion · Canva', amount: '380000.00', incurredOn: '2026-09-01' }),
  gasto({ id: 'e3', category: 'equipo', vendor: 'Estudio La Loma', amount: '900000.00', incurredOn: '2026-09-01' }),
  gasto({ id: 'e4', category: 'contabilidad', vendor: 'Contadora (Diana P.)', amount: '400000.00', incurredOn: '2026-09-01' }),
  gasto({ id: 'e5', category: 'servicios', vendor: 'Claro', amount: '220000.00', incurredOn: '2026-09-01' }),
];

test('ocho semanas exactas desde el LUNES de la fecha dada', () => {
  const p = proyectarGastosRecurrentes(SEED_SEPTIEMBRE, '2026-09-23');
  assert.equal(SEMANAS_PROYECCION, 8);
  assert.equal(p.semanas.length, 8);
  assert.equal(p.desde, '2026-09-21', 'el lunes de la semana del miércoles 23');
  assert.equal(p.hasta, '2026-11-15', 'el domingo de la octava semana: 8 × 7 = 56 días');
  assert.equal(p.currency, 'COP');
  // Cada semana empieza siete días después de la anterior y termina el domingo.
  for (let i = 0; i < p.semanas.length; i++) {
    const s = p.semanas[i]!;
    assert.equal(s.desde, ['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09'][i]);
    assert.equal(new Date(`${s.hasta}T00:00:00Z`).getUTCDay(), 0, 'termina en domingo');
  }
});

test('«un gasto recurrente aparece proyectado en las ocho semanas siguientes» (el seed, 3,7 M al mes)', () => {
  const p = proyectarGastosRecurrentes(SEED_SEPTIEMBRE, '2026-09-23');
  // Los cinco caen el día 1: el 1 de octubre (semana 2) y el 1 de
  // noviembre (semana 6). El 1 de septiembre YA está registrado y no se
  // vuelve a proyectar.
  assert.deepEqual(p.semanas.map((s) => s.total), [
    '0.00', '3700000.00', '0.00', '0.00', '0.00', '3700000.00', '0.00', '0.00',
  ]);
  assert.equal(p.total, '7400000.00');
  const octubre = p.semanas[1]!;
  assert.equal(octubre.ocurrencias.length, 5);
  assert.ok(octubre.ocurrencias.every((o) => o.date === '2026-10-01'));
  assert.deepEqual(octubre.ocurrencias.map((o) => o.category).sort(), ['contabilidad', 'edicion', 'equipo', 'servicios', 'software']);
  assert.equal(octubre.ocurrencias[0]?.currency, 'COP');
  assert.ok(
    p.semanas.every((s) => s.ocurrencias.every((o) => o.expenseId.length > 0)),
    'cada ocurrencia dice de qué fila plantilla sale',
  );
});

test('las tres filas de la misma suscripción son UNA serie: no se triplica', () => {
  const tresMeses: GastoRecurrente[] = [
    gasto({ id: 'jul', amount: '380000.00', incurredOn: '2026-07-01', description: 'Suscripciones · julio' }),
    gasto({ id: 'ago', amount: '380000.00', incurredOn: '2026-08-01', description: 'Suscripciones · agosto' }),
    gasto({ id: 'sep', amount: '380000.00', incurredOn: '2026-09-01', description: 'Suscripciones · septiembre' }),
  ];
  const series = seriesDeGastosRecurrentes(tresMeses);
  assert.equal(series.length, 1);
  assert.equal(series[0]?.id, 'sep', 'la más reciente es la plantilla');

  const p = proyectarGastosRecurrentes(tresMeses, '2026-09-23');
  assert.equal(p.total, '760000.00', '380 000 × 2 ocurrencias, no × 6');
  assert.equal(p.semanas[1]?.ocurrencias.length, 1);
});

test('una serie que sube de precio se proyecta con el último monto', () => {
  const series = seriesDeGastosRecurrentes([
    gasto({ id: 'viejo', amount: '380000.00', incurredOn: '2026-08-01' }),
    gasto({ id: 'nuevo', amount: '420000.00', incurredOn: '2026-09-01' }),
  ]);
  assert.equal(series.length, 1, 'el monto no entra en la clave de la serie');
  assert.equal(series[0]?.amount, '420000.00');
});

test('dos proveedores distintos son dos series, aunque compartan categoría', () => {
  const series = seriesDeGastosRecurrentes([
    gasto({ id: 'a', vendor: 'Adobe', amount: '200000.00', incurredOn: '2026-09-01' }),
    gasto({ id: 'b', vendor: 'Notion', amount: '90000.00', incurredOn: '2026-09-01' }),
  ]);
  assert.equal(series.length, 2);
});

test('mes de 31 días: el 31 se proyecta el 28 de febrero y vuelve al 31 en marzo', () => {
  const alquiler = [gasto({ id: 'r', category: 'equipo', vendor: 'Estudio', amount: '900000.00', incurredOn: '2026-12-31' })];
  // Doce semanas desde el lunes 28 de diciembre de 2026: llegan hasta el
  // domingo 21 de marzo, así que entran enero y febrero, no marzo.
  const p = proyectarGastosRecurrentes(alquiler, '2026-12-31', 12);
  assert.equal(p.desde, '2026-12-28');
  assert.equal(p.hasta, '2027-03-21');
  const fechas = p.semanas.flatMap((s) => s.ocurrencias.map((o) => o.date));
  assert.deepEqual(fechas, ['2027-01-31', '2027-02-28'], 'febrero no tiene 31: cae al 28');
  assert.equal(p.total, '1800000.00');
  assert.deepEqual(p.semanas.map((s) => s.total), [
    '0.00', '0.00', '0.00', '0.00', '900000.00', '0.00',
    '0.00', '0.00', '900000.00', '0.00', '0.00', '0.00',
  ]);
});

test('febrero bisiesto: el 31 cae al 29', () => {
  const p = proyectarGastosRecurrentes([gasto({ id: 'r', amount: '100000.00', incurredOn: '2024-01-31' })], '2024-02-01', 5);
  const fechas = p.semanas.flatMap((s) => s.ocurrencias.map((o) => o.date));
  assert.deepEqual(fechas, ['2024-02-29']);
});

test('un gasto que empieza a mitad de la ventana solo aporta desde ahí', () => {
  const nuevo = [gasto({ id: 'n', category: 'contabilidad', vendor: 'Diana', amount: '400000.00', incurredOn: '2026-10-05' })];
  const p = proyectarGastosRecurrentes(nuevo, '2026-09-23');
  // La fila es del 5 de octubre (ya registrada); la primera repetición
  // es el 5 de noviembre, en la séptima semana.
  assert.deepEqual(p.semanas.map((s) => s.total), [
    '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '400000.00', '0.00',
  ]);
  assert.equal(p.semanas[6]?.ocurrencias[0]?.date, '2026-11-05');
  assert.equal(p.total, '400000.00');
});

test('lo que ya pasó esta semana no es una proyección', () => {
  // La plantilla cae el día 22; el lunes de la semana de hoy (23) es el
  // 21, así que el 22 de octubre entra y el 22 de septiembre no.
  const p = proyectarGastosRecurrentes([gasto({ id: 'x', amount: '100000.00', incurredOn: '2026-08-22' })], '2026-09-23');
  const fechas = p.semanas.flatMap((s) => s.ocurrencias.map((o) => o.date));
  // El 22 de noviembre queda fuera: la ventana termina el 15.
  assert.deepEqual(fechas, ['2026-10-22'], 'el 22 de septiembre ya pasó y no se proyecta');
  assert.equal(p.total, '100000.00');
});

test('una plantilla vieja no cuesta años de iteraciones y proyecta bien', () => {
  const p = proyectarGastosRecurrentes([gasto({ id: 'v', amount: '50000.00', incurredOn: '2019-03-10' })], '2026-09-23');
  const fechas = p.semanas.flatMap((s) => s.ocurrencias.map((o) => o.date));
  assert.deepEqual(fechas, ['2026-10-10', '2026-11-10']);
});

test('una fila sin recurrencia (un gasto puntual) no se proyecta', () => {
  const p = proyectarGastosRecurrentes([gasto({ id: 'p', amount: '890000.00', incurredOn: '2026-09-14', recurrence: null })], '2026-09-23');
  assert.equal(p.total, '0.00');
  assert.equal(p.currency, null);
  assert.equal(seriesDeGastosRecurrentes([gasto({ id: 'p', amount: '1.00', incurredOn: '2026-09-14', recurrence: null })]).length, 0);
});

test('una recurrencia que el MVP no conoce no se proyecta', () => {
  const p = proyectarGastosRecurrentes([gasto({ id: 'w', amount: '10000.00', incurredOn: '2026-09-01', recurrence: 'weekly' })], '2026-09-23');
  assert.equal(p.total, '0.00');
  assert.equal(p.currency, null, 'sin ninguna serie no hay moneda que declarar');
});

test('sin gastos: ocho semanas en cero y sin moneda, para que la pantalla lo explique', () => {
  const p = proyectarGastosRecurrentes([], '2026-09-23');
  assert.equal(p.semanas.length, 8);
  assert.deepEqual([...new Set(p.semanas.map((s) => s.total))], ['0.00']);
  assert.equal(p.total, '0.00');
  assert.equal(p.currency, null);
});

test('mezclar monedas lanza en vez de sumar peras con manzanas', () => {
  const mezcla = [
    gasto({ id: 'cop', amount: '380000.00', incurredOn: '2026-09-01' }),
    gasto({ id: 'usd', amount: '20.00', incurredOn: '2026-09-01', currency: 'USD', vendor: 'Figma' }),
  ];
  assert.throws(
    () => proyectarGastosRecurrentes(mezcla, '2026-09-23'),
    (e: unknown) => e instanceof GastosEnVariasMonedas && /COP, USD/.test(e.messageEs),
  );
});

test('la ventana se valida: ni cero semanas ni una fecha inventada', () => {
  assert.throws(() => proyectarGastosRecurrentes([], '2026-09-23', 0), /entero de 1 a 52/);
  assert.throws(() => proyectarGastosRecurrentes([], '2026-09-23', 1.5), /entero de 1 a 52/);
  assert.throws(() => proyectarGastosRecurrentes([], '2026-09-23', 53), /entero de 1 a 52/);
  assert.throws(() => proyectarGastosRecurrentes([], '23/09/2026'), /YYYY-MM-DD real/);
  assert.throws(() => proyectarGastosRecurrentes([], '2026-02-31'), /YYYY-MM-DD real/);
});

test('el resultado no depende del orden en que llegan las filas', () => {
  const a = proyectarGastosRecurrentes(SEED_SEPTIEMBRE, '2026-09-23');
  const b = proyectarGastosRecurrentes([...SEED_SEPTIEMBRE].reverse(), '2026-09-23');
  assert.deepEqual(a, b);
});
