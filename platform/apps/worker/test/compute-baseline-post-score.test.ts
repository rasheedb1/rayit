/**
 * CON-6 · compute.baseline y compute.post_score sobre Postgres embebido
 * con las migraciones reales, corriendo como mc_worker.
 *
 * El escenario, con el reloj fijo en NOW:
 *
 *   Workspace A · Laura
 *     tiktok     ocho videos de 50 000 views a las 168 h y uno de
 *                100 000: el doble de la mediana → outlier.
 *                Más uno de tres días, que se puntúa a 72 h y no a 720.
 *     instagram  siete videos: con menos de ocho, is_reliable = false y
 *                ningún múltiplo inventado.
 *   Workspace B · Mateo
 *     tiktok     nueve videos de 1 000 views y uno de 2 200 (2,2×) que
 *                más tarde sube a 5 500 (5,5×): sube de nivel y avisa
 *                una segunda vez, sin repetir la primera.
 *
 * Las cifras de A y las de B se llevan por cincuenta: si se cruzaran los
 * workspaces, ninguna de las dos medianas saldría.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { findSecretInDump } from '@mc/connectors';
import { AGE_CUTS_HOURS, MIN_SAMPLE_FOR_BASELINE } from '@mc/core';
import { debeAvisar, scoreFrom } from '../src/jobs/conexiones/compute-post-score.ts';
import { allJobs } from '../src/jobs/index.ts';
import { jobRuns, startHarness, waitFor, type Harness, type JobRunRow } from './helpers/harness.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';

const NOW = new Date('2026-09-23T05:40:00Z');
/** El reloj del worker. Avanza entre corridas: dos líneas base del mismo día se distinguen por computed_at. */
let reloj = NOW;

const WS_A = '00000006-0000-4000-8000-00000000000a';
const WS_B = '00000006-0000-4000-8000-00000000000b';
const LAURA = '00000006-0000-4000-8000-0000000000a1';
const MATEO = '00000006-0000-4000-8000-0000000000b1';
/** Una referencia de secreto con marca, para comprobar que no se filtra a nada de lo que escribe CON-6. */
const SECRET_REF = 'vault:con6-NO-DEBE-APARECER';

const post = (n: string) => `00000006-0000-4000-8000-0000000${n}`;
const A_OUT = post('0a001');
const A_72 = post('0a002');
const B_BREAK = post('0b001');
const B_VIEJO = post('0b002');
const A_NORMALES = Array.from({ length: 8 }, (_, i) => post(`0a1${String(i).padStart(2, '0')}`));
const A_INSTA = Array.from({ length: 7 }, (_, i) => post(`0a2${String(i).padStart(2, '0')}`));
const B_NORMALES = Array.from({ length: 9 }, (_, i) => post(`0b1${String(i).padStart(2, '0')}`));

const HORA_MS = 3_600_000;
/** Lecturas de un video: edad en horas → views a esa edad. */
type Curva = Array<[number, number]>;

let h: Harness;
let conexiones: Record<string, string>;

/** Un video del escenario: el post y su curva de lecturas. */
interface Video {
  id: string;
  workspaceId: string;
  creatorId: string;
  platform: string;
  horasDesdePublicacion: number;
  curva: Curva;
  titulo: string;
}

const sql = (v: string) => `'${v.replaceAll("'", "''")}'`;

/**
 * Siembra todos los videos en dos sentencias. Una por fila dejaba el
 * arranque de la prueba en dos minutos: pglite paga el viaje y los
 * disparadores de 0025 en cada INSERT.
 */
async function sembrarVideos(db: PgliteDatabase, videos: readonly Video[]): Promise<void> {
  const posts: string[] = [];
  const lecturas: string[] = [];
  for (const v of videos) {
    const publishedAt = new Date(NOW.getTime() - v.horasDesdePublicacion * HORA_MS);
    const conexion = conexiones[`${v.workspaceId}:${v.platform}`]!;
    posts.push(
      `(${sql(v.id)}, ${sql(v.workspaceId)}, ${sql(v.creatorId)}, ${sql(conexion)}, ${sql(v.platform)}, ` +
        `${sql(`ext-${v.id}`)}, ${sql(`https://example.test/${v.id}`)}, 'video', 'feed', ${sql(v.titulo)}, ${sql(publishedAt.toISOString())})`,
    );
    for (const [edad, views] of v.curva) {
      // Las demás cifras salen de las views con proporciones fijas: lo que se
      // prueba es la mediana y el múltiplo, no la aritmética de la plataforma.
      const reach = Math.round(views * 0.7);
      const likes = Math.round(views * 0.05);
      const comments = Math.round(views * 0.002);
      const shares = Math.round(views * 0.006);
      const saves = Math.round(views * 0.008);
      const capturedAt = new Date(publishedAt.getTime() + edad * HORA_MS);
      lecturas.push(
        `(${sql(v.id)}, ${sql(v.workspaceId)}, ${sql(capturedAt.toISOString())}, ${edad}, ${views}, ${reach}, ` +
          `${likes}, ${comments}, ${shares}, ${saves}, ${likes + comments + shares + saves}, 0.42, 0.21, 'api')`,
      );
    }
  }
  await db.raw.exec(
    `INSERT INTO post (id, workspace_id, creator_id, connection_id, platform_id, external_post_id, url, media_type, surface, title, published_at)
     VALUES ${posts.join(', ')};
     INSERT INTO post_metric_snapshot (post_id, workspace_id, captured_at, age_hours, views, reach, likes, comments, shares, saves, total_interactions, completion_rate, skip_rate_3s, source)
     VALUES ${lecturas.join(', ')};`,
  );
}

async function seed(db: PgliteDatabase): Promise<void> {
  await db.raw.exec(`
    INSERT INTO workspace (id, slug, name) VALUES ('${WS_A}', 'laura-con6', 'Laura'), ('${WS_B}', 'mateo-con6', 'Mateo');
    INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${LAURA}', '${WS_A}', 'Laura'), ('${MATEO}', '${WS_B}', 'Mateo');
  `);
  conexiones = {};
  for (const [ws, creator, platform] of [
    [WS_A, LAURA, 'tiktok'],
    [WS_A, LAURA, 'instagram'],
    [WS_B, MATEO, 'tiktok'],
  ] as const) {
    const r = await db.raw.query<{ id: string }>(
      `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes)
       VALUES ($1, $2, $3, $4, $5, $6, '{}') RETURNING id`,
      [ws, creator, platform, `cuenta-${ws}-${platform}`, `creador.${platform}`, SECRET_REF],
    );
    conexiones[`${ws}:${platform}`] = r.rows[0]!.id;
  }

  await sembrarVideos(db, [
    // A · tiktok: ocho videos iguales a 50 000 (la mediana no se mueve aunque
    // cambie el outlier: la prueba dice lo que quiere decir) y uno del doble.
    ...A_NORMALES.map((id, i) => ({
      id, workspaceId: WS_A, creatorId: LAURA, platform: 'tiktok',
      horasDesdePublicacion: 240 + i * 24,
      curva: [[24, 20_000], [72, 35_000], [168, 50_000]] as Curva,
      titulo: `Arepas de la abuela, parte ${i + 1}`,
    })),
    {
      id: A_OUT, workspaceId: WS_A, creatorId: LAURA, platform: 'tiktok',
      horasDesdePublicacion: 18 * 24,
      curva: [[24, 40_000], [72, 70_000], [168, 100_000]],
      titulo: 'El error que todos cometemos con el arroz',
    },
    // Tres días y una hora: su corte es 72, no 720.
    {
      id: A_72, workspaceId: WS_A, creatorId: LAURA, platform: 'tiktok',
      horasDesdePublicacion: 73,
      curva: [[24, 8_000], [72, 15_000]],
      titulo: 'Almuerzo en diez minutos',
    },
    // A · instagram: siete videos. Uno menos que MIN_SAMPLE_FOR_BASELINE.
    ...A_INSTA.map((id, i) => ({
      id, workspaceId: WS_A, creatorId: LAURA, platform: 'instagram',
      horasDesdePublicacion: 240 + i * 24,
      curva: [[24, 12_000], [72, 22_000], [168, 30_000]] as Curva,
      titulo: `Reel de la semana ${i + 1}`,
    })),
    // B · tiktok: otra escala por completo. Nueve videos de 1 000 y uno de 2 200.
    ...B_NORMALES.map((id, i) => ({
      id, workspaceId: WS_B, creatorId: MATEO, platform: 'tiktok',
      horasDesdePublicacion: 240 + i * 24,
      curva: [[24, 400], [72, 700], [168, 1_000]] as Curva,
      titulo: `Rutina de gimnasio ${i + 1}`,
    })),
    // Recolección interrumpida: 31 días de edad y la última lectura es la
    // de las 60 h. Se puntúa en el corte que SÍ midió, no a los 30 días.
    {
      id: B_VIEJO, workspaceId: WS_B, creatorId: MATEO, platform: 'tiktok',
      horasDesdePublicacion: 31 * 24,
      curva: [[24, 300], [60, 500]],
      titulo: 'Lo que hago antes de entrenar',
    },
    {
      id: B_BREAK, workspaceId: WS_B, creatorId: MATEO, platform: 'tiktok',
      horasDesdePublicacion: 9 * 24,
      // La última lectura es a las 150 h: la recolección sigue y más
      // adelante llega otra dentro del mismo corte de 168.
      curva: [[24, 900], [72, 1_600], [150, 2_200]],
      titulo: 'Se me rompió la barra a mitad de serie',
    },
  ]);
}

/** Encola un job, espera a que termine y devuelve su fila de job_run. */
async function correr(jobId: string): Promise<JobRunRow> {
  const previas = (await jobRuns(h.db, jobId)).length;
  await h.worker.boss.send(jobId, { source: 'test' });
  const run = await waitFor(
    async () => {
      const runs = await jobRuns(h.db, jobId);
      return runs.length > previas ? runs.filter((r) => r.status !== 'running').at(-1) : null;
    },
    { label: jobId, timeoutMs: 30_000 },
  );
  assert.equal(run.status, 'ok', run.error ?? '');
  return run;
}

interface BaselineRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  creator_id: string;
  platform_id: string;
  age_hours_cut: number;
  sample_size: number;
  median_views: string | null;
  p25_views: string | null;
  p75_views: string | null;
  median_engagement: string | null;
  median_saves_per_1k: string | null;
  median_completion: string | null;
  median_skip_3s: string | null;
  is_reliable: boolean;
  computed_at: Date | string;
}

async function lineasBase(where = ''): Promise<BaselineRow[]> {
  const { rows } = await h.db.query<BaselineRow>(
    `SELECT id, workspace_id, creator_id, platform_id, age_hours_cut, sample_size,
            median_views::text AS median_views, p25_views::text AS p25_views, p75_views::text AS p75_views,
            median_engagement::text AS median_engagement, median_saves_per_1k::text AS median_saves_per_1k,
            median_completion::text AS median_completion, median_skip_3s::text AS median_skip_3s,
            is_reliable, computed_at
       FROM creator_baseline ${where}
      ORDER BY workspace_id, platform_id, age_hours_cut, computed_at`,
  );
  return rows;
}

interface ScoreRow extends Record<string, unknown> {
  post_id: string;
  workspace_id: string;
  baseline_id: string | null;
  age_hours_cut: number;
  views_at_cut: string | null;
  views_vs_median: string | null;
  is_outlier: boolean;
  outlier_tier: string | null;
  notified_at: Date | string | null;
}

async function puntaje(postId: string): Promise<ScoreRow | undefined> {
  const { rows } = await h.db.query<ScoreRow>(
    `SELECT post_id, workspace_id, baseline_id, age_hours_cut, views_at_cut::text AS views_at_cut,
            views_vs_median::text AS views_vs_median, is_outlier, outlier_tier, notified_at
       FROM post_score WHERE post_id = $1`,
    [postId],
  );
  return rows[0];
}

interface NotificationRow extends Record<string, unknown> {
  kind: string;
  title_es: string;
  body_es: string | null;
  action_url: string | null;
  severity: string;
}

async function notificaciones(postId: string): Promise<NotificationRow[]> {
  const { rows } = await h.db.query<NotificationRow>(
    `SELECT kind, title_es, body_es, action_url, severity FROM notification
      WHERE entity_type = 'post' AND entity_id = $1 ORDER BY created_at, kind`,
    [postId],
  );
  return rows;
}

before(async () => {
  h = await startHarness({ jobs: allJobs, now: () => reloj, seed });
});
after(async () => {
  await h.stop();
});

test('la vista post_metrics_at_cut mide en los cortes de AGE_CUTS_HOURS', async () => {
  const { rows } = await h.db.query<{ cut_hours: number }>('SELECT DISTINCT cut_hours FROM post_metrics_at_cut ORDER BY 1');
  assert.deepEqual(rows.map((r) => Number(r.cut_hours)), [...AGE_CUTS_HOURS]);
});

test('compute.baseline: la mediana de cada cuenta, y con menos de ocho videos no es fiable', async () => {
  const run = await correr('compute.baseline');
  const md = run.metadata as { cuentas: number; workspaces: number; fiablesPorCorte: Record<string, number>; fallidas: string[] };
  assert.equal(md.cuentas, 3, 'dos redes de Laura y una de Mateo');
  assert.equal(md.workspaces, 2);
  assert.deepEqual(md.fallidas, []);

  const tiktokA = (await lineasBase(`WHERE workspace_id = '${WS_A}' AND platform_id = 'tiktok'`)).filter((b) => b.age_hours_cut === 168);
  assert.equal(tiktokA.length, 1);
  const b168 = tiktokA[0]!;
  assert.equal(b168.sample_size, 9, 'ocho videos normales y el outlier');
  assert.equal(Number(b168.median_views), 50_000);
  assert.equal(Number(b168.p25_views), 50_000);
  assert.equal(Number(b168.p75_views), 50_000);
  assert.equal(b168.is_reliable, true);
  assert.equal(Number(b168.median_completion), 0.42, 'la mediana de completion sale de las lecturas, no de un cero');
  assert.equal(Number(b168.median_saves_per_1k), 8, '0,008 guardados por view son 8 por mil');

  const insta = (await lineasBase(`WHERE workspace_id = '${WS_A}' AND platform_id = 'instagram'`)).filter((b) => b.age_hours_cut === 168);
  assert.equal(insta[0]!.sample_size, MIN_SAMPLE_FOR_BASELINE - 1);
  assert.equal(insta[0]!.is_reliable, false, 'con siete videos la mediana no es fiable');
  assert.equal(Number(insta[0]!.median_views), 30_000, 'se calcula igual: lo que no se publica es el múltiplo, no la mediana');

  const cortes = (await lineasBase(`WHERE workspace_id = '${WS_A}' AND platform_id = 'tiktok'`)).map((b) => b.age_hours_cut);
  assert.deepEqual(cortes, [24, 72, 168], 'un corte por fila, y ningún video ha cumplido 720 h');
});

test('cada workspace tiene su propia mediana y ninguna cruza', async () => {
  const b = await lineasBase(`WHERE age_hours_cut = 168`);
  const porWorkspace = new Map(b.map((r) => [`${r.workspace_id}:${r.platform_id}`, r]));
  assert.equal(Number(porWorkspace.get(`${WS_A}:tiktok`)!.median_views), 50_000);
  assert.equal(Number(porWorkspace.get(`${WS_B}:tiktok`)!.median_views), 1_000);
  assert.equal(porWorkspace.get(`${WS_B}:tiktok`)!.sample_size, 10);
  for (const fila of b) {
    const dueno = fila.creator_id === LAURA ? WS_A : WS_B;
    assert.equal(fila.workspace_id, dueno, 'la fila de un creador nunca queda en el workspace del otro');
  }
});

test('compute.baseline con un workspace en el payload no toca al otro', async () => {
  const antes = (await lineasBase(`WHERE workspace_id = '${WS_B}'`)).length;
  reloj = new Date(NOW.getTime() + 60_000);
  await h.worker.boss.send('compute.baseline', { workspaceId: WS_A, source: 'test' });
  await waitFor(async () => (await lineasBase(`WHERE workspace_id = '${WS_A}' AND computed_at = '${reloj.toISOString()}'`)).length > 0, { label: 'línea base de A' });
  assert.equal((await lineasBase(`WHERE workspace_id = '${WS_B}'`)).length, antes, 'B se queda como estaba');
});

test('compute.post_score: el doble de la mediana queda como outlier, y el video de tres días se mide a 72 h', async () => {
  reloj = new Date(NOW.getTime() + 120_000);
  const run = await correr('compute.post_score');
  const md = run.metadata as { candidatos: number; sinLineaBase: number; outliers: string[]; avisados: string[]; fallidos: string[] };
  assert.deepEqual(md.fallidos, []);

  const out = (await puntaje(A_OUT))!;
  assert.equal(out.age_hours_cut, 168, 'un video de 18 días se mide en el mayor corte que alcanzó');
  assert.equal(Number(out.views_at_cut), 100_000);
  assert.equal(Number(out.views_vs_median), 2);
  assert.equal(out.outlier_tier, 'outlier');
  assert.equal(out.is_outlier, true);

  const normal = (await puntaje(A_NORMALES[0]!))!;
  assert.equal(Number(normal.views_vs_median), 1);
  assert.equal(normal.outlier_tier, 'normal');
  assert.equal(normal.is_outlier, false);

  const tresDias = (await puntaje(A_72))!;
  assert.equal(tresDias.age_hours_cut, 72, 'tres días son 72 h, no 720');
  assert.equal(Number(tresDias.views_at_cut), 15_000);

  assert.ok(md.outliers.includes(A_OUT) && md.outliers.includes(B_BREAK));
});

test('una lectura vieja no puntúa un video en un corte que nunca midió', async () => {
  const s = (await puntaje(B_VIEJO))!;
  assert.equal(s.age_hours_cut, 72, 'tiene 31 días, pero su última lectura es de las 60 h: se mide a las 72, no a los 30 días');
  assert.equal(Number(s.views_at_cut), 500);
  const b = await lineasBase(`WHERE workspace_id = '${WS_B}' AND platform_id = 'tiktok' AND age_hours_cut = 168`);
  assert.equal(b.at(-1)!.sample_size, 10, 'y ese valor inmaduro tampoco entra en la mediana de los 7 días');
});

test('con menos de ocho videos no se inventa un múltiplo', async () => {
  for (const id of A_INSTA) {
    const s = (await puntaje(id))!;
    assert.equal(s.views_vs_median, null, 'sin muestra suficiente, null: un cero diría «te fue pésimo»');
    assert.equal(s.outlier_tier, null);
    assert.equal(s.is_outlier, false, 'la columna es NOT NULL: el «no sabemos» vive en las otras dos');
    assert.equal(Number(s.views_at_cut), 30_000, 'la cifra real del video sí se escribe');
    assert.notEqual(s.baseline_id, null, 'queda dicho contra qué línea base (no fiable) se miró');
  }
});

test('el puntaje apunta a la línea base del propio workspace, la más reciente', async () => {
  const out = (await puntaje(A_OUT))!;
  const { rows } = await h.db.query<{ workspace_id: string; computed_at: Date | string; age_hours_cut: number }>(
    `SELECT workspace_id, computed_at, age_hours_cut FROM creator_baseline WHERE id = $1`,
    [out.baseline_id],
  );
  assert.equal(rows[0]!.workspace_id, WS_A);
  assert.equal(rows[0]!.age_hours_cut, 168);
  const todas = await lineasBase(`WHERE workspace_id = '${WS_A}' AND platform_id = 'tiktok' AND age_hours_cut = 168`);
  assert.equal(todas.length, 2, 'dos corridas dejan dos filas: la tabla es append-only');
  assert.notEqual(new Date(todas[0]!.computed_at as string).getTime(), new Date(todas[1]!.computed_at as string).getTime());
  assert.equal(out.baseline_id, todas.at(-1)!.id, 'se puntúa contra la última, no contra la del mes pasado');
  assert.equal(Number(todas[0]!.median_views), Number(todas[1]!.median_views), 'sin datos nuevos, la mediana no cambia');
});

test('la notificación de outlier llega una sola vez', async () => {
  const avisos = await notificaciones(A_OUT);
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0]!.kind, 'outlier');
  assert.equal(avisos[0]!.severity, 'success');
  assert.equal(avisos[0]!.action_url, '/resumen');
  assert.match(avisos[0]!.title_es, /2×/, 'el aviso dice el múltiplo en el locale del workspace');
  assert.match(avisos[0]!.body_es ?? '', /100\.000 views en TikTok a los 7 días/);
  assert.notEqual((await puntaje(A_OUT))!.notified_at, null);

  // Otra corrida completa no repite el aviso ni cambia el puntaje.
  reloj = new Date(NOW.getTime() + 180_000);
  await correr('compute.baseline');
  const run = await correr('compute.post_score');
  assert.deepEqual((run.metadata as { avisados: string[] }).avisados, [], 'ya estaban avisados todos');
  assert.equal((await notificaciones(A_OUT)).length, 1);
  const out = (await puntaje(A_OUT))!;
  assert.equal(out.outlier_tier, 'outlier');
  assert.equal(Number(out.views_vs_median), 2, 'el puntaje se recalcula contra la mediana de hoy y da lo mismo');
});

test('un video que sube de outlier a breakout avisa la segunda vez, y solo esa', async () => {
  assert.deepEqual((await notificaciones(B_BREAK)).map((n) => n.kind), ['outlier']);

  // Llega la lectura de las 166 h: el video se disparó dentro del mismo corte.
  const publishedAt = new Date(NOW.getTime() - 9 * 24 * HORA_MS);
  await h.db.raw.query(
    `INSERT INTO post_metric_snapshot (post_id, workspace_id, captured_at, age_hours, views, reach, likes, comments, shares, saves, total_interactions, completion_rate, skip_rate_3s, source)
     VALUES ($1, $2, $3, 166, 5500, 3850, 275, 11, 33, 44, 363, 0.42, 0.21, 'api')`,
    [B_BREAK, WS_B, new Date(publishedAt.getTime() + 166 * HORA_MS)],
  );
  reloj = new Date(NOW.getTime() + 240_000);
  await correr('compute.baseline');
  await correr('compute.post_score');

  const s = (await puntaje(B_BREAK))!;
  assert.equal(Number(s.views_at_cut), 5_500, 'la lectura más reciente sin pasarse del corte');
  assert.equal(Number(s.views_vs_median), 5.5);
  assert.equal(s.outlier_tier, 'breakout');
  assert.equal(s.is_outlier, true);
  const avisos = await notificaciones(B_BREAK);
  assert.deepEqual(avisos.map((n) => n.kind), ['outlier', 'breakout'], 'uno por nivel, nunca dos del mismo');
  assert.match(avisos[1]!.title_es, /Se disparó/);
});

test('el corte de un puntaje nunca retrocede', async () => {
  // Como si el video se hubiera medido antes a 720 h (un published_at corregido).
  await h.db.query(`UPDATE post_score SET age_hours_cut = 720 WHERE post_id = $1 AND workspace_id = $2`, [A_OUT, WS_A]);
  reloj = new Date(NOW.getTime() + 300_000);
  const run = await correr('compute.post_score');
  assert.ok((run.metadata as { noRetrocedidos: number }).noRetrocedidos >= 1);
  assert.equal((await puntaje(A_OUT))!.age_hours_cut, 720, 'se deja como está en vez de reescribirlo con una medida a menos edad');
  assert.equal((await notificaciones(A_OUT)).length, 1, 'y tampoco vuelve a avisar');
});

test('un múltiplo absurdo se recorta en vez de tumbar la corrida del workspace', () => {
  // numeric(8,3) de post_score: ocho videos de una view son una muestra
  // «fiable», y un video de 150 000 daría 150 000×, que no cabe.
  const fila = { sample_size: 8, views: '150000', median_views: '1', reach: null, median_reach: null,
    saves: null, median_saves_per_1k: null, total_interactions: null, likes: null, comments: null, shares: null,
    median_engagement: null, post_id: 'x', workspace_id: 'x', creator_id: 'x', platform_id: 'tiktok',
    locale: 'es-CO', title: null, caption: null, cut_hours: 168, baseline_id: null };
  const s = scoreFrom(fila);
  assert.equal(s.viewsVsMedian, 99_999.999);
  assert.deepEqual(s.capped, ['views_vs_median']);
  assert.equal(s.tier, 'breakout');
});

test('solo se avisa cuando el video SUBE de nivel', () => {
  assert.equal(debeAvisar('outlier', []), true);
  assert.equal(debeAvisar('breakout', ['outlier']), true, 'de 2× a 5× sí se avisa');
  assert.equal(debeAvisar('outlier', ['outlier']), false);
  assert.equal(debeAvisar('breakout', ['breakout', 'outlier']), false);
  assert.equal(debeAvisar('outlier', ['breakout']), false, 'bajar de breakout a outlier no es una buena noticia que anunciar');
});

test('nada de lo que escribe CON-6 lleva la referencia del secreto de la cuenta', async () => {
  // Las cuatro tablas que escriben estos dos jobs, fila entera a texto
  // (t::text incluye TODAS las columnas, también metadata y raw).
  // dumpTextColumns() sobre las 88 tablas tardaba cuarenta segundos.
  const tablas = ['creator_baseline', 'post_score', 'notification', 'job_run'];
  const volcado = [];
  for (const tabla of tablas) {
    const { rows } = await h.db.query<{ text: string }>(`SELECT coalesce(string_agg(t::text, E'\\n'), '') AS text FROM ${tabla} t`);
    volcado.push({ table: tabla, column: '*', text: rows[0]!.text });
  }
  assert.ok(volcado.every((v) => v.text.length > 0), 'las cuatro tablas tienen filas que mirar');
  assert.equal(findSecretInDump(volcado, [SECRET_REF]), null);
  assert.ok(!h.sink.text().includes(SECRET_REF), 'tampoco en el log');
});
