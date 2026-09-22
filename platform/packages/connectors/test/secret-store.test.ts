import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnvSecretStore, InMemorySecretStore } from '../src/secret-store.ts';
import type { OAuthTokens } from '../src/types.ts';

const tokens: OAuthTokens = {
  accessToken: 'acc-1',
  refreshToken: 'ref-1',
  accessExpiresAt: new Date('2026-09-22T10:00:00Z'),
  refreshExpiresAt: new Date('2027-09-22T10:00:00Z'),
  scopes: ['user.info.basic'],
};

test('InMemorySecretStore guarda y devuelve copias, no referencias', async () => {
  const store = new InMemorySecretStore();
  assert.equal(await store.get('vault:x'), null);
  await store.set('vault:x', tokens);
  const got = await store.get('vault:x');
  assert.deepEqual(got, tokens);
  got!.accessToken = 'mutado';
  got!.scopes.push('otro');
  assert.deepEqual(await store.get('vault:x'), tokens);
  assert.equal(store.writes.get('vault:x'), 1);
});

test('EnvSecretStore lee JSON de la variable que nombra el ref', async () => {
  const env = {
    TIKTOK_DEMO: JSON.stringify({
      accessToken: 'acc-env',
      refreshToken: 'ref-env',
      accessExpiresAt: '2026-09-22T10:00:00Z',
      scopes: ['user.info.basic', 'video.list'],
    }),
  };
  const store = new EnvSecretStore(env);
  const got = await store.get('env:TIKTOK_DEMO');
  assert.equal(got?.accessToken, 'acc-env');
  assert.equal(got?.accessExpiresAt.toISOString(), '2026-09-22T10:00:00.000Z');
  assert.deepEqual(got?.scopes, ['user.info.basic', 'video.list']);
  assert.equal(got?.refreshExpiresAt, undefined);
});

test('EnvSecretStore devuelve null sin variable y rechaza refs de otro tipo', async () => {
  const store = new EnvSecretStore({});
  assert.equal(await store.get('env:NO_EXISTE'), null);
  assert.equal(await store.get('vault:abc'), null);
  await assert.rejects(store.set('vault:abc', tokens), /prefijo env:/);
});

test('EnvSecretStore: set() sobrescribe en memoria hasta el reinicio', async () => {
  const env = { X: JSON.stringify({ accessToken: 'viejo', accessExpiresAt: '2026-01-01T00:00:00Z', scopes: [] }) };
  const store = new EnvSecretStore(env);
  await store.set('env:X', tokens);
  assert.equal((await store.get('env:X'))?.accessToken, 'acc-1');
});

test('EnvSecretStore explica un JSON roto', async () => {
  const store = new EnvSecretStore({ ROTO: '{no es json' });
  await assert.rejects(store.get('env:ROTO'), /JSON válido/);
});
