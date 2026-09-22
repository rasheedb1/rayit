import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_DIR } from '../src/embedded.ts';
import { SUPABASE_ROOT_CA } from '../src/supabase-ca.ts';
import { hostOf, isSupabaseHost, tlsFor, PLATFORM_ROOT } from '../src/tls.ts';

const SUPABASE_URL = 'postgres://mc_app.autlbeccerunvetptywe:secreto@aws-0-ca-central-1.pooler.supabase.com:6543/postgres';
const LOCAL_URL = 'postgres://mc:mc@localhost:5432/oncue';
const CERT = 'db/certs/supabase-root-2021.crt';

describe('TLS hacia Postgres', () => {
  test('la CA embebida es idéntica a db/certs/supabase-root-2021.crt', () => {
    const archivo = readFileSync(join(DB_DIR, 'certs', 'supabase-root-2021.crt'), 'utf8');
    assert.equal(SUPABASE_ROOT_CA.trim(), archivo.trim(), 'corre make db.cert para regenerar src/supabase-ca.ts');
    assert.match(SUPABASE_ROOT_CA, /-----BEGIN CERTIFICATE-----/);
  });

  test('hostOf entiende el usuario con el ref pegado', () => {
    assert.equal(hostOf(SUPABASE_URL), 'aws-0-ca-central-1.pooler.supabase.com');
    assert.equal(hostOf(LOCAL_URL), 'localhost');
    assert.equal(isSupabaseHost(hostOf(SUPABASE_URL)), true);
    assert.equal(isSupabaseHost('localhost'), false);
  });

  test('contra Supabase verifica con la CA embebida; nunca rejectUnauthorized: false', () => {
    const tls = tlsFor(SUPABASE_URL);
    assert.ok(tls);
    assert.equal(tls.rejectUnauthorized, true);
    assert.equal(tls.ca, SUPABASE_ROOT_CA);
  });

  test('contra localhost no impone TLS', () => {
    assert.equal(tlsFor(LOCAL_URL), false);
  });

  test('PGSSLROOTCERT manda: relativo a platform/ o absoluto', () => {
    const relativo = tlsFor(LOCAL_URL, CERT);
    assert.ok(relativo);
    assert.equal(relativo.ca.trim(), SUPABASE_ROOT_CA.trim());
    const absoluto = tlsFor(LOCAL_URL, join(PLATFORM_ROOT, CERT));
    assert.ok(absoluto);
    assert.equal(absoluto.ca.trim(), SUPABASE_ROOT_CA.trim());
  });

  test('un PGSSLROOTCERT que no existe falla con instrucciones, no en silencio', () => {
    assert.throws(() => tlsFor(SUPABASE_URL, 'db/certs/no-existe.crt'), /make db\.cert/);
  });
});
