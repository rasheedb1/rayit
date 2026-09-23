/**
 * WRK · el modo «una pasada» (--once, runner/once.ts) contra Postgres
 * embebido con las migraciones reales, corriendo como mc_worker.
 *
 * Lo que el enunciado exige: una pasada corre lo vencido y la siguiente
 * no repite lo ya corrido. Además: el reintento en la pasada siguiente
 * hasta max_attempts, el encadenamiento, que una corrida de UN
 * workspace no cubre el tick de todos, que una corrida viva no se pisa,
 * que no hace falta el esquema pgboss, oauth.refresh real sin nada que
 * renovar, y la salud (getWorkerHealth) que se lee al terminar.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTokenRefresher, InMemorySecretStore, refresherRegistry } from '@mc/connectors';
import { getWorkerHealth, workerDataAsOf } from '@mc/db/queries/worker';
import { allJobs } from '../src/jobs/index.ts';
import { bossSchemaExists } from '../src/runner/boss.ts';
import { lastTick } from '../src/runner/cron.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { loadJobDefinitions } from '../src/runner/definitions.ts';
import { createLogger, MemorySink } from '../src/runner/logger.ts';
import { runOnce, type OnceSummary } from '../src/runner/once.ts';
import { defineJob } from '../src/runner/registry.ts';
import { formatHealth } from '../src/runner/salud.ts';
import { jobRuns, openTestDatabase, testConfig } from './helpers/harness.ts';

const ANUAL = '0 0 1 1 *';

const calls: Record<string, number> = {};
const count = (id: string) => { calls[id] = (calls[id] ?? 0) + 1; };

const arriba = defineJob('test.once_arriba', async () => { count('arriba'); return { processed: 2, failed: 0, metadata: { accessToken: 'NO-DEBE-GUARDARSE' } }; });
const abajo = defineJob('test.once_abajo', async () => { count('abajo'); return { processed: 1, failed: 0 }; }, { after: ['test.once_arriba'] });
const falla = defineJob('test.once_falla', async () => { count('falla'); throw new RangeError('boom'); });
const vacio = defineJob('test.once_vacio', async () => { count('vacio'); return { processed: 0, failed: 0 }; });
const diario = defineJob('test.once_diario', async () => { count('diario'); return { processed: 1, failed: 0 }; });
const sinCron = defineJob('test.once_sincron', async () => { count('sincron'); return { processed: 1, failed: 0 }; });
const TEST_JOBS = [arriba, abajo, falla, vacio, diario, sinCron];

let db: PgliteDatabase;
const sink = new MemorySink();
const logger = createLogger({ level: 'debug', sink });
let workspaceId: string;

function pasada(overrides: { groups?: string[]; signal?: AbortSignal; now?: () => Date; jobs?: typeof TEST_JOBS } = {}): Promise<OnceSummary> {
  return runOnce({
    config: testConfig({ groups: overrides.groups ?? ['test'] }),
    db,
    logger,
    jobs: overrides.jobs ?? [...allJobs, ...TEST_JOBS],
    secrets: new InMemorySecretStore(),
    refreshers: refresherRegistry([new FakeTokenRefresher('tiktok')]),
    env: {},
    signal: overrides.signal,
    now: overrides.now,
  });
}

const reasons = (s: OnceSummary) => Object.fromEntries(s.skipped.map((x) => [x.job, x.reason]));

before(async () => {
  db = await openTestDatabase();
  await db.raw.exec(`
    INSERT INTO job_definition (id, label_es, queue, default_cron, timeout_s, max_attempts, max_concurrency) VALUES
      ('test.once_arriba',  'Prueba once: arriba',    'test', '${ANUAL}',   5, 1, 1),
      ('test.once_abajo',   'Prueba once: abajo',     'test', '${ANUAL}',   5, 1, 1),
      ('test.once_falla',   'Prueba once: falla',     'test', '${ANUAL}',   5, 2, 1),
      ('test.once_vacio',   'Prueba once: vacío',     'test', '${ANUAL}',   5, 1, 1),
      ('test.once_diario',  'Prueba once: diario',    'test', '0 3 * * *',  5, 1, 1),
      ('test.once_sincron', 'Prueba once: sin cron',  'test', NULL,         5, 1, 1),
      ('test.once_nada',    'Prueba once: sin handler','test', '${ANUAL}',  5, 1, 1),
      ('test.once_apagado', 'Prueba once: apagado',   'test', '${ANUAL}',   5, 1, 1);
    UPDATE job_definition SET enabled = false WHERE id = 'test.once_apagado';
  `);
  const ws = await db.raw.query<{ id: string }>(`INSERT INTO workspace (slug, name) VALUES ('ws-once', 'Once') RETURNING id`);
  workspaceId = ws.rows[0]!.id;
}, { timeout: 600_000 });

after(async () => {
  await db.close();
});

test('1 · la primera pasada corre lo vencido, encadena lo de abajo y anota el fallo', async () => {
  const s = await pasada();
  const porJob = Object.fromEntries(s.runs.map((r) => [r.job, r]));

  assert.equal(porJob['test.once_arriba']?.reason, 'vencido');
  assert.equal(porJob['test.once_arriba']?.status, 'ok');
  assert.equal(porJob['test.once_arriba']?.tick, lastTick(ANUAL, new Date(s.at))!.toISOString());
  assert.equal(porJob['test.once_abajo']?.reason, 'encadenado', 'corre enseguida tras arriba, que procesó 2');
  assert.equal(porJob['test.once_falla']?.status, 'failed');
  assert.equal(porJob['test.once_vacio']?.status, 'ok');
  assert.equal(porJob['test.once_diario']?.status, 'ok');
  assert.equal(calls['abajo'], 1, 'aunque también estaba vencido por su cron, corre una sola vez en la pasada');

  const r = reasons(s);
  assert.equal(r['test.once_sincron'], 'sin_cron', 'lo que no tiene cron es bajo demanda: --once no lo corre');
  assert.equal(r['test.once_nada'], 'sin_handler');
  assert.equal(r['test.once_apagado'], 'deshabilitado');
  assert.equal(s.failedRuns, 1, 'el proceso saldrá con 1: el cron externo lo marca en rojo');

  const [nada] = await jobRuns(db, 'test.once_nada');
  assert.equal(nada?.status, 'skipped');
  assert.equal(nada?.error, 'sin handler');

  const [abajoRun] = await jobRuns(db, 'test.once_abajo');
  assert.equal(abajoRun?.metadata['tras'], 'test.once_arriba');
  const [arribaRun] = await jobRuns(db, 'test.once_arriba');
  assert.match(String(arribaRun?.metadata['bossJobId']), /^once:[0-9a-f-]{36}$/);
  assert.equal(arribaRun?.workspace_id, null, 'la corrida de cron es global');
  assert.doesNotMatch(JSON.stringify(arribaRun?.metadata), /NO-DEBE-GUARDARSE/, 'el redactor también corre en --once');
});

test('2 · la segunda pasada no repite lo ya corrido y reintenta lo que falló', async () => {
  const antes = { ...calls };
  const s = await pasada();
  assert.deepEqual(s.runs.map((r) => [r.job, r.reason, r.status]), [['test.once_falla', 'reintento', 'failed']]);
  for (const id of ['test.once_arriba', 'test.once_abajo', 'test.once_vacio', 'test.once_diario']) {
    assert.equal(reasons(s)[id], 'al_dia', id);
  }
  assert.equal(calls['arriba'], antes['arriba']);
  assert.equal(calls['diario'], antes['diario']);

  const fallos = await jobRuns(db, 'test.once_falla');
  assert.deepEqual(fallos.map((f) => f.attempt), [1, 2], 'attempt = fallidas desde el tick + 1');
  assert.equal(fallos[1]?.error, 'RangeError: boom');
});

test('3 · agotados los max_attempts, espera al próximo tick y lo avisa; y "sin handler" no se repite', async () => {
  const s = await pasada();
  assert.equal(s.runs.length, 0);
  assert.equal(reasons(s)['test.once_falla'], 'reintentos_agotados');
  assert.equal(s.failedRuns, 0);
  assert.ok(sink.records().some((r) => r['msg'] === 'reintentos agotados hasta el próximo tick' && r['job'] === 'test.once_falla'));
  assert.equal((await jobRuns(db, 'test.once_nada')).length, 1);
});

test('4 · una corrida de ANTES del tick no cuenta: el job vuelve a estar vencido', async () => {
  // Movemos la corrida de diario a antes de su último tick (ayer a las 03:00 o antes).
  const tick = lastTick('0 3 * * *', new Date())!;
  await db.raw.query(`UPDATE job_run SET started_at = $1 WHERE job_id = 'test.once_diario'`, [new Date(tick.getTime() - 60_000).toISOString()]);
  const s = await pasada();
  assert.deepEqual(s.runs.map((r) => [r.job, r.reason]), [['test.once_diario', 'vencido']]);
});

/** Lleva las corridas previas del job a antes de su tick anual (1-ene del año en curso): vuelve a estar vencido. */
async function envejecer(jobId: string): Promise<void> {
  await db.raw.query(`UPDATE job_run SET started_at = date_trunc('year', now()) - interval '1 day' WHERE job_id = $1`, [jobId]);
}

test('5 · una corrida de un solo workspace no cubre el tick de todos', async () => {
  await envejecer('test.once_vacio');
  await db.raw.query(`INSERT INTO job_run (job_id, workspace_id, status, finished_at) VALUES ('test.once_vacio', $1, 'ok', now())`, [workspaceId]);
  const s = await pasada();
  assert.deepEqual(s.runs.map((r) => r.job), ['test.once_vacio']);
});

test('6 · una corrida viva (running, dentro de su timeout) no se pisa; una colgada sí se retoma', async () => {
  await envejecer('test.once_vacio');
  await db.raw.exec(`INSERT INTO job_run (job_id, status) VALUES ('test.once_vacio', 'running')`);
  let s = await pasada();
  assert.equal(reasons(s)['test.once_vacio'], 'corriendo');
  assert.equal(s.runs.length, 0);

  // timeout_s 5 + margen 30: a los 40 s ya no está viva.
  await db.raw.exec(`UPDATE job_run SET started_at = now() - interval '40 seconds' WHERE job_id = 'test.once_vacio' AND status = 'running'`);
  s = await pasada();
  assert.deepEqual(s.runs.map((r) => r.job), ['test.once_vacio']);
});

test('7 · con la señal ya disparada no empieza nada', async () => {
  await envejecer('test.once_vacio');
  const abort = new AbortController();
  abort.abort(new Error('SIGTERM'));
  const s = await pasada({ signal: abort.signal });
  assert.equal(s.runs.length, 0);
  assert.equal(reasons(s)['test.once_vacio'], 'apagando');
});

test('8 · oauth.refresh real, sin nada que renovar, deja su job_run ok; y nunca hizo falta el esquema pgboss', async () => {
  // Reloj fijo para las dos pasadas: la segunda no puede caer en otro cuarto de hora.
  const t = new Date();
  const s = await pasada({ groups: ['connections'], now: () => t });
  assert.deepEqual(s.runs.map((r) => [r.job, r.status, r.processed]), [['oauth.refresh', 'ok', 0]]);
  const [run] = await jobRuns(db, 'oauth.refresh');
  assert.equal(run?.status, 'ok');
  assert.equal(await bossSchemaExists(db, 'pgboss'), false, '--once no usa pg-boss');

  const again = await pasada({ groups: ['connections'], now: () => t });
  assert.equal(again.runs.length, 0, 'dentro del mismo cuarto de hora no se repite');
});

test('9 · todas las definiciones reales tienen un cron que --once entiende', async () => {
  const defs = await loadJobDefinitions(db);
  for (const d of defs.filter((x) => x.defaultCron && !x.id.startsWith('test.'))) {
    assert.ok(lastTick(d.defaultCron!, new Date('2026-09-23T12:00:00Z')), d.id);
  }
  assert.ok(!sink.records().some((r) => r['msg'] === 'cron inválido en job_definition: el job no corre en --once'));
});

test('10 · la salud: última corrida, última buena, fallos desde entonces y «Datos al»', async () => {
  const health = await getWorkerHealth(db);
  const h = Object.fromEntries(health.map((x) => [x.jobId, x]));
  assert.equal(h['test.once_arriba']?.lastStatus, 'ok');
  assert.match(h['test.once_arriba']?.lastOkAt ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(h['test.once_falla']?.lastOkAt, null, 'nunca terminó bien: null, no una fecha vieja');
  assert.equal(h['test.once_falla']?.failedSinceOk, 2);
  assert.equal(h['test.once_falla']?.lastError, 'RangeError: boom');
  assert.equal(h['collect.posts']?.lastRunAt, null, 'nunca corrió aquí');
  assert.equal(health.length, (await loadJobDefinitions(db)).length, 'una fila por definición');

  assert.equal(workerDataAsOf(health, ['test.once_arriba', 'test.once_diario']), [h['test.once_arriba']!.lastOkAt!, h['test.once_diario']!.lastOkAt!].sort()[0]);
  assert.equal(workerDataAsOf(health, ['test.once_arriba', 'test.once_falla']), null);
  assert.equal(workerDataAsOf(health), null, 'los recolectores reales no han corrido en esta base');

  const texto = formatHealth(health, new Date());
  assert.match(texto, /test\.once_falla\s+failed .*nunca terminó bien · 2 fallo\(s\) desde entonces/);
  assert.match(texto, /Datos al: todavía no/);
  assert.doesNotMatch(texto, /test\.once_nada/, 'un job sin handler no ensucia la salud');
});
