/**
 * CON-3 · EncryptedSecretStore sobre pglite con la migración 0015 real:
 * get() de una ref inexistente es null; dos set() dejan una fila; lo
 * guardado no contiene el token; RLS separa workspaces; rotate() reescribe.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { EncryptedSecretStore, isEncryptedRef, newSecretRef } from '../src/encrypted-secret-store.ts';
import { keyringOf } from '../src/crypto/master-key.ts';
import { TokenCipher, TokenCipherError } from '../src/crypto/token-cipher.ts';
import type { OAuthTokens } from '../src/types.ts';
import { WORKSPACE_ID, type executor, openMigratedPglite, seedConnections } from './helpers/pglite.ts';

const OTHER_WORKSPACE = '00000009-0000-4000-8000-000000000001';
const K1 = new Uint8Array(randomBytes(32));
const K2 = new Uint8Array(randomBytes(32));
const TOKENS: OAuthTokens = {
  accessToken: 'ACCESS-SECRETO-store-111',
  refreshToken: 'REFRESH-SECRETO-store-222',
  accessExpiresAt: new Date('2026-09-23T12:00:00Z'),
  refreshExpiresAt: new Date('2027-09-22T12:00:00Z'),
  scopes: ['user.info.basic'],
};

let db: PGlite;
before(async () => {
  db = await openMigratedPglite();
  await seedConnections(db);
  await db.exec(`INSERT INTO workspace (id, slug, name) VALUES ('${OTHER_WORKSPACE}', 'otro', 'Otro')`);
});
after(async () => { await db.close(); });

/** Como la web: transacción con el workspace fijado y sin BYPASSRLS (pglite corre como superusuario, así que el rol se cambia a uno normal). */
async function asWorkspace<T>(workspaceId: string, fn: (store: EncryptedSecretStore, q: ReturnType<typeof executor>) => Promise<T>, cipher = new TokenCipher(keyringOf({ v1: K1 }))): Promise<T> {
  await db.exec(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mc_app_test') THEN CREATE ROLE mc_app_test NOLOGIN; END IF; END $$;
    GRANT USAGE ON SCHEMA public TO mc_app_test; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mc_app_test;`);
  return db.transaction(async (tx) => {
    await tx.query('SET LOCAL ROLE mc_app_test');
    await tx.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const q = { query: (text: string, params: readonly unknown[] = []) => tx.query(text, params as unknown[]) };
    return fn(new EncryptedSecretStore({ db: q, cipher }), q);
  });
}

test('get() de una ref inexistente devuelve null; una ref que no es enc: se rechaza en set()', async () => {
  await asWorkspace(WORKSPACE_ID, async (store) => {
    assert.equal(await store.get(newSecretRef('tiktok')), null);
    await assert.rejects(store.set('vault://demo/tiktok/laura', TOKENS), /enc:<proveedor>:<uuid>/);
  });
  assert.equal(isEncryptedRef('enc:tiktok-business:2b1c6c1e-6f39-4a67-9c3e-0d1a0e6c1a11'), true);
  assert.equal(isEncryptedRef('enc:tiktok:no-uuid'), false);
});

test('dos set() seguidos dejan UNA fila, la segunda gana, y lo guardado no contiene el token en claro', async () => {
  const ref = newSecretRef('tiktok');
  const renewed: OAuthTokens = { ...TOKENS, accessToken: 'ACCESS-SECRETO-store-333', refreshToken: 'REFRESH-SECRETO-store-444' };
  await asWorkspace(WORKSPACE_ID, async (store) => {
    await store.set(ref, TOKENS);
    await store.set(ref, renewed);
    assert.deepEqual(await store.get(ref), renewed);
  });
  const rows = await db.query<{ n: string | number }>(`SELECT count(*)::int AS n FROM connection_secret WHERE secret_ref = $1`, [ref]);
  assert.equal(Number(rows.rows[0]!.n), 1);
  const raw = await db.query<{ workspace_id: string; key_version: string; hex: string; created_at: Date; updated_at: Date }>(
    `SELECT workspace_id, key_version, encode(ciphertext, 'hex') || encode(iv, 'hex') || encode(tag, 'hex') AS hex, created_at, updated_at FROM connection_secret WHERE secret_ref = $1`, [ref]);
  const r = raw.rows[0]!;
  assert.equal(r.workspace_id, WORKSPACE_ID, 'current_workspace_id() puso el workspace');
  assert.equal(r.key_version, 'v1');
  const plainHex = [TOKENS.accessToken, TOKENS.refreshToken!, renewed.accessToken, renewed.refreshToken!].map((s) => Buffer.from(s, 'utf8').toString('hex'));
  for (const h of plainHex) assert.ok(!r.hex.includes(h), 'el token no está en claro en la fila');
  assert.ok(new Date(r.updated_at).getTime() >= new Date(r.created_at).getTime());
});

test('RLS: otro workspace no lee ni borra la ref, y el propio sí', async () => {
  const ref = newSecretRef('instagram');
  await asWorkspace(WORKSPACE_ID, (store) => store.set(ref, TOKENS));
  await asWorkspace(OTHER_WORKSPACE, async (store) => {
    assert.equal(await store.get(ref), null, 'para el otro workspace la fila no existe');
    await store.delete(ref);
  });
  await asWorkspace(WORKSPACE_ID, async (store) => {
    assert.deepEqual(await store.get(ref), TOKENS, 'el borrado ajeno no tocó nada');
    await store.delete(ref);
    assert.equal(await store.get(ref), null);
  });
});

test('otro workspace tampoco puede escribir sobre una ref ajena (el UPSERT choca con la política)', async () => {
  const ref = newSecretRef('tiktok');
  await asWorkspace(WORKSPACE_ID, (store) => store.set(ref, TOKENS));
  await assert.rejects(asWorkspace(OTHER_WORKSPACE, (store) => store.set(ref, { ...TOKENS, accessToken: 'ACCESS-INTRUSO' })), /policy|row-level security|duplicate key/i);
  await asWorkspace(WORKSPACE_ID, async (store) => assert.equal((await store.get(ref))!.accessToken, TOKENS.accessToken));
});

test('clave equivocada lanza TokenCipherError (no null): el job lo trata como problema nuestro', async () => {
  const ref = newSecretRef('tiktok');
  await asWorkspace(WORKSPACE_ID, (store) => store.set(ref, TOKENS));
  await assert.rejects(
    asWorkspace(WORKSPACE_ID, (store) => store.get(ref), new TokenCipher(keyringOf({ v1: K2 }))),
    (e: unknown) => e instanceof TokenCipherError && e.code === 'auth_failed',
  );
});

test('rotate(): una fila en v1 se reescribe en v2 con el llavero nuevo y sigue leyéndose', async () => {
  const ref = newSecretRef('tiktok');
  await asWorkspace(WORKSPACE_ID, (store) => store.set(ref, TOKENS));
  const newRing = new TokenCipher(keyringOf({ v1: K1, v2: K2 }, 'v2'));
  await asWorkspace(WORKSPACE_ID, async (store) => {
    assert.equal(await store.rotate(ref), true);
    assert.equal(await store.rotate(ref), false, 'ya está en v2');
    assert.deepEqual(await store.get(ref), TOKENS);
  }, newRing);
  const row = await db.query<{ key_version: string }>(`SELECT key_version FROM connection_secret WHERE secret_ref = $1`, [ref]);
  assert.equal(row.rows[0]!.key_version, 'v2');
  await assert.rejects(asWorkspace(WORKSPACE_ID, (store) => store.get(ref)), (e: unknown) => e instanceof TokenCipherError && e.code === 'unknown_key_version');
});

test('como mc_worker (BYPASSRLS) el store lee cualquier ref sin fijar workspace, y con workspaceId acota', async () => {
  const ref = newSecretRef('tiktok');
  await asWorkspace(WORKSPACE_ID, (store) => store.set(ref, TOKENS));
  const cipher = new TokenCipher(keyringOf({ v1: K1 }));
  await db.transaction(async (tx) => {
    await tx.query('SET LOCAL ROLE mc_worker');
    const q = { query: (text: string, params: readonly unknown[] = []) => tx.query(text, params as unknown[]) };
    assert.deepEqual(await new EncryptedSecretStore({ db: q, cipher }).get(ref), TOKENS);
    assert.equal(await new EncryptedSecretStore({ db: q, cipher, workspaceId: OTHER_WORKSPACE }).get(ref), null);
    const renewed = { ...TOKENS, accessToken: 'ACCESS-SECRETO-worker-555' };
    await new EncryptedSecretStore({ db: q, cipher }).set(ref, renewed);
    assert.equal((await new EncryptedSecretStore({ db: q, cipher }).get(ref))!.accessToken, renewed.accessToken);
  });
  const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM connection_secret WHERE secret_ref = $1`, [ref]);
  assert.equal(Number(n.rows[0]!.n), 1, 'el set del worker no creó otra fila');
});
