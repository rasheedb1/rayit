/** CON-3 · sello HMAC de la cookie del flujo OAuth: firma, caducidad, manipulación. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openSealedValue, sealValue, sealingKey } from '../src/crypto/sealed-cookie.ts';

const KEY = sealingKey(new Uint8Array(randomBytes(32)));
const OTHER = sealingKey(new Uint8Array(randomBytes(32)));
const T0 = new Date('2026-09-22T10:00:00Z');
const payload = { state: 'abc', platform: 'tiktok', creatorId: '00000002-0000-4000-8000-000000000003' };

test('abre lo que selló con la misma clave dentro del TTL', () => {
  const sealed = sealValue(payload, KEY, T0);
  assert.ok(!sealed.includes('"'), 'la cookie es base64url.base64url');
  const r = openSealedValue<typeof payload>(sealed, KEY, new Date(T0.getTime() + 5 * 60_000));
  assert.ok(r.ok);
  assert.deepEqual(r.payload, payload);
  assert.equal(r.issuedAt.toISOString(), T0.toISOString());
});

test('vence a los 10 minutos y rechaza instantes anteriores a la emisión', () => {
  const sealed = sealValue(payload, KEY, T0);
  assert.deepEqual(openSealedValue(sealed, KEY, new Date(T0.getTime() + 10 * 60_000 + 1)), { ok: false, reason: 'expired' });
  assert.deepEqual(openSealedValue(sealed, KEY, new Date(T0.getTime() - 1)), { ok: false, reason: 'expired' });
  assert.ok(openSealedValue(sealed, KEY, new Date(T0.getTime() + 10 * 60_000)).ok, 'exactamente 10 minutos todavía vale');
});

test('otra clave, un byte cambiado o un formato raro no abren', () => {
  const sealed = sealValue(payload, KEY, T0);
  assert.deepEqual(openSealedValue(sealed, OTHER, T0), { ok: false, reason: 'bad_signature' });
  const [body, mac] = sealed.split('.') as [string, string];
  const flipped = body.slice(0, -2) + (body.at(-2) === 'A' ? 'B' : 'A') + body.slice(-1);
  assert.deepEqual(openSealedValue(`${flipped}.${mac}`, KEY, T0), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(openSealedValue(undefined, KEY, T0), { ok: false, reason: 'malformed' });
  assert.deepEqual(openSealedValue('sin-punto', KEY, T0), { ok: false, reason: 'malformed' });
  assert.deepEqual(openSealedValue('cuerpo.', KEY, T0), { ok: false, reason: 'malformed' });
});
