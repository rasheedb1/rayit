/**
 * CON-5 · las dos reglas que no se ven desde fuera: qué pasa cuando la
 * señal se aborta a mitad de una corrida, y qué se repite (y qué no)
 * cuando pg-boss reintenta.
 *
 * Estas dos se prueban llamando al handler con un JobContext armado a
 * mano, no por la cola: así el aborto ocurre en un punto exacto y el
 * número de intento se elige, en vez de esperar a que un timeout real
 * dispare. Es la misma base de datos embebida con las migraciones y los
 * seeds reales.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createConnectors, FixtureFetch, InMemorySecretStore, loadFixtures, PostgresCallLogSink, QuotaManager, refresherRegistry,
  withoutNetwork, type NetworkGuard,
} from '@mc/connectors';
import { collectPostMetricsJob } from '../src/jobs/conexiones/collect-post-metrics.ts';
import { collectPostsJob } from '../src/jobs/conexiones/collect-posts.ts';
import { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { createLogger, MemorySink } from '../src/runner/logger.ts';
import type { JobContext, JobDefinition, JobPayload, JobResult } from '../src/runner/registry.ts';
import { openTestDatabase } from './helpers/harness.ts';

const W1 = '00000025-0000-4000-8000-000000000001';
const C1 = '00000025-0000-4000-8000-000000000011';
const ENV = { INSTAGRAM_HOUSE_TOKEN: 'IGAA-casa-senal-SECRETO', GOOGLE_API_KEY: 'AIza-senal-SECRETO' };

let guard: NetworkGuard;
before(() => { guard = withoutNetwork(); });
after(() => { guard.restore(); });

/** Una definición como la de job_definition, con la concurrencia que pida la prueba. */
function definicion(id: string, maxConcurrency: number): JobDefinition {
  return { id, labelEs: id, queue: 'collect', defaultCron: null, timeoutS: 300, maxAttempts: 5, maxConcurrency, enabled: true };
}

interface ContextoOpts {
  db: PgliteDatabase;
  definition: JobDefinition;
  signal: AbortSignal;
  now: () => Date;
  fetch: FixtureFetch;
  attempt?: number;
  sink: MemorySink;
}

function contexto(opts: ContextoOpts): JobContext {
  const logger = createLogger({ level: 'debug', sink: opts.sink }).child({ job: opts.definition.id });
  const callLog = new PostgresCallLogSink(opts.db);
  return {
    jobId: opts.definition.id,
    runId: 1,
    attempt: opts.attempt ?? 1,
    workspaceId: W1,
    definition: opts.definition,
    db: opts.db,
    logger,
    signal: opts.signal,
    secrets: new InMemorySecretStore(),
    refreshers: refresherRegistry([]),
    connectors: createConnectors({ callLog, quota: new QuotaManager(), logger, signal: opts.signal, http: { fetch: opts.fetch.fetch } }),
    callLog,
    now: opts.now,
    env: ENV,
  };
}

async function siembra(db: PgliteDatabase): Promise<{ yt: string; ig: string }> {
  await db.raw.exec(`
    INSERT INTO workspace (id, slug, name) VALUES ('${W1}', 'laura', 'Laura');
    INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${C1}', '${W1}', 'Laura');
  `);
  const alta = async (platform: string, handle: string, ext: string) => {
    const r = await db.raw.query<{ id: string }>(
      `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_mode)
       VALUES ($1, $2, $3, $4, $5, $6, '{}', 'public_profile') RETURNING id`,
      [W1, C1, platform, ext, handle, `public:${platform}:${handle}`],
    );
    return r.rows[0]!.id;
  };
  return { yt: await alta('youtube', 'NutriveOficial', 'UCnutrive1'), ig: await alta('instagram', 'cafealma', '17841400000000e01') };
}

test('una señal abortada a mitad de corrida deja de llamar a la plataforma y cuenta lo pendiente como fallo', async () => {
  const db = await openTestDatabase();
  try {
    // Dos cuentas de la MISMA plataforma y concurrencia 1: se procesan
    // en fila, así el aborto cae en un punto exacto y la prueba no
    // depende de cuál respuesta llegue antes.
    await db.raw.exec(`
      INSERT INTO workspace (id, slug, name) VALUES ('${W1}', 'laura', 'Laura');
      INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${C1}', '${W1}', 'Laura');
    `);
    const alta = async (ext: string) => {
      const r = await db.raw.query<{ id: string }>(
        `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_mode, connected_at)
         VALUES ($1, $2, 'youtube', $3, 'NutriveOficial', $4, '{}', 'public_profile', $5::timestamptz) RETURNING id`,
        [W1, C1, ext, `public:youtube:${ext}`, `2026-09-0${ext.slice(-1)}T00:00:00Z`],
      );
      return r.rows[0]!.id;
    };
    const primera = await alta('UCcanal1');
    const segunda = await alta('UCcanal2');

    const sink = new MemorySink();
    const base = new FixtureFetch(
      await loadFixtures('youtube', [['channels.list', 'handle.uploads.ok'], ['playlist_items.list', 'uploads.ok'], ['videos.list', 'canal.ok']]),
    );
    const abort = new AbortController();
    // El worker se apaga (o vence el timeout) en cuanto vuelve la
    // primera respuesta de la plataforma.
    const envoltura = {
      calls: base.calls,
      fetch: async (url: string, init: RequestInit) => {
        const res = await base.fetch(url, init);
        abort.abort(new Error('apagado del worker'));
        return res;
      },
    } as unknown as FixtureFetch;

    const ctx = contexto({ db, definition: definicion('collect.posts', 1), signal: abort.signal, now: () => new Date('2026-09-23T06:00:00Z'), fetch: envoltura, sink });
    const res: JobResult = await collectPostsJob.handler({ workspaceId: W1 } as JobPayload, ctx);

    assert.equal(base.calls.length, 1, 'después del aborto no se llama a la plataforma otra vez');
    const md = res.metadata as { diferidas: string[]; abortadas: string[]; revisadas: string[]; transitorios: string[]; errores: string[] };
    assert.deepEqual(md.revisadas, [], 'ninguna cuenta se dio por revisada');
    assert.deepEqual(md.errores, [], 'un apagado nuestro no es una cuenta rota');
    assert.deepEqual(md.transitorios, [primera], 'la que estaba a medias se retoma');
    assert.deepEqual(md.abortadas, [segunda], 'la que no se alcanzó queda pendiente, no perdida');
    assert.deepEqual(md.diferidas, [], 'no fue la cuota: fue el apagado');
    assert.equal(res.failed, 2, 'lo pendiente cuenta como fallo: pg-boss vuelve a intentarlo');
    assert.equal(res.retry, true, 'un apagado sí mejora con un reintento');
    assert.equal(guard.attempts, 0);

    // El aborto es cosa nuestra: no se le apunta a la cuenta del creador.
    const cuentas = await db.query<{ status: string; consecutive_failures: number; last_error_at: Date | null }>(
      'SELECT status, consecutive_failures, last_error_at FROM social_connection',
    );
    for (const c of cuentas.rows) {
      assert.equal(c.consecutive_failures, 0);
      assert.equal(c.last_error_at, null);
      assert.equal(c.status, 'active');
    }
    const posts = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM post');
    assert.equal(posts.rows[0]!.n, '0', 'no se guarda medio descubrimiento');
  } finally {
    await db.close();
  }
});

test('dos corridas seguidas dejan dos lecturas; un reintento no repite lo que esa corrida ya midió', async () => {
  const db = await openTestDatabase();
  try {
    const ids = await siembra(db);
    await db.raw.query(
      `INSERT INTO post (workspace_id, creator_id, connection_id, platform_id, external_post_id, media_type, published_at)
       VALUES ($1, $2, $3, 'youtube', 'vid00000001', 'video', '2026-09-01T15:00:00Z'),
              ($1, $2, $3, 'youtube', 'vid00000002', 'video', '2026-09-02T15:00:00Z'),
              ($1, $2, $3, 'youtube', 'vid00000003', 'video', '2026-09-03T15:00:00Z')`,
      [W1, C1, ids.yt],
    );
    const sink = new MemorySink();
    const fetch = new FixtureFetch(await loadFixtures('youtube', [['videos.list', 'crecimiento']]));
    const def = definicion('collect.post_metrics', 4);
    const abort = new AbortController();
    const corre = (instante: string, attempt: number) =>
      collectPostMetricsJob.handler({ workspaceId: W1 }, contexto({ db, definition: def, signal: abort.signal, now: () => new Date(instante), fetch, attempt, sink }));

    const cuenta = async () => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM post_metric_snapshot`)).rows[0]!.n);

    const r1 = await corre('2026-09-23T05:00:00Z', 1);
    assert.equal(r1.processed, 3);
    assert.equal(await cuenta(), 3);

    // Un reintento diez minutos después: los tres ya están medidos en
    // esa ventana, así que no se repiten y no se gasta ni una llamada.
    const llamadas = fetch.calls.length;
    const r2 = await corre('2026-09-23T05:10:00Z', 2);
    assert.equal((r2.metadata as { yaMedidos: number }).yaMedidos, 3);
    assert.equal(r2.processed, 0);
    assert.equal(await cuenta(), 3, 'el reintento no duplica lo hecho');
    assert.equal(fetch.calls.length, llamadas, 'ni una llamada de más');

    // Una corrida nueva (primer intento) sí vuelve a medir: la tabla es
    // append-only a propósito, y de ahí sale post_metrics_daily_delta.
    const r3 = await corre('2026-09-23T17:00:00Z', 1);
    assert.equal(r3.processed, 3);
    assert.equal(await cuenta(), 6);

    const porPost = await db.query<{ external_post_id: string; n: string }>(
      `SELECT p.external_post_id, count(*)::text AS n FROM post_metric_snapshot s JOIN post p ON p.id = s.post_id GROUP BY 1 ORDER BY 1`,
    );
    assert.deepEqual(porPost.rows.map((r) => r.n), ['2', '2', '2']);
  } finally {
    await db.close();
  }
});

test('una lectura no puede quedar por detrás de otra ya guardada', async () => {
  const db = await openTestDatabase();
  try {
    const ids = await siembra(db);
    await db.raw.query(
      `INSERT INTO post (workspace_id, creator_id, connection_id, platform_id, external_post_id, media_type, published_at)
       VALUES ($1, $2, $3, 'youtube', 'vid00000001', 'video', '2026-09-01T15:00:00Z')`,
      [W1, C1, ids.yt],
    );
    const sink = new MemorySink();
    const fetch = new FixtureFetch(await loadFixtures('youtube', [['videos.list', 'crecimiento']]));
    const def = definicion('collect.post_metrics', 4);
    const abort = new AbortController();
    const corre = (instante: string) =>
      collectPostMetricsJob.handler({ workspaceId: W1 }, contexto({ db, definition: def, signal: abort.signal, now: () => new Date(instante), fetch, attempt: 1, sink }));

    await corre('2026-09-23T17:00:00Z');
    // Un reloj atrasado (o una corrida que llegó tarde) no puede
    // escribir una lectura anterior a la que ya está guardada: sería
    // una vuelta atrás en post_metrics_latest.
    const r = await corre('2026-09-23T05:00:00Z');
    assert.equal(r.processed, 0);
    const { rows } = await db.query<{ n: string; captured_at: Date }>(
      `SELECT count(*) OVER ()::text AS n, captured_at FROM post_metric_snapshot`,
    );
    assert.equal(rows.length, 1);
    assert.equal(new Date(rows[0]!.captured_at).toISOString(), '2026-09-23T17:00:00.000Z');
  } finally {
    await db.close();
  }
});
