/**
 * Las cifras del día de una cuenta de Instagram autorizada (5-oct-2026).
 *
 * Hasta aquí collect.account_metrics solo pedía /me (seguidores y
 * publicaciones) y la columna «Vistas» de Conexiones decía «Sin dato»
 * para una cuenta conectada con Instagram Login. Ahora pide además
 * /me/insights del último día cerrado (ayer, UTC) y guarda el snapshot
 * con la fecha de ESE día: vistas, alcance, interacciones, cuentas que
 * interactuaron, visitas al perfil, altas y clics. Si Meta no da las
 * cifras del día (error 100), se reintenta con la lista base y, si
 * tampoco, la cuenta se guarda igual con seguidores y publicaciones.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { FixtureFetch, loadFixture, withoutNetwork, type Fixture, type NetworkGuard } from '@mc/connectors';
import { allJobs } from '../src/jobs/index.ts';
import { jobRuns, startHarness, waitFor, type Harness, type JobRunRow, SETUP_TIMEOUT } from './helpers/harness.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';

/** La corrida de las 05:10 UTC del 23: el día cerrado es el 22. */
const NOW = new Date('2026-09-23T05:10:00Z');
const WORKSPACE = '00000002-0000-4000-8000-000000000001';
const CREATOR = '00000002-0000-4000-8000-000000000003';
const TOKENS = { accessToken: 'IGAA-cuenta-autorizada-SECRETO', accessExpiresAt: new Date('2026-12-04T00:00:00Z'), scopes: ['instagram_business_basic', 'instagram_business_manage_insights'] };

let h: Harness;
let guard: NetworkGuard;
let ids: { conInsights: string; sinInsights: string };

async function seed(db: PgliteDatabase): Promise<void> {
  const raw = db.raw;
  await raw.exec(`
    SELECT set_config('app.workspace_id', '${WORKSPACE}', false);
    INSERT INTO workspace (id, slug, name) VALUES ('${WORKSPACE}', 'laura', 'Laura');
    INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${CREATOR}', '${WORKSPACE}', 'Laura');
  `);
  const add = async (handle: string, ext: string, ref: string) => {
    const r = await raw.query<{ id: string }>(
      `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_mode, account_type, access_expires_at)
       VALUES ($1, $2, 'instagram', $3, $4, $5, '{instagram_business_basic,instagram_business_manage_insights}', 'direct_oauth', 'creator', $6) RETURNING id`,
      [WORKSPACE, CREATOR, ext, handle, ref, TOKENS.accessExpiresAt],
    );
    return r.rows[0]!.id;
  };
  ids = { conInsights: await add('nicolasduartea', '17841400000000123', 'vault:ig-ok'), sinInsights: await add('cuenta.nueva', '17841400000000999', 'vault:ig-sin') };
  await raw.exec("SELECT set_config('app.workspace_id', '', false)");
}

async function corrida(connectionId: string): Promise<JobRunRow> {
  const antes = (await jobRuns(h.db, 'collect.account_metrics')).length;
  await h.worker.boss.send('collect.account_metrics', { source: 'test', workspaceId: WORKSPACE, connectionId });
  return waitFor(async () => (await jobRuns(h.db, 'collect.account_metrics')).slice(antes).find((r) => r.status !== 'running'), { label: 'collect.account_metrics', timeoutMs: 30_000 });
}

before(async () => {
  guard = withoutNetwork();
  const me = await loadFixture('instagram', 'me', 'ok');
  const ok = await loadFixture('instagram', 'account.insights', 'ok');
  // Primera llamada a /me/insights: la respuesta grabada. Las siguientes:
  // el error 100 de Meta («métrica no soportada»), que se repite.
  const insights: Fixture = {
    ...ok,
    response: [
      ...(Array.isArray(ok.response) ? ok.response : [ok.response]),
      { status: 400, body: { error: { message: '(#100) Unsupported get request. The metric profile_views is not supported', type: 'OAuthException', code: 100, fbtrace_id: 'Axyz' } } },
    ],
  };
  const fetch = new FixtureFetch([me, insights]);
  h = await startHarness({ jobs: allJobs, now: () => NOW, seed, env: {}, http: { fetch: fetch.fetch } });
  await h.secrets.set('vault:ig-ok', TOKENS);
  await h.secrets.set('vault:ig-sin', { ...TOKENS, accessToken: 'IGAA-otra-SECRETO' });
}, SETUP_TIMEOUT);
after(async () => { await h.stop(); guard.restore(); });

test('la cuenta autorizada guarda el snapshot del día cerrado con vistas, alcance e interacciones', async () => {
  const run = await corrida(ids.conInsights);
  assert.equal(run.status, 'ok', run.error ?? '');
  const md = run.metadata as { snapshots: string[]; errored: string[]; transient: string[] };
  assert.deepEqual([md.snapshots, md.errored, md.transient], [[ids.conInsights], [], []]);

  const { rows } = await h.db.query<{ day: string; source: string; followers: string; media_count: string; views: string | null; reach: string | null; accounts_engaged: string | null; total_interactions: string | null }>(
    `SELECT day::text AS day, source, followers, media_count, views, reach, accounts_engaged, total_interactions FROM account_metric_snapshot WHERE connection_id = $1`,
    [ids.conInsights],
  );
  assert.equal(rows.length, 1);
  const s = rows[0]!;
  assert.equal(s.day, '2026-09-22', 'el snapshot lleva la fecha del día cerrado, no la de la corrida');
  assert.equal(s.source, 'api');
  assert.deepEqual([Number(s.followers), Number(s.media_count)], [412000, 1205], 'seguidores y publicaciones de /me');
  assert.deepEqual([Number(s.views), Number(s.reach)], [310000, 152000], 'vistas y alcance de /me/insights');
  assert.ok(s.accounts_engaged !== null && s.total_interactions !== null, 'cuentas que interactuaron e interacciones');

  // Por fecha y endpoint, no por id (uuid desde 0083, CIM-11): dos llamadas
  // pueden caer en el mismo milisegundo de PGlite, así que se compara el
  // conjunto ordenado, no el orden de llegada.
  const log = await h.db.query<{ endpoint: string; ok: boolean }>(`SELECT endpoint, ok FROM api_call_log WHERE connection_id = $1 ORDER BY called_at, endpoint`, [ids.conInsights]);
  assert.deepEqual(log.rows.map((r) => `${r.endpoint}:${r.ok}`).sort(), ['instagram.account.insights:true', 'instagram.me:true']);
  assert.equal(guard.attempts, 0);
  assert.ok(!h.sink.text().includes(TOKENS.accessToken), 'el token no sale en el log');
});

test('si Meta rechaza las métricas del día, se reintenta con la lista base y la cuenta se guarda igual, sin inventar ceros', async () => {
  const run = await corrida(ids.sinInsights);
  assert.equal(run.status, 'ok', run.error ?? '');
  const md = run.metadata as { snapshots: string[]; errored: string[]; transient: string[] };
  assert.deepEqual([md.snapshots, md.errored, md.transient], [[ids.sinInsights], [], []]);

  const { rows } = await h.db.query<{ day: string; followers: string; views: string | null; reach: string | null }>(
    `SELECT day::text AS day, followers, views, reach FROM account_metric_snapshot WHERE connection_id = $1`,
    [ids.sinInsights],
  );
  assert.deepEqual(rows.map((r) => [r.day, Number(r.followers), r.views, r.reach]), [['2026-09-22', 412000, null, null]]);

  const log = await h.db.query<{ endpoint: string; ok: boolean }>(`SELECT endpoint, ok FROM api_call_log WHERE connection_id = $1 ORDER BY called_at, endpoint`, [ids.sinInsights]);
  assert.deepEqual(log.rows.map((r) => `${r.endpoint}:${r.ok}`).sort(), ['instagram.account.insights:false', 'instagram.account.insights:false', 'instagram.me:true'], 'dos intentos: la lista completa y la base');
  const conn = await h.db.query<{ status: string }>(`SELECT status FROM social_connection WHERE id = $1`, [ids.sinInsights]);
  assert.equal(conn.rows[0]!.status, 'active', 'un 100 de insights no es un problema del token');
});
