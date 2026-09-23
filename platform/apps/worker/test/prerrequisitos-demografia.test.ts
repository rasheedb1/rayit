/**
 * CON-7 · la decisión de si se llama o no, en milisegundos y sin base.
 * El job solo obedece a esto, así que aquí está el detalle de cada
 * camino y en collect-demographics.test.ts, que cuesta minutos, solo lo
 * que hace falta demostrar de punta a punta.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { YOUTUBE_ANALYTICS_SCOPE, classifyApiError } from '@mc/connectors';
import {
  analyticsWindow, INSTAGRAM_BREAKDOWNS, MIN_FOLLOWERS, planDemographics, requirementFromApiError,
  type DemographicsAccount,
} from '../src/jobs/conexiones/prerrequisitos-demografia.ts';

const base: DemographicsAccount = {
  platformId: 'instagram', accessMode: 'direct_oauth', accountType: 'business',
  scopes: ['instagram_business_basic', 'instagram_business_manage_insights'], followers: 5_000,
};

function requisito(acc: Partial<DemographicsAccount>): string | null | undefined {
  const d = planDemographics({ ...base, ...acc });
  return d.ok ? undefined : d.requirementId;
}

test('Instagram: autorización, tipo de cuenta y cien seguidores, en ese orden', () => {
  const ok = planDemographics(base);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok && ok.plan, { platform: 'instagram', breakdowns: INSTAGRAM_BREAKDOWNS });
  assert.equal(requisito({ accessMode: 'public_profile' }), 'ig.demographics.auth');
  // El orden importa: a quien no ha autorizado no se le dice que le faltan seguidores.
  assert.equal(requisito({ accessMode: 'public_profile', accountType: 'personal', followers: 3 }), 'ig.demographics.auth');
  assert.equal(requisito({ accountType: 'personal' }), 'ig.insights.account_type');
  assert.equal(requisito({ scopes: ['instagram_business_basic'] }), 'ig.insights.account_type');
  assert.equal(requisito({ followers: MIN_FOLLOWERS - 1 }), 'ig.demographics');
  assert.equal(requisito({ followers: MIN_FOLLOWERS }), undefined, 'cien justos bastan');
});

test('un nulo no es un cero: sin snapshot se llama y decide la plataforma', () => {
  assert.equal(requisito({ followers: null }), undefined);
  assert.equal(requisito({ platformId: 'tiktok', scopes: ['user.insights'], followers: null }), undefined);
});

test('TikTok: sin el scope de la Accounts API no hay audiencia, y una cuenta personal nunca lo tiene', () => {
  const personal = { platformId: 'tiktok', accountType: 'personal', scopes: ['user.info.basic', 'video.list'] };
  assert.equal(requisito(personal), 'tt.insights.scope');
  assert.equal(requisito({ platformId: 'tiktok', scopes: ['user.insights'] }), undefined);
  assert.equal(requisito({ platformId: 'tiktok', scopes: ['user.insights'], followers: 99 }), 'tt.audience_age');
  assert.equal(requisito({ platformId: 'tiktok', accessMode: 'public_profile', scopes: [] }), 'tt.audience.auth');
});

test('YouTube: la Data API no abre Analytics; sin ese scope no se llama', () => {
  assert.equal(requisito({ platformId: 'youtube', scopes: ['https://www.googleapis.com/auth/youtube.readonly'] }), 'yt.analytics.scope');
  assert.equal(requisito({ platformId: 'youtube', scopes: [YOUTUBE_ANALYTICS_SCOPE] }), undefined);
  assert.equal(requisito({ platformId: 'youtube', scopes: [YOUTUBE_ANALYTICS_SCOPE], followers: 3 }),
    undefined, 'YouTube no exige un mínimo de suscriptores');
  assert.equal(requisito({ platformId: 'youtube', accessMode: 'public_profile', scopes: [] }), 'yt.demographics.auth');
});

test('Facebook no entrega demografía de cuenta: ni se llama ni se inventa un requisito', () => {
  const d = planDemographics({ ...base, platformId: 'facebook' });
  assert.equal(d.ok, false);
  assert.equal(!d.ok && d.requirementId, null);
  assert.match(!d.ok && 'reason' in d ? d.reason : '', /no entrega demografía/);
});

test('solo el subcódigo de Meta convierte un error en requisito', () => {
  const pocos = classifyApiError({
    platformId: 'instagram', endpoint: 'instagram.account.demographics', httpStatus: 400,
    parsed: { code: '100', message: 'Not enough followers (subcódigo 2108006)', subcode: '2108006' },
  });
  assert.equal(requirementFromApiError('instagram', pocos), 'ig.demographics');

  // El mismo code 100 sin ese subcódigo es un defecto nuestro: si se
  // tradujera a «te faltan seguidores», nadie lo arreglaría nunca.
  const parametro = classifyApiError({
    platformId: 'instagram', endpoint: 'instagram.account.demographics', httpStatus: 400,
    parsed: { code: '100', message: 'Invalid parameter' },
  });
  assert.equal(requirementFromApiError('instagram', parametro), null);

  const token = classifyApiError({ platformId: 'instagram', endpoint: 'x', httpStatus: 401, parsed: { code: '190' } });
  assert.equal(requirementFromApiError('instagram', token), null, 'un token muerto no es un requisito');
  assert.equal(requirementFromApiError('instagram', new Error('boom')), null);
});

test('la ventana de Analytics termina AYER: los datos llegan con 24-48 h de retraso', () => {
  assert.deepEqual(analyticsWindow(new Date('2026-09-23T05:20:00Z')), { startDate: '2026-08-26', endDate: '2026-09-22' });
  assert.deepEqual(analyticsWindow(new Date('2026-03-01T00:10:00Z')), { startDate: '2026-02-01', endDate: '2026-02-28' });
});
