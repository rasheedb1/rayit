/**
 * CON-3 · cifrado en reposo: ida y vuelta, manipulación detectada, clave
 * equivocada, AAD equivocada y rotación de versión.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { keyringFromEnv, keyringOf, MasterKeyError, parseMasterKey } from '../src/crypto/master-key.ts';
import { decodeTokens, encodeTokens, TokenCipher, TokenCipherError, GCM_IV_BYTES, GCM_TAG_BYTES } from '../src/crypto/token-cipher.ts';
import type { OAuthTokens } from '../src/types.ts';

const K1 = new Uint8Array(randomBytes(32));
const K2 = new Uint8Array(randomBytes(32));
const REF = 'enc:tiktok:2b1c6c1e-6f39-4a67-9c3e-0d1a0e6c1a11';
const TOKENS: OAuthTokens = {
  accessToken: 'ACCESS-SECRETO-abc123',
  refreshToken: 'REFRESH-SECRETO-def456',
  accessExpiresAt: new Date('2026-09-23T12:00:00Z'),
  refreshExpiresAt: new Date('2027-09-22T12:00:00Z'),
  scopes: ['user.info.basic', 'video.list'],
};

test('ida y vuelta: lo cifrado no contiene el token y descifra igual', () => {
  const cipher = new TokenCipher(keyringOf({ v1: K1 }));
  const blob = cipher.encryptTokens(TOKENS, REF);
  assert.equal(blob.keyVersion, 'v1');
  assert.equal(blob.iv.length, GCM_IV_BYTES);
  assert.equal(blob.tag.length, GCM_TAG_BYTES);
  const asText = Buffer.from(blob.ciphertext).toString('latin1') + Buffer.from(blob.ciphertext).toString('base64');
  assert.ok(!asText.includes(TOKENS.accessToken) && !asText.includes(TOKENS.refreshToken!), 'el token no aparece en el ciphertext');
  assert.deepEqual(cipher.decryptTokens(blob, REF), TOKENS);
});

test('dos cifrados del mismo texto tienen IV y ciphertext distintos', () => {
  const cipher = new TokenCipher(keyringOf({ v1: K1 }));
  const a = cipher.encryptTokens(TOKENS, REF);
  const b = cipher.encryptTokens(TOKENS, REF);
  assert.notDeepEqual(a.iv, b.iv);
  assert.notDeepEqual(a.ciphertext, b.ciphertext);
});

test('manipular un byte del ciphertext o del tag se detecta', () => {
  const cipher = new TokenCipher(keyringOf({ v1: K1 }));
  const blob = cipher.encryptTokens(TOKENS, REF);
  const tampered = { ...blob, ciphertext: new Uint8Array(blob.ciphertext) };
  tampered.ciphertext[0]! ^= 0x01;
  assert.throws(() => cipher.decryptTokens(tampered, REF), (e: unknown) => e instanceof TokenCipherError && e.code === 'auth_failed');
  const badTag = { ...blob, tag: new Uint8Array(blob.tag) };
  badTag.tag[3]! ^= 0x80;
  assert.throws(() => cipher.decryptTokens(badTag, REF), (e: unknown) => e instanceof TokenCipherError && e.code === 'auth_failed');
});

test('clave equivocada y AAD (ref) equivocada fallan sin revelar nada', () => {
  const blob = new TokenCipher(keyringOf({ v1: K1 })).encryptTokens(TOKENS, REF);
  const other = new TokenCipher(keyringOf({ v1: K2 }));
  assert.throws(() => other.decryptTokens(blob, REF), (e: unknown) => e instanceof TokenCipherError && e.code === 'auth_failed' && !e.message.includes(TOKENS.accessToken));
  const same = new TokenCipher(keyringOf({ v1: K1 }));
  assert.throws(() => same.decryptTokens(blob, 'enc:tiktok:otra-ref'), (e: unknown) => e instanceof TokenCipherError && e.code === 'auth_failed');
});

test('rotación: v1 se descifra con el llavero nuevo y se reescribe como v2; v1 solo no lee v2', () => {
  const old = new TokenCipher(keyringOf({ v1: K1 }));
  const blobV1 = old.encryptTokens(TOKENS, REF);
  const rotated = new TokenCipher(keyringOf({ v1: K1, v2: K2 }, 'v2'));
  assert.equal(rotated.currentVersion, 'v2');
  assert.equal(rotated.needsRotation(blobV1.keyVersion), true);
  const plain = rotated.decryptTokens(blobV1, REF);
  const blobV2 = rotated.encryptTokens(plain, REF);
  assert.equal(blobV2.keyVersion, 'v2');
  assert.equal(rotated.needsRotation(blobV2.keyVersion), false);
  assert.deepEqual(rotated.decryptTokens(blobV2, REF), TOKENS);
  assert.throws(() => old.decryptTokens(blobV2, REF), (e: unknown) => e instanceof TokenCipherError && e.code === 'unknown_key_version');
  // Sin CURRENT explícito, la versión más alta manda.
  assert.equal(keyringOf({ v1: K1, v2: K2 }).current, 'v2');
});

test('encodeTokens/decodeTokens conservan fechas y scopes; refreshToken ausente queda undefined', () => {
  const sinRefresh: OAuthTokens = { accessToken: 'a', accessExpiresAt: new Date('2026-11-21T00:00:00Z'), scopes: [] };
  assert.deepEqual(decodeTokens(encodeTokens(sinRefresh)), sinRefresh);
  assert.throws(() => decodeTokens('{no json'), (e: unknown) => e instanceof TokenCipherError && e.code === 'bad_input');
  assert.throws(() => decodeTokens('{"accessToken":1}'), (e: unknown) => e instanceof TokenCipherError && e.code === 'bad_input');
});

test('parseMasterKey acepta base64 de 32 bytes y hex de 64, y rechaza lo demás sin imprimir el valor', () => {
  const b64 = Buffer.from(K1).toString('base64');
  assert.equal(b64.length, 44, 'mismo formato que la del vault');
  assert.deepEqual(parseMasterKey(b64), K1);
  assert.deepEqual(parseMasterKey(Buffer.from(K1).toString('hex')), K1);
  assert.deepEqual(parseMasterKey(Buffer.from(K1).toString('base64url')), K1);
  assert.throws(() => parseMasterKey(undefined), (e: unknown) => e instanceof MasterKeyError && /Falta TOKEN_ENCRYPTION_KEY/.test(e.message));
  const corta = Buffer.from(K1.subarray(0, 16)).toString('base64');
  assert.throws(() => parseMasterKey(corta), (e: unknown) => e instanceof MasterKeyError && /16 bytes/.test(e.message) && !e.message.includes(corta));
  assert.throws(() => parseMasterKey('no válida!!'), (e: unknown) => e instanceof MasterKeyError && !e.message.includes('válida!!'));
});

test('keyringFromEnv: NOMBRE es v1, NOMBRE_V2 se suma y NOMBRE_CURRENT elige', () => {
  const env = { TOKEN_ENCRYPTION_KEY: Buffer.from(K1).toString('base64'), TOKEN_ENCRYPTION_KEY_V2: Buffer.from(K2).toString('base64') };
  const ring = keyringFromEnv(env);
  assert.deepEqual([...ring.keys.keys()], ['v1', 'v2']);
  assert.equal(ring.current, 'v2');
  assert.equal(keyringFromEnv({ ...env, TOKEN_ENCRYPTION_KEY_CURRENT: 'v1' }).current, 'v1');
  assert.throws(() => keyringFromEnv({ ...env, TOKEN_ENCRYPTION_KEY_CURRENT: 'v9' }), MasterKeyError);
  // Retirar la v1 tras rotar: con otra versión presente ya no es obligatoria.
  const soloV2 = keyringFromEnv({ TOKEN_ENCRYPTION_KEY_V2: Buffer.from(K2).toString('base64') });
  assert.deepEqual([...soloV2.keys.keys()], ['v2']);
  assert.equal(soloV2.current, 'v2');
  assert.throws(() => keyringFromEnv({}), (e: unknown) => e instanceof MasterKeyError && /Falta TOKEN_ENCRYPTION_KEY/.test(e.message));
});
