/**
 * RES-3 · «Lo que importa esta semana», de punta a punta: los cuatro
 * productores DE VERDAD escriben sus avisos sobre el seed de la demo y
 * la lectura de Resumen (@mc/db/queries/resumen-semana) los enseña.
 *
 * El «terminado cuando» de la historia:
 *   - cada fuente produce su fila: compute.post_score (el video que se
 *     disparó), el recolector (la cuenta que ya no se puede leer: el
 *     productor que añadió RES-3), finance.reminders (FV-2026-007,
 *     vencida hace 41 días) y sales.follow_ups (los seguimientos
 *     vencidos del seed);
 *   - cada fila lleva a su módulo (el action_url que dejó su productor);
 *   - una fila de Finanzas no aparece a quien no puede ver Finanzas: la
 *     Mánager, con los permisos REALES de su rol (role_permission).
 *
 * Los productores corren como mc_worker sobre la misma base que lee la
 * web (openTestDb de @mc/db, Postgres embebido y sin red); se llaman
 * directamente, sin pg-boss: lo que se prueba es lo que escriben.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Permiso } from '@mc/core';
import type { WorkspaceTx } from '@mc/db';
import { getSessionPermissions } from '@mc/db/queries/accesos';
import { listWeeklyHighlights, weeklySourcesFor, type WeeklyHighlight, type WeeklySource } from '@mc/db/queries/resumen-semana';
import { openTestDb, type TestDb } from '@mc/db/test/pglite';
import { markAccountError, selectCollectableAccounts } from '../src/jobs/conexiones/_posts.ts';
import { computePostScoreJob } from '../src/jobs/conexiones/compute-post-score.ts';
import { recordatoriosJob } from '../src/jobs/finanzas/recordatorios.ts';
import { runSeguimientos } from '../src/jobs/ventas/seguimientos.ts';
import type { JobDatabase, Queryable, QueryResult, Row } from '../src/runner/db.ts';
import { createLogger, MemorySink } from '../src/runner/logger.ts';
import type { JobContext } from '../src/runner/registry.ts';
import { SETUP_TIMEOUT } from './helpers/harness.ts';

/** Ids del seed (db/seed/0002 y 0003). */
const LAURA_WS = '00000002-0000-4000-8000-000000000001';
const LAURA = '00000002-0000-4000-8000-000000000002';
const CONEXION_TIKTOK = '00000002-0000-4000-8000-0000000000c2';
const FV_007 = '00000003-0000-4000-8000-0000fac26007';
/** Una Mánager del espacio, sin alcance: su rol no tiene finanzas.factura.ver. */
const MANAGER = '0000000d-0000-4000-8000-0000000000a1';

let t: TestDb;
const sink = new MemorySink();
const logger = createLogger({ level: 'debug', sink });

/** ctx.db de un job, sobre la base de la prueba: cada consulta es una transacción como mc_worker. */
function comoWorker(tx: { query: WorkspaceTx['query'] }): Queryable {
  return {
    query: async <R extends Row = Row>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>> => {
      const r = await tx.query<R>(text, params);
      return { rows: r.rows, rowCount: r.rows.length };
    },
  };
}

const jobDb: JobDatabase = {
  query: (text, params) => t.db.asWorker((tx) => comoWorker(tx).query(text, params)),
  transaction: (fn) => t.db.asWorker((tx) => fn(comoWorker(tx))),
};

/** Lo que un job lee de su contexto: la base, el reloj, el log, la señal y su definición. */
function ctxDe(jobId: string): JobContext {
  return {
    jobId,
    runId: 0,
    attempt: 1,
    workspaceId: undefined,
    definition: { id: jobId, maxConcurrency: 1 },
    db: jobDb,
    logger,
    signal: new AbortController().signal,
    now: () => new Date(),
    env: {},
  } as unknown as JobContext;
}

const como = <T>(userId: string, fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(LAURA_WS, fn, { userId });

async function permisosDe(userId: string): Promise<ReadonlySet<Permiso>> {
  return new Set((await como(userId, (tx) => getSessionPermissions(tx))) as Permiso[]);
}

async function bloqueDe(userId: string): Promise<{ fuentes: WeeklySource[]; filas: WeeklyHighlight[] }> {
  const fuentes = weeklySourcesFor(await permisosDe(userId));
  return { fuentes, filas: await como(userId, (tx) => listWeeklyHighlights(tx, fuentes)) };
}

before(async () => {
  t = await openTestDb();
  await t.admin(`
    INSERT INTO app_user (id, email, name, locale) VALUES ('${MANAGER}', 'manager.res3@ejemplo.com', 'Mánager', 'es-CO')
    ON CONFLICT DO NOTHING;
    INSERT INTO membership (workspace_id, user_id, role_id)
    VALUES ('${LAURA_WS}', '${MANAGER}', system_role_id('creator', 'manager')) ON CONFLICT DO NOTHING;
  `);
}, SETUP_TIMEOUT);

after(async () => {
  await t.close();
});

describe('los cuatro productores escriben, Resumen enseña', () => {
  before(async () => {
    // El video que se disparó: el puntaje de CON-6 sobre las líneas base del seed.
    const puntaje = await computePostScoreJob.handler({}, ctxDe('compute.post_score'));
    assert.ok(puntaje.processed > 0, 'compute.post_score puntuó videos del seed');
    // La cuenta de TikTok de Laura ya no se puede leer: el recolector la marca y avisa.
    const [tiktok] = await selectCollectableAccounts(ctxDe('collect.posts'), { connectionId: CONEXION_TIKTOK });
    assert.ok(tiktok, 'la cuenta de TikTok del seed es de las que se recolectan');
    await markAccountError(ctxDe('collect.posts'), tiktok, 'La cuenta ya no existe en TikTok.');
    // Los recordatorios de cobro y los seguimientos de Ventas.
    await recordatoriosJob.handler({}, ctxDe('finance.reminders'));
    await runSeguimientos(jobDb, new Date(), { horaLocal: 0 });
  }, SETUP_TIMEOUT);

  test('la dueña ve una fila de cada fuente, y cada fila lleva a su módulo', async () => {
    const { fuentes, filas } = await bloqueDe(LAURA);
    assert.deepEqual(fuentes, ['connection', 'invoice', 'deal', 'outlier']);
    for (const fuente of fuentes) assert.ok(filas.some((f) => f.source === fuente), `falta la fila de ${fuente}`);

    for (const f of filas) {
      switch (f.source) {
        case 'connection':
          assert.equal(f.connectionId, CONEXION_TIKTOK);
          assert.equal(f.status, 'error');
          assert.equal(f.actionUrl, '/conexiones');
          break;
        case 'invoice':
          assert.equal(f.invoiceId, FV_007);
          assert.ok(f.actionUrl?.startsWith(`/finanzas/facturas/${FV_007}?recordatorio=`), f.actionUrl ?? '');
          break;
        case 'deal':
          assert.equal(f.actionUrl, `/ventas/empresas/${f.companyId}`);
          assert.equal(f.dueState === 'vencido' || f.dueState === 'hoy', true);
          break;
        case 'outlier':
          assert.equal(f.actionUrl, '/resumen');
          assert.ok(f.viewsVsMedian !== null && Number(f.viewsVsMedian) >= 2, `${f.postId}: ${f.viewsVsMedian}`);
          break;
      }
    }
    assert.equal(filas.filter((f) => f.source === 'invoice').length, 1, 'una fila por factura, aunque tenga tres recordatorios');
    assert.equal(filas[0]?.source, 'connection', 'lo más urgente arriba');
    assert.equal(filas.at(-1)?.source, 'outlier', 'las buenas noticias al final');
  });

  test('la Mánager, sin finanzas.factura.ver, no ve la factura; el resto sí', async () => {
    const { fuentes, filas } = await bloqueDe(MANAGER);
    assert.ok(!fuentes.includes('invoice'));
    assert.ok(!filas.some((f) => f.source === 'invoice'));
    assert.ok(filas.some((f) => f.source === 'connection'));
    assert.ok(filas.some((f) => f.source === 'outlier'));
  });

  test('la cuenta que sigue rota al día siguiente no escribe otro aviso esa semana', async () => {
    const [tiktok] = await selectCollectableAccounts(ctxDe('collect.posts'), { connectionId: CONEXION_TIKTOK });
    assert.ok(tiktok);
    await markAccountError(ctxDe('collect.posts'), tiktok, 'La cuenta ya no existe en TikTok.');
    const avisos = await jobDb.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notification WHERE kind = 'connection_error' AND entity_id = $1`, [CONEXION_TIKTOK]);
    assert.equal(avisos.rows[0]?.n, 1);
  });
});
