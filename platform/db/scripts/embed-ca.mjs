#!/usr/bin/env node
/**
 * Regenera packages/db/src/provisional/supabase-ca.ts a partir de
 * db/certs/supabase-root-2021.crt. Lo llama `make db.cert`; la prueba
 * packages/db/test/supabase-ca.test.ts falla si las dos copias divergen.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM = join(HERE, '..', '..');
const pem = readFileSync(join(PLATFORM, 'db', 'certs', 'supabase-root-2021.crt'), 'utf8').trim();
if (!pem.startsWith('-----BEGIN CERTIFICATE-----')) {
  console.error('db/certs/supabase-root-2021.crt no parece un certificado PEM.');
  process.exit(1);
}
const out = `/**
 * Certificado raíz de Supabase ("Supabase Root 2021 CA"), embebido.
 *
 * Es público y está versionado en db/certs/supabase-root-2021.crt; se
 * copia aquí porque en Vercel el bundle no puede localizar ese archivo
 * por ruta (webpack fija import.meta.url a la ruta de la máquina de
 * build). Lo regenera \`make db.cert\` (db/scripts/embed-ca.mjs); la
 * prueba test/supabase-ca.test.ts falla si las dos copias divergen.
 */
export const SUPABASE_ROOT_CA = \`
${pem}
\`;
`;
writeFileSync(join(PLATFORM, 'packages', 'db', 'src', 'provisional', 'supabase-ca.ts'), out);
