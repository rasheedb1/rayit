/** TLS según el host y utilidades de db.ts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostOf, quoteIdent, tlsFor } from '../src/runner/db.ts';

test('localhost, Docker y un Postgres cualquiera van sin opción ssl (manda la URL)', () => {
  assert.equal(tlsFor('postgres://mc:mc@localhost:5432/multicampaign', null), false);
  assert.equal(tlsFor('postgres://mc:mc@localhost/multicampaign', null), false, 'sin puerto también');
  assert.equal(tlsFor('postgres://mc:mc@db:5432/multicampaign', null), false);
  assert.equal(tlsFor('postgres://u:p@postgres.railway.internal:5432/railway?sslmode=disable', null), false);
});

test('Supabase usa el CA versionado del repo con verificación estricta', () => {
  const tls = tlsFor('postgres://mc_migrator.ref:p@aws-0-ca-central-1.pooler.supabase.com:5432/postgres', null);
  assert.notEqual(tls, false);
  assert.equal((tls as { rejectUnauthorized: true }).rejectUnauthorized, true);
  assert.match((tls as { ca: string }).ca, /BEGIN CERTIFICATE/);
});

test('PGSSLROOTCERT manda sobre el host, y una ruta inexistente falla con instrucciones', () => {
  assert.throws(() => tlsFor('postgres://u:p@otro-host:5432/db', 'no/existe.crt'), /make db.cert/);
  const tls = tlsFor('postgres://u:p@otro-host:5432/db', 'db/certs/supabase-root-2021.crt');
  assert.notEqual(tls, false, 'ruta relativa a platform/');
});

test('hostOf tolera URLs raras', () => {
  assert.equal(hostOf('postgres://u:p@host.example.com:5432/db'), 'host.example.com');
  assert.equal(hostOf('postgres://u:p@[::1]:5432/db'), '::1');
  assert.equal(hostOf('u:p@host:5432/db'), 'host');
});

test('quoteIdent solo acepta identificadores simples', () => {
  assert.equal(quoteIdent('mc_worker'), '"mc_worker"');
  assert.throws(() => quoteIdent('mc_worker; DROP TABLE x'), /inválido/);
});
