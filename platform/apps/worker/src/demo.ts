/**
 * Modo --demo: Postgres embebido con un workspace, una creadora y tres
 * conexiones de TikTok en distinto estado, y un oauth.refresh encolado
 * al arrancar. Sirve para enseñar el worker sin Supabase ni Docker
 * (demo del viernes) y para ver job_run llenándose.
 *
 * Además agrega dos cuentas públicas por @ y corre los dos recolectores
 * de CON-5: descubre publicaciones, las mide dos veces (con un día de
 * diferencia, para que post_metrics_daily_delta tenga un crecimiento
 * que enseñar) e imprime post, post_metric_snapshot y la vista.
 *
 * Y termina con CON-6: tras cada recolección el runner encadena
 * compute.baseline y compute.post_score (JobOptions.after), y el demo
 * imprime su job_run.metadata, creator_baseline y post_score. Es el
 * camino entero collect → compute, sin encolar nada a mano.
 *
 * Con INSTAGRAM_HOUSE_TOKEN y GOOGLE_API_KEY en el entorno va contra
 * las APIs de verdad. Sin ellas usa las respuestas GRABADAS
 * (packages/connectors/fixtures) y lo dice en el log: así el demo
 * enseña el camino entero en una máquina sin credenciales, sin hacer
 * pasar por real un número que no lo es.
 *
 * Las cuentas se eligen con DEMO_INSTAGRAM_HANDLE y DEMO_YOUTUBE_HANDLE.
 */
import { FixtureFetch, loadFixtures, type ConnectorHttpOverrides, type SecretStore } from '@mc/connectors';
import type { Env } from './runner/config.ts';
import type { WorkerDatabase } from './runner/db.ts';
import type { Logger } from './runner/logger.ts';
import type { RunningWorker } from './runner/worker.ts';

export interface DemoSeed {
  workspaceId: string;
  creatorId: string;
  connections: { id: string; label: string; secretRef: string }[];
}

/**
 * Siembra el escenario de la prueba 5 de CON-2: una conexión vence en
 * 10 minutos (se renueva), otra en 3 horas (intacta), otra revocada
 * (needs_reauth). Escribe con el acceso de superusuario del embebido.
 */
export async function seedDemo(db: WorkerDatabase, secrets: SecretStore, now: Date): Promise<DemoSeed> {
  if (db.kind !== 'pglite') throw new Error('seedDemo solo corre en pglite');
  const raw = (db as unknown as { raw: { query<R>(q: string, p?: unknown[]): Promise<{ rows: R[] }> } }).raw;
  const ws = await raw.query<{ id: string }>(
    `INSERT INTO workspace (slug, name) VALUES ('demo-cafealma', 'Café Alma (demo)') RETURNING id`,
  );
  const workspaceId = ws.rows[0]!.id;
  const cp = await raw.query<{ id: string }>(
    `INSERT INTO creator_profile (workspace_id, display_name, handle) VALUES ($1, 'Café Alma', '@cafealma') RETURNING id`,
    [workspaceId],
  );
  const creatorId = cp.rows[0]!.id;
  const minutes = (m: number) => new Date(now.getTime() + m * 60_000);
  const specs = [
    { label: 'vence en 10 min', handle: '@cafealma', external: 'tt-1', expires: minutes(10), token: 'ok-token-1' },
    { label: 'vence en 3 h', handle: '@cafealma.recetas', external: 'tt-2', expires: minutes(180), token: 'ok-token-2' },
    { label: 'revocada', handle: '@cafealma.tienda', external: 'tt-3', expires: minutes(5), token: 'revoked-token-3' },
  ];
  const connections: DemoSeed['connections'] = [];
  for (const s of specs) {
    const secretRef = `demo:${s.external}`;
    const r = await raw.query<{ id: string }>(
      `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_expires_at, refresh_expires_at)
       VALUES ($1, $2, 'tiktok', $3, $4, $5, '{user.info.basic,video.list}', $6, $7) RETURNING id`,
      [workspaceId, creatorId, s.external, s.handle, secretRef, s.expires, minutes(60 * 24 * 300)],
    );
    await secrets.set(secretRef, {
      accessToken: s.token,
      refreshToken: `refresh-${s.external}`,
      accessExpiresAt: s.expires,
      refreshExpiresAt: minutes(60 * 24 * 300),
      scopes: ['user.info.basic', 'video.list'],
    });
    connections.push({ id: r.rows[0]!.id, label: s.label, secretRef });
  }
  return { workspaceId, creatorId, connections };
}

/** Cuentas por @ para ver CON-5 contra las APIs de verdad. Se cambian con DEMO_INSTAGRAM_HANDLE y DEMO_YOUTUBE_HANDLE. */
export const DEMO_INSTAGRAM_HANDLE = 'nicolasduartea';
export const DEMO_YOUTUBE_HANDLE = 'NutriveOficial';
/** Los @ que cubren las respuestas grabadas; con fixtures hay que usar estos o la llamada no casa con ninguna. */
export const DEMO_GRABADO_HANDLES = { instagram: 'cafealma', youtube: 'NutriveOficial' } as const;

/** Credenciales de mentira para que las fuentes arranquen cuando el demo va contra respuestas grabadas. */
const DEMO_FAKE_CREDENTIALS = { INSTAGRAM_HOUSE_TOKEN: 'demo-sin-credencial', GOOGLE_API_KEY: 'demo-sin-credencial' };

export interface DemoNetwork {
  /** true si las respuestas salen de los fixtures y no de la plataforma. */
  grabado: boolean;
  env: Env;
  http?: ConnectorHttpOverrides;
}

/**
 * Cómo habla el demo con las plataformas. Si faltan las credenciales de
 * la casa, se usan las respuestas grabadas de CON-1/CON-5 y se avisa;
 * el resto del camino (jobs, upsert, snapshots, vistas) es el de verdad.
 */
export async function demoNetwork(env: Env): Promise<DemoNetwork> {
  const conCredenciales = Boolean(env['INSTAGRAM_HOUSE_TOKEN']?.trim()) && Boolean(env['GOOGLE_API_KEY']?.trim());
  if (conCredenciales) return { grabado: false, env };
  const fixtures = await loadFixtures('youtube', [
    ['channels.list', 'handle.uploads.ok'], ['playlist_items.list', 'uploads.ok'], ['videos.list', 'crecimiento'],
  ]);
  const instagram = await loadFixtures('instagram', [['business_discovery.media', 'ok']]);
  const fetch = new FixtureFetch([...fixtures, ...instagram]);
  return { grabado: true, env: { ...env, ...DEMO_FAKE_CREDENTIALS }, http: { fetch: fetch.fetch } };
}

/**
 * El instante en que arranca el demo con respuestas grabadas: dos días
 * antes de grabarlas. Con la hora real, que un video llegue a un corte
 * dependería de a qué hora se corre el demo; con este instante la salida
 * es siempre la misma. Las publicaciones de Instagram grabadas (20, 18 y
 * 15 de septiembre) tienen 23, 73,5 y 148 horas en la primera lectura y
 * 47, 97,5 y 172 en la segunda: la primera se puntúa a 24 h, la tercera a
 * 168 h, y la segunda y las de YouTube (1 a 3 de septiembre) no tienen
 * una lectura dentro de la banda de su corte, así que se quedan sin fila.
 */
export const DEMO_GRABADO_INICIO = new Date('2026-09-21T16:00:00Z');

/** Reloj del demo: avanza un día entre las dos lecturas para que la vista de delta tenga dos días que comparar. */
export function demoClock(inicio: Date = new Date()): { now: () => Date; avanzaUnDia: () => void } {
  let instante = inicio;
  return {
    now: () => instante,
    avanzaUnDia: () => { instante = new Date(instante.getTime() + 86_400_000); },
  };
}

/** Agrega las dos cuentas por @ del demo (sin tokens: son públicas). */
export async function seedDemoPublicAccounts(db: WorkerDatabase, seed: DemoSeed, env: Env, grabado = false): Promise<Array<{ id: string; platform: string; handle: string }>> {
  const raw = (db as unknown as { raw: { query<R>(q: string, p?: unknown[]): Promise<{ rows: R[] }> } }).raw;
  const cuentas = grabado
    ? [
        { platform: 'instagram', handle: DEMO_GRABADO_HANDLES.instagram },
        { platform: 'youtube', handle: DEMO_GRABADO_HANDLES.youtube },
      ]
    : [
        { platform: 'instagram', handle: env['DEMO_INSTAGRAM_HANDLE']?.trim() || DEMO_INSTAGRAM_HANDLE },
        { platform: 'youtube', handle: env['DEMO_YOUTUBE_HANDLE']?.trim() || DEMO_YOUTUBE_HANDLE },
      ];
  const out: Array<{ id: string; platform: string; handle: string }> = [];
  for (const c of cuentas) {
    const r = await raw.query<{ id: string }>(
      `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_mode, status)
       VALUES ($1, $2, $3, $4, $5, $6, '{}', 'public_profile', 'active') RETURNING id`,
      [seed.workspaceId, seed.creatorId, c.platform, `${c.platform}:${c.handle}`, c.handle, `public:${c.platform}:${c.handle}`],
    );
    out.push({ id: r.rows[0]!.id, platform: c.platform, handle: c.handle });
  }
  return out;
}

/** Espera a que ese job deje `n` corridas terminadas, o se rinde con lo que haya. */
async function esperaCorridas(db: WorkerDatabase, jobId: string, n: number, msTope = 60_000): Promise<Array<Record<string, unknown>>> {
  const hasta = Date.now() + msTope;
  for (;;) {
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT id, job_id, status, attempt, duration_ms, items_processed, items_failed, error, metadata
         FROM job_run WHERE job_id = $1 AND status <> 'running' ORDER BY id`,
      [jobId],
    );
    if (rows.length >= n || Date.now() > hasta) return rows;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** CON-5 en vivo: descubre, mide dos veces e imprime lo que quedó en la base. */
export async function runDemoPosts(opts: {
  db: WorkerDatabase; worker: RunningWorker; logger: Logger; env: Env; seed: DemoSeed;
  grabado: boolean; avanzaUnDia: () => void;
}): Promise<void> {
  const { db, worker, logger, env, seed } = opts;
  const cuentas = await seedDemoPublicAccounts(db, seed, env, opts.grabado);
  logger.info('demo CON-5: cuentas por @ agregadas', {
    cuentas: cuentas.map((c) => `${c.platform}:@${c.handle}`),
    fuente: opts.grabado ? 'respuestas GRABADAS (faltan INSTAGRAM_HOUSE_TOKEN y GOOGLE_API_KEY)' : 'APIs de las plataformas',
  });

  // Solo las cuentas por @ de este demo: las tres conexiones de CON-2
  // llevan tokens de mentira, y llamar a TikTok con ellas solo
  // ensuciaría la salida con 401 que no dicen nada de CON-5.
  for (const c of cuentas) {
    await worker.boss.send('collect.posts', { source: 'demo', workspaceId: seed.workspaceId, connectionId: c.id }, { singletonKey: `demo-posts-${c.id}` });
  }
  const posts = await esperaCorridas(db, 'collect.posts', cuentas.length);
  logger.info('demo CON-5: job_run de collect.posts', { rows: posts });

  // Dos corridas con un día de diferencia: la tabla es append-only, así
  // que quedan dos filas por publicación, y post_metrics_daily_delta
  // —que agrupa por DÍA— puede enseñar el crecimiento.
  let hechas = 0;
  for (const vuelta of [1, 2]) {
    if (vuelta === 2) opts.avanzaUnDia();
    for (const c of cuentas) {
      await worker.boss.send('collect.post_metrics', { source: `demo-${vuelta}`, workspaceId: seed.workspaceId, connectionId: c.id }, { singletonKey: `demo-metrics-${vuelta}-${c.id}` });
    }
    hechas += cuentas.length;
    const corridas = await esperaCorridas(db, 'collect.post_metrics', hechas);
    logger.info(`demo CON-5: job_run de collect.post_metrics (corrida ${vuelta})`, { rows: corridas.slice(-cuentas.length) });
  }

  const resumen = await db.query(
    `SELECT sc.platform_id, sc.handle,
            (SELECT count(*)::int FROM post p WHERE p.connection_id = sc.id) AS posts,
            (SELECT count(*)::int FROM post_metric_snapshot s JOIN post p ON p.id = s.post_id WHERE p.connection_id = sc.id) AS lecturas
       FROM social_connection sc WHERE sc.access_mode = 'public_profile' ORDER BY sc.platform_id`,
  );
  logger.info('demo CON-5: post y post_metric_snapshot por cuenta', { rows: resumen.rows });

  const muestra = await db.query(
    `SELECT p.platform_id, p.external_post_id, p.title, p.media_type, p.surface,
            to_char(p.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS published_at,
            s.age_hours, s.views, s.likes, s.comments, s.source,
            to_char(s.captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS captured_at
       FROM post_metric_snapshot s JOIN post p ON p.id = s.post_id
      ORDER BY p.platform_id, p.published_at DESC, s.captured_at LIMIT 12`,
  );
  logger.info('demo CON-5: lecturas (una celda sin dato es null, nunca cero)', { rows: muestra.rows });

  const delta = await db.query(
    `SELECT p.platform_id, p.external_post_id, d.day::text AS day, d.views_gained, d.views_cumulative
       FROM post_metrics_daily_delta d JOIN post p ON p.id = d.post_id
      ORDER BY p.platform_id, p.external_post_id, d.day LIMIT 12`,
  );
  logger.info('demo CON-5: post_metrics_daily_delta', { rows: delta.rows });

  await runDemoCompute({ db, logger, workspaceId: seed.workspaceId });
}

/**
 * CON-6 en la misma demo: compute.baseline y compute.post_score NO se
 * encolan aquí. Los encola el runner solo, tras cada collect.post_metrics
 * que trae datos (JobOptions.after). El demo espera a que la cadena
 * termine después de la última recolección e imprime job_run.metadata,
 * creator_baseline y post_score.
 */
export async function runDemoCompute(opts: { db: WorkerDatabase; logger: Logger; workspaceId: string }): Promise<void> {
  const { db, logger, workspaceId } = opts;
  // La cadena terminó cuando hay un compute.* después de la última
  // recolección, nada corriendo y ninguna fila nueva en job_run durante
  // tres segundos. Mirar solo «un post_score después de la última
  // recolección» no basta: uno encadenado desde la primera ronda puede
  // empezar después, y una línea base que no escribe nada no encadena
  // post_score (no hay qué recalcular).
  const QUIETO_MS = 3_000;
  const hasta = Date.now() + 60_000;
  let visto = '';
  let quietoDesde = Date.now();
  let terminada = false;
  for (;;) {
    const ultimos = await db.query<{ ultimo: string | null; collect: string | null; compute: string | null; corriendo: number }>(
      `SELECT max(id)::text AS ultimo,
              max(id) FILTER (WHERE job_id = 'collect.post_metrics')::text AS collect,
              max(id) FILTER (WHERE job_id LIKE 'compute.%')::text AS compute,
              count(*) FILTER (WHERE status = 'running')::int AS corriendo
         FROM job_run WHERE job_id IN ('collect.post_metrics', 'compute.baseline', 'compute.post_score')`,
    );
    const u = ultimos.rows[0];
    const huella = `${u?.ultimo ?? ''}/${u?.corriendo ?? 0}`;
    if (huella !== visto) {
      visto = huella;
      quietoDesde = Date.now();
    }
    const id = (v: string | null | undefined) => BigInt(v ?? '0');
    terminada = u !== undefined && u.corriendo === 0 && id(u.compute) > id(u.collect) && Date.now() - quietoDesde >= QUIETO_MS;
    if (terminada || Date.now() > hasta) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!terminada) logger.warn('demo CON-6: la cadena no terminó en 60 s; se imprime lo que hay');
  const { rows: cadena } = await db.query<Record<string, unknown>>(
    `SELECT id, job_id, status, duration_ms, items_processed, items_failed, error, metadata
       FROM job_run WHERE job_id IN ('compute.baseline', 'compute.post_score') AND status <> 'running' ORDER BY id`,
  );
  logger.info('demo CON-6: job_run de compute.* (encadenados tras collect.post_metrics: metadata.tras)', { rows: cadena });

  const bases = await db.query(
    `SELECT platform_id, age_hours_cut, sample_size, median_views::text AS median_views, is_reliable,
            to_char(computed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS computed_at
       FROM creator_baseline WHERE workspace_id = $1
      ORDER BY computed_at DESC, platform_id, age_hours_cut LIMIT 12`,
    [workspaceId],
  );
  logger.info('demo CON-6: creator_baseline (con menos de ocho videos, is_reliable = false)', { rows: bases.rows });

  const puntajes = await db.query(
    `SELECT p.platform_id, p.external_post_id, s.age_hours_cut, s.views_at_cut::text AS views_at_cut,
            s.views_vs_median::text AS views_vs_median, s.outlier_tier, s.is_outlier
       FROM post_score s JOIN post p ON p.id = s.post_id
      WHERE s.workspace_id = $1 ORDER BY p.platform_id, p.external_post_id`,
    [workspaceId],
  );
  const sinFila = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM post p WHERE p.workspace_id = $1 AND NOT EXISTS (SELECT 1 FROM post_score s WHERE s.post_id = p.id)`,
    [workspaceId],
  );
  logger.info('demo CON-6: post_score (views_vs_median null = todavía no hay ocho videos para comparar, nunca cero)', {
    rows: puntajes.rows,
    sinCorteMedido: sinFila.rows[0]?.n ?? 0,
  });
}

export async function runDemo(opts: {
  db: WorkerDatabase; worker: RunningWorker; secrets: SecretStore; logger: Logger;
  env?: Env; grabado?: boolean; now?: () => Date; avanzaUnDia?: () => void;
}): Promise<void> {
  const { db, worker, secrets, logger } = opts;
  // Las conexiones de CON-2 vencen relativas al reloj del worker, no a la hora real: si no, con el reloj fijo
  // de las respuestas grabadas, la que «vence en 10 minutos» vencería dos días después para oauth.refresh.
  const seed = await seedDemo(db, secrets, (opts.now ?? (() => new Date()))());
  logger.info('demo: escenario sembrado', { workspaceId: seed.workspaceId, connections: seed.connections.map((c) => c.label) });
  const jobId = await worker.boss.send('oauth.refresh', { source: 'demo', workspaceId: seed.workspaceId });
  logger.info('demo: oauth.refresh encolado', { jobId });

  setTimeout(() => {
    void (async () => {
      const runs = await db.query(
        `SELECT id, job_id, status, attempt, duration_ms, items_processed, items_failed, error, metadata
           FROM job_run WHERE status <> 'skipped' ORDER BY id`,
      );
      const conns = await db.query(
        `SELECT handle, status, status_detail, to_char(access_expires_at, 'YYYY-MM-DD HH24:MI') AS access_expires_at FROM social_connection ORDER BY handle`,
      );
      const notes = await db.query(`SELECT kind, severity, title_es FROM notification ORDER BY created_at`);
      const calls = await db.query(
        `SELECT connection_id, platform_id, endpoint, http_status, ok, error_code, duration_ms, rate_limited FROM api_call_log ORDER BY id`,
      );
      logger.info('demo: job_run', { rows: runs.rows });
      logger.info('demo: social_connection', { rows: conns.rows });
      logger.info('demo: notification', { rows: notes.rows });
      logger.info('demo: api_call_log (CON-1: una fila por llamada, sin token)', { rows: calls.rows });
      await runDemoPosts({ db, worker, logger, env: opts.env ?? process.env, seed, grabado: opts.grabado ?? false, avanzaUnDia: opts.avanzaUnDia ?? (() => undefined) });
      logger.info('demo: el worker sigue corriendo; Ctrl-C para salir');
    })().catch((err: unknown) => logger.error('demo: no se pudo consultar', { err }));
  }, 4000);
}
