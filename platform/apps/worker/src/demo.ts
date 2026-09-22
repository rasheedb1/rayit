/**
 * Modo --demo: Postgres embebido con un workspace, una creadora y tres
 * conexiones de TikTok en distinto estado, y un oauth.refresh encolado
 * al arrancar. Sirve para enseñar el worker sin Supabase ni Docker
 * (demo del viernes) y para ver job_run llenándose.
 */
import type { SecretStore } from '@mc/connectors';
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

export async function runDemo(opts: { db: WorkerDatabase; worker: RunningWorker; secrets: SecretStore; logger: Logger }): Promise<void> {
  const { db, worker, secrets, logger } = opts;
  const seed = await seedDemo(db, secrets, new Date());
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
      logger.info('demo: job_run', { rows: runs.rows });
      logger.info('demo: social_connection', { rows: conns.rows });
      logger.info('demo: notification', { rows: notes.rows });
      logger.info('demo: el worker sigue corriendo; Ctrl-C para salir');
    })().catch((err: unknown) => logger.error('demo: no se pudo consultar', { err }));
  }, 4000);
}
