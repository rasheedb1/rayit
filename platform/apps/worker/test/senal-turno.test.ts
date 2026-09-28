/**
 * CIM-7 · los jobs de Ventas que no miraban ctx.signal (sales.follow_ups,
 * outbound.alerts, sales.channels_release) ya lo miran.
 *
 * En un turno el job recibe como timeout lo que queda del turno. Si se
 * pasa, el runner cierra su fila como corte (Promise.race) pero no puede
 * matar el handler: sin mirar la señal, el handler seguía vivo con su
 * conexión, pool.end() no terminaba y el turno siguiente (misma
 * instancia, Fluid compute) podía retomarlo con el anterior en marcha.
 * Ahora, disparada la señal, no empiezan nada nuevo y devuelven lo hecho;
 * sales.follow_ups, que es una transacción, además lleva un
 * statement_timeout con el que la base corta lo que siga vivo.
 *
 * Con bases de mentira: lo que se prueba es qué consultas llegan a
 * salir, no el SQL (eso lo prueban sus propios archivos).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySecretStore } from '@mc/connectors';
import { runChannelsRelease } from '../src/jobs/ventas/canales.release.ts';
import { runAlertas } from '../src/jobs/ventas/outbound.alerts.ts';
import { limitStatements, STATEMENT_GRACE_MS, statementTimeoutMs } from '../src/jobs/ventas/plazo.ts';
import { runSeguimientos } from '../src/jobs/ventas/seguimientos.ts';
import type { JobDatabase, Queryable, QueryResult, Row } from '../src/runner/db.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { openTestDatabase, SETUP_TIMEOUT } from './helpers/harness.ts';

const NOW = new Date('2026-09-28T15:00:00Z');

/** Una base que anota cada consulta y contesta con `answer` (o filas vacías). */
function fakeDb(answer: (text: string) => Row[] = () => []) {
  const seen: string[] = [];
  const query = async <R extends Row = Row>(text: string): Promise<QueryResult<R>> => {
    seen.push(text.replace(/\s+/g, ' ').trim());
    const rows = answer(text) as R[];
    return { rows, rowCount: rows.length };
  };
  const db: JobDatabase = {
    query,
    transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => {
      seen.push('BEGIN');
      return fn({ query });
    },
  };
  return { db, seen };
}

const abortada = () => {
  const c = new AbortController();
  c.abort(new Error('timeout del turno'));
  return c.signal;
};

let pg: PgliteDatabase;
before(async () => { pg = await openTestDatabase(); }, SETUP_TIMEOUT);
after(async () => { await pg?.close(); });

test('statement_timeout: el timeout del job más un segundo de gracia, contado desde que empezó', () => {
  assert.equal(statementTimeoutMs(40, 1_000, 1_000), 40_000 + STATEMENT_GRACE_MS);
  assert.equal(statementTimeoutMs(40, 1_000, 31_000), 10_000 + STATEMENT_GRACE_MS, 'lo que queda, no el timeout entero');
  assert.equal(statementTimeoutMs(40, 1_000, 99_000), 1, 'nunca 0 (0 en Postgres es «sin límite»)');
});

test('limitStatements acota solo la transacción en curso', async () => {
  const dentro = await pg.transaction(async (tx) => {
    await limitStatements(tx, 12_345);
    return (await tx.query<{ v: string }>(`SELECT current_setting('statement_timeout') AS v`)).rows[0]?.v;
  });
  assert.match(String(dentro), /^(12345ms|12345|12345\.?\d*ms)$/);
  const fuera = (await pg.query<{ v: string }>(`SELECT current_setting('statement_timeout') AS v`)).rows[0]?.v;
  assert.notEqual(fuera, dentro, 'al terminar la transacción vuelve el de la sesión');
});

test('sales.follow_ups: con la señal disparada no abre la transacción', async () => {
  const { db, seen } = fakeDb();
  await assert.rejects(runSeguimientos(db, NOW, { signal: abortada() }), /timeout del turno/);
  assert.deepEqual(seen, []);
});

test('sales.follow_ups: si la señal llega entre las dos sentencias, no empieza la segunda y la transacción se deshace', async () => {
  const c = new AbortController();
  const { db, seen } = fakeDb((text) => {
    if (/'deal_overdue', 'warning'/.test(text)) c.abort(new Error('timeout del turno'));
    return [];
  });
  await assert.rejects(runSeguimientos(db, NOW, { signal: c.signal, statementTimeoutMs: 9_000 }), /timeout del turno/);
  assert.equal(seen[0], 'BEGIN');
  assert.match(seen[1]!, /set_config\('statement_timeout', \$1, true\)/, 'lo primero de la transacción: el tope de la base');
  assert.match(seen[2]!, /pg_advisory_xact_lock/);
  assert.equal(seen.length, 4, `el candado, los vencidos y nada más: ${seen.join(' | ')}`);
});

test('outbound.alerts: con la señal disparada no revisa ningún workspace y dice cuántos quedaron', async () => {
  const { db, seen } = fakeDb((text) => (seen.length === 1 && /FROM workspace/i.test(text)
    ? [{ id: 'w1', name: 'Uno', tz: 'UTC', locale: 'es' }, { id: 'w2', name: 'Dos', tz: 'UTC', locale: 'es' }]
    : []));
  const r = await runAlertas(db, NOW, { mailer: null, appUrl: null, horaLocal: 0, signal: abortada() });
  assert.equal(r.interrupted, 2);
  assert.equal(r.workspaces, 0);
  assert.equal(seen.filter((s) => s === 'BEGIN').length, 0, 'ninguna transacción');
});

test('sales.channels_release: con la señal disparada no reclama ninguna cuenta', async () => {
  const { db, seen } = fakeDb((text) => (/FROM outreach_channel_account/.test(text) && seen.length === 1 ? [{ id: 'c1' }, { id: 'c2' }] : []));
  const r = await runChannelsRelease({ db, secrets: new InMemorySecretStore(), google: null, unipile: null, now: NOW, signal: abortada() });
  assert.equal(r.released + r.failed + r.waitingForKeys, 0);
  assert.equal(seen.length, 1, `solo la lectura de la cola: ${seen.join(' | ')}`);
});
