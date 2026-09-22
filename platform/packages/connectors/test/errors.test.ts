import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindFor } from '../src/http/errors.ts';
import { backoffMs, parseRetryAfter } from '../src/http/retry.ts';

test('clasificación por plataforma y código', () => {
  assert.equal(kindFor('tiktok', 401, 'access_token_invalid'), 'auth');
  assert.equal(kindFor('tiktok', 401, 'scope_not_authorized'), 'auth');
  assert.equal(kindFor('tiktok', 200, '40104'), 'auth', 'Accounts API: 40100–40199');
  assert.equal(kindFor('tiktok', 200, '40001'), 'permanent');
  assert.equal(kindFor('tiktok', 200, '50002'), 'transient');
  assert.equal(kindFor('tiktok', 429, '40022'), 'transient', 'el 429 manda sobre el código numérico');
  assert.equal(kindFor('tiktok', 429, 'rate_limit_exceeded'), 'transient');
  assert.equal(kindFor('tiktok', 400, 'scope_permission_missed'), 'permanent');
  assert.equal(kindFor('instagram', 400, '190'), 'auth', 'Meta 190 = token');
  assert.equal(kindFor('instagram', 400, '4'), 'quota');
  assert.equal(kindFor('instagram', 400, '80002'), 'quota');
  assert.equal(kindFor('instagram', 400, '100'), 'permanent');
  assert.equal(kindFor('instagram', 400, '1'), 'transient', 'Meta 1 y 2 son transitorios aunque vengan con 400');
  assert.equal(kindFor('instagram', 400, '2'), 'transient');
  assert.equal(kindFor('youtube', 403, 'quotaExceeded'), 'quota');
  assert.equal(kindFor('youtube', 403, 'dailyLimitExceeded'), 'quota');
  assert.equal(kindFor('youtube', 403, 'rateLimitExceeded'), 'transient');
  assert.equal(kindFor('youtube', 401, 'authError'), 'auth');
  assert.equal(kindFor('youtube', 404, 'playlistNotFound'), 'permanent');
  assert.equal(kindFor('youtube', 503, undefined), 'transient');
  assert.equal(kindFor('youtube', undefined, undefined), 'transient');
  assert.equal(kindFor('youtube', 400, 'invalid_grant'), 'permanent', 'PERMANENT_CODES del refresher');
});

test('backoff exponencial con jitter completo y tope', () => {
  const policy = { maxRetries: 3, baseMs: 1000, factor: 2, maxMs: 30_000 };
  assert.equal(backoffMs(policy, 1, () => 1), 1000);
  assert.equal(backoffMs(policy, 2, () => 1), 2000);
  assert.equal(backoffMs(policy, 3, () => 0.5), 2000);
  assert.equal(backoffMs(policy, 10, () => 1), 30_000);
  assert.equal(backoffMs(policy, 1, () => 0), 0);
});

test('Retry-After en segundos o como fecha HTTP', () => {
  const now = new Date('2026-09-22T10:00:00Z');
  assert.equal(parseRetryAfter('7', now), 7);
  assert.equal(parseRetryAfter('Tue, 22 Sep 2026 10:00:30 GMT', now), 30);
  assert.equal(parseRetryAfter('Tue, 22 Sep 2026 09:00:00 GMT', now), 0);
  assert.equal(parseRetryAfter('mañana', now), undefined);
  assert.equal(parseRetryAfter(null, now), undefined);
});
