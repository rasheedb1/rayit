/** CON-3 · TikTok Accounts API (fixtures de la documentación; se confirma con CON-9): intercambio, renovación, code 40105 y el refresher por ref. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TokenRefreshError } from '../src/token-refresher.ts';
import { tiktokBusinessAuthorizationUrl, tiktokBusinessExchangeCode, tiktokBusinessRefresh, TIKTOK_BUSINESS_SCOPES } from '../src/oauth/tiktok-business.ts';
import { TIKTOK_LOGIN_SCOPES } from '../src/oauth/tiktok-login.ts';
import { createTikTokRefresher } from '../src/platforms/tiktok.ts';
import { withoutNetwork, type NetworkGuard } from '../src/testing/fixture-fetch.ts';
import type { OAuthTokens } from '../src/types.ts';
import { appConfig, assertNoSecrets, NOW, oauthCore } from './helpers/oauth.ts';

let guard: NetworkGuard;
before(() => { guard = withoutNetwork(); });
after(() => { guard.restore(); });

const CFG = appConfig('tiktok-business', TIKTOK_BUSINESS_SCOPES);
const LOGIN = appConfig('tiktok', TIKTOK_LOGIN_SCOPES);
const CODE = 'AUTH-CODE-BUSINESS-SECRETO';
const CURRENT: OAuthTokens = { accessToken: 'act.demo-business-0001-SECRETO', refreshToken: 'rft.demo-business-0001-SECRETO', accessExpiresAt: new Date(NOW.getTime() + 600_000), scopes: [...TIKTOK_BUSINESS_SCOPES] };

test('authorizationUrl usa el app id como client_key y los scopes de la Accounts API', () => {
  const u = new URL(tiktokBusinessAuthorizationUrl(CFG, { state: 's' }));
  assert.equal(u.searchParams.get('client_key'), CFG.clientId);
  assert.ok(u.searchParams.get('scope')!.includes('video.insights'));
});

test('exchangeCode: JSON con auth_code, respuesta { code: 0, data }, open_id de negocio', async () => {
  const { core, fetch, log } = await oauthCore('tiktok-accounts', [['oauth.token', 'code.ok']]);
  const out = await tiktokBusinessExchangeCode(core, CFG, CODE);
  assert.equal(out.externalAccountId, 'biz_open_id_demo_laura');
  assert.equal(out.tokens.refreshToken, 'rft.demo-business-0001-SECRETO');
  assert.ok(out.scopesGranted.includes('video.insights'));
  const body = fetch.calls[0]!.body as Record<string, string>;
  assert.equal(body['grant_type'], 'authorization_code');
  assert.equal(body['auth_code'], '[REDACTADO]');
  assert.equal(body['client_secret'], '[REDACTADO]');
  assert.equal(log.entries[0]!.endpoint, 'oauth.token');
  assert.equal(assertNoSecrets([JSON.stringify(log.entries)], [CODE, CFG.clientSecret]), null);
});

test('refresh ok rota el refresh token; code 40105 (HTTP 200) es definitivo', async () => {
  const ok = await oauthCore('tiktok-accounts', [['oauth.refresh', 'ok']]);
  const fresh = await tiktokBusinessRefresh(ok.core, CFG, CURRENT);
  assert.equal(fresh.refreshToken, 'rft.demo-business-0002-SECRETO');
  assert.equal(fresh.accessExpiresAt.toISOString(), '2026-09-23T10:00:00.000Z');
  const bad = await oauthCore('tiktok-accounts', [['oauth.refresh', 'invalid']]);
  await assert.rejects(tiktokBusinessRefresh(bad.core, CFG, CURRENT), (e: unknown) => e instanceof TokenRefreshError && e.kind === 'permanent' && e.code === '40105');
  assert.equal(bad.log.entries[0]!.ok, false);
  assert.equal(bad.log.entries[0]!.error_code, '40105');
});

test('el refresher de tiktok elige la app por el prefijo del secret_ref', async () => {
  const { core, fetch } = await oauthCore('tiktok-accounts', [['oauth.refresh', 'ok']]);
  const refresher = createTikTokRefresher(core, { login: LOGIN, business: CFG });
  const fresh = await refresher.refresh(CURRENT, { secretRef: 'enc:tiktok-business:00000000-0000-4000-8000-000000000001', connectionId: '00000002-0000-4000-8000-0000000000c2' });
  assert.equal(fresh.accessToken, 'act.demo-business-0002-SECRETO');
  assert.match(fetch.calls[0]!.url, /tt_user\/oauth2\/refresh_token/);
});
