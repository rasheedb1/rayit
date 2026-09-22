/** CON-3 · Instagram Login: autorización, code → corto → larga duración, renovación con las reglas de 24 h, errores 190 / 4 / 5xx. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PlatformApiError } from '../src/http/errors.ts';
import { TokenRefreshError } from '../src/token-refresher.ts';
import { instagramAuthorizationUrl, instagramExchangeCode, instagramIdentity, instagramRefresh, INSTAGRAM_LOGIN_SCOPES } from '../src/oauth/instagram-login.ts';
import { createInstagramRefresher } from '../src/platforms/instagram.ts';
import { withoutNetwork, type NetworkGuard } from '../src/testing/fixture-fetch.ts';
import type { OAuthTokens } from '../src/types.ts';
import { appConfig, assertNoSecrets, NOW, oauthCore } from './helpers/oauth.ts';

let guard: NetworkGuard;
before(() => { guard = withoutNetwork(); });
after(() => { guard.restore(); });

const CFG = appConfig('instagram', INSTAGRAM_LOGIN_SCOPES);
const CODE = 'IG-CODE-SECRETO-999';
const DAY = 24 * 3600 * 1000;
const CURRENT: OAuthTokens = { accessToken: 'IGAA-long-demo-0001-SECRETO', accessExpiresAt: new Date(NOW.getTime() + 5 * DAY), scopes: [...INSTAGRAM_LOGIN_SCOPES] };
const SECRETS = [CFG.clientSecret, CODE, 'IGQVJ-short-demo-0001-SECRETO', CURRENT.accessToken];

test('authorizationUrl: client_id, redirect_uri, response_type=code, scope por comas y state', () => {
  const u = new URL(instagramAuthorizationUrl(CFG, { state: 'st' }));
  assert.equal(u.origin + u.pathname, 'https://www.instagram.com/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), CFG.clientId);
  assert.equal(u.searchParams.get('scope'), 'instagram_business_basic,instagram_business_manage_insights');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('state'), 'st');
});

test('exchangeCode: dos llamadas (corto y larga duración); se guarda el largo, sin refresh token, vence a ~60 días; user_id y permissions', async () => {
  const { core, fetch, log } = await oauthCore('instagram', [['oauth.access_token', 'ok'], ['oauth.long_lived', 'ok']]);
  const out = await instagramExchangeCode(core, CFG, CODE);
  // 17841400000000123 no es un entero seguro en JavaScript: JSON.parse lo redondea a …124. Por eso el id no se toma de aquí sino de `me`.
  assert.equal(out.externalAccountId, null);
  assert.deepEqual(out.scopesGranted, [...INSTAGRAM_LOGIN_SCOPES]);
  assert.equal(out.tokens.accessToken, 'IGAA-long-demo-0001-SECRETO');
  assert.equal(out.tokens.refreshToken, undefined);
  assert.equal(out.tokens.accessExpiresAt.toISOString(), new Date(NOW.getTime() + 5_183_944_000).toISOString());
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0]!.method, 'POST');
  assert.equal((fetch.calls[0]!.body as Record<string, string>)['code'], '[REDACTADO]');
  assert.equal(fetch.calls[1]!.method, 'GET');
  assert.equal(fetch.calls[1]!.headers['Authorization'], '[REDACTADO]', 'el token corto va en cabecera');
  assert.ok(!fetch.calls[1]!.url.includes('IGQVJ-short-demo-0001-SECRETO'), 'y no en la URL');
  assert.deepEqual(log.entries.map((e) => e.endpoint), ['oauth.token', 'oauth.long_lived']);
  assert.equal(assertNoSecrets([JSON.stringify(log.entries)], SECRETS), null);
});

test('exchangeCode con code inválido: la forma vieja de api.instagram.com se clasifica como permanente', async () => {
  const { core } = await oauthCore('instagram', [['oauth.access_token', 'invalid']]);
  await assert.rejects(instagramExchangeCode(core, CFG, CODE), (e: unknown) => e instanceof PlatformApiError && e.kind === 'permanent' && e.code === 'OAuthException' && e.httpStatus === 400);
});

test('refresh ok mientras queden más de 24 h: nuevo token de 60 días, mismos scopes, fila oauth.refresh', async () => {
  const { core, log } = await oauthCore('instagram', [['oauth.refresh', 'ok']]);
  const fresh = await instagramRefresh(core, CFG, CURRENT, { connectionId: '00000002-0000-4000-8000-0000000000c1' });
  assert.equal(fresh.accessToken, 'IGAA-long-demo-0002-SECRETO');
  assert.equal(fresh.refreshToken, undefined);
  assert.equal(fresh.accessExpiresAt.toISOString(), new Date(NOW.getTime() + 60 * DAY).toISOString());
  assert.deepEqual(fresh.scopes, [...INSTAGRAM_LOGIN_SCOPES]);
  assert.equal(log.entries[0]!.endpoint, 'oauth.refresh');
  assert.equal(log.entries[0]!.connection_id, '00000002-0000-4000-8000-0000000000c1');
});

test('refresh de un token vencido: definitivo refresh_expired SIN llamar a Meta', async () => {
  const { core, fetch } = await oauthCore('instagram', []);
  await assert.rejects(instagramRefresh(core, CFG, { ...CURRENT, accessExpiresAt: new Date(NOW.getTime() - 1) }), (e: unknown) => e instanceof TokenRefreshError && e.kind === 'permanent' && e.code === 'refresh_expired');
  assert.equal(fetch.calls.length, 0);
});

test('code 190 es definitivo; code 4 es transitorio rate_limit sin Retry-After; 500 y luego 200 se reintenta', async () => {
  const c190 = await oauthCore('instagram', [['oauth.refresh', 'invalid']]);
  let caught: unknown;
  try { await instagramRefresh(c190.core, CFG, CURRENT); } catch (e) { caught = e; }
  assert.ok(caught instanceof TokenRefreshError && caught.kind === 'permanent' && caught.code === '190');
  assert.equal(assertNoSecrets([caught.message, JSON.stringify(c190.log.entries)], SECRETS), null);

  const c4 = await oauthCore('instagram', [['oauth.refresh', 'rate_limit']]);
  await assert.rejects(instagramRefresh(c4.core, CFG, CURRENT), (e: unknown) => e instanceof TokenRefreshError && e.kind === 'transient' && e.code === 'rate_limit' && e.isRateLimited);
  assert.equal(c4.fetch.calls.length, 1, 'quota no se reintenta dentro del núcleo');

  const c5 = await oauthCore('instagram', [['oauth.refresh', 'server_error_then_ok']]);
  const fresh = await instagramRefresh(c5.core, CFG, CURRENT);
  assert.equal(fresh.accessToken, 'IGAA-long-demo-0003-SECRETO');
  assert.equal(c5.log.entries.length, 2);
});

test('el refresher de plataforma sin app configurada falla como not_configured; identity usa me de CON-1', async () => {
  const { core } = await oauthCore('instagram', [['me', 'ok']]);
  await assert.rejects(createInstagramRefresher(core, undefined).refresh(CURRENT), (e: unknown) => e instanceof TokenRefreshError && e.code === 'not_configured' && /META_APP_ID/.test(e.messageEs));
  const profile = await instagramIdentity(core, CURRENT);
  assert.equal(profile.external_account_id, '17841400000000123');
  assert.equal(profile.handle, 'laura.cocinafacil');
});
