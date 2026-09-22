/**
 * Núcleo HTTP con fetch falso y reloj falso (CON-1 · fase 2).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { HttpCore, type ApiRequest } from '../src/http/client.ts';
import { PlatformApiError } from '../src/http/errors.ts';
import { InMemoryCallLogSink } from '../src/log/memory.ts';
import { QuotaManager } from '../src/quota/manager.ts';
import { withoutNetwork, type NetworkGuard } from '../src/testing/fixture-fetch.ts';
import type { OAuthTokens } from '../src/types.ts';
import { FakeClock, jsonResponse } from './helpers/fake-clock.ts';

let guard: NetworkGuard;
before(() => { guard = withoutNetwork(); });
after(() => { guard.restore(); });

const TOKENS: OAuthTokens = { accessToken: 'ACCESS-SECRETO-abcdef', refreshToken: 'REFRESH-SECRETO-ghijk', accessExpiresAt: new Date('2027-01-01T00:00:00Z'), scopes: ['video.list'] };
const CONN = '00000002-0000-4000-8000-0000000000c2';

function tiktokError(status: number, body: unknown) {
  const b = body as { error?: { code?: string; message?: string; log_id?: string } } | null;
  if (b?.error && b.error.code && b.error.code !== 'ok') return { code: b.error.code, message: b.error.message, requestId: b.error.log_id };
  return status >= 400 ? { code: `http_${status}` } : null;
}

function request(overrides: Partial<ApiRequest> = {}): ApiRequest {
  return {
    platformId: 'tiktok', family: 'tiktok', endpoint: 'tiktok.video.list', method: 'POST',
    url: 'https://open.tiktokapis.com/v2/video/list/', query: { fields: 'id,title' }, body: { max_count: 20 },
    connectionId: CONN, tokens: TOKENS, authStyle: 'bearer', parseError: tiktokError, ...overrides,
  };
}

async function expectError(p: Promise<unknown>): Promise<PlatformApiError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof PlatformApiError, `esperaba PlatformApiError, llegó ${String(e)}`);
    return e;
  }
  throw new Error('esperaba un error y la llamada terminó bien');
}

function setup(responses: Array<() => Response | Promise<Response>>) {
  const clock = new FakeClock();
  const log = new InMemoryCallLogSink();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`fetch falso sin respuesta para la llamada ${calls.length}`);
    return next();
  };
  const quota = new QuotaManager({ now: clock.now, sleep: clock.sleep });
  const core = new HttpCore({ callLog: log, quota, fetch, now: clock.now, sleep: clock.sleep, random: () => 1 });
  return { clock, log, calls, core };
}

test('reintento tras 503 → ok, con dos filas en el log y una sola espera del reloj falso', async () => {
  const { clock, log, calls, core } = setup([
    () => jsonResponse(503, { error: { code: 'internal_error', message: 'boom', log_id: 'L1' } }),
    () => jsonResponse(200, { data: { videos: [] }, error: { code: 'ok', message: '', log_id: 'L2' } }),
  ]);
  const res = await core.call<{ data: { videos: unknown[] } }>(request());
  assert.equal(res.status, 200);
  assert.equal(res.attempts, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(clock.sleeps, [1000], 'backoff base de 1 s con random = 1');
  assert.equal(log.entries.length, 2);
  assert.equal(log.entries[0]!.ok, false);
  assert.equal(log.entries[0]!.http_status, 503);
  assert.equal(log.entries[0]!.error_code, 'internal_error');
  assert.equal(log.entries[1]!.ok, true);
  assert.equal(log.entries[1]!.http_status, 200);
  assert.equal(log.entries[1]!.connection_id, CONN);
  assert.ok(log.entries.every((e) => e.duration_ms !== null && e.duration_ms >= 0));
  assert.equal(guard.attempts, 0, 'nada salió por globalThis.fetch');
});

test('429 con Retry-After 7 → espera 7 s del reloj falso, no del real', async () => {
  const { clock, log, core } = setup([
    () => jsonResponse(429, { error: { code: 'rate_limit_exceeded', message: 'slow down', log_id: 'L1' } }, { 'retry-after': '7' }),
    () => jsonResponse(200, { data: {}, error: { code: 'ok', message: '', log_id: 'L2' } }),
  ]);
  const t0 = Date.now();
  await core.call(request());
  assert.ok(Date.now() - t0 < 2000, 'no esperó en tiempo real');
  assert.deepEqual(clock.sleeps, [7000]);
  assert.equal(log.entries[0]!.rate_limited, true);
  assert.equal(log.entries[0]!.retry_after_s, 7);
});

test('401 → no reintenta y kind auth; el token no aparece en el error ni en el log', async () => {
  const { log, calls, core } = setup([
    () => jsonResponse(401, { error: { code: 'access_token_invalid', message: `token ${TOKENS.accessToken} rejected`, log_id: 'L1' } }),
  ]);
  const err = await expectError(core.call(request()));
  assert.equal(err.kind, 'auth');
  assert.equal(err.code, 'access_token_invalid');
  assert.equal(err.httpStatus, 401);
  assert.equal(calls.length, 1);
  const serialized = JSON.stringify({ message: err.message, messageEs: err.messageEs, stack: err.stack, entries: log.entries });
  assert.ok(!serialized.includes(TOKENS.accessToken), 'el access token no se serializa');
  assert.ok(!serialized.includes(TOKENS.refreshToken!), 'el refresh token no se serializa');
  assert.ok(log.entries[0]!.error_message!.includes('[REDACTADO]'));
  // El token sí viajó en la cabecera y nunca en la URL.
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers['Authorization'], `Bearer ${TOKENS.accessToken}`);
  assert.ok(!calls[0]!.url.includes(TOKENS.accessToken));
});

test('400 con invalid_params → permanent sin reintento; 404 → permanent', async () => {
  const a = setup([() => jsonResponse(400, { error: { code: 'invalid_params', message: 'bad', log_id: 'L' } })]);
  const e1 = await expectError(a.core.call(request()));
  assert.equal(e1.kind, 'permanent');
  assert.equal(a.calls.length, 1);
  const b = setup([() => jsonResponse(404, null)]);
  const e2 = await expectError(b.core.call(request()));
  assert.equal(e2.kind, 'permanent');
});

test('señal abortada → error transitorio y ninguna llamada más', async () => {
  const ctrl = new AbortController();
  const { calls, core, log } = setup([
    () => { ctrl.abort(); return jsonResponse(503, { error: { code: 'internal_error', message: '', log_id: 'L' } }); },
    () => jsonResponse(200, {}),
  ]);
  const err = await expectError(core.call(request({ signal: ctrl.signal })));
  assert.equal(err.kind, 'transient');
  assert.equal(calls.length, 1, 'tras abortar no se llama más');
  assert.equal(log.entries.length, 1);
  // Y si ya estaba abortada antes de empezar: ninguna llamada.
  const again = await expectError(core.call(request({ signal: ctrl.signal })));
  assert.equal(again.code, 'aborted');
  assert.equal(calls.length, 1);
});

test('fallo de red → transitorio con reintento; se agotan los reintentos → lanza el último', async () => {
  const { calls, core, log } = setup([
    () => { throw new TypeError('fetch failed'); },
    () => { throw new TypeError('fetch failed'); },
    () => { throw new TypeError('fetch failed'); },
    () => { throw new TypeError('fetch failed'); },
  ]);
  const err = await expectError(core.call(request()));
  assert.equal(err.kind, 'transient');
  assert.equal(err.code, 'network');
  assert.equal(calls.length, 4, '1 intento + 3 reintentos');
  assert.equal(log.entries.length, 4);
  assert.ok(log.entries.every((e) => e.http_status === null && e.error_code === 'network'));
});

test('escribir el log nunca tumba la llamada', async () => {
  const { log, core } = setup([() => jsonResponse(200, { data: {}, error: { code: 'ok' } })]);
  log.failWith = new Error('api_call_log caída');
  const res = await core.call(request());
  assert.equal(res.status, 200);
});

test('cuota por minuto: la llamada 41 del mismo endpoint y conexión espera hasta que se libere la ventana', async () => {
  const responses = Array.from({ length: 41 }, () => () => jsonResponse(200, { data: {}, error: { code: 'ok' } }));
  const { clock, core } = setup(responses);
  for (let i = 0; i < 40; i++) {
    await core.call(request());
    clock.advance(100);
  }
  assert.deepEqual(clock.sleeps, [], 'las primeras 40 no esperan');
  await core.call(request());
  assert.equal(clock.sleeps.length, 1);
  // La primera llamada fue en t0; la ventana de 60 s se libera 60 s después de ella.
  assert.equal(clock.sleeps[0], 60_000 - 40 * 100);
});

test('presupuesto diario agotado → kind quota sin llamar, con su fila en el log', async () => {
  const { log, calls, core } = setup([() => jsonResponse(200, {})]);
  const youtube = (): ApiRequest => request({
    platformId: 'youtube', family: 'youtube', endpoint: 'youtube.videos.list', method: 'GET',
    url: 'https://www.googleapis.com/youtube/v3/videos', body: undefined, connectionId: null, units: 9_999,
    parseError: (s) => (s >= 400 ? { code: `http_${s}` } : null),
  });
  await core.call(youtube());
  const err = await expectError(core.call(youtube()));
  assert.equal(err.kind, 'quota');
  assert.equal(err.code, 'quota_exhausted');
  assert.equal(calls.length, 1, 'la segunda no llamó');
  assert.equal(log.entries.length, 2);
  assert.equal(log.entries[1]!.http_status, null);
  assert.equal(log.entries[1]!.error_code, 'quota_exhausted');
});
