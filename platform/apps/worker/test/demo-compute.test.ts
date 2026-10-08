/**
 * Humo de runDemoCompute (la espera de la cadena CON-6 en `--demo`).
 *
 * Desde 0082 (CIM-11) job_run.id es un uuid: la espera dejó de mirar
 * max(id) (Postgres no tiene max(uuid)) y mira las fechas de las
 * corridas. Esta prueba la corre contra PGlite con las migraciones
 * reales, para que el próximo cambio de tipo de una columna de job_run
 * no rompa la demo sin que nadie lo vea: la demo no corre en
 * `pnpm verificar`, esta prueba sí.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { runDemoCompute } from '../src/demo.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { createLogger, MemorySink } from '../src/runner/logger.ts';
import { DESCRIBE_DB_TIMEOUT, openTestDatabase, SETUP_TIMEOUT } from './helpers/harness.ts';

const WS = '00000082-0000-4000-8000-0000000000d1';

describe('runDemoCompute espera la cadena por fecha, no por id', DESCRIBE_DB_TIMEOUT, () => {
  let db: PgliteDatabase;
  before(async () => {
    db = await openTestDatabase();
  }, SETUP_TIMEOUT);
  after(() => db?.close());

  /** Una corrida terminada de `job`, que empezó `seg` segundos después de las 08:00 del 1-oct. */
  const corrida = (job: string, seg: number) =>
    db.raw.query(
      `INSERT INTO job_run (job_id, status, attempt, started_at, finished_at, duration_ms)
       VALUES ($1, 'ok', 1, TIMESTAMPTZ '2026-10-01 08:00:00+00' + make_interval(secs => $2),
               TIMESTAMPTZ '2026-10-01 08:00:00+00' + make_interval(secs => $2 + 1), 1000)`,
      [job, seg],
    );

  test('sin un compute.* después de la última recolección no la da por terminada, y avisa', async () => {
    await db.raw.exec('DELETE FROM job_run');
    await corrida('compute.baseline', 0);
    await corrida('collect.post_metrics', 10);
    const sink = new MemorySink();
    const terminada = await runDemoCompute({ db, logger: createLogger({ level: 'debug', sink }), workspaceId: WS, quietoMs: 50, plazoMs: 400 });
    assert.equal(terminada, false);
    assert.match(sink.text(), /la cadena no terminó/);
  });

  test('con un compute.* que empezó después de la última recolección, nada corriendo y job_run quieta, termina', async () => {
    await db.raw.exec('DELETE FROM job_run');
    await corrida('collect.post_metrics', 0);
    await corrida('collect.post_metrics', 10);
    await corrida('compute.baseline', 20);
    await corrida('compute.post_score', 30);
    const sink = new MemorySink();
    const terminada = await runDemoCompute({ db, logger: createLogger({ level: 'debug', sink }), workspaceId: WS, quietoMs: 50, plazoMs: 5_000 });
    assert.equal(terminada, true);
    const cadena = sink.records().find((r) => String(r.msg).startsWith('demo CON-6: job_run de compute.*'));
    const filas = (cadena?.rows ?? []) as Array<{ job_id: string }>;
    // En el orden en que empezaron, no en el del uuid.
    assert.deepEqual(filas.map((r) => r.job_id), ['compute.baseline', 'compute.post_score']);
  });

  test('una corrida que sigue abierta la deja esperando aunque haya un compute.* después', async () => {
    await db.raw.exec('DELETE FROM job_run');
    await corrida('collect.post_metrics', 0);
    await corrida('compute.baseline', 10);
    await db.raw.query(
      `INSERT INTO job_run (job_id, status, attempt, started_at) VALUES ('compute.post_score', 'running', 1, TIMESTAMPTZ '2026-10-01 08:00:20+00')`,
    );
    const terminada = await runDemoCompute({ db, logger: createLogger({ level: 'debug', sink: new MemorySink() }), workspaceId: WS, quietoMs: 50, plazoMs: 400 });
    assert.equal(terminada, false);
  });
});
