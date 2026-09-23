/**
 * Casos 1 a 4 de CON-2 · Fase 5, contra Postgres embebido con las
 * migraciones reales y los GRANTs propuestos para mc_worker.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { allJobs } from '../src/jobs/index.ts';
import { defineJob } from '../src/runner/registry.ts';
import { jobRuns, seedTestDefinitions, startHarness, waitFor, type Harness } from './helpers/harness.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const echoJob = defineJob<{ workspaceId?: string; entityType?: string; entityId?: string; n?: number }>('test.echo', async (payload, ctx) => {
  await sleep(25);
  ctx.logger.debug('eco', { n: payload.n });
  return { processed: payload.n ?? 1, failed: 0, metadata: { eco: payload.n ?? 1 } };
});

const attemptsSeen: number[] = [];
const failJob = defineJob('test.fail', async (_payload, ctx) => {
  attemptsSeen.push(ctx.attempt);
  throw new RangeError('boom');
});

let slowAborted = false;
let slowHandlerSettled = false;
const slowJob = defineJob('test.slow', async (_payload, ctx) => {
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 3000);
    ctx.signal.addEventListener('abort', () => { slowAborted = true; clearTimeout(t); resolve(); }, { once: true });
  });
  slowHandlerSettled = true;
  return { processed: 0, failed: 0 };
});

const itemsJob = defineJob<{ processed: number; failed: number }>('test.items', async (payload) => ({
  processed: payload.processed,
  failed: payload.failed,
  metadata: { accessToken: 'NO-DEBERIA-GUARDARSE', ok: true },
}));

const noRetryJob = defineJob<{ processed: number; failed: number }>('test.noretry', async (payload) => ({
  processed: payload.processed,
  failed: payload.failed,
  retry: false,
}));

let h: Harness;

before(async () => {
  h = await startHarness({ jobs: [...allJobs, echoJob, failJob, slowJob, itemsJob, noRetryJob], seed: seedTestDefinitions });
}, { timeout: 120_000 });

after(async () => {
  await h.stop();
});

test('1 · arranca como mc_worker, lee las definiciones y el log dice cuáles tienen handler', async () => {
  const records = h.sink.records();
  const rol = records.find((r) => r['msg'] === 'rol comprobado');
  assert.equal(rol?.['currentUser'], 'mc_worker');
  assert.equal(rol?.['bypassRls'], true);

  const seeded = h.worker.definitions.filter((d) => !d.id.startsWith('test.'));
  assert.equal(seeded.length, 21, 'las 21 definiciones de 0009');

  const registered = records.filter((r) => r['msg'] === 'job registrado');
  assert.equal(registered.length, 21 + 6);
  const byJob = new Map(registered.map((r) => [r['job'], r]));
  assert.equal(byJob.get('oauth.refresh')?.['handler'], 'sí');
  assert.equal(byJob.get('oauth.refresh')?.['cron'], '*/15 * * * *');
  assert.equal(byJob.get('oauth.refresh')?.['group'], 'connections');
  assert.equal(byJob.get('collect.posts')?.['handler'], 'no');
  assert.equal(byJob.get('video.probe')?.['cron'], '—');

  const listo = records.find((r) => r['msg'] === 'worker listo');
  assert.equal(listo?.['withHandler'], 8);       // oauth.refresh + collect.account_metrics + campaign.compute (CAM-5) + 5 de prueba (test.off está apagado)
  assert.equal(listo?.['withoutHandler'], 18);
  assert.equal(listo?.['disabled'], 1);
  assert.equal(listo?.['crons'], 17);           // las 21 menos las 4 de video

  // Sin handler → una fila skipped por arranque, y nada más.
  const skipped = await h.db.query<{ job_id: string; error: string; n: number | string }>(
    `SELECT job_id, error, count(*)::int AS n FROM job_run WHERE status = 'skipped' GROUP BY 1, 2 ORDER BY 1`,
  );
  assert.equal(skipped.rows.length, 18);
  assert.ok(skipped.rows.every((r) => r.error === 'sin handler' && Number(r.n) === 1));
  assert.ok(!skipped.rows.some((r) => ['oauth.refresh', 'collect.account_metrics', 'campaign.compute', 'test.off'].includes(r.job_id)));

  // Los crons viven en pg-boss, con la clave 'cron' y el payload que identifica al job.
  const schedules = await h.worker.boss.getSchedules();
  assert.equal(schedules.length, 17);
  const oauth = schedules.find((s) => s.name === 'oauth.refresh');
  assert.equal(oauth?.cron, '*/15 * * * *');
  assert.equal(oauth?.timezone, 'UTC');
  assert.deepEqual(oauth?.data, { job: 'oauth.refresh', source: 'cron' });
  assert.equal(schedules.some((s) => s.name === 'test.off'), false, 'un job deshabilitado no se programa');

  // Política por definición: con cron 'stately' (no se apilan ticks), sin cron 'standard'.
  assert.equal((await h.worker.boss.getQueue('oauth.refresh'))?.policy, 'stately');
  assert.equal((await h.worker.boss.getQueue('video.probe'))?.policy, 'standard');
  assert.equal((await h.worker.boss.getQueue('test.echo'))?.policy, 'standard');
  assert.equal((await h.worker.boss.getQueue('oauth.refresh'))?.retryLimit, 4, 'max_attempts 5 → 4 reintentos');
  assert.equal((await h.worker.boss.getQueue('oauth.refresh'))?.expireInSeconds, 90, 'timeout_s 60 + 30 de margen');
});

test('un workspaceId que ya no existe no pierde la ejecución: job_run se abre sin workspace', async () => {
  const fantasma = '99999999-9999-4999-8999-999999999999';
  await h.worker.boss.send('test.echo', { n: 1, workspaceId: fantasma });
  const row = await waitFor(async () => (await jobRuns(h.db, 'test.echo')).find((r) => r.metadata['workspaceIdIgnored'] === fantasma && r.status === 'ok'), { label: 'fk' });
  assert.equal(row.workspace_id, null);
  const warn = h.sink.records().find((r) => r['msg'] === 'el workspace del payload no existe; job_run se abre sin workspace');
  assert.equal(warn?.['workspaceId'], fantasma);
});

test('2 · un job encolado pasa por running y termina ok con duration_ms > 0', async () => {
  const ws = await h.db.query<{ id: string }>(`INSERT INTO workspace (slug, name) VALUES ('ws-eco', 'Eco') RETURNING id`);
  const workspaceId = ws.rows[0]!.id;
  const entityId = '11111111-2222-4333-8444-555555555555';
  const jobId = await h.worker.boss.send('test.echo', { n: 3, workspaceId, entityType: 'prueba', entityId });
  assert.ok(jobId);

  // Debe verse en running antes de terminar (el handler tarda 25 ms).
  const running = await waitFor(async () => {
    const rows = await jobRuns(h.db, 'test.echo');
    return rows.find((r) => r.status === 'running' && r.workspace_id === workspaceId);
  }, { everyMs: 5, timeoutMs: 5000, label: 'running' });
  assert.equal(running.attempt, 1);
  assert.equal(running.workspace_id, workspaceId);
  assert.equal(running.entity_type, 'prueba');
  assert.equal(running.entity_id, entityId);

  const done = await waitFor(async () => (await jobRuns(h.db, 'test.echo')).find((r) => r.status === 'ok' && r.metadata['eco'] === 3), { label: 'ok' });
  assert.ok(Number(done.duration_ms) > 0, `duration_ms = ${done.duration_ms}`);
  assert.ok(done.finished_at);
  assert.equal(done.items_processed, 3);
  assert.equal(done.items_failed, 0);
  assert.equal(done.error, null);
  assert.equal(done.metadata['eco'], 3);
  assert.equal(done.metadata['bossJobId'], jobId);

  const log = h.sink.records().find((r) => r['msg'] === 'job terminado' && r['job'] === 'test.echo' && r['processed'] === 3);
  assert.equal(log?.['runId'], Number(done.id));
  assert.equal(log?.['jobId'], jobId);
  assert.ok(typeof log?.['durationMs'] === 'number');

  const boss = (await h.worker.boss.findJobs('test.echo', { id: jobId! }))[0];
  assert.equal(boss?.state, 'completed');
});

test('3 · un handler que lanza deja job_run failed con "Clase: mensaje" y pg-boss reintenta hasta max_attempts', async () => {
  const jobId = await h.worker.boss.send('test.fail', {});
  const rows = await waitFor(async () => {
    const r = await jobRuns(h.db, 'test.fail');
    return r.length === 3 && r.every((x) => x.status === 'failed') ? r : null;
  }, { timeoutMs: 20_000, label: '3 intentos' });
  assert.deepEqual(rows.map((r) => r.attempt), [1, 2, 3]);
  assert.ok(rows.every((r) => r.error === 'RangeError: boom'));
  assert.ok(rows.every((r) => r.finished_at !== null));
  assert.deepEqual(attemptsSeen, [1, 2, 3]);

  const boss = await waitFor(async () => {
    const j = (await h.worker.boss.findJobs('test.fail', { id: jobId! }))[0];
    return j?.state === 'failed' ? j : null;
  }, { label: 'pg-boss failed' });
  assert.equal(boss.retryCount, 2);
  await sleep(1500);
  assert.equal((await jobRuns(h.db, 'test.fail')).length, 3, 'no hay un cuarto intento');

  // El stack va al log, no a la columna.
  const errLog = h.sink.records().find((r) => r['msg'] === 'job falló' && r['job'] === 'test.fail');
  const err = errLog?.['err'] as Record<string, unknown> | undefined;
  assert.equal(err?.['name'], 'RangeError');
  assert.match(String(err?.['stack']), /RangeError: boom/);
});

test('4 · un handler que excede timeout_s se aborta por la señal y queda failed con error "timeout"', async () => {
  const t0 = Date.now();
  await h.worker.boss.send('test.slow', {});
  const row = await waitFor(async () => (await jobRuns(h.db, 'test.slow')).find((r) => r.status !== 'running'), { label: 'timeout' });
  assert.equal(row.status, 'failed');
  assert.equal(row.error, 'timeout');
  assert.equal(row.metadata['timeoutS'], 1);
  // Margen de 100 ms por abajo: es un reloj de pared y el temporizador
  // puede disparar 1 ms antes del segundo (se vio «duración 999» en una
  // corrida). Lo que importa es que esperó al timeout, no al handler.
  assert.ok(Number(row.duration_ms) >= 900 && Number(row.duration_ms) < 2500, `duración ${row.duration_ms}`);
  assert.ok(Date.now() - t0 < 4000, 'no esperó los 3 s del handler');
  assert.equal(slowAborted, true, 'la AbortSignal llegó al handler');
  await sleep(50);
  assert.equal(slowHandlerSettled, true);
  assert.equal((await jobRuns(h.db, 'test.slow')).length, 1, 'max_attempts = 1: sin reintento');
});

test('fallos por elemento: partial cuando processed > 0, failed cuando processed = 0; la metadata se redacta', async () => {
  await h.worker.boss.send('test.items', { processed: 2, failed: 1 });
  const rows = await waitFor(async () => {
    const r = await jobRuns(h.db, 'test.items');
    return r.length === 2 && r.every((x) => x.status !== 'running') ? r : null;
  }, { timeoutMs: 20_000, label: 'partial x2' });
  assert.deepEqual(rows.map((r) => r.status), ['partial', 'partial'], 'failed > 0 hace que pg-boss reintente');
  assert.equal(rows[0]!.items_processed, 2);
  assert.equal(rows[0]!.items_failed, 1);
  assert.equal(rows[0]!.error, null);
  assert.equal(rows[0]!.metadata['accessToken'], '[REDACTADO]');
  assert.equal(rows[0]!.metadata['ok'], true);

  const jobId = await h.worker.boss.send('test.items', { processed: 0, failed: 4 });
  const failed = await waitFor(async () => {
    const r = await jobRuns(h.db, 'test.items');
    return r.length === 4 && r.every((x) => x.status !== 'running') ? r.slice(2) : null;
  }, { timeoutMs: 20_000, label: 'failed x2' });
  assert.deepEqual(failed.map((r) => r.status), ['failed', 'failed']);
  assert.equal(failed[0]!.error, 'JobItemsFailedError: 4 elemento(s) fallaron de 4');
  assert.ok(jobId);
});

test('un job que devuelve retry: false queda partial una sola vez, sin reintento', async () => {
  await h.worker.boss.send('test.noretry', { processed: 1, failed: 1 });
  const row = await waitFor(async () => (await jobRuns(h.db, 'test.noretry')).find((r) => r.status !== 'running'), { label: 'noretry' });
  assert.equal(row.status, 'partial');
  await sleep(2500);
  assert.equal((await jobRuns(h.db, 'test.noretry')).length, 1);
  assert.ok(h.sink.records().some((r) => r['msg'] === 'sin reintento: el job indicó que no ayuda' && r['job'] === 'test.noretry'));
});

test('idempotencia de cron: reiniciar no duplica schedules y un cron cambiado se actualiza', async () => {
  const before = await h.worker.boss.getSchedules('oauth.refresh');
  assert.equal(before.length, 1);
  await h.db.raw.exec(`UPDATE job_definition SET default_cron = '*/5 * * * *' WHERE id = 'oauth.refresh'`);

  // Segundo worker sobre la misma base (como un reinicio del proceso).
  const { createLogger, MemorySink } = await import('../src/runner/logger.ts');
  const { startWorker } = await import('../src/runner/worker.ts');
  const { testConfig } = await import('./helpers/harness.ts');
  const { refresherRegistry, InMemorySecretStore } = await import('@mc/connectors');
  const sink = new MemorySink();
  const second = await startWorker({
    config: testConfig(), db: h.db, logger: createLogger({ sink }), jobs: allJobs,
    secrets: new InMemorySecretStore(), refreshers: refresherRegistry([]), env: {},
  });
  try {
    const after = await second.boss.getSchedules();
    assert.equal(after.length, 17, 'mismas 17 filas de schedule');
    assert.equal(after.filter((s) => s.name === 'oauth.refresh').length, 1);
    assert.equal(after.find((s) => s.name === 'oauth.refresh')?.cron, '*/5 * * * *');
    const updated = sink.records().find((r) => r['msg'] === 'schedule actualizado');
    assert.equal(updated?.['job'], 'oauth.refresh');
    assert.equal(updated?.['previous'], '*/15 * * * *');
    assert.equal(sink.records().filter((r) => r['msg'] === 'schedule creado').length, 0, 'ningún schedule se creó de nuevo');
    // El segundo worker no registra los jobs test.*: esos 5 sí quedan skipped
    // (ahora no tienen handler). Los 18 de 0009 sin handler no se repiten.
    const skipped = await h.db.query<{ n: number | string }>(`SELECT count(*)::int AS n FROM job_run WHERE status = 'skipped' AND job_id NOT LIKE 'test.%'`);
    assert.equal(Number(skipped.rows[0]!.n), 18, 'el reinicio no vuelve a insertar filas skipped');
    const skippedTest = await h.db.query<{ n: number | string }>(`SELECT count(*)::int AS n FROM job_run WHERE status = 'skipped' AND job_id LIKE 'test.%'`);
    assert.equal(Number(skippedTest.rows[0]!.n), 5, 'los que perdieron su handler sí se anotan');
  } finally {
    await second.boss.stop({ graceful: true, timeout: 5000, close: false });
  }
});
