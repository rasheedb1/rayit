import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  median, versusMedian, outlierTier, snapshotAtCut,
  summarizeRetention, traitLift, MIN_SAMPLE_FOR_BASELINE,
  medianOf, percentileOf, interactionsOf, engagementRate, savesPer1k, isOutlier,
} from '../src/scoring.ts';

test('la mediana ignora el video viral que distorsiona el promedio', () => {
  const views = [30_000, 32_000, 35_000, 38_000, 40_000, 2_000_000];
  assert.equal(median(views), 36_500);
});

test('sin muestra suficiente no se inventa un puntaje', () => {
  assert.equal(versusMedian(100_000, 40_000, MIN_SAMPLE_FOR_BASELINE - 1), null);
  assert.equal(versusMedian(100_000, 40_000, MIN_SAMPLE_FOR_BASELINE), 2.5);
});

test('los tramos de outlier', () => {
  assert.equal(outlierTier(6), 'breakout');
  assert.equal(outlierTier(2), 'outlier');
  assert.equal(outlierTier(1.3), 'good');
  assert.equal(outlierTier(0.9), 'normal');
  assert.equal(outlierTier(0.4), 'under');
  assert.equal(outlierTier(null), null);
});

test('el corte de edad toma el snapshot más reciente sin pasarse', () => {
  const snaps = [{ ageHours: 6 }, { ageHours: 22 }, { ageHours: 30 }];
  assert.deepEqual(snapshotAtCut(snaps, 24), { ageHours: 22 });
  assert.equal(snapshotAtCut([{ ageHours: 50 }], 24), null);
});

test('el resumen de retención encuentra la caída que hay que arreglar', () => {
  const curve = [
    { s: 0, p: 1.0 }, { s: 1, p: 0.88 }, { s: 2, p: 0.81 }, { s: 3, p: 0.77 },
    { s: 4, p: 0.74 }, { s: 5, p: 0.71 }, { s: 6, p: 0.68 }, { s: 7, p: 0.37 },
    { s: 8, p: 0.34 }, { s: 9, p: 0.31 },
  ];
  const r = summarizeRetention(curve);
  assert.equal(r.retention3s, 0.77);
  assert.equal(r.biggestDropAt, 6, 'la peor caída empieza en el segundo 6');
  assert.equal(r.halfAt, 7, 'la mitad de la audiencia se va en el segundo 7');
  assert.equal(r.fullWatchRate, 0.31);
});

test('un lift con muestra chica no se declara significativo', () => {
  const chico = traitLift(2, 3, 1, 4);
  assert.equal(chico.isSignificant, false);
  const grande = traitLift(8, 10, 4, 30);
  assert.equal(grande.isSignificant, true);
  assert.ok(grande.lift > 2);
});

// ---------------------------------------------------------------------
// CON-6 · lo que la línea base y el puntaje necesitan de core
// ---------------------------------------------------------------------

test('la mediana de lo que no se midió es null, no cero', () => {
  assert.equal(medianOf([]), null, 'sin ninguna lectura no hay mediana');
  assert.equal(medianOf([null, undefined]), null, 'una red que no publica la métrica no tiene mediana');
  assert.equal(medianOf([0.4, null, 0.6]), 0.5, 'se mide con lo que sí hay');
  assert.equal(medianOf([0]), 0, 'un cero medido sí es un cero');
  assert.equal(percentileOf([], 0.25), null);
  assert.equal(percentileOf([10, null, 20, 30, 40], 0.25), 17.5);
});

test('las interacciones salen del total de la plataforma, y si no lo da, de la suma', () => {
  assert.equal(interactionsOf({ totalInteractions: 900, likes: 1, comments: 1 }), 900, 'manda el total que dio la plataforma');
  assert.equal(interactionsOf({ totalInteractions: null, likes: 400, comments: 30, shares: 20, saves: 50 }), 500);
  assert.equal(interactionsOf({ totalInteractions: null, likes: 400, saves: null }), 400, 'se suma lo que haya');
  assert.equal(interactionsOf({}), null, 'sin ningún dato no es cero interacciones: es que no sabemos');
  assert.equal(interactionsOf({ totalInteractions: 0 }), 0, 'un cero reportado sí es cero');
});

test('engagement y guardados por mil: null cuando no hay views', () => {
  assert.equal(engagementRate({ totalInteractions: 500 }, 10_000), 0.05);
  assert.equal(engagementRate({ likes: 400, comments: 30, shares: 20, saves: 50 }, 10_000), 0.05);
  assert.equal(engagementRate({ totalInteractions: 500 }, 0), null, 'dividir entre cero views no da cero engagement');
  assert.equal(engagementRate({ totalInteractions: 500 }, null), null);
  assert.equal(engagementRate({}, 10_000), null, 'sin interacciones reportadas no se inventa un cero');

  assert.equal(savesPer1k(80, 10_000), 8);
  assert.equal(savesPer1k(null, 10_000), null, 'TikTok no publica guardados: null, no cero');
  assert.equal(savesPer1k(80, 0), null);
});

test('is_outlier sale del mismo umbral que el tramo outlier', () => {
  assert.equal(isOutlier(outlierTier(2)), true);
  assert.equal(isOutlier(outlierTier(6)), true, 'un breakout también es outlier');
  assert.equal(isOutlier(outlierTier(1.999)), false);
  assert.equal(isOutlier(null), false, 'sin muestra suficiente, false: la columna es NOT NULL');
});

test('con menos de ocho videos no hay puntaje que escribir', () => {
  for (let n = 0; n < MIN_SAMPLE_FOR_BASELINE; n++) {
    assert.equal(versusMedian(120_000, 40_000, n), null, `con ${n} videos la mediana no significa nada`);
    assert.equal(outlierTier(versusMedian(120_000, 40_000, n)), null);
    assert.equal(isOutlier(outlierTier(versusMedian(120_000, 40_000, n))), false);
  }
  assert.equal(versusMedian(120_000, 40_000, MIN_SAMPLE_FOR_BASELINE), 3);
});

test('la mediana cero no produce un múltiplo infinito', () => {
  assert.equal(versusMedian(120_000, 0, 20), null);
});
