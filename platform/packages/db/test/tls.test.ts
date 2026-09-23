import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { createPool } from '../src/client.ts';
import { DB_DIR } from '../src/embedded.ts';
import { SUPABASE_ROOT_CA } from '../src/supabase-ca.ts';
import { hostOf, isSupabaseHost, resolveTls, tlsFor, TlsConfigError, TLS_URL_PARAMS, PLATFORM_ROOT } from '../src/tls.ts';

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

/**
 * Y los otros cuatro parámetros de TLS de la URL, que la ronda 4 no
 * miraba. `pg-connection-string` arma `config.ssl` también con ellos y
 * `pg` re-parsea la cadena DESPUÉS de la configuración explícita, así
 * que entraban por la puerta de al lado de `sslmode`.
 */
describe('sslrootcert, sslcert, sslkey y sslnegotiation tampoco le ganan a la CA del repositorio', () => {
  const sslDe = (pool: pg.Pool): unknown =>
    (new pg.Client(pool.options) as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl;

  const CERT_ABS = join(PLATFORM_ROOT, CERT);

  for (const param of ['sslrootcert', 'sslcert', 'sslkey'] as const) {
    test(`?${param}=… contra Supabase se rechaza con instrucciones`, () => {
      const url = `${SUPABASE_URL}?${param}=${CERT_ABS}`;
      assert.throws(() => createPool(url), TlsConfigError);
      assert.throws(() => createPool(url), new RegExp(param));
    });
  }

  test('?sslnegotiation=direct contra Supabase también', () => {
    assert.throws(() => createPool(`${SUPABASE_URL}?sslnegotiation=direct`), TlsConfigError);
    assert.throws(() => createPool(`${SUPABASE_URL}?sslnegotiation=direct`), /sslnegotiation/);
  });

  test('sin la guardia, sslrootcert habría sustituido la CA y sslnegotiation la habría perdido', () => {
    // El comportamiento que la guardia impide, medido sobre `pg` a pelo.
    const conParametro = (query: string) => {
      const pool = new pg.Pool({
        connectionString: `${SUPABASE_URL}?${query}`,
        ssl: { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true },
      });
      try {
        return sslDe(pool);
      } finally {
        void pool.end();
      }
    };
    const conCaAjena = conParametro(`sslrootcert=${CERT_ABS}`) as { ca?: string };
    assert.equal(typeof conCaAjena.ca, 'string');
    assert.equal(conCaAjena.ca?.includes('BEGIN CERTIFICATE'), true);
    assert.equal(
      conParametro('sslnegotiation=direct'),
      true,
      'la CA embebida se pierde y queda el almacén del sistema, que no conoce la de Supabase',
    );
  });

  test('en un host sin CA propia, sslrootcert SÍ se traduce: es la forma legítima de traer una CA', () => {
    const d = resolveTls(`${LOCAL_URL}?sslrootcert=${CERT}`);
    assert.deepEqual(d.ssl, { ca: readFileSync(CERT_ABS, 'utf8'), rejectUnauthorized: true });
    assert.ok(!d.connectionString.includes('sslrootcert'), d.connectionString);
    // Y lo que `pg` acaba usando es esa CA, no la de la cadena: es la
    // única forma de medir lo que de verdad llega al socket.
    const pool = createPool(`${LOCAL_URL}?sslrootcert=${CERT}`);
    try {
      const efectivo = sslDe(pool) as { ca?: string; rejectUnauthorized?: boolean };
      assert.equal(efectivo.rejectUnauthorized, true);
      assert.equal(efectivo.ca?.trim(), SUPABASE_ROOT_CA.trim());
    } finally {
      void pool.end();
    }
  });

  test('sslmode=verify-full y sslrootcert conviven: el modo decide, el certificado verifica', () => {
    const d = resolveTls(`${LOCAL_URL}?sslmode=verify-full&sslrootcert=${CERT}`);
    assert.equal((d.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized, true);
    assert.equal((d.ssl as { ca: string }).ca.trim(), SUPABASE_ROOT_CA.trim());
  });

  test('sslrootcert con el TLS apagado es una contradicción, y se dice', () => {
    assert.throws(() => resolveTls(`${LOCAL_URL}?sslmode=disable&sslrootcert=${CERT}`), /no significa nada/);
  });

  test('sslcert / sslkey / sslnegotiation se rechazan también sin CA propia: su sitio es PoolOptions', () => {
    assert.throws(() => resolveTls(`${LOCAL_URL}?sslcert=${CERT_ABS}`), TlsConfigError);
    assert.throws(() => resolveTls(`${LOCAL_URL}?sslkey=${CERT_ABS}`), /PoolOptions/);
    assert.throws(() => resolveTls(`${LOCAL_URL}?sslnegotiation=direct`), /PoolOptions/);
  });

  test('un sslrootcert que no existe falla con instrucciones, no en silencio', () => {
    assert.throws(() => resolveTls(`${LOCAL_URL}?sslrootcert=db/certs/no-existe.crt`), /make db\.cert/);
  });

  test('TLS_URL_PARAMS los lista todos: es la lista que borra la URL de una sola vez', () => {
    assert.deepEqual([...TLS_URL_PARAMS], ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'sslnegotiation']);
    const d = resolveTls(`${LOCAL_URL}?sslmode=require&application_name=x`);
    for (const p of TLS_URL_PARAMS) assert.ok(!d.connectionString.includes(`${p}=`), `${p} sigue en la URL`);
  });
});
