/** CON-8 · Google/YouTube: URL de autorización con access_type=offline, intercambio del code, renovación que NO rota el refresh token, errores clasificados, cuenta sin canal, y sin secretos en errores ni log. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PlatformApiError } from '../src/http/errors.ts';
import { TokenRefreshError } from '../src/token-refresher.ts';
import { googleAuthorizationUrl, googleExchangeCode, googleRefresh, youtubeIdentity, GOOGLE_AUTHORIZE_URL, YOUTUBE_OAUTH_SCOPES } from '../src/oauth/google.ts';
import { loadOAuthApps, OAUTH_ENV_NAMES, callbackPath } from '../src/oauth/config.ts';
import { createYouTubeRefresher } from '../src/platforms/youtube.ts';
import { withoutNetwork, type NetworkGuard } from '../src/testing/fixture-fetch.ts';
import type { OAuthTokens } from '../src/types.ts';
import { appConfig, assertNoSecrets, NOW, oauthCore } from './helpers/oauth.ts';

let guard: NetworkGuard;
before(() => { guard = withoutNetwork(); });
after(() => { guard.restore(); });

const CFG = appConfig('youtube', YOUTUBE_OAUTH_SCOPES);
const CODE = '4/0AY-CODE-DE-AUTORIZACION-SECRETO-777';
const CURRENT: OAuthTokens = { accessToken: 'ya29.demo-access-youtube-0001-SECRETO', refreshToken: '1//demo-refresh-youtube-0001-SECRETO', accessExpiresAt: new Date(NOW.getTime() + 600_000), scopes: [...YOUTUBE_OAUTH_SCOPES] };
const SECRETS = [CFG.clientSecret, CODE, CURRENT.accessToken, CURRENT.refreshToken!];

test('authorizationUrl: scope separado por ESPACIOS, access_type=offline y prompt=consent (sin ellos no hay refresh token)', () => {
  const u = new URL(googleAuthorizationUrl(CFG, { state: 'estado-aleatorio' }));
  assert.equal(u.origin + u.pathname, GOOGLE_AUTHORIZE_URL);
  assert.equal(u.searchParams.get('client_id'), CFG.clientId);
  assert.equal(u.searchParams.get('redirect_uri'), CFG.redirectUri);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly');
  assert.equal(u.searchParams.get('state'), 'estado-aleatorio');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.equal(u.searchParams.has('code_challenge'), false);
  assert.ok(!u.toString().includes(CFG.clientSecret));
});

test('los scopes son los dos de solo lectura: ni monetario, ni de escritura, ni de MCN', () => {
  assert.deepEqual([...YOUTUBE_OAUTH_SCOPES], ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly']);
  for (const prohibido of ['yt-analytics-monetary.readonly', 'youtube.force-ssl', 'youtubepartner']) {
    assert.ok(!YOUTUBE_OAUTH_SCOPES.some((s) => s.includes(prohibido)), `${prohibido} no se pide`);
  }
});

test('config: el proveedor youtube se arma con GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y la ruta del callback', () => {
  assert.deepEqual(OAUTH_ENV_NAMES.youtube, { clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET', redirectUri: 'GOOGLE_REDIRECT_URI' });
  assert.equal(callbackPath('youtube'), '/conexiones/oauth/youtube/callback');
  const { apps, missing } = loadOAuthApps({ APP_URL: 'https://on-cue-web.vercel.app/', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec' });
  assert.equal(apps.youtube?.redirectUri, 'https://on-cue-web.vercel.app/conexiones/oauth/youtube/callback');
  assert.deepEqual([...(apps.youtube?.scopes ?? [])], [...YOUTUBE_OAUTH_SCOPES]);
  assert.deepEqual(loadOAuthApps({}).missing.youtube, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI (o APP_URL)']);
  assert.equal(missing.youtube, undefined);
});

test('exchangeCode: formulario con el code, token de una hora, refresh token, scopes por espacios; el log no lleva el code ni el secreto', async () => {
  const { core, fetch, log } = await oauthCore('youtube', [['oauth.token', 'code.ok']]);
  const out = await googleExchangeCode(core, CFG, CODE);
  assert.equal(out.externalAccountId, null, 'el endpoint de token no dice de qué canal es: manda la identidad');
  assert.deepEqual(out.scopesGranted, [...YOUTUBE_OAUTH_SCOPES]);
  assert.equal(out.tokens.accessToken, 'ya29.demo-access-youtube-0001-SECRETO');
  assert.equal(out.tokens.refreshToken, '1//demo-refresh-youtube-0001-SECRETO');
  assert.equal(out.tokens.accessExpiresAt.toISOString(), '2026-09-22T10:59:59.000Z');
  assert.equal(out.tokens.refreshExpiresAt, undefined, 'Google no da fecha de vencimiento del refresh token');
  const call = fetch.calls[0]!;
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal((call.body as Record<string, string>)['grant_type'], 'authorization_code');
  assert.equal((call.body as Record<string, string>)['redirect_uri'], CFG.redirectUri);
  assert.equal((call.body as Record<string, string>)['client_secret'], '[REDACTADO]');
  assert.equal((call.body as Record<string, string>)['code'], '[REDACTADO]');
  assert.ok(!call.url.includes(CODE) && !call.url.includes(CFG.clientSecret), 'nada secreto en la URL');
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0]!.endpoint, 'oauth.token');
  assert.equal(log.entries[0]!.connection_id, null);
  assert.equal(assertNoSecrets([JSON.stringify(log.entries)], SECRETS), null);
});

test('exchangeCode sin refresh_token (la cuenta ya había autorizado): transitorio, no se guarda una conexión que muere en una hora', async () => {
  const { core } = await oauthCore('youtube', [['oauth.token', 'code.sin_refresh']]);
  await assert.rejects(googleExchangeCode(core, CFG, CODE), (e: unknown) => e instanceof PlatformApiError && e.kind === 'transient' && e.code === 'no_refresh_token' && /renovación/.test(e.messageEs));
});

test('exchangeCode con code inválido: PlatformApiError permanente (invalid_grant), sin secretos', async () => {
  const { core, log } = await oauthCore('youtube', [['oauth.token', 'code.invalid']]);
  await assert.rejects(googleExchangeCode(core, CFG, CODE), (e: unknown) => e instanceof PlatformApiError && e.kind === 'permanent' && e.code === 'invalid_grant');
  assert.equal(assertNoSecrets([JSON.stringify(log.entries)], SECRETS), null);
});

test('refresh ok: Google NO rota el refresh token y se conserva el nuestro; una fila oauth.refresh con la conexión', async () => {
  const { core, log } = await oauthCore('youtube', [['oauth.token', 'refresh.ok']]);
  const fresh = await googleRefresh(core, CFG, CURRENT, { connectionId: '00000002-0000-4000-8000-0000000000c8' });
  assert.equal(fresh.accessToken, 'ya29.demo-access-youtube-0002-SECRETO');
  assert.equal(fresh.refreshToken, CURRENT.refreshToken, 'el mismo refresh token: Google no manda uno nuevo');
  assert.equal(fresh.accessExpiresAt.toISOString(), '2026-09-22T10:59:59.000Z');
  assert.equal(fresh.refreshExpiresAt, undefined);
  assert.deepEqual(fresh.scopes, [...YOUTUBE_OAUTH_SCOPES]);
  assert.equal(log.entries[0]!.endpoint, 'oauth.refresh');
  assert.equal(log.entries[0]!.connection_id, '00000002-0000-4000-8000-0000000000c8');
  assert.equal(log.entries[0]!.ok, true);
});

test('refresh invalid_grant: TokenRefreshError definitivo y el token que Google repitió en el mensaje queda borrado', async () => {
  const { core, log } = await oauthCore('youtube', [['oauth.token', 'refresh.invalid_grant']]);
  let caught: unknown;
  try { await googleRefresh(core, CFG, CURRENT); } catch (e) { caught = e; }
  assert.ok(caught instanceof TokenRefreshError);
  assert.equal(caught.kind, 'permanent');
  assert.equal(caught.code, 'invalid_grant');
  assert.equal(caught.httpStatus, 400);
  assert.equal(assertNoSecrets([caught.message, caught.messageEs, JSON.stringify(log.entries)], SECRETS), null);
  assert.match(log.entries[0]!.error_message ?? '', /\[REDACTADO\]/);
});

test('refresh con invalid_client (nuestro secreto mal rotado): transitorio, NO needs_reauth', async () => {
  const { core } = await oauthCore('youtube', [['oauth.token', 'refresh.invalid_client']]);
  await assert.rejects(googleRefresh(core, CFG, CURRENT), (e: unknown) => e instanceof TokenRefreshError && e.kind === 'transient' && e.code === 'invalid_client' && /vault/.test(e.messageEs));
});

test('refresh con 429 y Retry-After: transitorio, rate limit, retryAfterS = 7, y el núcleo reintentó hasta el tope', async () => {
  const { core, clock } = await oauthCore('youtube', [['oauth.token', 'refresh.rate_limit']]);
  let caught: unknown;
  try { await googleRefresh(core, CFG, CURRENT); } catch (e) { caught = e; }
  assert.ok(caught instanceof TokenRefreshError);
  assert.equal(caught.kind, 'transient');
  assert.equal(caught.isRateLimited, true);
  assert.equal(caught.retryAfterS, 7);
  assert.deepEqual(clock.sleeps, [7000, 7000, 7000]);
});

test('refresh con 500 y luego 200: el núcleo reintenta y devuelve el token nuevo', async () => {
  const { core, log } = await oauthCore('youtube', [['oauth.token', 'refresh.server_error_then_ok']]);
  const fresh = await googleRefresh(core, CFG, CURRENT);
  assert.equal(fresh.accessToken, 'ya29.demo-access-youtube-0003-SECRETO');
  assert.equal(log.entries.length, 2, 'una fila por intento');
  assert.equal(log.entries[0]!.http_status, 500);
  assert.equal(log.entries[1]!.ok, true);
});

test('sin refresh token: definitivo refresh_expired sin llamar; sin la app configurada, transitorio nombrando GOOGLE_CLIENT_ID', async () => {
  const { core, fetch } = await oauthCore('youtube', []);
  await assert.rejects(googleRefresh(core, CFG, { ...CURRENT, refreshToken: undefined }), (e: unknown) => e instanceof TokenRefreshError && e.kind === 'permanent' && e.code === 'refresh_expired');
  assert.equal(fetch.calls.length, 0);
  const sinApp = createYouTubeRefresher(core, undefined);
  assert.equal(sinApp.platformId, 'youtube');
  await assert.rejects(sinApp.refresh(CURRENT), (e: unknown) => e instanceof TokenRefreshError && e.kind === 'transient' && e.code === 'not_configured' && /GOOGLE_CLIENT_ID/.test(e.messageEs));
});

test('el refresher de plataforma renueva de verdad y pasa la conexión al log', async () => {
  const { core, log } = await oauthCore('youtube', [['oauth.token', 'refresh.ok']]);
  const fresh = await createYouTubeRefresher(core, CFG).refresh(CURRENT, { connectionId: '00000002-0000-4000-8000-0000000000c8' });
  assert.equal(fresh.accessToken, 'ya29.demo-access-youtube-0002-SECRETO');
  assert.equal(log.entries[0]!.connection_id, '00000002-0000-4000-8000-0000000000c8');
});

test('identity: channels.list?mine=true con el token recién emitido; el token va en la cabecera, nunca en la URL', async () => {
  const { core, fetch } = await oauthCore('youtube', [['channels.list', 'mine.ok']]);
  const profile = await youtubeIdentity(core, CURRENT);
  assert.equal(profile.external_account_id, 'UCdemo000000000000000001');
  assert.equal(profile.handle, 'lauracocinafacil');
  assert.equal(profile.account_type, 'channel');
  assert.equal(fetch.calls[0]!.headers['Authorization'], '[REDACTADO]');
  assert.ok(!fetch.calls[0]!.url.includes('key='), 'con token no se manda la API key');
  assert.equal(assertNoSecrets([fetch.calls[0]!.url], SECRETS), null);
});

test('identity de una cuenta de Google sin canal: definitivo no_channel, con la frase que lo explica', async () => {
  const { core } = await oauthCore('youtube', [['channels.list', 'mine.empty']]);
  await assert.rejects(youtubeIdentity(core, CURRENT), (e: unknown) => e instanceof PlatformApiError && e.kind === 'permanent' && e.code === 'no_channel' && /no tiene ningún canal/.test(e.messageEs));
});
