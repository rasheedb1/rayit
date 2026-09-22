import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIMITS, mergeLimits, unitCostFor } from '../src/quota/limits.ts';

test('cada fila de la tabla tiene fuente y fecha', () => {
  for (const [family, limits] of Object.entries(DEFAULT_LIMITS)) {
    for (const r of limits.rates) {
      assert.ok(r.source && r.checkedAt, `${family}: regla sin fuente`);
    }
    if (limits.daily) assert.ok(limits.daily.source && limits.daily.checkedAt, `${family}: presupuesto sin fuente`);
  }
  assert.equal(unitCostFor(DEFAULT_LIMITS.youtube, 'youtube.videos.list'), 1);
  assert.equal(unitCostFor(DEFAULT_LIMITS.youtube, 'youtube.otro'), 1);
});

test('platform.limits sobreescribe por familia y lo inválido se ignora sin lanzar', () => {
  const { limits, ignored } = mergeLimits(DEFAULT_LIMITS, {
    tiktok: { tiktok: { rates: [{ scope: 'connection', per_endpoint: true, window_s: 60, max: 30, source: 'seed 0001', checked_at: '2026-10-01' }] }, instagram: {} },
    youtube: { youtube: { daily: { scope: 'app', units: 50_000 }, unit_cost: { 'youtube.search.list': 100 } }, 'youtube-analytics': { daily: { scope: 'app', units: 'muchas' } } },
    instagram: 'no es objeto',
  });
  assert.equal(limits.tiktok.rates.length, 1);
  assert.equal(limits.tiktok.rates[0]!.max, 30);
  assert.equal(limits.youtube.daily!.units, 50_000);
  assert.equal(limits.youtube.unitCost['youtube.search.list'], 100);
  assert.equal(limits.youtube.unitCost['youtube.videos.list'], 1, 'lo no mencionado se conserva');
  assert.equal(limits['youtube-analytics'].daily!.units, null, 'la forma inválida no toca la familia');
  assert.equal(limits.instagram.rates[0]!.max, 200);
  assert.equal(ignored.length, 3, ignored.join('; '));
});
