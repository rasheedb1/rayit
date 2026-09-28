/**
 * CON-5 · collect.posts sobre pglite con las migraciones y los seeds
 * reales. Lo que se demuestra: que un post no se duplica, que
 * first_seen_at es de la primera vez que lo vimos, que un video que
 * entró por el archivo de TikTok Studio se FUSIONA en vez de
 * duplicarse, que un payload con workspaceId toca un solo workspace, y
 * que una cuenta sin fuente de publicaciones queda anotada sin fallar.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { dumpTextColumns, findSecretInDump, FixtureFetch, loadFixtures, withoutNetwork, type NetworkGuard } from '@mc/connectors';
import { allJobs } from '../src/jobs/index.ts';
import { jobRuns, startHarness, waitFor, type Harness } from './helpers/harness.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';

const AHORA = new Date('2026-09-23T06:00:00Z');
const W1 = '00000005-0000-4000-8000-000000000001';
const W2 = '00000005-0000-4000-8000-000000000002';
const C1 = '00000005-0000-4000-8000-000000000011';
const C2 = '00000005-0000-4000-8000-000000000012';
const ENV = { INSTAGRAM_HOUSE_TOKEN: 'IGAA-casa-posts-SECRETO', GOOGLE_API_KEY: 'AIza-posts-SECRETO' };
/** El video que ya entró por el archivo de TikTok Studio sobre la MISMA cuenta de Instagram. */
const DEL_CSV = '1800000000000000b02';

let h: Harness;
let guard: NetworkGuard;
let fetch: FixtureFetch;
let ids: { yt: string; ig: string; tt: string; ytOtro: string };

async function altaCuenta(db: PgliteDatabase, workspace: string, creador: string, platform: string, handle: string, ext: string): Promise<string> {
  const r = await db.raw.query<{ id: string }>(
    `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_mode)
     VALUES ($1, $2, $3, $4, $5, $6, '{}', 'public_profile') RETURNING id`,
    [workspace, creador, platform, ext, handle, `public:${platform}:${handle}`],
  );
  return r.rows[0]!.id;
}

async function seed(db: PgliteDatabase): Promise<void> {
  await db.raw.exec(`
    INSERT INTO workspace (id, slug, name) VALUES ('${W1}', 'laura', 'Laura'), ('${W2}', 'otro', 'Otro');
    INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${C1}', '${W1}', 'Laura'), ('${C2}', '${W2}', 'Otro');
  `);
  ids = {
    yt: await altaCuenta(db, W1, C1, 'youtube', 'NutriveOficial', 'UCnutrive00000000000000e4'),
    ig: await altaCuenta(db, W1, C1, 'instagram', 'cafealma', '17841400000000e01'),
    tt: await altaCuenta(db, W1, C1, 'tiktok', 'selvathegolden', 'selvathegolden'),
    ytOtro: await altaCuenta(db, W2, C2, 'youtube', 'NutriveOficial', 'UCnutrive00000000000000e4'),
  };
  // El video que ya existía por el archivo de TikTok Studio, con su
  // lectura. La API lo va a encontrar con el mismo external_post_id.
  await db.raw.query(
    `INSERT INTO post (workspace_id, creator_id, connection_id, platform_id, external_post_id, title, media_type, published_at, first_seen_at)
     VALUES ($1, $2, $3, 'instagram', $4, 'Título que puso el archivo', 'video', '2026-09-18T14:30:00Z', '2026-09-19T08:00:00Z')`,
    [W1, C1, ids.ig, DEL_CSV],
  );
  await db.raw.query(
    `INSERT INTO post_metric_snapshot (post_id, workspace_id, captured_at, age_hours, views, source)
     SELECT id, $1, '2026-09-19T08:00:00Z', 17.5, 1200, 'csv_import' FROM post WHERE external_post_id = $2 AND workspace_id = $1`,
    [W1, DEL_CSV],
  );
}

before(async () => {
  guard = withoutNetwork();
  fetch = new FixtureFetch([
    ...(await loadFixtures('youtube', [['channels.list', 'handle.uploads.ok'], ['playlist_items.list', 'uploads.ok'], ['videos.list', 'canal.ok']])),
    ...(await loadFixtures('instagram', [['business_discovery.media', 'ok']])),
  ]);
  h = await startHarness({ jobs: allJobs, now: () => AHORA, seed, env: ENV, http: { fetch: fetch.fetch } });
});
after(async () => { await h.stop(); guard.restore(); });

async function corre(n: number): Promise<Record<string, unknown>> {
  await h.worker.boss.send('collect.posts', { workspaceId: W1 });
  const runs = await waitFor(async () => {
    const todos = (await jobRuns(h.db, 'collect.posts')).filter((r) => r.status !== 'running');
    return todos.length >= n ? todos : null;
  }, { label: `collect.posts #${n}`, timeoutMs: 30_000 });
  const run = runs[n - 1]!;
  assert.equal(run.status, 'ok', run.error ?? '');
  return run.metadata;
}

test('primera corrida: descubre los videos de YouTube y los medios de Instagram, y no toca el otro workspace', async () => {
  const md = (await corre(1)) as { nuevos: number; revisadas: string[]; sinFuenteDePosts: string[]; sinConfigurar: Record<string, string> };
  assert.deepEqual(md.sinConfigurar, {});
  assert.deepEqual([...md.revisadas].sort(), [ids.yt, ids.ig].sort());
  assert.deepEqual(md.sinFuenteDePosts, [ids.tt], 'TikTok por @ no lista videos y no falla');

  const posts = await h.db.query<{ workspace_id: string; connection_id: string; platform_id: string; external_post_id: string; media_type: string; surface: string | null; title: string | null; duration_s: string | null; published_at: Date | string }>(
    `SELECT workspace_id, connection_id, platform_id, external_post_id, media_type, surface, title, duration_s, published_at FROM post ORDER BY platform_id, external_post_id`,
  );
  // Tres videos de YouTube + tres medios de Instagram; el del archivo
  // ya estaba y no se duplica, así que Instagram sigue en tres.
  assert.equal(posts.rows.length, 6);
  assert.equal(posts.rows.filter((p) => p.workspace_id === W2).length, 0, 'el payload traía workspaceId: el otro workspace no se tocó');
  assert.equal(md.nuevos, 5, 'el del archivo ya existía');

  const yt = posts.rows.filter((p) => p.platform_id === 'youtube');
  assert.deepEqual(yt.map((p) => p.external_post_id), ['vid00000001', 'vid00000002', 'vid00000003']);
  assert.equal(yt[0]!.title, 'Receta 1 en 10 minutos');
  assert.equal(Number(yt[0]!.duration_s), 73);

  const ig = posts.rows.filter((p) => p.platform_id === 'instagram');
  assert.equal(ig.length, 3);
  const reel = ig.find((p) => p.external_post_id === '1800000000000000b01')!;
  assert.equal(reel.media_type, 'video');
  assert.equal(reel.surface, 'reels');
  const carrusel = ig.find((p) => p.external_post_id === '1800000000000000b03')!;
  assert.equal(carrusel.media_type, 'carousel');
});

test('el video del archivo de TikTok Studio se fusiona: la API manda en identidad y el archivo conserva lo suyo', async () => {
  const { rows } = await h.db.query<{ n: number; title: string; permalink: string | null; caption: string | null; first_seen_at: Date | string; media_type: string; lecturas: number }>(
    `SELECT count(*) OVER ()::int AS n, p.title, p.permalink, p.caption, p.first_seen_at, p.media_type,
            (SELECT count(*)::int FROM post_metric_snapshot s WHERE s.post_id = p.id AND s.source = 'csv_import') AS lecturas
       FROM post p WHERE p.external_post_id = $1`,
    [DEL_CSV],
  );
  assert.equal(rows.length, 1, 'un solo post: la clave natural es (plataforma, id externo, conexión)');
  const p = rows[0]!;
  assert.equal(p.title, 'Título que puso el archivo', 'la API no trajo título: no borra el del archivo');
  assert.equal(p.permalink, 'https://www.instagram.com/p/demo-b02/', 'lo que sí trae la API, manda');
  assert.match(p.caption!, /grano de la semana/);
  assert.equal(p.media_type, 'image', 'la API corrige el tipo que había puesto el archivo');
  assert.equal(new Date(p.first_seen_at).toISOString(), '2026-09-19T08:00:00.000Z', 'first_seen_at es la primera vez que lo vimos nosotros');
  assert.equal(p.lecturas, 1, 'la lectura del archivo sigue ahí: post_metric_snapshot es append-only');
});

test('segunda corrida: ni un post nuevo, ni un first_seen_at movido, y no se vuelve a pedir la lista de videos', async () => {
  const antes = await h.db.query<{ id: string; first_seen_at: Date | string; updated_at: Date | string }>('SELECT id, first_seen_at, updated_at FROM post ORDER BY id');
  const llamadasAntes = fetch.calls.length;

  const md = (await corre(2)) as { nuevos: number; revisadas: string[] };
  assert.equal(md.nuevos, 0);
  assert.deepEqual([...md.revisadas].sort(), [ids.yt, ids.ig].sort());

  const despues = await h.db.query<{ id: string; first_seen_at: Date | string }>('SELECT id, first_seen_at FROM post ORDER BY id');
  assert.equal(despues.rows.length, antes.rows.length, 'ni un post duplicado');
  assert.deepEqual(
    despues.rows.map((r) => new Date(r.first_seen_at).toISOString()),
    antes.rows.map((r) => new Date(r.first_seen_at).toISOString()),
    'first_seen_at no se mueve nunca',
  );

  // Una sola página por cuenta: la primera ya trae publicaciones
  // conocidas, así que no se pide una segunda. La página sí se vuelve a
  // describir entera, que es lo que refresca títulos y portadas.
  const nuevas = fetch.calls.slice(llamadasAntes).map((c) => new URL(c.url).pathname);
  assert.equal(nuevas.filter((p) => p.endsWith('/channels')).length, 1);
  assert.equal(nuevas.filter((p) => p.endsWith('/playlistItems')).length, 1, 'ni una página más de la lista de subidas');
  assert.equal(nuevas.filter((p) => p.endsWith('/videos')).length, 1);
  assert.equal(nuevas.filter((p) => p.endsWith('/me')).length, 1, 'Instagram: una sola llamada al token de la casa');
});

test('la cuenta de TikTok queda anotada con la razón, activa y sin error', async () => {
  const { rows } = await h.db.query<{ status: string; status_detail: string | null; consecutive_failures: number; last_synced_at: Date | null }>(
    'SELECT status, status_detail, consecutive_failures, last_synced_at FROM social_connection WHERE id = $1',
    [ids.tt],
  );
  assert.equal(rows[0]!.status, 'active');
  assert.match(rows[0]!.status_detail!, /archivo de TikTok Studio/);
  assert.equal(rows[0]!.consecutive_failures, 0);
  assert.equal(rows[0]!.last_synced_at, null, 'descubrir no es medir: la frescura de la serie de cuenta no se toca');
});

test('ni el token de la casa ni la API key aparecen en la base ni en el log', async () => {
  const raw = { query: (text: string, params?: readonly unknown[]) => h.db.raw.query(text, params as unknown[]) };
  const dump = await dumpTextColumns(raw, 'public');
  assert.equal(findSecretInDump(dump, [ENV.INSTAGRAM_HOUSE_TOKEN, ENV.GOOGLE_API_KEY]), null);
  const texto = h.sink.text();
  for (const s of [ENV.INSTAGRAM_HOUSE_TOKEN, ENV.GOOGLE_API_KEY]) assert.ok(!texto.includes(s));
  assert.equal(guard.attempts, 0, 'ninguna prueba salió a la red');
});
