/**
 * La comprobación previa del worker (src/preflight.ts), sobre Postgres
 * embebido y sin red.
 *
 * Es lo que respalda el «terminado cuando» de CIM-2 —«pnpm --filter
 * @mc/worker dev imprime las definiciones de jobs contra Supabase»— y
 * hasta la ronda 5 no la probaba nadie: `explainMissing` y
 * `explainConnectionError` son funciones puras con ramas (rol no
 * miembro, esquema de pg-boss ausente, 28P01, ENOTFOUND…) y
 * `formatJobDefinitions` tiene formato de columnas. Sin credenciales de
 * Supabase, esto es lo que hace reproducible ese criterio: la misma
 * base que usa el resto del repositorio, con las migraciones reales.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ESQUEMA_AL_DIA } from '@mc/db';
import { openTestDb, type TestDb } from '@mc/db/test/pglite';
import { explainConnectionError, explainMissing, formatJobDefinitions, runPreflight, type PreflightResult } from '../src/preflight.ts';

const URL_SUPABASE = 'postgres://mc_worker.autlbeccerunvetptywe:secreto@aws-0-ca-central-1.pooler.supabase.com:5432/postgres';
const OPTS = { role: 'mc_worker', bossSchema: 'pgboss' };

let t: TestDb;

before(async () => {
  t = await openTestDb();
}, { timeout: 600_000 });

after(async () => {
  await t.close();
});

describe('runPreflight contra una base de verdad', () => {
  test('dice con qué rol entró, que mc_app NO puede asumir mc_worker y que no hay esquema de pg-boss', async (ctx) => {
    if (t.kind !== 'pglite') return ctx.skip('el rol de conexión lo decide TEST_DATABASE_URL');
    const p = await runPreflight(t.db, OPTS);
    assert.equal(p.currentUser, 'mc_app');
    assert.equal(p.memberOfRole, false, 'mc_app no es miembro de mc_worker, y eso es lo buscado');
    assert.equal(p.bossSchemaExists, false);
    // El esquema sí está al día: lo acaba de aplicar el mismo runner.
    assert.deepEqual(p.esquema.pendientes, []);
    assert.deepEqual(p.esquema.sinRls, []);
    assert.deepEqual(p.esquema.privilegiosDeMas, [], JSON.stringify(p.esquema.privilegiosDeMas));
  });

  test('sin rol que comprobar (WORKER_SET_ROLE=none), memberOfRole es true', async () => {
    const p = await runPreflight(t.db, { role: null, bossSchema: 'pgboss' });
    assert.equal(p.memberOfRole, true);
  });

  test('bossSchemaExists pasa a true en cuanto existe el esquema', async () => {
    await t.admin('CREATE SCHEMA IF NOT EXISTS pgboss');
    try {
      const p = await runPreflight(t.db, OPTS);
      assert.equal(p.bossSchemaExists, true);
    } finally {
      await t.admin('DROP SCHEMA IF EXISTS pgboss CASCADE');
    }
  });
});

describe('explainMissing: qué falta y el comando exacto', () => {
  const base: PreflightResult = {
    currentUser: 'mc_migrator',
    memberOfRole: true,
    bossSchemaExists: true,
    esquema: { ...ESQUEMA_AL_DIA, aplicadas: 22, ultima: '0022_x.sql' },
  };

  test('sin nada que falte, no dice nada', () => {
    assert.deepEqual(explainMissing(base, OPTS), []);
  });

  test('rol no miembro: el GRANT con el usuario real, no un ejemplo', () => {
    const lines = explainMissing({ ...base, memberOfRole: false }, OPTS).join('\n');
    assert.match(lines, /mc_migrator no es miembro de mc_worker/);
    assert.match(lines, /\.\/scripts\/supabase-admin\.sh sql "GRANT mc_worker TO mc_migrator"/);
    assert.match(lines, /docs\/propuestas\/CON-2\.md/);
  });

  test('sin esquema de pg-boss: el CREATE SCHEMA y el install-schema', () => {
    const lines = explainMissing({ ...base, bossSchemaExists: false }, OPTS).join('\n');
    assert.match(lines, /CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION mc_migrator/);
    assert.match(lines, /pnpm --filter @mc\/worker install-schema/);
  });

  test('esquema atrasado: lo dice aquí, con make db.migrate, aunque el resto esté bien', () => {
    const lines = explainMissing(
      {
        ...base,
        esquema: {
          ...ESQUEMA_AL_DIA,
          aplicadas: 15,
          ultima: '0015_connection_secret.sql',
          pendientes: ['0019_a.sql', '0020_b.sql'],
          sinRls: ['contact'],
          sinAislar: [{ tabla: 'contact', falta: 'sin ENABLE ROW LEVEL SECURITY' }],
        },
      },
      OPTS,
    ).join('\n');
    assert.match(lines, /faltan 2 migración\(es\)/);
    assert.match(lines, /0019_a\.sql, 0020_b\.sql/);
    assert.match(lines, /contact/);
    assert.match(lines, /make db\.migrate/);
  });

  test('un rol que no hay que comprobar no genera línea de rol', () => {
    const lines = explainMissing({ ...base, memberOfRole: false }, { role: null, bossSchema: 'pgboss' });
    assert.deepEqual(lines, []);
  });
});

describe('explainConnectionError: una línea del producto, no el stack de pg', () => {
  test('28P01 nombra usuario y host, y manda a make db.unlock', () => {
    const msg = explainConnectionError({ code: '28P01' }, URL_SUPABASE);
    assert.match(String(msg), /mc_worker\.autlbeccerunvetptywe@aws-0-ca-central-1\.pooler\.supabase\.com/);
    assert.match(String(msg), /make db\.unlock/);
  });

  for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET']) {
    test(`${code} dice a qué host no se llega`, () => {
      const msg = explainConnectionError({ code }, URL_SUPABASE);
      assert.match(String(msg), /aws-0-ca-central-1\.pooler\.supabase\.com/);
      assert.match(String(msg), new RegExp(code));
    });
  }

  test('un error cualquiera devuelve null: que se propague con su stack', () => {
    assert.equal(explainConnectionError(new Error('boom'), URL_SUPABASE), null);
    assert.equal(explainConnectionError({ code: '42P01' }, URL_SUPABASE), null);
    assert.equal(explainConnectionError(undefined, URL_SUPABASE), null);
  });
});

describe('formatJobDefinitions: el humo que imprime `dev`', () => {
  test('lista las definiciones del esquema con el host y el cron de cada una', async () => {
    const salida = await formatJobDefinitions(t.db, URL_SUPABASE);
    const defs = await t.db.withCatalogs((tx) => tx.query<{ id: string }>('SELECT id FROM job_definition ORDER BY id'));
    assert.ok(defs.rows.length > 0, 'el esquema trae definiciones de jobs');
    assert.match(salida, new RegExp(`${defs.rows.length} definiciones de jobs en aws-0-ca-central-1\\.pooler\\.supabase\\.com`));
    for (const d of defs.rows) assert.ok(salida.includes(d.id), `falta ${d.id} en el listado`);
    // Una línea por definición, más el encabezado y los saltos.
    const lineas = salida.split('\n').filter((l) => /^ {2}[·✗] /.test(l));
    assert.equal(lineas.length, defs.rows.length);
  });
});
