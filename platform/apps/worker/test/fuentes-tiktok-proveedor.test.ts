/**
 * CON-C · costura CON-12 ↔ CON-5/CON-10: la MISMA cuenta de TikTok leída
 * por oEmbed (sin ENSEMBLEDATA_TOKEN) y por el proveedor de pago (con
 * él), encendiendo y apagando la variable entre corridas sobre la misma
 * base. Lo que se demuestra:
 *
 *   - sin la variable, TikTok sigue como en CON-10: identidad sin cifras
 *     y collect.posts la anota «sin fuente de publicaciones», sin fallar;
 *   - con la variable, collect.account_metrics convierte la fila a
 *     'aggregator' conservando su id, y collect.posts SÍ la lee (antes
 *     del cierre se quedaba fuera: su SELECT solo miraba public_profile
 *     y direct_oauth);
 *   - leer dos veces, apagar el proveedor y volver a encenderlo no
 *     duplica ni la cuenta ni un solo post, y no borra ninguno.
 *
 * El env del arnés es el mismo objeto que ve cada corrida (ctx.env), así
 * que cambiarlo entre corridas es contratar o dar de baja el proveedor.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { FixtureFetch, loadFixtures, withoutNetwork, type Fixture, type NetworkGuard } from '@mc/connectors';
import { allJobs } from '../src/jobs/index.ts';
import { jobRuns, startHarness, waitFor, withoutChaining, type Harness } from './helpers/harness.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';

const AHORA = new Date('2026-09-23T06:00:00Z');
const W = '0000000c-0000-4000-8000-000000000001';
const C = '0000000c-0000-4000-8000-000000000011';
const ED_TOKEN = 'ed-token-costura-SECRETO';
const HANDLE = 'laura.cocinafacil';

let h: Harness;
let guard: NetworkGuard;
let tt: string;
const env: Record<string, string | undefined> = {};

async function seed(db: PgliteDatabase): Promise<void> {
  await db.raw.exec(`
    INSERT INTO workspace (id, slug, name) VALUES ('${W}', 'laura-cc', 'Laura');
    INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${C}', '${W}', 'Laura');
  `);
  const r = await db.raw.query<{ id: string }>(
    `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_mode)
     VALUES ($1, $2, 'tiktok', $3, $3, $4, '{}', 'public_profile') RETURNING id`,
    [W, C, HANDLE, `public:tiktok:${HANDLE}`],
  );
  tt = r.rows[0]!.id;
}

before(async () => {
  guard = withoutNetwork();
  // El proveedor responde en la misma URL para cualquier @: se acota por username.
  const porUsuario = (f: Fixture): Fixture => ({ ...f, request: { ...f.request, urlPattern: `${f.request.urlPattern}(?=.*username=laura\\.cocinafacil(&|$))` } });
  const [info, posts] = await loadFixtures('ensembledata', [['user.info', 'ok'], ['user.posts', 'ok']]);
  const fetch = new FixtureFetch([porUsuario(info!), porUsuario(posts!), ...(await loadFixtures('tiktok', [['oembed.profile', 'ok']]))]);
  // Sin encadenar: aquí se cuentan corridas de collect.*, no las de compute.* (esa cadena es de costuras-con.test.ts).
  h = await startHarness({ jobs: withoutChaining(allJobs), now: () => AHORA, seed, env, http: { fetch: fetch.fetch } });
});
after(async () => { await h.stop(); guard.restore(); });

/** Encola el job y devuelve la metadata de su corrida número n (las corridas de cada job se cuentan desde 1). */
async function corre(job: 'collect.account_metrics' | 'collect.posts', n: number): Promise<Record<string, unknown>> {
  await h.worker.boss.send(job, { workspaceId: W });
  const runs = await waitFor(async () => {
    const hechas = (await jobRuns(h.db, job)).filter((r) => r.status !== 'running');
    return hechas.length >= n ? hechas : null;
  }, { label: `${job} #${n}`, timeoutMs: 30_000 });
  const run = runs[n - 1]!;
  assert.equal(run.status, 'ok', run.error ?? '');
  return run.metadata;
}

async function estado(): Promise<{ filas: number; accessMode: string; posts: number; distintos: number; deOtraConexion: number }> {
  const c = await h.db.query<{ n: number; access_mode: string }>(
    `SELECT count(*) OVER ()::int AS n, access_mode FROM social_connection WHERE workspace_id = $1 AND platform_id = 'tiktok' AND deleted_at IS NULL`, [W]);
  const p = await h.db.query<{ n: number; distintos: number; otra: number }>(
    `SELECT count(*)::int AS n, count(DISTINCT external_post_id)::int AS distintos, count(*) FILTER (WHERE connection_id <> $2)::int AS otra
       FROM post WHERE workspace_id = $1 AND platform_id = 'tiktok'`, [W, tt]);
  return { filas: c.rows[0]!.n, accessMode: c.rows[0]!.access_mode, posts: p.rows[0]!.n, distintos: p.rows[0]!.distintos, deOtraConexion: p.rows[0]!.otra };
}

test('sin ENSEMBLEDATA_TOKEN: oEmbed confirma la cuenta, sin cifras ni publicaciones, y nada falla', async () => {
  const cuentas = (await corre('collect.account_metrics', 1)) as { noMetrics: string[] };
  assert.deepEqual(cuentas.noMetrics, [tt]);
  const posts = (await corre('collect.posts', 1)) as { sinFuenteDePosts: string[]; nuevos: number };
  assert.deepEqual(posts.sinFuenteDePosts, [tt], 'TikTok por @ no lista videos: se anota y no falla');
  assert.equal(posts.nuevos, 0);
  assert.deepEqual(await estado(), { filas: 1, accessMode: 'public_profile', posts: 0, distintos: 0, deOtraConexion: 0 });
});

test('con ENSEMBLEDATA_TOKEN: la misma fila pasa a aggregator y collect.posts lee sus videos', async () => {
  env['ENSEMBLEDATA_TOKEN'] = ED_TOKEN;
  await corre('collect.account_metrics', 2);
  assert.equal((await estado()).accessMode, 'aggregator', 'misma fila, otra fuente');

  const md = (await corre('collect.posts', 2)) as { revisadas: string[]; sinFuenteDePosts: string[]; nuevos: number };
  assert.deepEqual(md.revisadas, [tt], 'una cuenta aggregator entra a collect.posts');
  assert.deepEqual(md.sinFuenteDePosts, []);
  assert.equal(md.nuevos, 3);
  assert.deepEqual(await estado(), { filas: 1, accessMode: 'aggregator', posts: 3, distintos: 3, deOtraConexion: 0 });
});

test('idempotencia: otra lectura, dar de baja el proveedor y volver a contratarlo no duplican ni borran nada', async () => {
  const otra = (await corre('collect.posts', 3)) as { nuevos: number };
  assert.equal(otra.nuevos, 0, 'la segunda lectura del proveedor no crea posts');
  assert.equal((await estado()).posts, 3);

  delete env['ENSEMBLEDATA_TOKEN'];
  await corre('collect.account_metrics', 3);
  const baja = (await corre('collect.posts', 4)) as { sinFuenteDePosts: string[] };
  assert.deepEqual(baja.sinFuenteDePosts, [tt], 'sin el proveedor vuelve a oEmbed, que no lista videos');
  assert.deepEqual(await estado(), { filas: 1, accessMode: 'public_profile', posts: 3, distintos: 3, deOtraConexion: 0 }, 'los posts ya leídos se quedan');

  env['ENSEMBLEDATA_TOKEN'] = ED_TOKEN;
  await corre('collect.account_metrics', 4);
  const vuelta = (await corre('collect.posts', 5)) as { nuevos: number };
  assert.equal(vuelta.nuevos, 0, 'recontratar no vuelve a crear los mismos videos');
  assert.deepEqual(await estado(), { filas: 1, accessMode: 'aggregator', posts: 3, distintos: 3, deOtraConexion: 0 });

  const fuentes = await h.db.query<{ source: string; n: number }>(
    `SELECT source, count(*)::int AS n FROM account_metric_snapshot WHERE connection_id = $1 GROUP BY source ORDER BY source`, [tt]);
  assert.deepEqual(fuentes.rows.map((r) => [r.source, r.n]), [['aggregator', 1]], 'un snapshot por (cuenta, día, fuente): la segunda lectura del día no duplica');
  assert.equal(guard.attempts, 0);
});
