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
 * Y no es solo `sslmode`: `pg-connection-string` arma `config.ssl`
 * también con `sslrootcert`, `sslcert`, `sslkey` y `sslnegotiation`
 * (TLS_URL_PARAMS los lista con lo que hace cada uno, medido). Un
 * `?sslrootcert=/tmp/atacante.crt` sustituía la CA del repositorio sin
 * que nada lo dijera.
 *
 * Por eso resolveTls:
 *   - Con CA propia (Supabase o PGSSLROOTCERT), CUALQUIERA de los seis
 *     parámetros en la URL es un error y se lanza con instrucciones.
 *   - Sin CA propia, el parámetro se traduce aquí a una opción `ssl`
 *     explícita y se BORRA de una copia de la URL, para que solo haya
 *     un sitio donde mirar: `sslmode`/`ssl` deciden si hay TLS y
 *     `sslrootcert` aporta la CA. `no-verify` se rechaza siempre, y
 *     `sslcert`/`sslkey`/`sslnegotiation` también: hablan del cliente y
 *     su sitio es PoolOptions, donde se ven.
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

/**
 * Los parámetros de la URL que hablan de TLS. Ninguno convive con una
 * CA propia.
 *
 * Son SEIS, no dos: `pg-connection-string` construye `config.ssl` a
 * partir de todos ellos, y `pg` re-parsea la cadena DESPUÉS de la
 * configuración explícita. Medido con el `pg` instalado, pasando
 * siempre `ssl: { ca: 'CA-DEL-REPO', rejectUnauthorized: true }`:
 *
 *   ?sslrootcert=/tmp/atacante.crt  → { ca: '…ATACANTE…' }   (nuestra CA, fuera)
 *   ?sslcert=/tmp/atacante.crt      → { cert: '…ATACANTE…' } (ídem)
 *   ?sslkey=/tmp/atacante.key       → {}                     (ídem)
 *   ?sslnegotiation=direct          → true                   (almacén del sistema)
 *   ?ssl=true                       → true
 *   ?sslmode=no-verify              → { rejectUnauthorized: false }
 *
 * Es decir: la misma puerta que cerró la ronda 4 con `sslmode`, abierta
 * cuatro veces más. Y es realista: quien vea un fallo de certificado
 * pega `sslrootcert=` a la URL del vault.
 */
export const TLS_URL_PARAMS = ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'sslnegotiation'] as const;

/** Los que no tienen traducción posible: hablan del cliente, no del servidor. */
const TLS_URL_PARAMS_SIN_TRADUCCION = ['sslcert', 'sslkey', 'sslnegotiation'] as const;

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

/** Lee un certificado raíz del disco. Una ruta relativa se resuelve contra platform/. */
function leerCa(sslRootCert: string, platformRoot: string): { ca: string; rejectUnauthorized: true } {
  const path = isAbsolute(sslRootCert) ? sslRootCert : resolve(platformRoot, sslRootCert);
  if (!existsSync(path)) {
    throw new Error(`Falta el certificado raíz en ${path} (PGSSLROOTCERT). Descárgalo con: make db.cert`);
  }
  return { ca: readFileSync(path, 'utf8'), rejectUnauthorized: true };
}

export function tlsFor(connectionString: string, sslRootCert: string | null = null, platformRoot: string = PLATFORM_ROOT): Tls {
  if (sslRootCert) return leerCa(sslRootCert, platformRoot);
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

  // Sin CA propia: el parámetro se traduce aquí y se borra de una copia
  // de la URL, para que solo haya un sitio donde mirar.
  const sinTraduccion = TLS_URL_PARAMS_SIN_TRADUCCION.filter((p) => url.searchParams.has(p));
  if (sinTraduccion.length > 0) {
    throw new TlsConfigError(
      `La URL de la base trae ${sinTraduccion.join(' y ')}, que @mc/db no traduce: el TLS lo decide el paquete, no la cadena. ` +
        'Un certificado de cliente (sslcert/sslkey) o una negociación distinta (sslnegotiation) se añaden a PoolOptions, ' +
        'donde se ven; en la URL, `pg` los aplicaría DESPUÉS y descartarían la CA configurada.',
    );
  }
  if (url.searchParams.has('sslmode') && url.searchParams.has('ssl')) {
    throw new TlsConfigError(`La URL de la base trae ${escrito}: dos parámetros de TLS que pueden contradecirse. Deja solo sslmode.`);
  }

  const modo = url.searchParams.has('sslmode') ? 'sslmode' : url.searchParams.has('ssl') ? 'ssl' : null;
  let ssl: Ssl = modo === null ? VERIFIED : sslFromParam(modo, url.searchParams.get(modo) ?? '');

  const rootCert = url.searchParams.get('sslrootcert');
  if (rootCert !== null) {
    if (ssl === false) {
      throw new TlsConfigError(
        `La URL de la base trae sslrootcert=${rootCert} junto a ${escrito}: un certificado raíz con el TLS apagado no significa nada. Deja uno de los dos.`,
      );
    }
    ssl = leerCa(rootCert, platformRoot);
  }

  const limpia = new URL(url.toString());
  for (const p of TLS_URL_PARAMS) limpia.searchParams.delete(p);
  return { connectionString: limpia.toString(), ssl };
}
