/** CON-3 · TikTok Login Kit: URL de autorización, intercambio del code, renovación con rotación, errores clasificados, sin secretos en errores ni log. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PlatformApiError } from '../src/http/errors.ts';
import { TokenRefreshError } from '../src/token-refresher.ts';
import { tiktokAuthorizationUrl, tiktokExchangeCode, tiktokIdentity, tiktokRefresh, TIKTOK_LOGIN_SCOPES } from '../src/oauth/tiktok-login.ts';
import { createTikTokRefresher } from '../src/platforms/tiktok.ts';
import { withoutNetwork, type NetworkGuard } from '../src/testing/fixture-fetch.ts';
import type { OAuthTokens } from '../src/types.ts';
import { appConfig, assertNoSecrets, NOW, oauthCore } from './helpers/oauth.ts';

let guard: NetworkGuard;
before(() => { guard = withoutNetwork(); });
after(() => { guard.restore(); });

const CFG = appConfig('tiktok', TIKTOK_LOGIN_SCOPES);
const CODE = 'CODE-DE-AUTORIZACION-SECRETO-777';
const CURRENT: OAuthTokens = { accessToken: 'act.demo-access-tiktok-0001-SECRETO', refreshToken: 'rft.demo-refresh-tiktok-0001-SECRETO', accessExpiresAt: new Date(NOW.getTime() + 600_000), refreshExpiresAt: new Date('2027-09-21T10:00:00Z'), scopes: [...TIKTOK_LOGIN_SCOPES] };
const SECRETS = [CFG.clientSecret, CODE, CURRENT.accessToken, CURRENT.refreshToken!];

test('authorizationUrl: client_key, scope por comas, response_type=code, redirect_uri y state; sin PKCE', () => {
  const u = new URL(tiktokAuthorizationUrl(CFG, { state: 'estado-aleatorio' }));
  assert.equal(u.origin + u.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
  assert.equal(u.searchParams.get('client_key'), CFG.clientId);
  assert.equal(u.searchParams.get('scope'), 'user.info.basic,user.info.profile,user.info.stats,video.list');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('redirect_uri'), CFG.redirectUri);
  assert.equal(u.searchParams.get('state'), 'estado-aleatorio');
  assert.equal(u.searchParams.has('code_challenge'), false);
  assert.ok(!u.toString().includes(CFG.clientSecret));
});

test('exchangeCode: formulario con el code, tokens de 24 h / 365 días, open_id y scopes; el log no lleva el code ni el secreto', async () => {
  const { core, fetch, log } = await oauthCore('tiktok', [['oauth.token', 'code.ok']]);
  const out = await tiktokExchangeCode(core, CFG, CODE);
  assert.equal(out.externalAccountId, 'open_id_demo_laura');
  assert.deepEqual(out.scopesGranted, [...TIKTOK_LOGIN_SCOPES]);
  assert.equal(out.tokens.accessToken, 'act.demo-access-tiktok-0001-SECRETO');
  assert.equal(out.tokens.refreshToken, 'rft.demo-refresh-tiktok-0001-SECRETO');
  assert.equal(out.tokens.accessExpiresAt.toISOString(), '2026-09-23T10:00:00.000Z');
  assert.equal(out.tokens.refreshExpiresAt?.toISOString(), '2027-09-22T10:00:00.000Z');
  const call = fetch.calls[0]!;
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal((call.body as Record<string, string>)['grant_type'], 'authorization_code');
  assert.equal((call.body as Record<string, string>)['redirect_uri'], CFG.redirectUri);
  assert.equal((call.body as Record<string, string>)['client_secret'], '[REDACTADO]', 'el fetch de pruebas tampoco conserva el secreto');
  assert.equal((call.body as Record<string, string>)['code'], '[REDACTADO]');
  assert.ok(!call.url.includes(CODE) && !call.url.includes(CFG.clientSecret), 'nada secreto en la URL');
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0]!.endpoint, 'oauth.token');
  assert.equal(log.entries[0]!.connection_id, null);
  assert.equal(assertNoSecrets([JSON.stringify(log.entries)], SECRETS), null);
});

test('exchangeCode con code inválido: PlatformApiError permanente (invalid_grant), sin secretos', async () => {
  const { core, log } = await oauthCore('tiktok', [['oauth.token', 'code.invalid']]);
  await assert.rejects(tiktokExchangeCode(core, CFG, CODE), (e: unknown) => e instanceof PlatformApiError && e.kind === 'permanent' && e.code === 'invalid_grant');
  assert.equal(assertNoSecrets([JSON.stringify(log.entries)], SECRETS), null);
});

test('refresh ok: el refresh token ROTA y lo devuelto es el nuevo; una fila oauth.refresh con la conexión', async () => {
  const { core, log } = await oauthCore('tiktok', [['oauth.token', 'refresh.ok']]);
  const fresh = await tiktokRefresh(core, CFG, CURRENT, { connectionId: '00000002-0000-4000-8000-0000000000c2' });
  assert.equal(fresh.accessToken, 'act.demo-access-tiktok-0002-SECRETO');
  assert.equal(fresh.refreshToken, 'rft.demo-refresh-tiktok-0002-SECRETO');
  assert.notEqual(fresh.refreshToken, CURRENT.refreshToken);
  assert.equal(fresh.accessExpiresAt.toISOString(), '2026-09-23T10:00:00.000Z');
  assert.deepEqual(fresh.scopes, [...TIKTOK_LOGIN_SCOPES]);
  assert.equal(log.entries[0]!.endpoint, 'oauth.refresh');
  assert.equal(log.entries[0]!.connection_id, '00000002-0000-4000-8000-0000000000c2');
  assert.equal(log.entries[0]!.ok, true);
});

test('refresh invalid_grant: TokenRefreshError definitivo y el token que la plataforma repitió en el mensaje queda borrado', async () => {
  const { core, log } = await oauthCore('tiktok', [['oauth.token', 'refresh.invalid_grant']]);
  let caught: unknown;
  try { await tiktokRefresh(core, CFG, CURRENT); } catch (e) { caught = e; }
  assert.ok(caught instanceof TokenRefreshError);
  assert.equal(caught.kind, 'permanent');
  assert.equal(caught.code, 'invalid_grant');
  assert.equal(caught.httpStatus, 400);
  assert.equal(assertNoSecrets([caught.message, caught.messageEs, JSON.stringify(log.entries)], SECRETS), null);
  assert.match(log.entries[0]!.error_message ?? '', /\[REDACTADO\]/);
});

test('refresh con invalid_client (nuestra app mal configurada): transitorio, NO needs_reauth', async () => {
  const { core } = await oauthCore('tiktok', [['oauth.token', 'refresh.invalid_client']]);
  await assert.rejects(tiktokRefresh(core, CFG, CURRENT), (e: unknown) => e instanceof TokenRefreshError && e.kind === 'transient' && e.code === 'invalid_client' && /vault/.test(e.messageEs));
});

test('refresh con 429 y Retry-After: transitorio, rate limit, retryAfterS = 7, y el núcleo reintentó hasta el tope', async () => {
  const { core, clock } = await oauthCore('tiktok', [['oauth.token', 'refresh.rate_limit']]);
  let caught: unknown;
  try { await tiktokRefresh(core, CFG, CURRENT); } catch (e) { caught = e; }
  assert.ok(caught instanceof TokenRefreshError);
  assert.equal(caught.kind, 'transient');
  assert.equal(caught.isRateLimited, true);
  assert.equal(caught.retryAfterS, 7);
  assert.deepEqual(clock.sleeps, [7000, 7000, 7000]);
});

test('refresh con 500 y luego 200: el núcleo reintenta y devuelve el token nuevo', async () => {
  const { core, log } = await oauthCore('tiktok', [['oauth.token', 'refresh.server_error_then_ok']]);
  const fresh = await tiktokRefresh(core, CFG, CURRENT);
  assert.equal(fresh.accessToken, 'act.demo-access-tiktok-0003-SECRETO');
  assert.equal(log.entries.length, 2, 'una fila por intento');
  assert.equal(log.entries[0]!.http_status, 500);
  assert.equal(log.entries[1]!.ok, true);
});

test('sin refresh token: definitivo refresh_expired sin llamar; el refresher de plataforma elige Login Kit por la ref y avisa si falta la app', async () => {
  const { core, fetch } = await oauthCore('tiktok', []);
  await assert.rejects(tiktokRefresh(core, CFG, { ...CURRENT, refreshToken: undefined }), (e: unknown) => e instanceof TokenRefreshError && e.kind === 'permanent' && e.code === 'refresh_expired');
  assert.equal(fetch.calls.length, 0);
  const sinApp = createTikTokRefresher(core, {});
  await assert.rejects(sinApp.refresh(CURRENT, { secretRef: 'enc:tiktok:00000000-0000-4000-8000-000000000001' }), (e: unknown) => e instanceof TokenRefreshError && e.kind === 'transient' && e.code === 'not_configured' && /TIKTOK_LOGIN_CLIENT_KEY/.test(e.messageEs));
  await assert.rejects(sinApp.refresh(CURRENT, { secretRef: 'enc:tiktok-business:00000000-0000-4000-8000-000000000001' }), (e: unknown) => e instanceof TokenRefreshError && /TIKTOK_BUSINESS_APP_ID/.test(e.messageEs));
});

test('identity: userInfo de CON-1 con el token recién emitido', async () => {
  const { core, fetch } = await oauthCore('tiktok', [['user.info', 'ok']]);
  const profile = await tiktokIdentity(core, CURRENT);
  assert.equal(profile.external_account_id, 'open_id_demo_laura');
  assert.equal(profile.handle, 'laura.cocinafacil');
  assert.equal(fetch.calls[0]!.headers['Authorization'], '[REDACTADO]');
});
