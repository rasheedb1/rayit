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
import { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { createLogger, MemorySink } from '../src/runner/logger.ts';
import { MAX_TICK_CUTS, TICK_CUT_KEY } from '../src/runner/once.ts';
import { defineJob, type JobRegistration } from '../src/runner/registry.ts';
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
      ('test.tick_eterno',   'Prueba turno: eterno',  'test_eterno',      '${ANUAL}', 300, 1, 1);
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

test('outbound.dispatch sobre el seed de outreach: un turno saca el mensaje vencido de la demo y el siguiente no lo repite', async () => {
  // Dentro del horario de envío de la demo (Bogotá): ahora, o la próxima apertura.
  const reloj = nextWindowSlot(new Date(), 'America/Bogota');
  const motor = motorDbFromJob(db);
  const prep = await motor.transaction((tx) => prepareDemoForDispatch(tx, DEMO_WORKSPACE_ID, reloj));
  await motor.transaction((tx) => enableOutreach(tx, { workspaceId: DEMO_WORKSPACE_ID, now: reloj }));
  const env = { WORKER_GROUPS: 'sales', OUTREACH_CHANNELS: 'fake', APP_URL: 'https://oncue.test' };

  const s = await turno('sales', [dispatchJob], { now: () => reloj, env, budgetMs: 45_000 });
  assert.deepEqual(s.ran.map((r) => [r.job, r.status, r.processed]), [[DISPATCH_JOB_ID, 'ok', 1]]);
  assert.ok(s.elapsedMs < 15_000, `no espera a agotar los 45 s: ${s.elapsedMs} ms`);
  const { rows } = await db.query<{ status: string; provider_message_id: string | null }>(
    'SELECT status, provider_message_id FROM outbound_touch WHERE id = $1', [prep.touchId]);
  assert.equal(rows[0]?.status, 'sent');
  assert.match(rows[0]?.provider_message_id ?? '', /^fake-linkedin-/);
  const [corrida] = await jobRuns(db, DISPATCH_JOB_ID);
  assert.equal(corrida?.metadata['sent'], 1);
  assert.match(String(corrida?.metadata['bossJobId']), /^once:[0-9a-f-]{36}$/);

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
