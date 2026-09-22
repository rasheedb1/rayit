/**
 * TLS hacia Postgres. Supabase firma con su propia autoridad ("Supabase
 * Root 2021 CA"), que el sistema no conoce. En vez de apagar la
 * verificación —que deja la conexión abierta a un intermediario— se
 * fija ese certificado. Nunca `rejectUnauthorized: false`.
 *
 * Orden de decisión:
 *   1. PGSSLROOTCERT definido → ese archivo, verificación estricta. Una
 *      ruta relativa se resuelve contra platform/.
 *   2. Host de Supabase → la CA embebida en supabase-ca.ts (idéntica a
 *      db/certs/supabase-root-2021.crt; la prueba test/tls.test.ts lo
 *      comprueba). Embebida porque en Vercel el bundle no puede
 *      localizar el archivo por ruta.
 *   3. Cualquier otro host (localhost, Docker) → sin opción ssl: manda
 *      lo que diga la URL (`sslmode=…`), como hace `pg`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPABASE_ROOT_CA } from './supabase-ca.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** platform/, relativo a packages/db/src. Solo se usa para rutas relativas de PGSSLROOTCERT. */
export const PLATFORM_ROOT = join(HERE, '..', '..', '..');

export type Tls = false | { ca: string; rejectUnauthorized: true };

export function hostOf(connectionString: string): string {
  let host = '';
  try {
    host = new URL(connectionString).hostname;
  } catch {
    host = '';
  }
  if (!host) host = connectionString.replace(/^.*@/, '').replace(/[:/].*$/, '');
  return host.replace(/^\[|\]$/g, '');
}

export function isSupabaseHost(host: string): boolean {
  return /\.supabase\.(com|co)$/i.test(host);
}

export function tlsFor(connectionString: string, sslRootCert: string | null = null, platformRoot: string = PLATFORM_ROOT): Tls {
  if (sslRootCert) {
    const path = isAbsolute(sslRootCert) ? sslRootCert : resolve(platformRoot, sslRootCert);
    if (!existsSync(path)) {
      throw new Error(`Falta el certificado raíz en ${path} (PGSSLROOTCERT). Descárgalo con: make db.cert`);
    }
    return { ca: readFileSync(path, 'utf8'), rejectUnauthorized: true };
  }
  if (isSupabaseHost(hostOf(connectionString))) {
    return { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true };
  }
  return false;
}
