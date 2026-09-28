/**
 * CON-5 · collect.post_metrics sobre pglite con las migraciones reales.
 *
 * Lo que se demuestra: que dos corridas dejan dos filas por post y que
 * post_metrics_daily_delta enseña el crecimiento; que age_hours sale
 * del reloj del job y no de Date.now(); que lo viejo deja de medirse
 * salvo que esté en una campaña abierta; que un video borrado se marca
 * solo donde la fuente sabe preguntar por id; que un token rechazado
 * deja la cuenta en needs_reauth con su notificación; y que una celda
 * sin dato nunca es un cero.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { dumpTextColumns, findSecretInDump, FixtureFetch, loadFixtures, withoutNetwork, type NetworkGuard } from '@mc/connectors';
import { allJobs } from '../src/jobs/index.ts';
import { jobRuns, startHarness, waitFor, type Harness } from './helpers/harness.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';

const W1 = '00000015-0000-4000-8000-000000000001';
const C1 = '00000015-0000-4000-8000-000000000011';
const ENV = { INSTAGRAM_HOUSE_TOKEN: 'IGAA-casa-metricas-SECRETO', GOOGLE_API_KEY: 'AIza-metricas-SECRETO' };

const DIA_1 = new Date('2026-09-23T05:00:00Z');
const DIA_2 = new Date('2026-09-24T05:00:00Z');

let guard: NetworkGuard;
before(() => { guard = withoutNetwork(); });
after(() => { guard.restore(); });

async function altaYouTube(db: PgliteDatabase, workspace: string, creador: string, handle = 'NutriveOficial'): Promise<string> {
  const r = await db.raw.query<{ id: string }>(
    `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_mode)
     VALUES ($1, $2, 'youtube', $3, $4, $5, '{}', 'public_profile') RETURNING id`,
    [workspace, creador, `UC${handle}`, handle, `public:youtube:${handle}`],
  );
  return r.rows[0]!.id;
}

async function altaPost(db: PgliteDatabase, workspace: string, creador: string, conexion: string, externalId: string, publishedAt: string): Promise<string> {
  const r = await db.raw.query<{ id: string }>(
    `INSERT INTO post (workspace_id, creator_id, connection_id, platform_id, external_post_id, media_type, published_at)
     VALUES ($1, $2, $3, 'youtube', $4, 'video', $5::timestamptz) RETURNING id`,
    [workspace, creador, conexion, externalId, publishedAt],
  );
  return r.rows[0]!.id;
}

async function esperaCorrida(h: Harness, n: number): Promise<Record<string, unknown>> {
  const runs = await waitFor(async () => {
    const todas = (await jobRuns(h.db, 'collect.post_metrics')).filter((r) => r.status !== 'running');
    return todas.length >= n ? todas : null;
  }, { label: `collect.post_metrics #${n}`, timeoutMs: 30_000 });
  const run = runs[n - 1]!;
  assert.equal(run.status, 'ok', run.error ?? '');
  return run.metadata;
}

// ---------------------------------------------------------------------
// Dos corridas, dos filas, y el crecimiento que enseña la vista
// ---------------------------------------------------------------------

test('dos corridas dejan dos filas por post y post_metrics_daily_delta muestra el crecimiento', async () => {
  const fetch = new FixtureFetch(await loadFixtures('youtube', [['videos.list', 'crecimiento']]));
  let reloj = DIA_1;
  const h = await startHarness({
    jobs: allJobs, now: () => reloj, env: ENV, http: { fetch: fetch.fetch },
    seed: async (db) => {
      await db.raw.exec(`
        INSERT INTO workspace (id, slug, name) VALUES ('${W1}', 'laura', 'Laura');
        INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${C1}', '${W1}', 'Laura');
      `);
      const conn = await altaYouTube(db, W1, C1);
      await altaPost(db, W1, C1, conn, 'vid00000001', '2026-09-01T15:00:00Z');
      await altaPost(db, W1, C1, conn, 'vid00000002', '2026-09-02T15:00:00Z');
      await altaPost(db, W1, C1, conn, 'vid00000003', '2026-09-03T15:00:00Z');
    },
  });
  try {
    await h.worker.boss.send('collect.post_metrics', { workspaceId: W1 });
    const md1 = (await esperaCorrida(h, 1)) as { snapshots: number; capturedAt: string };
    assert.equal(md1.snapshots, 3);
    assert.equal(md1.capturedAt, DIA_1.toISOString(), 'el reloj es ctx.now(), no Date.now()');

    reloj = DIA_2;
    await h.worker.boss.send('collect.post_metrics', { workspaceId: W1 });
    const md2 = (await esperaCorrida(h, 2)) as { snapshots: number };
    assert.equal(md2.snapshots, 3);

    const filas = await h.db.query<{ external_post_id: string; captured_at: Date; age_hours: string; views: string | null; likes: string | null; comments: string | null; source: string; total_interactions: string | null }>(
      `SELECT p.external_post_id, s.captured_at, s.age_hours::text, s.views::text, s.likes::text, s.comments::text, s.source, s.total_interactions::text
         FROM post_metric_snapshot s JOIN post p ON p.id = s.post_id
        ORDER BY p.external_post_id, s.captured_at`,
    );
    assert.equal(filas.rows.length, 6, 'dos lecturas por post: la tabla es append-only');
    for (const f of filas.rows) assert.equal(f.source, 'api');

    // age_hours con el reloj falso: del 1-sep 15:00 al 23-sep 05:00 son
    // 22 días menos 10 horas = 518 h exactas.
    const uno = filas.rows.filter((f) => f.external_post_id === 'vid00000001');
    assert.equal(uno[0]!.age_hours, '518.00');
    assert.equal(uno[1]!.age_hours, '542.00', 'un día después, 24 h más');
    assert.equal(uno[0]!.views, '90001');
    assert.equal(uno[1]!.views, '95001');

    // El tercero no trae commentCount: comentarios cerrados son null.
    const tres = filas.rows.filter((f) => f.external_post_id === 'vid00000003');
    assert.equal(tres[0]!.comments, null, 'una celda sin dato nunca es un cero');
    assert.equal(tres[0]!.likes, '301');
    assert.equal(tres[0]!.total_interactions, '301', 'con solo «me gusta», el total es ese');

    const delta = await h.db.query<{ external_post_id: string; day: string; views_gained: string | null; views_cumulative: string }>(
      `SELECT p.external_post_id, d.day::text AS day, d.views_gained::text, d.views_cumulative::text
         FROM post_metrics_daily_delta d JOIN post p ON p.id = d.post_id
        ORDER BY p.external_post_id, d.day`,
    );
    assert.equal(delta.rows.length, 6);
    const d1 = delta.rows.find((d) => d.external_post_id === 'vid00000001' && d.day === '2026-09-23')!;
    const d2 = delta.rows.find((d) => d.external_post_id === 'vid00000001' && d.day === '2026-09-24')!;
    assert.equal(d1.views_gained, null, 'el primer día no tiene con qué compararse');
    assert.equal(d2.views_gained, '5000', 'el crecimiento del día');
    assert.equal(d2.views_cumulative, '95001');

    // La vista de «última lectura» se queda con la más reciente.
    const latest = await h.db.query<{ views: string }>(
      `SELECT m.views::text FROM post_metrics_latest m JOIN post p ON p.id = m.post_id WHERE p.external_post_id = 'vid00000001'`,
    );
    assert.equal(latest.rows[0]!.views, '95001');

    const raw = { query: (t: string, p?: readonly unknown[]) => h.db.raw.query(t, p as unknown[]) };
    assert.equal(findSecretInDump(await dumpTextColumns(raw, 'public'), [ENV.GOOGLE_API_KEY, ENV.INSTAGRAM_HOUSE_TOKEN]), null, 'ni en raw ni en metadata');
    assert.ok(!h.sink.text().includes(ENV.GOOGLE_API_KEY));
    assert.equal(guard.attempts, 0);
  } finally {
    await h.stop();
  }
});

// ---------------------------------------------------------------------
// Hasta cuándo se mide, y qué pasa con lo borrado
// ---------------------------------------------------------------------

test('lo viejo deja de medirse salvo campaña abierta, y lo que la plataforma ya no devuelve se marca borrado', async () => {
  const AHORA = new Date('2026-11-01T05:00:00Z');
  const fetch = new FixtureFetch(await loadFixtures('youtube', [['videos.list', 'crecimiento']]));
  let conn = '';
  const h = await startHarness({
    jobs: allJobs, now: () => AHORA, env: ENV, http: { fetch: fetch.fetch },
    seed: async (db) => {
      await db.raw.exec(`
        INSERT INTO workspace (id, slug, name) VALUES ('${W1}', 'laura', 'Laura');
        INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${C1}', '${W1}', 'Laura');
      `);
      conn = await altaYouTube(db, W1, C1);
      // Reciente: se mide.
      await altaPost(db, W1, C1, conn, 'vid00000001', '2026-10-25T15:00:00Z');
      // Viejo y sin campaña: 1 464 h, por encima del tope de 888.
      await altaPost(db, W1, C1, conn, 'vid00000002', '2026-09-02T15:00:00Z');
      // Viejo pero en una campaña que sigue midiéndose: se mide.
      const enCampana = await altaPost(db, W1, C1, conn, 'vid00000003', '2026-09-03T15:00:00Z');
      // Viejo, en una campaña abierta pero que terminó hace más de 30
      // días: la cola de CAM-5 ya pasó y deja de medirse.
      const colaVencida = await altaPost(db, W1, C1, conn, 'vid00000004', '2026-09-04T15:00:00Z');
      // Reciente pero la plataforma ya no lo devuelve: borrado.
      await altaPost(db, W1, C1, conn, 'vid00000099', '2026-10-26T15:00:00Z');
      const marca = await db.raw.query<{ id: string }>(`INSERT INTO company (name) VALUES ('Nutrivé') RETURNING id`);
      const alta = async (nombre: string, status: string, endsOn: string, post: string) => {
        const camp = await db.raw.query<{ id: string }>(
          `INSERT INTO campaign (workspace_id, creator_id, company_id, name, status, ends_on)
           VALUES ($1, $2, $3, $4, $5, $6::date) RETURNING id`,
          [W1, C1, marca.rows[0]!.id, nombre, status, endsOn],
        );
        await db.raw.query(`INSERT INTO campaign_post (campaign_id, post_id) VALUES ($1, $2)`, [camp.rows[0]!.id, post]);
      };
      await alta('Campaña de octubre', 'measuring', '2026-10-20', enCampana);
      await alta('Campaña de septiembre', 'live', '2026-09-15', colaVencida);
    },
  });
  try {
    await h.worker.boss.send('collect.post_metrics', { workspaceId: W1 });
    const md = (await esperaCorrida(h, 1)) as { snapshots: number; viejos: number; borrados: string[]; candidatos: number };
    // El de septiembre sin campaña ni siquiera llega a candidato: lo
    // descarta el corte grueso de la consulta, que es donde es barato.
    assert.equal(md.candidatos, 4);
    // El que sí llega y se cae por la regla de @mc/core es el de la
    // campaña cuya cola de 30 días ya pasó.
    assert.equal(md.viejos, 1);
    assert.equal(md.snapshots, 2);
    assert.deepEqual(md.borrados, ['vid00000099']);

    const medidos = await h.db.query<{ external_post_id: string }>(
      `SELECT p.external_post_id FROM post_metric_snapshot s JOIN post p ON p.id = s.post_id ORDER BY 1`,
    );
    assert.deepEqual(medidos.rows.map((r) => r.external_post_id), ['vid00000001', 'vid00000003']);

    const borrado = await h.db.query<{ external_post_id: string; deleted_on_platform: boolean }>(
      `SELECT external_post_id, deleted_on_platform FROM post ORDER BY 1`,
    );
    const porId = new Map(borrado.rows.map((r) => [r.external_post_id, r.deleted_on_platform]));
    assert.equal(porId.get('vid00000099'), true);
    assert.equal(porId.get('vid00000001'), false);
    assert.equal(porId.get('vid00000002'), false, 'dejar de medirlo no es borrarlo');
    assert.equal(porId.get('vid00000004'), false);
  } finally {
    await h.stop();
  }
});

// ---------------------------------------------------------------------
// El token del dueño rechazado
// ---------------------------------------------------------------------

test('un token rechazado deja la cuenta en needs_reauth con su notificación, y no se pierde nada en silencio', async () => {
  const AHORA = new Date('2026-09-23T05:00:00Z');
  const fetch = new FixtureFetch(await loadFixtures('tiktok', [['video.query', 'invalid_token']]));
  const TOKENS = { accessToken: 'act.token-del-creador-SECRETO', refreshToken: 'rft.refresh-SECRETO', accessExpiresAt: new Date('2026-09-30T00:00:00Z'), scopes: ['video.list'] };
  let conn = '';
  const h = await startHarness({
    jobs: allJobs, now: () => AHORA, env: ENV, http: { fetch: fetch.fetch },
    seed: async (db) => {
      await db.raw.exec(`
        INSERT INTO workspace (id, slug, name) VALUES ('${W1}', 'laura', 'Laura');
        INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${C1}', '${W1}', 'Laura');
      `);
      const r = await db.raw.query<{ id: string }>(
        `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_mode, access_expires_at)
         VALUES ($1, $2, 'tiktok', 'open_id_laura', 'laura.cocinafacil', 'vault:tt', '{video.list}', 'direct_oauth', '2026-09-30T00:00:00Z') RETURNING id`,
        [W1, C1],
      );
      conn = r.rows[0]!.id;
      await db.raw.query(
        `INSERT INTO post (workspace_id, creator_id, connection_id, platform_id, external_post_id, media_type, published_at)
         VALUES ($1, $2, $3, 'tiktok', '7400000000000000d01', 'video', '2026-09-20T15:00:00Z')`,
        [W1, C1, conn],
      );
    },
  });
  try {
    await h.secrets.set('vault:tt', TOKENS);
    await h.worker.boss.send('collect.post_metrics', { workspaceId: W1 });
    const runs = await waitFor(async () => (await jobRuns(h.db, 'collect.post_metrics')).find((r) => r.status !== 'running'), { label: '401', timeoutMs: 30_000 });
    const md = runs.metadata as { errores: string[]; snapshots: number };
    assert.deepEqual(md.errores, [conn], 'el fallo se cuenta: nada en silencio');
    assert.equal(md.snapshots, 0);

    const cuenta = await h.db.query<{ status: string; status_detail: string | null; consecutive_failures: number }>(
      'SELECT status, status_detail, consecutive_failures FROM social_connection WHERE id = $1', [conn],
    );
    assert.equal(cuenta.rows[0]!.status, 'needs_reauth');
    assert.ok((cuenta.rows[0]!.status_detail ?? '').length > 0);
    assert.equal(cuenta.rows[0]!.consecutive_failures, 1);

    const aviso = await h.db.query<{ kind: string; severity: string; title_es: string; action_url: string; entity_id: string }>(
      'SELECT kind, severity, title_es, action_url, entity_id FROM notification', [],
    );
    assert.equal(aviso.rows.length, 1);
    assert.equal(aviso.rows[0]!.kind, 'connection_error');
    assert.equal(aviso.rows[0]!.severity, 'critical');
    assert.match(aviso.rows[0]!.title_es, /Vuelve a conectar tu cuenta de TikTok/);
    assert.equal(aviso.rows[0]!.action_url, '/conexiones');
    assert.equal(aviso.rows[0]!.entity_id, conn);

    const raw = { query: (t: string, p?: readonly unknown[]) => h.db.raw.query(t, p as unknown[]) };
    assert.equal(findSecretInDump(await dumpTextColumns(raw, 'public'), [TOKENS.accessToken, TOKENS.refreshToken]), null);
    assert.ok(!h.sink.text().includes(TOKENS.accessToken));
  } finally {
    await h.stop();
  }
});
