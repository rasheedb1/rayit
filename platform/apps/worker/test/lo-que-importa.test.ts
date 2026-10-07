/**
 * RES-3 · «Lo que importa esta semana», de punta a punta: los cuatro
 * productores DE VERDAD escriben sus avisos sobre el seed de la demo y
 * la lectura de Resumen (@mc/db/queries/resumen-semana) los enseña.
 *
 * El «terminado cuando» de la historia:
 *   - cada fuente produce su fila: compute.post_score (el video que se
 *     disparó), el recolector (la cuenta que ya no se puede leer: el
 *     productor que añadió RES-3), markChannelAccountDown de @mc/db (la
 *     cuenta de envío que cae, como la deja el webhook de Unipile),
 *     finance.reminders (FV-2026-007, vencida hace 41 días) y
 *     sales.follow_ups (los seguimientos vencidos del seed);
 *   - cada fila lleva a su módulo (el action_url que dejó su productor);
 *   - una fila de Finanzas no aparece a quien no puede ver Finanzas: la
 *     Mánager, con los permisos REALES de su rol (role_permission).
 *
 * Los productores corren como mc_worker sobre la misma base que lee la
 * web (openTestDb de @mc/db, Postgres embebido y sin red); se llaman
 * directamente, sin pg-boss: lo que se prueba es lo que escriben. Los
 * avisos que trae el seed de la demo (0012) se quitan antes: aquí cada
 * fila tiene que salir de un productor de verdad.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CANALES_TEXTOS, type Permiso } from '@mc/core';
import type { WorkspaceTx } from '@mc/db';
import { getSessionPermissions } from '@mc/db/queries/accesos';
import { markChannelAccountDown } from '@mc/db/queries/canales';
import { listWeeklyHighlights, weeklySourcesFor, type WeeklyHighlight, type WeeklySource } from '@mc/db/queries/resumen-semana';
import { openTestDb, type TestDb } from '@mc/db/test/pglite';
import { markAccountError, markNeedsReauth, selectCollectableAccounts } from '../src/jobs/conexiones/_posts.ts';
import { BROKEN_ACCOUNT_LOCK_PREFIX, notifyBrokenAccount, remindBrokenAccounts } from '../src/jobs/conexiones/aviso-cuenta.ts';
import { acknowledgeHighlight } from '@mc/db/queries/resumen-semana';
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
/** El LinkedIn de envío de Laura, por Unipile (seed 0005); la prueba lo da por conectado antes de que caiga. */
const LINKEDIN_LAURA = '00000005-0000-4000-8000-0000000ac002';
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
  return { fuentes, filas: (await como(userId, (tx) => listWeeklyHighlights(tx, fuentes))).rows };
}

before(async () => {
  t = await openTestDb();
  await t.admin(`
    DELETE FROM notification WHERE id::text LIKE '00000011-%';
    INSERT INTO app_user (id, email, name, locale) VALUES ('${MANAGER}', 'manager.res3@ejemplo.com', 'Mánager', 'es-CO')
    ON CONFLICT DO NOTHING;
    INSERT INTO membership (workspace_id, user_id, role_id)
    VALUES ('${LAURA_WS}', '${MANAGER}', system_role_id('creator', 'manager')) ON CONFLICT DO NOTHING;
  `);
}, SETUP_TIMEOUT);

after(async () => {
  await t.close();
});

describe('los productores escriben, Resumen enseña', () => {
  before(async () => {
    // El video que se disparó: el puntaje de CON-6 sobre las líneas base del seed.
    const puntaje = await computePostScoreJob.handler({}, ctxDe('compute.post_score'));
    assert.ok(puntaje.processed > 0, 'compute.post_score puntuó videos del seed');
    // La cuenta de TikTok de Laura ya no se puede leer: el recolector la marca y avisa.
    const [tiktok] = await selectCollectableAccounts(ctxDe('collect.posts'), { connectionId: CONEXION_TIKTOK });
    assert.ok(tiktok, 'la cuenta de TikTok del seed es de las que se recolectan');
    await markAccountError(ctxDe('collect.posts'), tiktok, 'La cuenta ya no existe en TikTok.');
    // El LinkedIn de envío cae: el aviso que deja el webhook de Unipile (y canales.keepalive, con el mismo texto).
    await t.admin(`UPDATE outreach_channel_account SET status = 'connected' WHERE id = '${LINKEDIN_LAURA}'`);
    const red = 'LinkedIn';
    const cayo = await t.db.withWorkspace(LAURA_WS, (tx) =>
      markChannelAccountDown(tx, LINKEDIN_LAURA, 'unipile_status:CREDENTIALS', {
        titleEs: CANALES_TEXTOS.down.title(red, 'Laura Méndez'),
        bodyEs: CANALES_TEXTOS.down.body(CANALES_TEXTOS.unipileStatus('CREDENTIALS', red)),
      }));
    assert.equal(cayo, true, 'el LinkedIn estaba conectado');
    // Los recordatorios de cobro y los seguimientos de Ventas.
    await recordatoriosJob.handler({}, ctxDe('finance.reminders'));
    await runSeguimientos(jobDb, new Date(), { horaLocal: 0 });
  }, SETUP_TIMEOUT);

  test('la dueña ve una fila de cada fuente, y cada fila lleva a su módulo', async () => {
    const { fuentes, filas } = await bloqueDe(LAURA);
    assert.deepEqual(fuentes, ['connection', 'channel', 'invoice', 'deal', 'outlier']);
    for (const fuente of fuentes) assert.ok(filas.some((f) => f.source === fuente), `falta la fila de ${fuente}`);

    for (const f of filas) {
      switch (f.source) {
        case 'connection':
          assert.equal(f.connectionId, CONEXION_TIKTOK);
          assert.equal(f.status, 'error');
          assert.equal(f.actionUrl, '/conexiones');
          break;
        case 'channel':
          assert.equal(f.accountId, LINKEDIN_LAURA);
          assert.equal(f.actionUrl, '/ventas/canales');
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
    // Lo más urgente arriba: la cuenta de envío caída es crítica; la cuenta
    // social que no se lee es un warning, y va después aunque su fuente pese más.
    assert.equal(filas[0]?.source, 'channel', 'lo más urgente arriba');
    assert.equal(filas[0]?.severity, 'critical');
    assert.equal(filas.find((f) => f.source === 'connection')?.severity, 'warning');
    assert.equal(filas.at(-1)?.source, 'outlier', 'las buenas noticias al final');
  });

  test('la Mánager, sin finanzas.factura.ver, no ve la factura; el resto sí', async () => {
    const { fuentes, filas } = await bloqueDe(MANAGER);
    assert.ok(!fuentes.includes('invoice'));
    assert.ok(!filas.some((f) => f.source === 'invoice'));
    assert.ok(filas.some((f) => f.source === 'connection'));
    assert.ok(filas.some((f) => f.source === 'channel'));
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

  test('un aviso descartado también cuenta: el reintento del día siguiente no lo vuelve a escribir', async () => {
    // Alguien lo quitó de la campana (dismissed_at). La cuenta sigue en 'error' y se reintenta cada día.
    await t.admin(`UPDATE notification SET dismissed_at = now() WHERE kind = 'connection_error' AND entity_id = '${CONEXION_TIKTOK}'`);
    const [tiktok] = await selectCollectableAccounts(ctxDe('collect.posts'), { connectionId: CONEXION_TIKTOK });
    assert.ok(tiktok);
    await markAccountError(ctxDe('collect.posts'), tiktok, 'La cuenta ya no existe en TikTok.');
    const avisos = await jobDb.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notification WHERE kind = 'connection_error' AND entity_id = $1`, [CONEXION_TIKTOK]);
    assert.equal(avisos.rows[0]?.n, 1, 'lo vuelve a ver a la semana, no mañana');
  });

  test('si la avería sube de gravedad la misma semana (no se lee → token rechazado), el crítico sí se escribe y va arriba', async () => {
    const [tiktok] = await selectCollectableAccounts(ctxDe('collect.posts'), { connectionId: CONEXION_TIKTOK });
    assert.ok(tiktok);
    await markNeedsReauth(ctxDe('collect.posts'), tiktok, 'TikTok rechazó el token de la cuenta.');
    const { rows } = await jobDb.query<{ severity: string; title_es: string }>(
      `SELECT severity, title_es FROM notification WHERE kind = 'connection_error' AND entity_id = $1 ORDER BY created_at, id`,
      [CONEXION_TIKTOK]);
    assert.deepEqual(rows.map((r) => r.severity), ['warning', 'critical']);
    assert.equal(rows[1]?.title_es, 'TikTok dejó de darnos las cifras de @laura.cocinafacil', 'el título de @mc/core connectionErrorTitle, con el @');
    const fila = (await bloqueDe(LAURA)).filas.find((f) => f.source === 'connection');
    assert.ok(fila?.source === 'connection');
    assert.equal(fila.severity, 'critical');
    assert.equal(fila.status, 'needs_reauth');

    // Y el crítico no se repite: otro rechazo esa misma semana no escribe nada.
    await markNeedsReauth(ctxDe('collect.posts'), tiktok, 'TikTok rechazó el token de la cuenta.');
    const otra = await jobDb.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notification WHERE kind = 'connection_error' AND entity_id = $1`, [CONEXION_TIKTOK]);
    assert.equal(otra.rows[0]?.n, 2);
  });

  test('una cuenta que se leyó bien después del aviso y vuelve a caer es otra avería: vuelve a avisar', async () => {
    await jobDb.query(`UPDATE social_connection SET status = 'active', last_synced_at = now() WHERE id = $1`, [CONEXION_TIKTOK]);
    const [tiktok] = await selectCollectableAccounts(ctxDe('collect.posts'), { connectionId: CONEXION_TIKTOK });
    assert.ok(tiktok);
    await markAccountError(ctxDe('collect.posts'), tiktok, 'La cuenta ya no existe en TikTok.');
    const avisos = await jobDb.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notification WHERE kind = 'connection_error' AND entity_id = $1`, [CONEXION_TIKTOK]);
    assert.equal(avisos.rows[0]?.n, 3);
  });
  test('una cuenta que sigue sin token vuelve al bloque a la semana, aunque se diera «Entendido» por error', async () => {
    // La TikTok de Laura queda sin token; su último aviso fue hace ocho días y Laura le dio «Entendido».
    await jobDb.query(`UPDATE social_connection SET status = 'needs_reauth' WHERE id = $1`, [CONEXION_TIKTOK]);
    await t.admin(`UPDATE notification SET created_at = created_at - interval '8 days'
                    WHERE kind = 'connection_error' AND entity_id = '${CONEXION_TIKTOK}'`);
    const fuentes = weeklySourcesFor(await permisosDe(LAURA));
    const antes = (await bloqueDe(LAURA)).filas.find((f) => f.source === 'connection' && f.connectionId === CONEXION_TIKTOK);
    assert.ok(antes, 'el aviso viejo sigue en el bloque: nadie lo atendió');
    assert.equal(await como(LAURA, (tx) => acknowledgeHighlight(tx, antes.id, fuentes)), true);
    assert.ok(!(await bloqueDe(LAURA)).filas.some((f) => f.source === 'connection' && f.connectionId === CONEXION_TIKTOK));

    // Nadie lee una cuenta sin token: sin el barrido, no volvía nunca. (≥ 1: la
    // Facebook del seed 0012 también está sin token y sin aviso en esta prueba.)
    assert.ok((await remindBrokenAccounts(jobDb, LAURA_WS)) >= 1);
    const vuelve = (await bloqueDe(LAURA)).filas.find((f) => f.source === 'connection' && f.connectionId === CONEXION_TIKTOK);
    assert.ok(vuelve, 'otro aviso, con otro id: el «Entendido» de la semana pasada no lo calla');
    assert.notEqual(vuelve.id, antes.id);
    assert.equal(vuelve.severity, 'critical');

    // Y no se repite: el barrido siguiente, la misma semana, no escribe nada.
    assert.equal(await remindBrokenAccounts(jobDb, LAURA_WS), 0);
  });
});

describe('dos jobs que rompen la misma cuenta a la vez', () => {
  test('el aviso toma el candado de la cuenta ANTES de mirar si ya hay uno, dentro de la misma transacción', async () => {
    // La base de la prueba (PGlite) es de una sola conexión y no puede
    // correr dos transacciones a la vez: se prueba el orden de las
    // sentencias, que es lo que cierra la carrera en Postgres (ver
    // notifyBrokenAccount).
    const vistas: { sql: string; params: readonly unknown[] }[] = [];
    const espia: Queryable = {
      query: async <R extends Row = Row>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> => {
        vistas.push({ sql: text, params });
        return { rows: [] as R[], rowCount: 0 };
      },
    };
    const cuenta = { id: CONEXION_TIKTOK, workspace_id: LAURA_WS, platform_id: 'tiktok', handle: 'laura.cocinafacil' };
    await notifyBrokenAccount(espia, cuenta, 'unreadable', null);
    assert.match(vistas[0]?.sql ?? '', /pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)/);
    assert.deepEqual(vistas[0]?.params, [`${BROKEN_ACCOUNT_LOCK_PREFIX}${CONEXION_TIKTOK}`]);
    assert.match(vistas[1]?.sql ?? '', /INSERT INTO notification[\s\S]*WHERE NOT EXISTS/);
    assert.equal(vistas.length, 2);
  });

  test('el barrido abre una transacción por cuenta: el candado no se suelta antes de escribir', async () => {
    let transacciones = 0;
    const db: JobDatabase = {
      query: jobDb.query,
      transaction: (fn) => {
        transacciones += 1;
        return jobDb.transaction(fn);
      },
    };
    await t.admin(`UPDATE notification SET created_at = created_at - interval '30 days'
                    WHERE kind = 'connection_error' AND entity_id = '${CONEXION_TIKTOK}'`);
    const escritos = await remindBrokenAccounts(db, LAURA_WS);
    assert.ok(escritos >= 1);
    assert.equal(transacciones, escritos, 'una por cuenta que pasó por notifyBrokenAccount');
  });
});
