/**
 * CIM-7 · el worker por turnos (src/tick.ts) sobre Postgres embebido con
 * las migraciones y los seeds del repositorio, como mc_worker. Sin red.
 *
 * Lo que pide el enunciado: un turno corre lo vencido y termina dentro
 * de su presupuesto; lo que no cupo queda para el siguiente, que lo
 * retoma; dos turnos a la vez no corren dos veces lo mismo; un turno sin
 * nada vencido sale enseguida; y outbound.dispatch, sobre el seed de
 * outreach, saca el mensaje vencido de la demo por el canal falso.
 *
 * Cada grupo de jobs de prueba va en su propia cola (WORKER_GROUPS), y el
 * reloj de los turnos es fijo: un tick de cron que cambiara de minuto a
 * mitad de la prueba volvería a dejar vencido lo ya corrido.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import type { PGlite } from '@electric-sql/pglite';
import { FakeTokenRefresher, InMemorySecretStore, loadPlatformLimits, refresherRegistry, withoutNetwork, type NetworkGuard } from '@mc/connectors';
import { nextWindowSlot } from '@mc/core';
import { createEmbeddedDb, type EmbeddedDb } from '@mc/db/embedded';
import { enableOutreach } from '@mc/db/queries/outreach';
import { DEMO_WORKSPACE_ID } from '../src/jobs/ventas/demo-ids.ts';
import { prepareDemoForDispatch } from '../src/jobs/ventas/demo-preparar.ts';
import { motorDbFromJob } from '../src/jobs/ventas/motor-db.ts';
import { dispatchJob, DISPATCH_JOB_ID } from '../src/jobs/ventas/outbound.dispatch.ts';
import { lastTick } from '../src/runner/cron.ts';
import { JOB_LOCK_PREFIX } from '../src/runner/comun.ts';
import type { Queryable, WorkerDatabase } from '../src/runner/db.ts';
import { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { createLogger, MemorySink } from '../src/runner/logger.ts';
import { claimRun, MAX_TICK_CUTS, TICK_CUT_KEY, TICK_RUN_PREFIX, type Claim } from '../src/runner/once.ts';
import { ALLOW_WITH_TICK_ENV, assertNoRecentTicks, LONG_PROCESS_LOCK, RECENT_TICK_WINDOW_MS } from '../src/runner/exclusion.ts';
import { startWorker } from '../src/runner/worker.ts';
import { defineJob, type JobDefinition, type JobRegistration } from '../src/runner/registry.ts';
import { ConfigError, loadConfig } from '../src/runner/config.ts';
import {
  assertTickTarget, BOSS_READ_GRANT, forgetTickInstanceState, runTick, runTickFromEnv, TICK_CLOSE_MS, TICK_CONNECT_TIMEOUT_MS, tickBudget,
  type RunTickOptions, type TickSummary,
} from '../src/tick.ts';
import { jobRuns, SETUP_TIMEOUT } from './helpers/harness.ts';
import { bogota, motorKit } from './helpers/motor-kit.ts';

const ANUAL = '0 0 1 1 *';
/** El reloj de los turnos: fijo (ver arriba). */
const RELOJ = new Date();

const calls: Record<string, number> = {};
const count = (id: string) => { calls[id] = (calls[id] ?? 0) + 1; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Se toma todo lo que le den: solo para cuando se aborta su señal. En el segundo intento ya avanzó lo bastante y termina. */
const lento = defineJob('test.tick_a_lento', async (_p, ctx) => {
  count('lento');
  if (ctx.attempt >= 2) return { processed: 1, failed: 0 };
  while (!ctx.signal.aborted) await sleep(20);
  return { processed: 0, failed: 0 };
});
const rapido = defineJob('test.tick_b_rapido', async () => { count('rapido'); return { processed: 1, failed: 0 }; });
const contado = defineJob('test.tick_contado', async () => { count('contado'); await sleep(200); return { processed: 1, failed: 0 }; });
const eterno = defineJob('test.tick_eterno', async (_p, ctx) => {
  count('eterno');
  while (!ctx.signal.aborted) await sleep(20);
  return { processed: 0, failed: 0 };
});
const corte = defineJob('test.tick_corte', async (_p, ctx) => {
  while (!ctx.signal.aborted) await sleep(20);
  return { processed: 0, failed: 0 };
});
/** Cuándo empezó y terminó cada corrida del grupo test_orden (ms de reloj de pared). */
const tiempos: Record<string, { start: number; end: number; source?: unknown }> = {};
const medido = (id: string, ms: number) => async (payload: Record<string, unknown>) => {
  const start = Date.now();
  await sleep(ms);
  tiempos[id] = { start, end: Date.now(), source: payload['source'] };
  return { processed: 1, failed: 0 };
};
const arriba = defineJob('test.tick_orden_arriba', medido('arriba', 150));
const abajo = defineJob('test.tick_orden_abajo', medido('abajo', 10), { after: ['test.tick_orden_arriba'] });
const suelto = defineJob('test.tick_orden_suelto', medido('suelto', 10));
const falla = defineJob('test.tick_falla', async () => { count('falla'); throw new Error('proveedor caído (429)'); });
const muerto = defineJob('test.tick_muerto', async () => { count('muerto'); return { processed: 1, failed: 0 }; });
const vivo = defineJob('test.tick_vivo', async () => { count('vivo'); return { processed: 1, failed: 0 }; });
const reclamoRoto = defineJob('test.tick_err_reclamo', async () => { count('err_reclamo'); return { processed: 1, failed: 0 }; });
const medioSegundo = defineJob('test.tick_err_lento', async () => { await sleep(500); count('err_lento'); return { processed: 1, failed: 0 }; });

let web: EmbeddedDb;
let db: PgliteDatabase;
let guard: NetworkGuard;
/** El utillaje del motor (VEN-10) sobre esta base: lo que siembra va como superusuario (la sesión de la PGlite es mc_app, con RLS). */
const comoSuperusuario = () => ({ raw: { exec: (sql: string) => web.execAsSuperuser(sql), query: (text: string, params?: unknown[]) => web.queryAsSuperuser(text, params) } }) as unknown as PgliteDatabase;
const kit = motorKit({ db: comoSuperusuario, motor: () => motorDbFromJob(db), prefix: '0000017c', slug: 'turno' });
const sink = new MemorySink();
const logger = createLogger({ level: 'debug', sink });

function turno(group: string, jobs: readonly JobRegistration[], extra: Partial<RunTickOptions> = {}): Promise<TickSummary> {
  return runTick({
    db,
    budgetMs: 4_000,
    now: () => RELOJ,
    env: { WORKER_GROUPS: group },
    jobs,
    logger,
    secrets: new InMemorySecretStore(),
    refreshers: refresherRegistry([new FakeTokenRefresher('tiktok')]),
    ...extra,
  });
}

before(async () => {
  guard = withoutNetwork();
  web = await createEmbeddedDb({ snapshot: true });
  const pglite = await web.raw(async (p: PGlite) => p);
  db = PgliteDatabase.wrap(pglite, 'mc_worker');
  await web.execAsSuperuser(`
    INSERT INTO job_definition (id, label_es, queue, default_cron, timeout_s, max_attempts, max_concurrency) VALUES
      ('test.tick_a_lento',  'Prueba turno: lento',   'test_presupuesto', '${ANUAL}', 300, 1, 1),
      ('test.tick_b_rapido', 'Prueba turno: rápido',  'test_presupuesto', '${ANUAL}', 60,  1, 1),
      ('test.tick_contado',  'Prueba turno: contado', 'test_carrera',     '${ANUAL}', 60,  1, 1),
      ('test.tick_eterno',   'Prueba turno: eterno',  'test_eterno',      '${ANUAL}', 300, 1, 1),
      ('test.tick_corte',    'Prueba turno: corte',   'test_corte',       '${ANUAL}', 300, 1, 1),
      ('test.tick_muerto',   'Prueba turno: muerto',  'test_muerto',      '${ANUAL}', 600, 2, 1),
      ('test.tick_vivo',     'Prueba turno: vivo',    'test_muerto',      '${ANUAL}', 600, 2, 1),
      ('test.tick_orden_arriba', 'Prueba turno: arriba', 'test_orden',    '${ANUAL}', 60,  1, 1),
      ('test.tick_orden_abajo',  'Prueba turno: abajo',  'test_orden',    '${ANUAL}', 60,  1, 1),
      ('test.tick_orden_suelto', 'Prueba turno: suelto', 'test_orden',    '${ANUAL}', 60,  1, 1),
      ('test.tick_falla',    'Prueba turno: falla',   'test_backoff',     '${ANUAL}', 60,  4, 1),
      ('test.tick_err_reclamo', 'Prueba turno: reclamo roto', 'test_error', '${ANUAL}', 60, 1, 1),
      ('test.tick_err_lento',   'Prueba turno: medio segundo', 'test_error', '${ANUAL}', 60, 1, 1);
  `);
  // Lo que el turno guarda por instancia (platform.limits, avisos ya dados) no viene de otro archivo de pruebas.
  forgetTickInstanceState();
}, SETUP_TIMEOUT);

after(async () => {
  guard?.restore();
  await web?.close();
});

test('el presupuesto: margen y mínimo para empezar, acotados en un turno corto', () => {
  assert.deepEqual(tickBudget(45_000, 1_000), { deadline: 41_000, minSliceMs: 10_000 }, 'Vercel: 45 s, 5 s de margen');
  assert.deepEqual(tickBudget(4_000, 0), { deadline: 3_200, minSliceMs: 1_000 }, 'corto: 20 % de margen, 25 % para empezar');
});

test('respeta el presupuesto: corta lo que no cabe, no empieza lo que no tiene tiempo, y no deja nada corriendo', async () => {
  const s = await turno('test_presupuesto', [lento, rapido], { concurrency: 1 });
  assert.ok(s.elapsedMs < s.budgetMs, `terminó a tiempo: ${s.elapsedMs} ms de ${s.budgetMs}`);
  assert.deepEqual(s.ran.map((r) => [r.job, r.reason, r.status, r.cut]), [['test.tick_a_lento', 'due', 'failed', true]]);
  assert.deepEqual(s.left, [{ job: 'test.tick_a_lento', reason: 'cut' }, { job: 'test.tick_b_rapido', reason: 'budget' }]);
  assert.equal(s.failedRuns, 0, 'un corte del turno no es un fallo del job');
  assert.equal(calls['rapido'], undefined, 'sin tiempo para empezarlo, ni lo reclamó');

  const [corrida] = await jobRuns(db, 'test.tick_a_lento');
  assert.equal(corrida?.status, 'failed');
  assert.equal(corrida?.error, 'timeout');
  assert.equal(corrida?.metadata[TICK_CUT_KEY], true);
  assert.ok(Number(corrida?.metadata['timeoutS']) < 300, 'el timeout fue lo que quedaba del turno, no el de job_definition');
  assert.deepEqual(await jobRuns(db, 'test.tick_b_rapido'), [], 'lo que no empezó no deja fila: sigue vencido');
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM job_run WHERE status = 'running' AND job_id LIKE 'test.tick_%'`);
  assert.equal(rows[0]?.n, 0, 'ni zombis: cada fila quedó cerrada');
});

test('el turno siguiente retoma lo que quedó, sin gastar un intento, y después no repite nada', async () => {
  const s = await turno('test_presupuesto', [lento, rapido], { concurrency: 1 });
  assert.deepEqual(s.ran.map((r) => [r.job, r.reason, r.status]), [['test.tick_a_lento', 'resume', 'ok'], ['test.tick_b_rapido', 'due', 'ok']],
    'max_attempts es 1 y aun así lo retoma: el corte no contó como intento');
  assert.deepEqual(s.left, []);
  assert.deepEqual((await jobRuns(db, 'test.tick_a_lento')).map((r) => r.attempt), [1, 2]);

  const t0 = Date.now();
  const again = await turno('test_presupuesto', [lento, rapido]);
  assert.deepEqual(again.ran, [], 'al día: nada vuelve a correr en el mismo tick');
  assert.equal(again.upToDate, 2);
  assert.ok(Date.now() - t0 < 2_000, `sin nada vencido sale enseguida: ${Date.now() - t0} ms`);
  assert.equal(calls['rapido'], 1);
});

test('dos turnos a la vez no corren dos veces lo mismo', async () => {
  const [a, b] = await Promise.all([turno('test_carrera', [contado]), turno('test_carrera', [contado])]);
  assert.equal(calls['contado'], 1, 'un solo turno lo reclamó');
  const corridas = [...a.ran, ...b.ran].filter((r) => r.job === 'test.tick_contado');
  assert.deepEqual(corridas.map((r) => r.status), ['ok']);
  const otro = a.ran.length === 0 ? a : b;
  assert.ok(otro.left.some((l) => l.job === 'test.tick_contado' && l.reason === 'running') || otro.upToDate === 1,
    `el otro turno lo vio corriendo o ya hecho: ${JSON.stringify(otro)}`);
  assert.equal((await jobRuns(db, 'test.tick_contado')).length, 1, 'una sola fila en job_run');
});

test(`un job que nunca cabe se deja de retomar tras ${MAX_TICK_CUTS} cortes, hasta su próximo tick`, async () => {
  const s = await turno('test_eterno', [eterno], { budgetMs: 1_500 });
  assert.deepEqual(s.ran.map((r) => [r.job, r.cut]), [['test.tick_eterno', true]]);
  // Los cortes anteriores, sin esperar diecinueve turnos: se copian como filas del mismo tick.
  await web.execAsSuperuser(`
    INSERT INTO job_run (job_id, status, attempt, started_at, finished_at, error, metadata)
    SELECT 'test.tick_eterno', 'failed', 1, '${RELOJ.toISOString()}', now(), 'timeout', '{"${TICK_CUT_KEY}": true}'::jsonb
      FROM generate_series(1, ${MAX_TICK_CUTS - 1});
  `);
  const agotado = await turno('test_eterno', [eterno], { budgetMs: 1_500 });
  assert.deepEqual(agotado.ran, []);
  assert.deepEqual(agotado.exhausted, ['test.tick_eterno']);
  assert.equal(calls['eterno'], 1);
});

test('el corte se marca en la misma escritura que cierra la fila: quien reclama justo después ya lo ve como corte', async () => {
  const DEF_CORTE: JobDefinition = {
    id: 'test.tick_corte', labelEs: 'Prueba turno: corte', queue: 'test_corte', defaultCron: ANUAL, timeoutS: 300, maxAttempts: 1, maxConcurrency: 1, enabled: true,
  };
  const updates: string[] = [];
  let cierre: Record<string, unknown> | null = null;
  let visto: Claim | null = null;
  const ROLLBACK = new Error('rollback');
  // Una base espía: tras la escritura que cierra la fila del job, y antes de
  // que el turno haga nada más, otra pasada intenta reclamarlo (y deshace).
  const espia = new Proxy(db, {
    get(target, prop) {
      if (prop === 'query') {
        return async (text: string, params: readonly unknown[] = []) => {
          const r = await target.query(text, params);
          if (/^\s*UPDATE job_run/.test(text)) updates.push(text);
          if (/UPDATE job_run\s+SET status = \$2/.test(text) && cierre === null) {
            cierre = JSON.parse(String(params[6])) as Record<string, unknown>;
            await target.transaction(async (tx) => {
              const enTx = { transaction: <T>(fn: (q: typeof tx) => Promise<T>) => fn(tx) } as unknown as WorkerDatabase;
              visto = await claimRun(enTx, { def: DEF_CORTE, registration: corte, payload: {}, coverFrom: lastTick(ANUAL, RELOJ)!, reason: 'due' }, RELOJ, 'once:espia');
              throw ROLLBACK;
            }).catch((err: unknown) => { if (err !== ROLLBACK) throw err; });
          }
          return r;
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as WorkerDatabase;

  const s = await turno('test_corte', [corte], { db: espia, budgetMs: 1_500 });
  assert.deepEqual(s.ran.map((r) => [r.job, r.cut]), [['test.tick_corte', true]]);
  assert.equal(cierre?.[TICK_CUT_KEY], true, 'la fila se cerró ya con tickCut');
  assert.equal(updates.length, 1, `una sola escritura sobre job_run, sin un UPDATE de marca después: ${updates.join(' | ')}`);
  assert.deepEqual(visto && { reason: (visto as { reason?: string }).reason, attempt: (visto as { attempt?: number }).attempt }, { reason: 'resume', attempt: 2 },
    'max_attempts es 1: si el corte hubiera contado como intento, sería retries_exhausted');
});

test('una fila running de un turno muerto deja de estar viva a su sliceS + 30 s, no a los timeout_s de la definición', async () => {
  const hace2min = new Date(RELOJ.getTime() - 120_000).toISOString();
  await web.execAsSuperuser(`
    INSERT INTO job_run (job_id, status, attempt, started_at, metadata) VALUES
      ('test.tick_muerto', 'running', 1, '${hace2min}', '{"bossJobId": "once:muerto", "sliceS": 40}'::jsonb),
      ('test.tick_vivo',   'running', 1, '${hace2min}', '{"bossJobId": "once:vivo"}'::jsonb);
  `);
  const s = await turno('test_muerto', [muerto, vivo]);
  assert.deepEqual(s.ran.map((r) => [r.job, r.reason, r.status]), [['test.tick_muerto', 'retry', 'ok']],
    'la del turno (sliceS 40) murió hace 50 s: cuenta como intento y se reintenta');
  assert.deepEqual(s.left, [{ job: 'test.tick_vivo', reason: 'running' }], 'sin sliceS, 600 s de timeout: sigue viva');
  assert.equal(calls['vivo'], undefined);
});

test('con 3 recorredores, lo encadenado vencido a la vez que lo de arriba espera a que termine, y corre una vez con sus datos nuevos', async () => {
  // La puesta al día: arriba (collect.post_metrics) y abajo (compute.baseline) vencidos por su cron a la vez.
  const s = await turno('test_orden', [arriba, abajo, suelto], { concurrency: 3 });
  assert.deepEqual(s.ran.map((r) => r.job).sort(), ['test.tick_orden_abajo', 'test.tick_orden_arriba', 'test.tick_orden_suelto']);
  const a = tiempos['arriba']!;
  const b = tiempos['abajo']!;
  assert.ok(b.start >= a.end, `abajo empezó (${b.start}) después de que arriba terminara (${a.end})`);
  assert.equal(b.source, 'chain', 'corrió como encadenado de arriba, no por su cron con los datos de antes');
  assert.equal(s.ran.find((r) => r.job === 'test.tick_orden_abajo')?.reason, 'chained');
  assert.ok(tiempos['suelto']!.start < a.end, 'lo que no depende de nada sigue en paralelo');
  assert.equal((await jobRuns(db, 'test.tick_orden_abajo')).length, 1, 'una sola corrida de abajo en la pasada');
});

test('un fallo espera su backoff antes del reintento, como en el proceso largo (WORKER_RETRY_DELAY_S=60)', async () => {
  const t0 = RELOJ.getTime();
  const en = (s: number) => turno('test_backoff', [falla], { now: () => new Date(t0 + s * 1000), env: { WORKER_GROUPS: 'test_backoff', WORKER_RETRY_DELAY_S: '60', WORKER_RETRY_DELAY_MAX_S: '900' } });
  const razon = (s: TickSummary) => s.left.find((l) => l.job === 'test.tick_falla')?.reason;

  assert.deepEqual((await en(0)).ran.map((r) => [r.reason, r.status]), [['due', 'failed']], 'minuto 0: falla');
  const a30 = await en(30);
  assert.deepEqual(a30.ran, [], '0:30: dentro de los 60 s de espera, no se reintenta');
  assert.equal(razon(a30), 'backoff');
  assert.deepEqual((await en(60)).ran.map((r) => [r.reason, r.status]), [['retry', 'failed']], '1:00: pasada la espera, sí');
  // Segundo fallo a la 1:00: la espera se dobla (60·2 = 120 s), hasta las 3:00.
  assert.equal(razon(await en(150)), 'backoff', '2:30: dentro de los 120 s');
  assert.deepEqual((await en(180)).ran.map((r) => [r.reason, r.status]), [['retry', 'failed']], '3:00: el tercer intento');
  assert.deepEqual((await jobRuns(db, 'test.tick_falla')).map((r) => r.attempt), [1, 2, 3]);
  assert.equal(calls['falla'], 3, 'tres golpes al proveedor en tres minutos, no uno por turno');
});

test('los trabajos que esperan en pgboss.job se cuentan y se avisan: el turno no los procesa', async () => {
  const sinBoss = await turno('test_carrera', [contado]);
  assert.equal(sinBoss.orphanedBossJobs, null, 'sin esquema pgboss, nada que contar');
  assert.equal(typeof sinBoss.planMs, 'number');
  // Como lo deja `--install`: el esquema es del rol de conexión, y mc_worker no tiene permiso.
  await web.execAsSuperuser(`
    CREATE SCHEMA pgboss;
    CREATE TABLE pgboss.job (id serial PRIMARY KEY, name text, state text);
    INSERT INTO pgboss.job (name, state) VALUES ('campaign.compute', 'created'), ('collect.posts', 'completed');
  `);
  try {
    const desde = sink.records().length;
    const ciego = await turno('test_carrera', [contado]);
    assert.equal(ciego.orphanedBossJobs, 'unreadable', 'hay esquema pero no se puede leer: no es lo mismo que no tenerlo');
    await turno('test_carrera', [contado]);
    const avisos = sink.records().slice(desde).filter((r) => r['level'] === 'warn' && String(r['msg']).includes('pgboss.job existe'));
    assert.equal(avisos.length, 1, 'el aviso sale una vez por instancia, no cada minuto');
    assert.equal(avisos[0]?.['grant'], BOSS_READ_GRANT, 'y dice el GRANT que falta');

    await web.execAsSuperuser(BOSS_READ_GRANT);
    const conBoss = await turno('test_carrera', [contado]);
    assert.equal(conBoss.orphanedBossJobs, 1);
    assert.ok(sink.records().some((r) => r['level'] === 'warn' && String(r['msg']).includes('pgboss.job') && r['orphanedBossJobs'] === 1));
  } finally {
    await web.execAsSuperuser('DROP SCHEMA pgboss CASCADE');
  }
});

test('una corrida que lanza fuera de su job (la base falla al reclamarla) no tumba el turno: los demás terminan y el resumen llega con los dos', async () => {
  // Una base que falla solo en el reclamo de test.tick_err_reclamo (su candado): un timeout del pooler, por ejemplo.
  const candado = `${JOB_LOCK_PREFIX}test.tick_err_reclamo`;
  const bind = (t: object, p: string | symbol) => {
    const v = Reflect.get(t, p, t) as unknown;
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
  };
  const txRota = (tx: Queryable): Queryable => new Proxy(tx, {
    get(t, p) {
      if (p !== 'query') return bind(t, p);
      return async (text: string, params: readonly unknown[] = []) => {
        if (params[0] === candado) throw new Error('timeout exceeded when trying to connect');
        return t.query(text, params);
      };
    },
  });
  const rota = new Proxy(db, {
    get(t, p) {
      if (p !== 'transaction') return bind(t, p);
      return <T>(fn: (tx: Queryable) => Promise<T>) => t.transaction((tx) => fn(txRota(tx)));
    },
  }) as WorkerDatabase;

  const desde = sink.records().length;
  const s = await turno('test_error', [reclamoRoto, medioSegundo], { db: rota, concurrency: 3 });
  assert.deepEqual(s.ran.map((r) => [r.job, r.status]), [['test.tick_err_lento', 'ok']], 'el que seguía corriendo terminó');
  assert.deepEqual(s.left, [{ job: 'test.tick_err_reclamo', reason: 'error' }]);
  assert.ok(s.elapsedMs >= 500, `el turno esperó al otro recorredor (${s.elapsedMs} ms), no respondió a los pocos ms`);
  assert.equal(calls['err_reclamo'], undefined, 'sin reclamo, el job no corrió');
  assert.equal(calls['err_lento'], 1);
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM job_run WHERE status = 'running' AND job_id LIKE 'test.tick_err_%'`);
  assert.equal(rows[0]?.n, 0, 'ninguna fila running');
  assert.ok(sink.records().slice(desde).some((r) => r['level'] === 'error' && r['job'] === 'test.tick_err_reclamo' && /timeout exceeded/.test(JSON.stringify(r['err']))),
    'el error queda en el log con su job');

  // Con la base ya bien, el turno siguiente lo corre: seguía vencido.
  const despues = await turno('test_error', [reclamoRoto, medioSegundo]);
  assert.deepEqual(despues.ran.map((r) => [r.job, r.reason, r.status]), [['test.tick_err_reclamo', 'due', 'ok']]);
});

test('platform.limits con entradas que no se aplican (las de la migración 0011): un turno no las escribe a warn, solo un aviso por instancia', async () => {
  const directo = new MemorySink();
  await loadPlatformLimits(db, createLogger({ level: 'warn', sink: directo }));
  const porEntrada = directo.records().filter((r) => r['msg'] === 'platform.limits: entrada ignorada').length;
  assert.ok(porEntrada > 0, 'la base de pruebas trae las mismas entradas que producción');

  forgetTickInstanceState();
  const avisos = new MemorySink();
  const enWarn = createLogger({ level: 'warn', sink: avisos });
  for (let i = 0; i < 3; i++) await turno('test_carrera', [contado], { logger: enWarn });
  const mensajes = avisos.records().map((r) => String(r['msg']));
  assert.equal(mensajes.filter((m) => m.includes('entrada ignorada')).length, 0, `ninguna línea por entrada: ${mensajes.join(' | ')}`);
  const resumen = avisos.records().filter((r) => String(r['msg']).startsWith('platform.limits'));
  assert.equal(resumen.length, 1, 'tres turnos, un solo aviso');
  assert.equal(resumen[0]?.['ignored'], porEntrada);
});

test('outbound.dispatch sobre el seed de outreach: dos turnos a la vez sacan el mensaje vencido UNA vez, con presupuesto para más de 5 toques, y el siguiente no lo repite', async () => {
  // Dentro del horario de envío de la demo (Bogotá): ahora, o la próxima apertura.
  const reloj = nextWindowSlot(new Date(), 'America/Bogota');
  const motor = motorDbFromJob(db);
  const prep = await motor.transaction((tx) => prepareDemoForDispatch(tx, DEMO_WORKSPACE_ID, reloj));
  await motor.transaction((tx) => enableOutreach(tx, { workspaceId: DEMO_WORKSPACE_ID, now: reloj }));
  const env = { WORKER_GROUPS: 'sales', OUTREACH_CHANNELS: 'fake', APP_URL: 'https://oncue.test' };

  const [a, b] = await Promise.all([
    turno('sales', [dispatchJob], { now: () => reloj, env, budgetMs: 45_000 }),
    turno('sales', [dispatchJob], { now: () => reloj, env, budgetMs: 45_000 }),
  ]);
  const corridas = [...a.ran, ...b.ran].filter((r) => r.job === DISPATCH_JOB_ID);
  assert.deepEqual(corridas.map((r) => [r.status, r.processed]), [['ok', 1]], 'un solo turno lo reclamó y envió');
  for (const s of [a, b]) assert.ok(s.elapsedMs < 15_000, `no espera a agotar los 45 s: ${s.elapsedMs} ms`);
  const { rows } = await db.query<{ status: string; provider_message_id: string | null }>(
    'SELECT status, provider_message_id FROM outbound_touch WHERE id = $1', [prep.touchId]);
  assert.equal(rows[0]?.status, 'sent');
  assert.match(rows[0]?.provider_message_id ?? '', /^fake-linkedin-/);
  const [corrida, ...otras] = await jobRuns(db, DISPATCH_JOB_ID);
  assert.deepEqual(otras, [], 'una sola fila en job_run');
  assert.equal(corrida?.metadata['sent'], 1);
  assert.match(String(corrida?.metadata['bossJobId']), /^tick:[0-9a-f-]{36}$/, 'la marca de turno (TICK_RUN_PREFIX): startWorker la busca');
  // Con 45 s de turno el job tiene ~40 s y un margen del 25 % (plazo.ts): ~15 toques por pasada.
  // Con el margen fijo de 30 s eran 10 s y 5 toques, nueve veces menos que el proceso largo.
  assert.ok(Number(corrida?.metadata['claimBudget']) >= 10, `presupuesto de la pasada: ${String(corrida?.metadata['claimBudget'])} toques`);

  const again = await turno('sales', [dispatchJob], { now: () => reloj, env, budgetMs: 45_000 });
  assert.deepEqual(again.ran, [], 'el mismo tick de */2 ya está cubierto');
  assert.equal((await jobRuns(db, DISPATCH_JOB_ID)).length, 1);
});

test('outbound.dispatch con más toques vencidos de los que caben en una pasada: el turno envía los que caben, el siguiente tick de */2 el resto, y ninguno sale dos veces', async () => {
  // Un martes a las 10:00 de Bogotá, dentro de la ventana: el tick de */2 de las 10:00 y el de las 10:02.
  const t1 = bogota('2026-10-06', '10:00');
  const t2 = new Date(t1.getTime() + 2 * 60_000);
  const t3 = new Date(t1.getTime() + 4 * 60_000);
  const TOQUES = 6;
  const w = await kit.workspace(1, { contacts: TOQUES, dailyCap: 100, warmupStartedAt: null });
  await kit.enroll(w, bogota('2026-10-06', '09:00'));
  // Los primeros correos de los seis, vencidos a la vez; solo este workspace despacha.
  await web.queryAsSuperuser(`UPDATE outbound_touch SET scheduled_for = $2 WHERE workspace_id = $1 AND step_id = $3`, [w.id, bogota('2026-10-06', '09:40').toISOString(), w.steps[0]]);
  await web.queryAsSuperuser(`UPDATE outbound_policy SET enabled = false WHERE workspace_id <> $1`, [w.id]);
  const env = { WORKER_GROUPS: 'sales', OUTREACH_CHANNELS: 'fake', APP_URL: 'https://oncue.test' };
  const enviados = async () => (await web.queryAsSuperuser<{ id: string; provider_message_id: string | null; attempt_count: number }>(
    `SELECT id, provider_message_id, attempt_count FROM outbound_touch WHERE workspace_id = $1 AND status = 'sent'`, [w.id])).rows;

  // Un turno corto: el job tiene unos 6 s, y a ESTIMATED_SEND_MS por toque caben 2.
  const primero = await turno('sales', [dispatchJob], { now: () => t1, env, budgetMs: 8_000 });
  const c1 = (await jobRuns(db, DISPATCH_JOB_ID)).at(-1);
  const cabian = Number(c1?.metadata['claimBudget']);
  assert.ok(cabian >= 1 && cabian < TOQUES, `la pasada solo podía con ${cabian} de ${TOQUES}`);
  assert.deepEqual(primero.ran.map((r) => [r.job, r.status, r.processed, r.cut]), [[DISPATCH_JOB_ID, 'ok', cabian, false]],
    'termina solo, antes de su plazo: devuelve a la cola lo que no intentó, sin corte');
  assert.equal((await enviados()).length, cabian);

  // El mismo tick de */2 ya está cubierto: un turno repetido no envía más.
  assert.deepEqual((await turno('sales', [dispatchJob], { now: () => new Date(t1.getTime() + 30_000), env, budgetMs: 8_000 })).ran, []);
  assert.equal((await enviados()).length, cabian);

  // El tick siguiente retoma lo que quedó en la cola.
  const segundo = await turno('sales', [dispatchJob], { now: () => t2, env, budgetMs: 45_000 });
  assert.deepEqual(segundo.ran.map((r) => [r.job, r.status, r.processed]), [[DISPATCH_JOB_ID, 'ok', TOQUES - cabian]]);
  const tercero = await turno('sales', [dispatchJob], { now: () => t3, env, budgetMs: 45_000 });
  assert.deepEqual(tercero.ran.map((r) => [r.status, r.processed]), [['ok', 0]], 'nada más que enviar');

  const filas = await enviados();
  assert.equal(filas.length, TOQUES, 'los seis salieron');
  assert.ok(filas.every((f) => f.attempt_count === 1), 'cada uno en un solo intento');
  const envios = [primero, segundo, tercero].flatMap((t) => t.ran).reduce((n, r) => n + r.processed, 0);
  assert.equal(envios, TOQUES, 'tantos envíos como toques: ninguno salió dos veces');
  assert.ok(filas.every((f) => f.provider_message_id), 'todos con su mensaje del proveedor');
});

test('contra una base remota el turno solo corre en el despliegue de producción de Vercel (o con TICK_ALLOW_REMOTE=1)', async () => {
  const supabase = 'postgresql://mc_worker_login.x:clave@aws-0-ca-central-1.pooler.supabase.com:5432/postgres';
  // Lo que pasa con `pnpm --filter @mc/web dev` y el .env.local de `make db.unlock`: se niega ANTES de abrir el pool (sin red).
  await assert.rejects(runTickFromEnv({ budgetMs: 4_000, logger, env: { DATABASE_URL_DIRECT: supabase, APP_URL: 'http://localhost:3100' } }),
    (err: unknown) => err instanceof ConfigError && /solo corre en el despliegue de producción de Vercel/.test(err.message) && /WORKER_DATABASE_URL/.test(err.message));
  await assert.rejects(runTickFromEnv({ budgetMs: 4_000, logger, env: { WORKER_DATABASE_URL: supabase, VERCEL_ENV: 'preview' } }), ConfigError,
    'tampoco en una vista previa de Vercel');
  assert.throws(() => assertTickTarget({ VERCEL_ENV: 'preview' }, { databaseUrl: supabase }), ConfigError);
  assert.doesNotThrow(() => assertTickTarget({ VERCEL_ENV: 'production' }, { databaseUrl: supabase }));
  assert.doesNotThrow(() => assertTickTarget({ TICK_ALLOW_REMOTE: '1' }, { databaseUrl: supabase }), 'a sabiendas');
  assert.doesNotThrow(() => assertTickTarget({}, { databaseUrl: 'postgres://mc:mc@localhost:5432/oncue' }), 'tu Postgres de Docker');
});

test(`con el pooler colgado (acepta y no contesta), el turno falla a los ${TICK_CONNECT_TIMEOUT_MS / 1000} s con su motivo, no a los 60 s de Vercel`, async () => {
  // Un «pooler» en esta máquina que acepta la conexión y no dice nada: lo que pasa con las 15 de sesión ocupadas.
  const abiertas: Socket[] = [];
  const mudo = createServer((socket) => { abiertas.push(socket); });
  await new Promise<void>((resolve) => mudo.listen(0, '127.0.0.1', resolve));
  const { port } = mudo.address() as AddressInfo;
  try {
    const t0 = Date.now();
    await assert.rejects(
      runTickFromEnv({ budgetMs: 45_000, logger, env: { WORKER_DATABASE_URL: `postgres://mc:mc@127.0.0.1:${port}/oncue` } }),
      /timeout/i,
    );
    const ms = Date.now() - t0;
    // La espera de conexión, más como mucho lo que se espera a cerrar el pool (TICK_CLOSE_MS): muy por debajo de los 60 s.
    assert.ok(ms >= TICK_CONNECT_TIMEOUT_MS - 200 && ms < TICK_CONNECT_TIMEOUT_MS + TICK_CLOSE_MS + 2_000, `falló a los ${ms} ms`);
  } finally {
    for (const s of abiertas) s.destroy();
    await new Promise<void>((resolve) => mudo.close(() => resolve()));
  }
});

test('con el canal falso pedido contra una base que no es local, el turno no arranca', async () => {
  const supabase = 'postgresql://mc_worker_login.x:clave@aws-0-ca-central-1.pooler.supabase.com:5432/postgres';
  // El modo lo decide el entorno (NODE_ENV=production), igual que en src/index.ts.
  await assert.rejects(
    turno('sales', [dispatchJob], { env: { OUTREACH_CHANNELS: 'fake', NODE_ENV: 'production', WORKER_DATABASE_URL: supabase } }),
    /OUTREACH_CHANNELS=fake no se permite en producción/,
  );
});

test('un presupuesto sin sentido se rechaza antes de tocar la base', async () => {
  await assert.rejects(turno('test_carrera', [contado], { budgetMs: 10 }), RangeError);
  await assert.rejects(turno('test_carrera', [contado], { budgetMs: Number.NaN }), RangeError);
});

/**
 * CIM-7 · exclusión mutua con el proceso largo (src/runner/exclusion.ts).
 * PGlite tiene una sola sesión: el candado de otra sesión se simula
 * respondiendo la consulta a pg_locks. Con dos sesiones de verdad lo
 * prueba test/tick-postgres.test.ts.
 */
const candado = defineJob('test.tick_candado', async () => { count('candado'); return { processed: 1, failed: 0 }; });

/** La base del turno, con la consulta a pg_locks respondida como si otra sesión tuviera el candado. */
function conCandadoAjeno(base: WorkerDatabase): WorkerDatabase {
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'query') {
        return (text: string, params?: readonly unknown[]) =>
          text.includes('pg_locks') ? Promise.resolve({ rows: [{ held: true }], rowCount: 1 }) : target.query(text, params);
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as WorkerDatabase;
}

test('con el candado del proceso largo en otra sesión, el turno no corre nada y lo dice; sin él, corre y marca sus filas como de turno', async () => {
  await web.execAsSuperuser(`
    INSERT INTO job_definition (id, label_es, queue, default_cron, timeout_s, max_attempts, max_concurrency)
    VALUES ('test.tick_candado', 'Prueba turno: candado', 'test_candado', '${ANUAL}', 60, 1, 1)`);
  const antes = sink.records().length;
  const bloqueado = await runTick({
    db: conCandadoAjeno(db), budgetMs: 4_000, now: () => RELOJ, env: { WORKER_GROUPS: 'test_candado' }, jobs: [candado], logger,
    secrets: new InMemorySecretStore(), refreshers: refresherRegistry([new FakeTokenRefresher('tiktok')]),
  });
  assert.deepEqual(bloqueado.ran, []);
  assert.deepEqual(bloqueado.left, [{ job: '*', reason: 'running' }]);
  assert.equal(calls['candado'], undefined, 'ni lo reclamó');
  assert.deepEqual(await jobRuns(db, 'test.tick_candado'), [], 'ni una fila en job_run');
  const aviso = sink.records().slice(antes).find((r) => r['level'] === 'warn' && String(r['msg']).includes('proceso largo'));
  assert.equal(aviso?.['lock'], LONG_PROCESS_LOCK, 'el log dice por qué no corrió');

  // En PGlite el candado propio no cuenta como de otra sesión: el turno corre.
  const libre = await turno('test_candado', [candado]);
  assert.deepEqual(libre.ran.map((r) => [r.job, r.status]), [['test.tick_candado', 'ok']]);
  const [fila] = await jobRuns(db, 'test.tick_candado');
  assert.match(String(fila?.metadata['bossJobId']), new RegExp(`^${TICK_RUN_PREFIX}[0-9a-f-]{36}$`), 'la fila lleva la marca de turno');
});

test('el proceso largo no arranca con turnos en los últimos 5 min, salvo WORKER_ALLOW_WITH_TICK=1', async () => {
  // La prueba de arriba dejó una corrida de turno con started_at = RELOJ.
  await assert.rejects(assertNoRecentTicks(db, {}, RELOJ), (err: unknown) => err instanceof ConfigError && /modo por turnos/.test(err.message) && /cron\.uninstall/.test(err.message));
  await assertNoRecentTicks(db, { [ALLOW_WITH_TICK_ENV]: '1' }, RELOJ);
  // Pasada la ventana (con un reloj posterior a todas las corridas de este archivo, que usan relojes propios), arranca.
  const { rows } = await db.query<{ ultima: Date }>(`SELECT max(started_at) AS ultima FROM job_run`);
  await assertNoRecentTicks(db, {}, new Date(new Date(rows[0]!.ultima).getTime() + RECENT_TICK_WINDOW_MS + 1_000));
  // Las filas de --once (bossJobId once:…, sin sliceS) no cuentan como turno.
  await web.execAsSuperuser(`
    INSERT INTO job_run (job_id, status, attempt, started_at, finished_at, metadata)
    VALUES ('test.tick_candado', 'ok', 1, '${new Date(new Date(rows[0]!.ultima).getTime() + 60_000).toISOString()}', now(), '{"bossJobId": "once:manual"}'::jsonb)`);
  await assertNoRecentTicks(db, {}, new Date(new Date(rows[0]!.ultima).getTime() + RECENT_TICK_WINDOW_MS + 2_000));

  // Y startWorker lo aplica antes de arrancar pg-boss.
  await assert.rejects(
    startWorker({
      config: loadConfig({}, { mode: 'pglite' }), db, logger, jobs: [], env: {}, now: () => RELOJ,
      secrets: new InMemorySecretStore(), refreshers: refresherRegistry([]),
    }),
    ConfigError,
  );
});
