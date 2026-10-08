/**
 * CIM-7 · el reclamo de una corrida (runner/once.ts, claimRun) con dos
 * transacciones que se intercalan de verdad. Sin red y sin Postgres.
 *
 * PGlite tiene una sola conexión y serializa cada transacción: ahí la
 * lectura del estado y el INSERT de la fila `running` nunca se
 * intercalan, con candado o sin él, así que la prueba de tick.test.ts no
 * distingue el mecanismo. En Postgres (READ COMMITTED, dos invocaciones
 * de Vercel con su pool cada una) el candado por job es lo único que
 * evita la corrida doble.
 *
 * Esta base falsa hace lo que haría Postgres con dos conexiones: cada
 * transacción ve solo lo confirmado, pg_advisory_xact_lock bloquea de
 * verdad hasta el COMMIT de quien lo tiene, y la lectura del estado
 * ESPERA a que llegue la otra transacción (hasta 150 ms) antes de
 * responder, para forzar el peor orden: las dos leen antes de que
 * ninguna inserte. Con el candado, la segunda no llega a leer hasta que
 * la primera confirma; sin él, las dos reclaman (se comprobó quitándolo:
 * la prueba queda en rojo). La variante contra un Postgres real está en
 * tick-postgres.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Queryable, QueryResult, Row, WorkerDatabase } from '../src/runner/db.ts';
import { claimRun, type Claim, type PendingRun } from '../src/runner/once.ts';
import { defineJob, type JobDefinition } from '../src/runner/registry.ts';
import { JOB_LOCK_PREFIX } from '../src/runner/worker.ts';

const DEF: JobDefinition = {
  id: 'test.reclamo', labelEs: 'Prueba: reclamo', queue: 'test', defaultCron: '* * * * *', timeoutS: 60, maxAttempts: 3, maxConcurrency: 1, enabled: true,
};
const REG = defineJob('test.reclamo', async () => ({ processed: 1, failed: 0 }));
const AT = new Date('2026-09-28T15:00:30Z');
const TICK = new Date('2026-09-28T15:00:00Z');

interface FakeRun { job_id: string; status: string; started_at: Date; metadata: Record<string, unknown> }

/** Dos conexiones de Postgres, en memoria, con lo justo para claimRun. */
class InterleavingDb {
  readonly committed: FakeRun[] = [];
  readonly log: string[] = [];
  readonly #locks = new Map<string, Promise<void>>();
  #waiting: Array<() => void> = [];
  #nextId = 1;
  #tx = 0;

  async #lock(key: string): Promise<() => void> {
    while (this.#locks.has(key)) await this.#locks.get(key);
    let release!: () => void;
    this.#locks.set(key, new Promise<void>((r) => { release = r; }));
    return () => { this.#locks.delete(key); release(); };
  }

  /** La lectura espera a la otra transacción (o 150 ms): el peor intercalado posible. */
  async #rendezvous(): Promise<void> {
    if (this.#waiting.length > 0) {
      for (const w of this.#waiting.splice(0)) w();
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.#waiting = this.#waiting.filter((w) => w !== go); resolve(); }, 150);
      const go = () => { clearTimeout(timer); resolve(); };
      this.#waiting.push(go);
    });
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const n = ++this.#tx;
    const inserts: FakeRun[] = [];
    const held: Array<() => void> = [];
    const tx: Queryable = {
      query: async <R extends Row = Row>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> => {
        if (text.includes('pg_advisory_xact_lock')) {
          this.log.push(`tx${n}:lock:${String(params[0])}`);
          held.push(await this.#lock(String(params[0])));
          return { rows: [], rowCount: 0 };
        }
        if (text.includes('unnest(')) {
          this.log.push(`tx${n}:state`);
          await this.#rendezvous();
          const ids = params[0] as string[];
          const rows = ids.map((id) => ({
            job_id: id, done: 0, attempts: 0, cuts: 0,
            running: this.committed.filter((r) => r.job_id === id && r.status === 'running').length,
          }));
          return { rows: rows as unknown as R[], rowCount: rows.length };
        }
        if (text.includes('INSERT INTO job_run')) {
          this.log.push(`tx${n}:insert`);
          inserts.push({ job_id: String(params[0]), status: 'running', started_at: new Date(String(params[2])), metadata: JSON.parse(String(params[3])) });
          // job_run.id es un uuid desde 0083 (CIM-11): runIdOf rechaza otra cosa.
          const id = `00000000-0000-4000-8000-${String(this.#nextId++).padStart(12, '0')}`;
          return { rows: [{ id }] as unknown as R[], rowCount: 1 };
        }
        throw new Error(`consulta inesperada: ${text.slice(0, 60)}`);
      },
    };
    try {
      const out = await fn(tx);
      this.committed.push(...inserts); // COMMIT: ahora lo ven los demás
      return out;
    } finally {
      for (const release of held) release();
    }
  }

  asWorkerDatabase(): WorkerDatabase {
    return this as unknown as WorkerDatabase;
  }
}

const item = (): PendingRun => ({ def: DEF, registration: REG, payload: { job: DEF.id }, coverFrom: TICK, reason: 'due' });

test('dos reclamos que se intercalan: uno abre la fila y el otro la ve corriendo', async () => {
  const db = new InterleavingDb();
  const claims: Claim[] = await Promise.all([
    claimRun(db.asWorkerDatabase(), item(), AT, 'once:a'),
    claimRun(db.asWorkerDatabase(), item(), AT, 'once:b'),
  ]);
  assert.equal(claims.filter((c) => 'runId' in c).length, 1, `un solo reclamo: ${JSON.stringify(claims)}`);
  assert.deepEqual(claims.filter((c) => 'skip' in c), [{ skip: 'running' }]);
  assert.equal(db.committed.length, 1, 'una sola fila running');
});

test('el candado es por job, con JOB_LOCK_PREFIX, y se pide ANTES de leer el estado', async () => {
  const db = new InterleavingDb();
  await claimRun(db.asWorkerDatabase(), item(), AT, 'once:a', 39);
  assert.deepEqual(db.log, [`tx1:lock:${JOB_LOCK_PREFIX}${DEF.id}`, 'tx1:state', 'tx1:insert']);
  assert.equal(db.committed[0]?.metadata['sliceS'], 39, 'el timeout del turno queda en el reclamo');
});

test('dos jobs distintos no se esperan: cada uno tiene su candado', async () => {
  const db = new InterleavingDb();
  const otro: PendingRun = { ...item(), def: { ...DEF, id: 'test.reclamo_otro' } };
  const claims = await Promise.all([claimRun(db.asWorkerDatabase(), item(), AT, 'once:a'), claimRun(db.asWorkerDatabase(), otro, AT, 'once:b')]);
  assert.ok(claims.every((c) => 'runId' in c));
});
