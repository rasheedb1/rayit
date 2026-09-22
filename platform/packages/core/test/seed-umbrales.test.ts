/**
 * Los umbrales del producto viven en scoring.ts, pero el seed de la
 * demo (db/seed/0002_demo_ventas_metricas.sql) los repite a mano en
 * SQL: la línea base pide MIN_SAMPLE_FOR_BASELINE videos para ser
 * confiable y el puntaje clasifica con la escalera de outlierTier().
 *
 * Nada ataba las dos copias. Si alguien sube el mínimo de muestra a 10
 * o mueve el umbral de "good", el seed sigue puntuando con la regla
 * vieja, la verificación del seed pasa en verde —compara el seed
 * contra sí mismo— y la demo enseña etiquetas que el código del
 * producto ya no produce. Se descubre semanas después, delante de un
 * cliente.
 *
 * Esta prueba lee el SQL como texto y exige que los números que
 * aparecen en su sección 7 sean los que exporta scoring.ts. Es fea, y
 * es la única atadura posible entre TypeScript y SQL: falla el día del
 * cambio, no seis semanas más tarde.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AGE_CUTS_HOURS, MIN_SAMPLE_FOR_BASELINE, outlierTier } from '../src/scoring.ts';

const leer = (ruta: string) => readFileSync(new URL(ruta, import.meta.url), 'utf8');
const SEED = leer('../../../db/seed/0002_demo_ventas_metricas.sql');
const VERIFY = leer('../../../db/seed/verify/0002.sql');

/** La escalera de outlierTier(), con el nivel que le toca a cada umbral. */
const ESCALERA: Array<[number, string]> = [
  [5, 'breakout'],
  [2, 'outlier'],
  [1.2, 'good'],
  [0.7, 'normal'],
];

test('la escalera de la prueba es de verdad la de outlierTier()', () => {
  for (const [umbral, nivel] of ESCALERA) {
    assert.equal(outlierTier(umbral), nivel, `${umbral} debería ser ${nivel}`);
    assert.notEqual(outlierTier(umbral - 0.001), nivel, `${umbral} no es el borde de ${nivel}`);
  }
  assert.equal(outlierTier(ESCALERA[3]![0] - 0.001), 'under');
});

test('el seed pide la misma muestra mínima que MIN_SAMPLE_FOR_BASELINE', () => {
  // is_reliable de creator_baseline.
  assert.ok(
    SEED.includes(`count(*) >= ${MIN_SAMPLE_FOR_BASELINE}`),
    `el seed debería escribir count(*) >= ${MIN_SAMPLE_FOR_BASELINE} al calcular is_reliable`
  );
  // versusMedian(): sin muestra suficiente, null y no cero.
  const muestras = [...SEED.matchAll(/sample_size\s*>=\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(muestras.length >= 4, 'el seed debería mirar sample_size al puntuar');
  for (const n of muestras) assert.equal(n, MIN_SAMPLE_FOR_BASELINE);
});

test('el CASE del seed usa los cuatro umbrales de outlierTier()', () => {
  for (const [umbral, nivel] of ESCALERA) {
    const enElCase = new RegExp(`>=\\s*${umbral}\\s+THEN\\s+'${nivel}'`);
    assert.match(SEED, enElCase, `falta «>= ${umbral} THEN '${nivel}'» en el seed`);
  }
  // is_outlier es el mismo umbral que 'outlier', no una constante suelta.
  assert.ok(
    SEED.includes(`s.views_vs >= ${ESCALERA[1]![0]}, false`),
    'is_outlier debería salir del mismo umbral que el nivel outlier'
  );
});

test('la verificación del seed clasifica con esos mismos umbrales', () => {
  for (const [umbral, nivel] of ESCALERA) {
    const enElCase = new RegExp(`>=\\s*${umbral}\\s+THEN\\s+'${nivel}'`);
    assert.match(VERIFY, enElCase, `falta «>= ${umbral} THEN '${nivel}'» en verify/0002.sql`);
  }
});

test('el seed calcula la línea base en los cortes de AGE_CUTS_HOURS', () => {
  const lista = AGE_CUTS_HOURS.map((h) => `(${h})`).join(', ');
  assert.ok(
    SEED.includes(`(VALUES ${lista}) AS c(cut)`),
    `el seed debería recorrer los cortes ${lista}`
  );
  for (const h of AGE_CUTS_HOURS) {
    assert.ok(
      SEED.includes(`interval '${h} hours'`),
      `falta el corte de ${h} h al elegir el mayor corte alcanzado`
    );
  }
});
