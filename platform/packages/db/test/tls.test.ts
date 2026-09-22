import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { createPool } from '../src/client.ts';
import { DB_DIR } from '../src/embedded.ts';
import { SUPABASE_ROOT_CA } from '../src/supabase-ca.ts';
import { hostOf, isSupabaseHost, resolveTls, tlsFor, TlsConfigError, PLATFORM_ROOT } from '../src/tls.ts';

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

/**
 * La guardia contra el `?sslmode=…` pegado a la URL.
 *
 * `pg` re-parsea la cadena de conexión DESPUÉS de la configuración
 * explícita (`Object.assign({}, config, parse(config.connectionString))`),
 * así que ese parámetro ganaba sobre el `ssl` de createPool. Se mide lo
 * que de verdad llega al socket: la configuración efectiva de un
 * `pg.Client` construido con las opciones del pool.
 */
describe('sslmode en la URL no puede ganarle a la CA del repositorio', () => {
  /**
   * La configuración TLS efectiva: lo que un pg.Client construido con
   * las opciones del pool le entregaría al socket. `connectionParameters`
   * no está en @types/pg, pero es donde pg deja el resultado de mezclar
   * la config explícita con lo que re-parsea de la cadena.
   */
  const sslDe = (pool: pg.Pool): unknown =>
    (new pg.Client(pool.options) as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl;

  /** Lo que `pg` usaría de verdad al conectar, pasando por createPool. */
  const sslEfectivo = (url: string): unknown => {
    const pool = createPool(url);
    try {
      return sslDe(pool);
    } finally {
      void pool.end();
    }
  };

  test('sin parámetros, contra Supabase manda la CA embebida', () => {
    assert.deepEqual(sslEfectivo(SUPABASE_URL), { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true });
  });

  for (const modo of ['no-verify', 'disable', 'require', 'verify-full'] as const) {
    test(`?sslmode=${modo} contra Supabase se rechaza con instrucciones, no se aplica`, () => {
      const url = `${SUPABASE_URL}?sslmode=${modo}`;
      assert.throws(() => createPool(url), TlsConfigError);
      assert.throws(() => createPool(url), new RegExp(`sslmode=${modo}`));
      assert.throws(() => createPool(url), /make db\.cert/);
    });
  }

  test('sin la guardia, no-verify habría apagado la verificación y disable habría mandado texto plano', () => {
    // El comportamiento que la guardia impide, medido sobre `pg` a pelo.
    const conParametro = (modo: string) => {
      const pool = new pg.Pool({
        connectionString: `${SUPABASE_URL}?sslmode=${modo}`,
        ssl: { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true },
      });
      try {
        return sslDe(pool);
      } finally {
        void pool.end();
      }
    };
    assert.deepEqual(conParametro('no-verify'), { rejectUnauthorized: false }, 'esto es lo que CLAUDE.md prohíbe');
    assert.equal(conParametro('disable'), false, 'texto plano hacia Supabase');
    assert.deepEqual(conParametro('require'), {}, 'se descarta la CA embebida');
  });

  test('con PGSSLROOTCERT también se rechaza, aunque el host no sea de Supabase', () => {
    assert.throws(() => createPool(`${LOCAL_URL}?sslmode=require`, { sslRootCert: CERT }), /sslmode=require/);
  });

  test('en un host sin CA propia el parámetro se traduce y se borra de la URL: una sola fuente de verdad', () => {
    const d = resolveTls(`${LOCAL_URL}?sslmode=require&application_name=x`);
    assert.deepEqual(d.ssl, { rejectUnauthorized: true });
    assert.ok(!d.connectionString.includes('sslmode'), d.connectionString);
    assert.ok(d.connectionString.includes('application_name=x'), 'el resto de la URL no se toca');
    // Y lo que llega a pg es esa decisión, no la de la cadena.
    assert.deepEqual(sslEfectivo(`${LOCAL_URL}?sslmode=require`), { rejectUnauthorized: true });
    assert.equal(sslEfectivo(`${LOCAL_URL}?sslmode=disable`), false);
  });

  test('sslmode=no-verify se rechaza en cualquier host: rejectUnauthorized:false no entra por ningún lado', () => {
    assert.throws(() => createPool(`${LOCAL_URL}?sslmode=no-verify`), TlsConfigError);
    assert.throws(() => createPool(`${LOCAL_URL}?sslmode=no-verify`), /PGSSLROOTCERT/);
  });

  test('un sslmode que no se entiende falla con la lista de los válidos', () => {
    assert.throws(() => resolveTls(`${LOCAL_URL}?sslmode=casi`), /verify-full/);
  });

  test('una cadena que no es una URL se deja tal cual', () => {
    const d = resolveTls('host=localhost port=5432 dbname=oncue');
    assert.equal(d.connectionString, 'host=localhost port=5432 dbname=oncue');
    assert.equal(d.ssl, false);
  });
});
