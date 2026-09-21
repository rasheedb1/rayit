import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  median, versusMedian, outlierTier, snapshotAtCut,
  summarizeRetention, traitLift, MIN_SAMPLE_FOR_BASELINE,
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
