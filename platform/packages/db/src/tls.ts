/**
 * TLS hacia Postgres. Supabase firma con su propia autoridad ("Supabase
 * Root 2021 CA"), que el sistema no conoce. En vez de apagar la
 * verificación —que deja la conexión abierta a un intermediario— se
 * fija ese certificado. Nunca `rejectUnauthorized: false`.
 *
 * Orden de decisión (tlsFor):
 *   1. PGSSLROOTCERT definido → ese archivo, verificación estricta. Una
 *      ruta relativa se resuelve contra platform/.
 *   2. Host de Supabase → la CA embebida en supabase-ca.ts (idéntica a
 *      db/certs/supabase-root-2021.crt; la prueba test/tls.test.ts lo
 *      comprueba). Embebida porque en Vercel el bundle no puede
 *      localizar el archivo por ruta.
 *   3. Cualquier otro host (localhost, Docker, un Postgres gestionado
 *      de otro proveedor) → sin CA propia: decide `sslmode` de la URL.
 *
 * Y una sola fuente de verdad (resolveTls). `pg` re-parsea la cadena de
 * conexión DESPUÉS de la configuración explícita —
 * `Object.assign({}, config, parse(config.connectionString))`— así que
 * un `?sslmode=…` pegado a la URL GANA sobre el `ssl` que le pasemos:
 * `sslmode=no-verify` deja `{rejectUnauthorized:false}`, `disable` manda
 * texto plano a Supabase y `require` descarta la CA embebida y verifica
 * contra el almacén del sistema, que no conoce la CA de Supabase. Es
 * exactamente la vía por la que entraría el `rejectUnauthorized: false`
 * que el proyecto prohíbe, y el escenario es realista: quien vea un
 * fallo de certificado pega `?sslmode=no-verify` a la URL del vault y
 * todo parece seguir funcionando.
 *
 * Por eso resolveTls:
 *   - Con CA propia (Supabase o PGSSLROOTCERT), un `sslmode` / `ssl` en
 *     la URL es un error y se lanza con instrucciones.
 *   - Sin CA propia, el parámetro se traduce aquí a una opción `ssl`
 *     explícita y se BORRA de una copia de la URL, para que solo haya
 *     un sitio donde mirar. `no-verify` se rechaza siempre.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPABASE_ROOT_CA } from './supabase-ca.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** platform/, relativo a packages/db/src. Solo se usa para rutas relativas de PGSSLROOTCERT. */
export const PLATFORM_ROOT = join(HERE, '..', '..', '..');

/** Lo que decide tlsFor: una CA propia, o nada. */
export type Tls = false | { ca: string; rejectUnauthorized: true };

/** Lo que recibe `pg`: sin TLS, o con verificación estricta (con CA propia o con la del sistema). */
export type Ssl = false | { ca?: string; rejectUnauthorized: true };

/** La cadena de conexión ya sin parámetros de TLS, y la decisión única. */
export interface TlsDecision {
  connectionString: string;
  ssl: Ssl;
}

/** Los parámetros de la URL que hablan de TLS. Ninguno convive con una CA propia. */
export const TLS_URL_PARAMS = ['sslmode', 'ssl'] as const;

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

/** Se lanza cuando la URL y @mc/db dicen cosas distintas sobre el TLS. */
export class TlsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TlsConfigError';
  }
}

const VERIFIED: Ssl = { rejectUnauthorized: true };

/**
 * Traduce un parámetro de TLS de la URL a una opción `ssl` explícita.
 * Solo se llama para hosts sin CA propia. `no-verify` no tiene
 * traducción: es justo lo que el proyecto prohíbe.
 */
function sslFromParam(name: string, value: string): Ssl {
  const v = value.trim().toLowerCase();
  if (name === 'ssl') {
    if (v === 'true' || v === '1') return VERIFIED;
    if (v === 'false' || v === '0') return false;
    throw new TlsConfigError(`La URL de la base trae ssl=${value}, que no se entiende. Usa ssl=true o ssl=false, o mejor sslmode=…`);
  }
  switch (v) {
    case 'disable':
      return false;
    // `pg` trata hoy prefer/allow/require/verify-ca como verify-full;
    // se conserva ese comportamiento, escrito aquí en vez de heredado.
    case 'allow':
    case 'prefer':
    case 'require':
    case 'verify-ca':
    case 'verify-full':
      return VERIFIED;
    case 'no-verify':
      throw new TlsConfigError(
        'La URL de la base trae sslmode=no-verify, que apaga la verificación del certificado (rejectUnauthorized: false) ' +
          'y deja la conexión abierta a un intermediario. El proyecto no lo permite. Si el certificado no valida, ' +
          'fija PGSSLROOTCERT con la CA del servidor (contra Supabase la pone @mc/db sola; corre make db.cert si falla).',
      );
    default:
      throw new TlsConfigError(`La URL de la base trae sslmode=${value}, que no se entiende. Modos válidos: disable, prefer, require, verify-ca, verify-full.`);
  }
}

/**
 * La decisión de TLS y la URL con la que se abre el pool.
 *
 * Si hay CA propia (host de Supabase o PGSSLROOTCERT), un `sslmode` o
 * `ssl` en la URL lanza: son dos fuentes de verdad y `pg` haría ganar a
 * la equivocada. Si no la hay, el parámetro se traduce a una opción
 * explícita y se borra de una copia de la URL.
 */
export function resolveTls(connectionString: string, sslRootCert: string | null = null, platformRoot: string = PLATFORM_ROOT): TlsDecision {
  const ca = tlsFor(connectionString, sslRootCert, platformRoot);
  let url: URL | null = null;
  try {
    url = new URL(connectionString);
  } catch {
    // Formato key=value ("host=… sslmode=…"): no lo usamos en el repo y
    // no se toca; manda lo que diga la cadena, como haría pg.
    return { connectionString, ssl: ca };
  }
  const present = TLS_URL_PARAMS.filter((p) => url.searchParams.has(p));
  if (present.length === 0) return { connectionString, ssl: ca };
  const escrito = present.map((p) => `${p}=${url.searchParams.get(p) ?? ''}`).join(' y ');

  if (ca !== false) {
    const fuente = sslRootCert ? `el certificado de PGSSLROOTCERT (${sslRootCert})` : 'la CA de db/certs';
    throw new TlsConfigError(
      `La URL de la base trae ${escrito}; el TLS lo fija @mc/db con ${fuente}. ` +
        'Quita el parámetro de la URL: `pg` la re-parsea después de la configuración y ese valor ganaría, ' +
        'descartando la CA (o apagando la verificación). Si el certificado falla, corre make db.cert.',
    );
  }
  if (present.length > 1) {
    throw new TlsConfigError(`La URL de la base trae ${escrito}: dos parámetros de TLS que pueden contradecirse. Deja solo sslmode.`);
  }
  const [param] = present;
  const ssl = sslFromParam(param!, url.searchParams.get(param!) ?? '');
  const limpia = new URL(url.toString());
  for (const p of TLS_URL_PARAMS) limpia.searchParams.delete(p);
  return { connectionString: limpia.toString(), ssl };
}
