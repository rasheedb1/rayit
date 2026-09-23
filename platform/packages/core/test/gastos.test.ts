import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIAS_GASTO, CATEGORIA_GASTO_IDS, RECURRENCIAS, RECURRENCIA_IDS,
  esCategoriaGasto, esRecurrencia, labelCategoria, labelRecurrencia, sumarMeses,
} from '../src/gastos.ts';

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

// -------------------------------------------------------------- meses

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
