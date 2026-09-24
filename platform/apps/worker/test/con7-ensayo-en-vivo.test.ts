/**
 * CON-C · el ensayo de CON-7 en vivo, hecho con respuestas grabadas.
 *
 * Es el guion de docs/propuestas/CIERRE-CON-C.md §3 paso por paso, sobre
 * la MISMA conexión de principio a fin:
 *
 *   1. Un canal de YouTube agregado por @ (CON-10): collect.demographics
 *      no llama a nadie y deja en metric_gap el hueco
 *      yt.demographics.auth, con el message_es que verá la pantalla.
 *   2. El dueño autoriza con CON-8: la fila pasa a direct_oauth con
 *      youtube.readonly + yt-analytics.readonly, conservando su id. Aquí
 *      se escribe con el mismo UPDATE de upgradePublicAccountToOAuth
 *      (packages/db); que el callback de Google deja exactamente eso lo
 *      prueba apps/web …/oauth-handlers.test.ts.
 *   3. La corrida siguiente hace dos llamadas a la Analytics API, escribe
 *      las filas de audience_breakdown (viewers × age_gender y country) y
 *      el hueco de esa conexión DESAPARECE.
 *   4. Una tercera corrida el mismo día no llama ni duplica.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { FixtureFetch, loadFixtures, withoutNetwork, YOUTUBE_ANALYTICS_SCOPE, type NetworkGuard } from '@mc/connectors';
import { allJobs } from '../src/jobs/index.ts';
import { DEMOGRAPHICS_GROUP } from '../src/jobs/conexiones/prerrequisitos-demografia.ts';
import { jobRuns, startHarness, waitFor, withoutChaining, type Harness } from './helpers/harness.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';

const NOW = new Date('2026-09-23T05:20:00Z');
const W = '0000000c-0000-4000-8000-000000000007';
const C = '0000000c-0000-4000-8000-000000000017';
const CANAL = 'UCnutrive00000000000000e4';
const SECRET_REF = 'enc:youtube:0000000c-0000-4000-8000-0000000000e7';
const YT_SCOPES = ['https://www.googleapis.com/auth/youtube.readonly', YOUTUBE_ANALYTICS_SCOPE];

let h: Harness;
let guard: NetworkGuard;
let fetch: FixtureFetch;
let yt: string;

async function seed(db: PgliteDatabase): Promise<void> {
  await db.raw.exec(`
    INSERT INTO workspace (id, slug, name) VALUES ('${W}', 'laura-c7', 'Laura');
    INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${C}', '${W}', 'Laura');
  `);
  const r = await db.raw.query<{ id: string }>(
    `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_mode, account_type)
     VALUES ($1, $2, 'youtube', $3, 'NutriveOficial', 'public:youtube:NutriveOficial', '{}', 'public_profile', 'unknown') RETURNING id`,
    [W, C, CANAL],
  );
  yt = r.rows[0]!.id;
}

before(async () => {
  guard = withoutNetwork();
  fetch = new FixtureFetch(await loadFixtures('youtube', [['analytics.query', 'channel_demographics.ok'], ['analytics.query', 'country.ok']]));
  h = await startHarness({ jobs: withoutChaining(allJobs), now: () => NOW, seed, http: { fetch: fetch.fetch } });
});
after(async () => { await h.stop(); guard.restore(); });

async function corre(n: number): Promise<{ saved: string[]; gaps: Record<string, string>; alreadyToday: string[] }> {
  await h.worker.boss.send('collect.demographics', { workspaceId: W });
  const runs = await waitFor(async () => {
    const hechas = (await jobRuns(h.db, 'collect.demographics')).filter((r) => r.status !== 'running');
    return hechas.length >= n ? hechas : null;
  }, { label: `collect.demographics #${n}`, timeoutMs: 30_000 });
  const run = runs[n - 1]!;
  assert.equal(run.status, 'ok', run.error ?? '');
  return run.metadata as { saved: string[]; gaps: Record<string, string>; alreadyToday: string[] };
}

/** Lo que la pantalla (RES-4) leería: el hueco vivo de la conexión con su frase. */
async function hueco(): Promise<{ requirement_id: string; message_es: string } | null> {
  const { rows } = await h.db.query<{ requirement_id: string; message_es: string }>(
    `SELECT g.requirement_id, r.message_es FROM metric_gap g JOIN metric_requirement r ON r.id = g.requirement_id
      WHERE g.connection_id = $1 AND g.workspace_id = $2 AND g.metric_group = $3`,
    [yt, W, DEMOGRAPHICS_GROUP],
  );
  return rows[0] ?? null;
}

async function filas(): Promise<Array<{ population: string; dimension: string; n: number }>> {
  const { rows } = await h.db.query<{ population: string; dimension: string; n: number }>(
    `SELECT population, dimension, count(*)::int AS n FROM audience_breakdown
      WHERE scope = 'account' AND connection_id = $1 AND workspace_id = $2 AND day = '2026-09-23'
      GROUP BY population, dimension ORDER BY dimension`,
    [yt, W],
  );
  return rows;
}

test('1 · por @: hueco yt.demographics.auth con su frase, y ninguna llamada', async () => {
  const md = await corre(1);
  assert.equal(md.gaps[yt], 'yt.demographics.auth');
  const g = await hueco();
  assert.equal(g?.requirement_id, 'yt.demographics.auth');
  assert.match(g!.message_es, /autorizar/i, 'la frase le dice al dueño qué hacer');
  assert.deepEqual(await filas(), []);
  assert.equal(fetch.calls.length, 0);
});

test('2 y 3 · el dueño autoriza con CON-8: la misma fila deja la demografía y el hueco desaparece', async () => {
  // Lo que deja upgradePublicAccountToOAuth tras el callback de Google (mismo id).
  await h.db.query(
    `UPDATE social_connection
        SET access_mode = 'direct_oauth', account_type = 'channel', scopes = $3::text[], secret_ref = $4,
            access_expires_at = $5, refresh_expires_at = NULL, status = 'active', status_detail = NULL
      WHERE id = $1 AND workspace_id = $2`,
    [yt, W, YT_SCOPES, SECRET_REF, new Date('2026-09-23T06:15:00Z')],
  );
  await h.secrets.set(SECRET_REF, {
    accessToken: 'ya29.ensayo-ACCESS-SECRETO', refreshToken: '1//ensayo-REFRESH-SECRETO',
    accessExpiresAt: new Date('2026-09-23T06:15:00Z'), scopes: YT_SCOPES,
  });

  const md = await corre(2);
  assert.deepEqual(md.saved, [yt]);
  assert.equal(md.gaps[yt], undefined);
  assert.deepEqual(await filas(), [
    { population: 'viewers', dimension: 'age_gender', n: 8 },
    { population: 'viewers', dimension: 'country', n: 3 },
  ]);
  assert.equal(await hueco(), null, 'la fila de metric_gap de esta conexión se borra cuando el dato llega');
  assert.deepEqual(fetch.calls.map((c) => new URL(c.url).pathname), ['/v2/reports', '/v2/reports'], 'dos llamadas a la Analytics API');

  const conn = await h.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM social_connection WHERE workspace_id = $1`, [W]);
  assert.equal(conn.rows[0]!.n, 1, 'una sola conexión en todo el ensayo');
});

test('4 · otra corrida el mismo día: cero llamadas y las mismas filas', async () => {
  const antes = fetch.calls.length;
  const md = await corre(3);
  assert.deepEqual(md.alreadyToday, [yt]);
  assert.equal(fetch.calls.length, antes);
  assert.equal((await filas()).reduce((s, r) => s + r.n, 0), 11);
  assert.equal(guard.attempts, 0);
});
