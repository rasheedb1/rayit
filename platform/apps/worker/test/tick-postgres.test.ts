/**
 * CIM-7 · el worker por turnos contra un Postgres DE VERDAD, con dos
 * pools, como dos invocaciones de Vercel que se solapan.
 *
 * Solo corre con TEST_DATABASE_URL (el molde migrado y con seed de
 * @mc/db: packages/db/README.md, «Contra Postgres real, en local», o el
 * job contra-postgres-real del CI); sin ella se salta. PGlite tiene una
 * sola conexión y serializa las transacciones, así que ahí el candado por
 * job de claimRun no se distingue de no tenerlo: aquí sí. Para que el
 * peor orden no dependa de la suerte, el primer caso retiene 200 ms cada
 * transacción de reclamo DESPUÉS de leer el estado: sin el candado, los
 * dos turnos leen «nada corriendo» y reclaman los dos (se comprobó
 * quitándolo: rojo).
 *
 * También: dos turnos a la vez sobre outbound.dispatch y el seed de
 * outreach sacan el mensaje una sola vez, TICK_CONCURRENCY corridas que
 * retienen una transacción y escriben api_call_log con otra conexión
 * caben en el pool del turno (TICK_POOL_MAX), y un job cortado dentro de
 * una sentencia larga suelta su conexión al acabar el presupuesto
 * (statement_timeout de la base del turno, openTickDatabase).
 *
 * En local, sin Docker: apps/worker/README.md, «Pruebas» (Postgres 16 de
 * embedded-postgres, el montaje, migrar con seed y TEST_DATABASE_URL).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTokenRefresher, InMemorySecretStore, refresherRegistry } from '@mc/connectors';
import { enableOutreach } from '@mc/db/queries/outreach';
import { openTestDb, type TestDb } from '@mc/db/test/pglite';
import { DEMO_WORKSPACE_ID } from '../src/jobs/ventas/demo-ids.ts';
import { nextDemoTouch, prepareDemoForDispatch } from '../src/jobs/ventas/demo-preparar.ts';
import { motorDbFromJob } from '../src/jobs/ventas/motor-db.ts';
import { dispatchJob, DISPATCH_JOB_ID } from '../src/jobs/ventas/outbound.dispatch.ts';
import { ConfigError, loadConfig } from '../src/runner/config.ts';
import { holdLongProcessLock } from '../src/runner/exclusion.ts';
import { PostgresDatabase, type Queryable, type WorkerDatabase } from '../src/runner/db.ts';
import { createLogger, MemorySink } from '../src/runner/logger.ts';
import { defineJob, type JobRegistration } from '../src/runner/registry.ts';
import { openTickDatabase, runTick, TICK_CONCURRENCY, TICK_POOL_MAX, type RunTickOptions, type TickSummary } from '../src/tick.ts';
import { DESCRIBE_DB_TIMEOUT, SETUP_TIMEOUT } from './helpers/harness.ts';
import { aperturaReciente } from './helpers/ventana.ts';

const REAL = Boolean(process.env.TEST_DATABASE_URL);
const ANUAL = '0 0 1 1 *';
const RELOJ = new Date();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let t: TestDb;
const abiertas: WorkerDatabase[] = [];
const logger = createLogger({ level: 'warn', sink: new MemorySink() });
let contados = 0;

const contado = defineJob('test.pg_contado', async () => { contados++; await sleep(100); return { processed: 1, failed: 0 }; });
/** Una corrida que retiene una transacción y, dentro, escribe api_call_log con OTRA conexión (ctx.callLog usa ctx.db). */
const retiene = (i: number): JobRegistration => defineJob(`test.pg_pool_${i}`, async (_p, ctx) => {
  await ctx.db.transaction(async (tx) => {
    await tx.query('SELECT 1');
    await ctx.callLog.record({
      connection_id: null, platform_id: 'tiktok', endpoint: 'test.pool', http_status: 200, ok: true, error_code: null, error_message: null,
      request_units: 1, duration_ms: 1, rate_limited: false, retry_after_s: null,
    });
    await sleep(300);
  });
  return { processed: 1, failed: 0 };
});
const POOL_JOBS = Array.from({ length: TICK_CONCURRENCY }, (_, i) => retiene(i));
/** Cómo terminó la sentencia de un minuto del dormilón, y cuánto duró; null mientras sigue. */
let despertar: { error: string; ms: number } | null = null;
/** Un job que no mira ctx.signal y se mete en una sentencia de un minuto (como compute.baseline en una tabla grande). */
const dormilon = defineJob('test.pg_dormilon', async (_p, ctx) => {
  const inicio = Date.now();
  try {
    await ctx.db.query('SELECT pg_sleep(60)');
    despertar = { error: 'ninguno', ms: Date.now() - inicio };
  } catch (err) {
    despertar = { error: err instanceof Error ? err.message : String(err), ms: Date.now() - inicio };
  }
  return { processed: 1, failed: 0 };
});

/** Un pool propio, como el de una invocación de Vercel (runTickFromEnv): SET ROLE mc_worker, TICK_POOL_MAX conexiones. */
function pool(): PostgresDatabase {
  const db = new PostgresDatabase({
    connectionString: t.url!, setRole: 'mc_worker', jobPoolMax: TICK_POOL_MAX, bossPoolMax: 1, applicationName: 'mc-worker:test-tick', sslRootCert: null,
  });
  abiertas.push(db);
  return db;
}

/** Retiene cada transacción de reclamo 200 ms después de leer el estado: el peor intercalado, a propósito. */
function lento(db: PostgresDatabase): WorkerDatabase {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'transaction') {
        return <T>(fn: (tx: Queryable) => Promise<T>) => target.transaction((tx) => fn({
          query: async (text, params) => {
            const r = await tx.query(text, params);
            if (text.includes('unnest(')) await sleep(200);
            return r;
          },
        } as Queryable));
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as WorkerDatabase;
}

/** Lee como mc_worker: job_run, api_call_log y outbound_touch no son de mc_app (t.raw). */
async function leer<R extends Record<string, unknown>>(sql: string): Promise<R[]> {
  return (await pool().query<R>(sql)).rows;
}

function turno(db: WorkerDatabase, group: string, jobs: readonly JobRegistration[], extra: Partial<RunTickOptions> = {}): Promise<TickSummary> {
  return runTick({
    db, budgetMs: 10_000, now: () => RELOJ, env: { WORKER_GROUPS: group, WORKER_DATABASE_URL: t.url }, jobs, logger,
    secrets: new InMemorySecretStore(), refreshers: refresherRegistry([new FakeTokenRefresher('tiktok')]), ...extra,
  });
}

describe('el turno contra Postgres real (TEST_DATABASE_URL)', { ...DESCRIBE_DB_TIMEOUT, skip: REAL ? false : 'sin TEST_DATABASE_URL: PGlite no tiene dos conexiones' }, () => {
  before(async () => {
    t = await openTestDb();
    const pools = POOL_JOBS.map((j) => `('${j.id}', 'Prueba pool', 'test_pg_pool', '${ANUAL}', 60, 1, 1)`).join(',\n');
    await t.admin(`
      INSERT INTO job_definition (id, label_es, queue, default_cron, timeout_s, max_attempts, max_concurrency) VALUES
        ('test.pg_contado', 'Prueba pg: contado', 'test_pg_carrera', '${ANUAL}', 60, 1, 1),
        ('test.pg_dormilon', 'Prueba pg: dormilón', 'test_pg_dormilon', '${ANUAL}', 300, 1, 1),
        ('test.pg_candado', 'Prueba pg: candado', 'test_pg_candado', '${ANUAL}', 60, 1, 1),
        ${pools};
    `);
  }, SETUP_TIMEOUT);

  after(async () => {
    for (const db of abiertas) await db.close();
    await t?.close();
  });

  test('dos turnos con dos pools, en el peor orden: una sola corrida y una sola fila', async () => {
    const [a, b] = await Promise.all([turno(lento(pool()), 'test_pg_carrera', [contado]), turno(lento(pool()), 'test_pg_carrera', [contado])]);
    assert.equal(contados, 1, `un solo turno lo reclamó: ${JSON.stringify([a.ran, b.ran])}`);
    const otro = a.ran.length === 0 ? a : b;
    assert.ok(otro.left.some((l) => l.job === 'test.pg_contado' && l.reason === 'running') || otro.upToDate === 1, JSON.stringify(otro));
    const filas = await leer<{ n: number }>(`SELECT count(*)::int AS n FROM job_run WHERE job_id = 'test.pg_contado'`);
    assert.equal(filas[0]?.n, 1);
  });

  test('un turno sin nada vencido usa UNA conexión y sale enseguida (Hobby cobra la CPU activa)', async () => {
    const nombre = `mc-worker:test-vacio-${process.pid}`;
    const db = new PostgresDatabase({ connectionString: t.url!, setRole: 'mc_worker', jobPoolMax: TICK_POOL_MAX, bossPoolMax: 1, applicationName: nombre, sslRootCert: null });
    abiertas.push(db);
    const s = await turno(db, 'test_pg_carrera', [contado]);
    assert.deepEqual(s.ran, []);
    assert.equal(s.upToDate, 1);
    // En Supabase el objetivo es < 300 ms (README); aquí, holgado, para no dar rojos por carga de la máquina.
    assert.ok(s.elapsedMs < 1_000, `${s.elapsedMs} ms (plan ${s.planMs} ms)`);
    // Las conexiones ociosas siguen en el pool un rato: se cuentan desde otra.
    const abiertasDelTurno = await leer<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = '${nombre}:jobs'`);
    assert.equal(abiertasDelTurno[0]?.n, 1, 'el rol, las definiciones, el estado de los ticks y pgboss.job, por la misma conexión');
  });

  test('outbound.dispatch con dos turnos a la vez: el mensaje de la demo sale una vez', async () => {
    const uno = pool();
    const motor = motorDbFromJob(uno);
    // Un instante del horario de envío que ya llegó: el now() de este Postgres es el de verdad (CIM-12).
    const siguiente = await motor.transaction((tx) => nextDemoTouch(tx, DEMO_WORKSPACE_ID));
    assert.ok(siguiente, 'el seed de outreach tiene un mensaje programado');
    const reloj = aperturaReciente(siguiente.timeZone, siguiente.window);
    const prep = await motor.transaction((tx) => prepareDemoForDispatch(tx, DEMO_WORKSPACE_ID, reloj));
    await motor.transaction((tx) => enableOutreach(tx, { workspaceId: DEMO_WORKSPACE_ID, now: reloj }));
    const env = { WORKER_GROUPS: 'sales', OUTREACH_CHANNELS: 'fake', APP_URL: 'https://oncue.test', WORKER_DATABASE_URL: t.url };
    const [a, b] = await Promise.all([
      turno(lento(uno), 'sales', [dispatchJob], { now: () => reloj, env, budgetMs: 45_000 }),
      turno(lento(pool()), 'sales', [dispatchJob], { now: () => reloj, env, budgetMs: 45_000 }),
    ]);
    const corridas = [...a.ran, ...b.ran].filter((r) => r.job === DISPATCH_JOB_ID);
    assert.deepEqual(corridas.map((r) => [r.status, r.processed]), [['ok', 1]]);
    const toque = await leer<{ status: string }>(`SELECT status FROM outbound_touch WHERE id = '${prep.touchId}'`);
    assert.equal(toque[0]?.status, 'sent');
    const filas = await leer<{ n: number }>(`SELECT count(*)::int AS n FROM job_run WHERE job_id = '${DISPATCH_JOB_ID}'`);
    assert.equal(filas[0]?.n, 1);
  });

  test(`${TICK_CONCURRENCY} corridas que retienen una transacción y piden otra conexión caben en el pool del turno (${TICK_POOL_MAX})`, async () => {
    const s = await turno(pool(), 'test_pg_pool', POOL_JOBS, { budgetMs: 10_000 });
    assert.deepEqual(s.ran.map((r) => r.status).sort(), POOL_JOBS.map(() => 'ok'), JSON.stringify(s));
    assert.ok(s.elapsedMs < 5_000, `sin esperar conexión hasta el corte: ${s.elapsedMs} ms`);
    const log = await leer<{ n: number }>(`SELECT count(*)::int AS n FROM api_call_log WHERE endpoint = 'test.pool'`);
    assert.equal(log[0]?.n, TICK_CONCURRENCY);
  });

  test('un job cortado dentro de una sentencia larga suelta su conexión al acabar el presupuesto (statement_timeout)', async () => {
    const BUDGET = 3_000;
    const config = loadConfig({ WORKER_DATABASE_URL: t.url! }, { mode: 'postgres', jobPoolMax: TICK_POOL_MAX });
    const db = openTickDatabase(config, BUDGET, logger);
    abiertas.push(db);

    const s = await turno(db, 'test_pg_dormilon', [dormilon], { budgetMs: BUDGET });
    assert.deepEqual(s.ran.map((r) => [r.job, r.cut]), [['test.pg_dormilon', true]], 'el turno lo cortó y respondió a tiempo');
    assert.ok(s.elapsedMs < BUDGET, `${s.elapsedMs} ms`);
    assert.equal(despertar, null, 'al responder, el job sigue dentro de su pg_sleep(60): no mira la señal');
    // …hasta el statement_timeout de la sesión (el presupuesto): la base cancela la sentencia y la conexión vuelve al pool.
    const hasta = Date.now() + BUDGET + 2_000;
    while (despertar === null && Date.now() < hasta) await sleep(50);
    const d = despertar as { error: string; ms: number } | null;
    assert.match(d?.error ?? 'sigue durmiendo', /statement timeout/, 'la cortó la base, no los 60 s');
    assert.ok((d?.ms ?? Infinity) < BUDGET + 1_000, `a los ${d?.ms} ms, no a los 60 s`);
    // El timeout es de las conexiones del turno: una conexión cualquiera sigue con el de la base.
    const [fila] = await leer<{ v: string }>(`SELECT current_setting('statement_timeout') AS v`);
    assert.equal(fila?.v, '0');
  });
  test('con el proceso largo vivo (su candado en otra sesión), el turno no corre nada; un segundo proceso largo no arranca; suelto el candado, el turno corre', async () => {
    let candados = 0;
    const candado = defineJob('test.pg_candado', async () => { candados++; return { processed: 1, failed: 0 }; });
    const conexion = { connectionString: t.url!, ssl: false as const };
    const largo = await holdLongProcessLock({ connection: conexion, applicationName: 'mc-worker:test-candado', logger });
    try {
      const s = await turno(pool(), 'test_pg_candado', [candado]);
      assert.deepEqual(s.ran, []);
      assert.deepEqual(s.left, [{ job: '*', reason: 'running' }]);
      assert.equal(candados, 0);
      const filas = await leer<{ n: number }>(`SELECT count(*)::int AS n FROM job_run WHERE job_id = 'test.pg_candado'`);
      assert.equal(filas[0]?.n, 0, 'ni una fila');
      await assert.rejects(holdLongProcessLock({ connection: conexion, applicationName: 'mc-worker:test-candado-2', logger }), ConfigError, 'un segundo proceso largo no arranca');
    } finally {
      await largo.release();
    }
    const s = await turno(pool(), 'test_pg_candado', [candado]);
    assert.deepEqual(s.ran.map((r) => [r.job, r.status]), [['test.pg_candado', 'ok']]);
    assert.equal(candados, 1);
  });
});
