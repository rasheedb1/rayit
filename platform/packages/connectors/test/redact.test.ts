import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, REDACTED_TOKENS, isSecretKey, redactSecrets } from '../src/redact.ts';
import type { OAuthTokens } from '../src/types.ts';

const tokens: OAuthTokens = {
  accessToken: 'ACCESO-SECRETO-123',
  refreshToken: 'REFRESCO-SECRETO-456',
  accessExpiresAt: new Date('2026-09-22T10:00:00Z'),
  scopes: ['a'],
};

test('un OAuthTokens se tapa entero, a cualquier profundidad', () => {
  const out = JSON.stringify(redactSecrets({ ctx: { conexion: { tokens } }, lista: [tokens] }));
  assert.ok(!out.includes('ACCESO-SECRETO'));
  assert.ok(!out.includes('REFRESCO-SECRETO'));
  assert.ok(out.includes(REDACTED_TOKENS));
});

test('las llaves con nombre de secreto se tapan; secret_ref se conserva', () => {
  const out = redactSecrets({
    accessToken: 'x', refresh_token: 'y', client_secret: 'z', Authorization: 'Bearer q', apiKey: 'k', password: 'p',
    secret_ref: 'vault:conn/1', platform_id: 'tiktok', expires_in: 3600, nulo: null,
  }) as Record<string, unknown>;
  assert.equal(out['accessToken'], REDACTED);
  assert.equal(out['refresh_token'], REDACTED);
  assert.equal(out['client_secret'], REDACTED);
  assert.equal(out['Authorization'], REDACTED);
  assert.equal(out['apiKey'], REDACTED);
  assert.equal(out['password'], REDACTED);
  assert.equal(out['secret_ref'], 'vault:conn/1');
  assert.equal(out['platform_id'], 'tiktok');
  assert.equal(out['expires_in'], 3600);
  assert.equal(out['nulo'], null);
});

test('errores, fechas, mapas y arreglos sobreviven la redacción', () => {
  const err = new Error('falló', { cause: { token: 'oculto' } });
  const out = redactSecrets({ err, when: new Date(0), m: new Map([['refreshToken', 'x']]), arr: [{ token: 't' }] }) as Record<string, unknown>;
  const e = out['err'] as Record<string, unknown>;
  assert.equal(e['message'], 'falló');
  assert.ok(typeof e['stack'] === 'string');
  assert.deepEqual(e['cause'], { token: REDACTED });
  assert.ok(out['when'] instanceof Date);
  assert.deepEqual(out['m'], { refreshToken: REDACTED });
  assert.deepEqual(out['arr'], [{ token: REDACTED }]);
});

test('isSecretKey', () => {
  for (const k of ['accessToken', 'ACCESS_TOKEN', 'refresh-token', 'id_token', 'tokens', 'clientSecret', 'private_key', 'credentials']) {
    assert.equal(isSecretKey(k), true, k);
  }
  for (const k of ['secret_ref', 'secretRef', 'platform_id', 'expiresAt', 'scopes', 'id']) {
    assert.equal(isSecretKey(k), false, k);
  }
});

test('no muta la entrada', () => {
  const input = { accessToken: 'vivo', nested: { refreshToken: 'vivo' } };
  redactSecrets(input);
  assert.equal(input.accessToken, 'vivo');
  assert.equal(input.nested.refreshToken, 'vivo');
});

test('un ciclo se marca como [circular]; un objeto repetido en dos ramas no', () => {
  const circular: Record<string, unknown> = { a: 1 };
  circular['self'] = circular;
  assert.deepEqual(redactSecrets(circular), { a: 1, self: '[circular]' });
  const shared = { x: 1 };
  assert.deepEqual(redactSecrets({ a: shared, b: shared }), { a: { x: 1 }, b: { x: 1 } });
});
