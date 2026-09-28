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
import type { PGlite } from '@electric-sql/pglite';
import { FakeTokenRefresher, InMemorySecretStore, refresherRegistry, withoutNetwork, type NetworkGuard } from '@mc/connectors';
import { nextWindowSlot } from '@mc/core';
import { createEmbeddedDb, type EmbeddedDb } from '@mc/db/embedded';
import { enableOutreach } from '@mc/db/queries/outreach';
import { DEMO_WORKSPACE_ID } from '../src/jobs/ventas/demo-ids.ts';
import { prepareDemoForDispatch } from '../src/jobs/ventas/demo-preparar.ts';
import { motorDbFromJob } from '../src/jobs/ventas/motor-db.ts';
import { dispatchJob, DISPATCH_JOB_ID } from '../src/jobs/ventas/outbound.dispatch.ts';
import { lastTick } from '../src/runner/cron.ts';
import type { WorkerDatabase } from '../src/runner/db.ts';
import { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { createLogger, MemorySink } from '../src/runner/logger.ts';
import { claimRun, MAX_TICK_CUTS, TICK_CUT_KEY, type Claim } from '../src/runner/once.ts';
import { defineJob, type JobDefinition, type JobRegistration } from '../src/runner/registry.ts';
import { runTick, tickBudget, type RunTickOptions, type TickSummary } from '../src/tick.ts';
import { jobRuns, SETUP_TIMEOUT } from './helpers/harness.ts';

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
const muerto = defineJob('test.tick_muerto', async () => { count('muerto'); return { processed: 1, failed: 0 }; });
const vivo = defineJob('test.tick_vivo', async () => { count('vivo'); return { processed: 1, failed: 0 }; });

let web: EmbeddedDb;
let db: PgliteDatabase;
let guard: NetworkGuard;
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
      ('test.tick_vivo',     'Prueba turno: vivo',    'test_muerto',      '${ANUAL}', 600, 2, 1);
  `);
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

test('los trabajos que esperan en pgboss.job se cuentan y se avisan: el turno no los procesa', async () => {
  const sinBoss = await turno('test_carrera', [contado]);
  assert.equal(sinBoss.orphanedBossJobs, null, 'sin esquema pgboss, nada que contar');
  assert.equal(typeof sinBoss.planMs, 'number');
  await web.execAsSuperuser(`
    CREATE SCHEMA pgboss;
    CREATE TABLE pgboss.job (id serial PRIMARY KEY, name text, state text);
    INSERT INTO pgboss.job (name, state) VALUES ('campaign.compute', 'created'), ('collect.posts', 'completed');
    GRANT USAGE ON SCHEMA pgboss TO mc_worker;
    GRANT SELECT ON pgboss.job TO mc_worker;
  `);
  try {
    const conBoss = await turno('test_carrera', [contado]);
    assert.equal(conBoss.orphanedBossJobs, 1);
    assert.ok(sink.records().some((r) => r['level'] === 'warn' && String(r['msg']).includes('pgboss.job') && r['orphanedBossJobs'] === 1));
  } finally {
    await web.execAsSuperuser('DROP SCHEMA pgboss CASCADE');
  }
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
  assert.match(String(corrida?.metadata['bossJobId']), /^once:[0-9a-f-]{36}$/);
  // Con 45 s de turno el job tiene ~40 s y un margen del 25 % (plazo.ts): ~15 toques por pasada.
  // Con el margen fijo de 30 s eran 10 s y 5 toques, nueve veces menos que el proceso largo.
  assert.ok(Number(corrida?.metadata['claimBudget']) >= 10, `presupuesto de la pasada: ${String(corrida?.metadata['claimBudget'])} toques`);

  const again = await turno('sales', [dispatchJob], { now: () => reloj, env, budgetMs: 45_000 });
  assert.deepEqual(again.ran, [], 'el mismo tick de */2 ya está cubierto');
  assert.equal((await jobRuns(db, DISPATCH_JOB_ID)).length, 1);
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
