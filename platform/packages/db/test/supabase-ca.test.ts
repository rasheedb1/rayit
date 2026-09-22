import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUPABASE_ROOT_CA } from '../src/provisional/supabase-ca.ts';
import { DB_DIR } from '../src/provisional/embedded.ts';

test('la CA embebida es idéntica a db/certs/supabase-root-2021.crt', () => {
  const archivo = readFileSync(join(DB_DIR, 'certs', 'supabase-root-2021.crt'), 'utf8');
  assert.equal(SUPABASE_ROOT_CA.trim(), archivo.trim(), 'corre make db.cert y copia el archivo a src/provisional/supabase-ca.ts');
  assert.match(SUPABASE_ROOT_CA, /-----BEGIN CERTIFICATE-----/);
});
