import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTokenRefresher, planByTokenPrefix } from '../src/fakes/fake-token-refresher.ts';
import { TokenRefreshError, kindFromHttp, refresherRegistry } from '../src/token-refresher.ts';
import type { OAuthTokens } from '../src/types.ts';

const base = (accessToken: string): OAuthTokens => ({
  accessToken,
  refreshToken: 'ref-0',
  accessExpiresAt: new Date('2026-09-21T10:00:00Z'),
  refreshExpiresAt: new Date('2027-09-21T10:00:00Z'),
  scopes: ['a'],
});

test('éxito: token nuevo, refresh rotado, vencimiento en 24 h, scopes intactos', async () => {
  const now = new Date('2026-09-21T09:50:00Z');
  const r = new FakeTokenRefresher('tiktok', { now: () => now });
  const out = await r.refresh(base('ok-1'));
  assert.notEqual(out.accessToken, 'ok-1');
  assert.match(out.accessToken, /^renewed-/);
  assert.notEqual(out.refreshToken, 'ref-0');
  assert.equal(out.accessExpiresAt.toISOString(), '2026-09-22T09:50:00.000Z');
  assert.deepEqual(out.scopes, ['a']);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]?.outcome, 'success');
});

test('fallo transitorio y definitivo según el prefijo del token', async () => {
  const r = new FakeTokenRefresher('tiktok');
  await assert.rejects(r.refresh(base('flaky-1')), (e: unknown) => e instanceof TokenRefreshError && e.kind === 'transient' && e.httpStatus === 503);
  await assert.rejects(r.refresh(base('revoked-1')), (e: unknown) => e instanceof TokenRefreshError && e.kind === 'permanent' && e.code === 'invalid_grant');
  assert.deepEqual(r.calls.map((c) => c.outcome), ['transient', 'permanent']);
});

test('un plan explícito manda sobre el prefijo', async () => {
  const r = new FakeTokenRefresher('youtube', { plan: (_t, i) => (i === 0 ? { kind: 'transient' } : { kind: 'success' }) });
  await assert.rejects(r.refresh(base('ok')));
  const out = await r.refresh(base('ok'));
  assert.match(out.accessToken, /^renewed-/);
  assert.equal(planByTokenPrefix(base('ok')).kind, 'success');
});

test('una señal abortada corta la llamada como transitoria', async () => {
  const r = new FakeTokenRefresher('instagram', { latencyMs: 200 });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(r.refresh(base('ok'), { signal: ac.signal }), (e: unknown) => e instanceof TokenRefreshError && e.code === 'aborted');
});

test('kindFromHttp clasifica como esperan las plataformas', () => {
  assert.equal(kindFromHttp(429), 'transient');
  assert.equal(kindFromHttp(503), 'transient');
  assert.equal(kindFromHttp(400, 'invalid_grant'), 'permanent');
  assert.equal(kindFromHttp(401), 'permanent');
  assert.equal(kindFromHttp(200), 'transient');
});

test('el registro rechaza dos refreshers de la misma plataforma', () => {
  const a = new FakeTokenRefresher('tiktok');
  assert.throws(() => refresherRegistry([a, new FakeTokenRefresher('tiktok')]), /Dos refreshers/);
  assert.equal(refresherRegistry([a]).get('tiktok'), a);
});
