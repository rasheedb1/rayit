/**
 * CON-5 · hasta cuándo se mide un post. Reglas puras, en milisegundos.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMPAIGN_TAIL_DAYS,
  COLLECTION_GRACE_HOURS,
  DEFAULT_MAX_AGE_HOURS,
  isOpenCampaign,
  MAX_SCORING_CUT_HOURS,
  shouldKeepMeasuring,
} from '../src/recoleccion.ts';
import { AGE_CUTS_HOURS } from '../src/scoring.ts';

const HOY = '2026-09-23';

test('el tope sale del último corte de scoring más una semana de gracia', () => {
  assert.equal(MAX_SCORING_CUT_HOURS, Math.max(...AGE_CUTS_HOURS));
  assert.equal(MAX_SCORING_CUT_HOURS, 720);
  assert.equal(COLLECTION_GRACE_HOURS, 168);
  assert.equal(DEFAULT_MAX_AGE_HOURS, 888);
});

test('un post joven se mide; uno que pasó el tope, no', () => {
  assert.equal(shouldKeepMeasuring({ ageHours: 0.5 }), true);
  assert.equal(shouldKeepMeasuring({ ageHours: 720 }), true, 'justo en el corte de 720 h todavía hace falta una lectura');
  assert.equal(shouldKeepMeasuring({ ageHours: 888 }), true, 'el último instante de la gracia');
  assert.equal(shouldKeepMeasuring({ ageHours: 888.01 }), false);
  assert.equal(shouldKeepMeasuring({ ageHours: 5000 }), false);
});

test('la gracia existe para que el corte de 720 h tenga una lectura posterior', () => {
  // Con la última lectura a las 719 h, post_metrics_at_cut se quedaría
  // con un valor de casi un día antes del corte.
  assert.ok(DEFAULT_MAX_AGE_HOURS > MAX_SCORING_CUT_HOURS);
  assert.equal(shouldKeepMeasuring({ ageHours: MAX_SCORING_CUT_HOURS + 1 }), true);
});

test('una campaña abierta manda sobre el tope, hasta 30 días después de terminar', () => {
  const viejo = { ageHours: 2000, today: HOY };
  assert.equal(shouldKeepMeasuring({ ...viejo, campaign: { status: 'live', endsOn: '2026-09-01' } }), true);
  assert.equal(shouldKeepMeasuring({ ...viejo, campaign: { status: 'measuring', endsOn: '2026-08-24' } }), true, 'justo 30 días después');
  assert.equal(shouldKeepMeasuring({ ...viejo, campaign: { status: 'measuring', endsOn: '2026-08-23' } }), false, '31 días después ya no');
  assert.equal(CAMPAIGN_TAIL_DAYS, 30);
});

test('una campaña cerrada o cancelada no revive un post viejo', () => {
  const viejo = { ageHours: 2000, today: HOY };
  for (const status of ['reported', 'closed', 'cancelled']) {
    assert.equal(shouldKeepMeasuring({ ...viejo, campaign: { status, endsOn: '2026-09-22' } }), false, status);
  }
  assert.equal(shouldKeepMeasuring({ ...viejo, campaign: null }), false);
  assert.equal(shouldKeepMeasuring(viejo), false);
});

test('una campaña abierta sin fecha de fin se sigue midiendo', () => {
  assert.equal(shouldKeepMeasuring({ ageHours: 9000, today: HOY, campaign: { status: 'planned', endsOn: null } }), true);
});

test('no saber cuándo se publicó no es saber que es viejo: se mide igual', () => {
  assert.equal(shouldKeepMeasuring({ ageHours: Number.NaN }), true);
});

test('el tope se puede bajar por entorno sin tocar la regla', () => {
  assert.equal(shouldKeepMeasuring({ ageHours: 100, maxAgeHours: 48 }), false);
  assert.equal(shouldKeepMeasuring({ ageHours: 24, maxAgeHours: 48 }), true);
});

test('isOpenCampaign distingue las campañas que siguen necesitando lecturas', () => {
  assert.equal(isOpenCampaign({ status: 'live', endsOn: null }), true);
  assert.equal(isOpenCampaign({ status: 'closed', endsOn: null }), false);
  assert.equal(isOpenCampaign(null), false);
  assert.equal(isOpenCampaign(undefined), false);
});

test('una fecha de fin ilegible no saca al post de la medición', () => {
  assert.equal(shouldKeepMeasuring({ ageHours: 9000, today: HOY, campaign: { status: 'live', endsOn: 'no es fecha' } }), true);
});
