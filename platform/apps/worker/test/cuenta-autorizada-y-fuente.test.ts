/**
 * CON-C · dos costuras de collect.account_metrics que salieron en la
 * revisión del cierre:
 *
 *   1. Un canal de YouTube autorizado con CON-8 se sigue leyendo cada día
 *      con su propio token (channels.list?mine=true): antes del cierre
 *      readAuthorized no tenía YouTube, y autorizar un canal que ya se
 *      leía por @ le congelaba los suscriptores para siempre.
 *   2. Si el dueño autoriza su cuenta de TikTok MIENTRAS la corrida la lee
 *      por el proveedor, el cambio de fuente no la degrada de direct_oauth
 *      a aggregator (el UPDATE lleva la guarda de setAccountAccessMode), no
 *      se guarda la lectura por @ y no queda bitácora falsa.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { FixtureFetch, loadFixtures, withoutNetwork, type Fixture, type NetworkGuard } from '@mc/connectors';
import { allJobs } from '../src/jobs/index.ts';
import { jobRuns, startHarness, waitFor, withoutChaining, type Harness } from './helpers/harness.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';

const NOW = new Date('2026-09-23T05:10:00Z');
const W = '0000000c-0000-4000-8000-000000000008';
const C = '0000000c-0000-4000-8000-000000000018';
const YT_REF = 'enc:youtube:0000000c-0000-4000-8000-0000000000f8';
const YT_TOKENS = {
  accessToken: 'ya29.cuenta-autorizada-ACCESS-SECRETO', refreshToken: '1//cuenta-autorizada-REFRESH-SECRETO',
  accessExpiresAt: new Date('2026-09-23T06:00:00Z'),
  scopes: ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly'],
};

let h: Harness;
let guard: NetworkGuard;
let ids: { yt: string; tt: string };
/** Se enciende en la prueba 2: la primera llamada al proveedor «coincide» con el callback de OAuth del dueño. */
let authorizeDuringRead = false;

async function seed(db: PgliteDatabase): Promise<void> {
  await db.raw.exec(`
    INSERT INTO workspace (id, slug, name) VALUES ('${W}', 'laura-cf', 'Laura');
    INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${C}', '${W}', 'Laura');
  `);
  const yt = await db.raw.query<{ id: string }>(
    `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_mode, access_expires_at)
     VALUES ($1, $2, 'youtube', 'UCnutrive00000000000000e4', 'NutriveOficial', $3, $4::text[], 'direct_oauth', $5) RETURNING id`,
    [W, C, YT_REF, YT_TOKENS.scopes, YT_TOKENS.accessExpiresAt],
  );
  const tt = await db.raw.query<{ id: string }>(
    `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_mode)
     VALUES ($1, $2, 'tiktok', 'laura.cocinafacil', 'laura.cocinafacil', 'public:tiktok:laura.cocinafacil', '{}', 'public_profile') RETURNING id`,
    [W, C],
  );
  ids = { yt: yt.rows[0]!.id, tt: tt.rows[0]!.id };
}

before(async () => {
  guard = withoutNetwork();
  const porUsuario = (f: Fixture): Fixture => ({ ...f, request: { ...f.request, urlPattern: `${f.request.urlPattern}(?=.*username=laura\\.cocinafacil(&|$))` } });
  const [info] = await loadFixtures('ensembledata', [['user.info', 'ok']]);
  const fixtures = new FixtureFetch([porUsuario(info!), ...(await loadFixtures('youtube', [['channels.list', 'mine.ok']]))]);
  // El fetch del proveedor simula que el dueño termina «Autorizar cifras» justo
  // mientras la corrida lee su @: la fila pasa a direct_oauth antes del UPDATE de fuente.
  const fetch: typeof fixtures.fetch = async (input, init) => {
    if (authorizeDuringRead && String(input).includes('ensembledata.com')) {
      authorizeDuringRead = false;
      await h.db.query(
        `UPDATE social_connection SET access_mode = 'direct_oauth', secret_ref = 'enc:tiktok:carrera', scopes = '{user.info.basic}' WHERE id = $1 AND workspace_id = $2`,
        [ids.tt, W],
      );
    }
    return fixtures.fetch(input, init);
  };
  h = await startHarness({ jobs: withoutChaining(allJobs), now: () => NOW, seed, env: { ENSEMBLEDATA_TOKEN: 'ed-token-carrera-SECRETO' }, http: { fetch } });
  await h.secrets.set(YT_REF, YT_TOKENS);
});
after(async () => { await h.stop(); guard.restore(); });

async function corre(n: number, connectionId: string): Promise<Record<string, unknown>> {
  await h.worker.boss.send('collect.account_metrics', { workspaceId: W, connectionId });
  const runs = await waitFor(async () => {
    const hechas = (await jobRuns(h.db, 'collect.account_metrics')).filter((r) => r.status !== 'running');
    return hechas.length >= n ? hechas : null;
  }, { label: `collect.account_metrics #${n}`, timeoutMs: 30_000 });
  const run = runs[n - 1]!;
  assert.equal(run.status, 'ok', run.error ?? '');
  return run.metadata;
}

test('YouTube autorizado (CON-8): suscriptores del día con su token, vistas en null y source api', async () => {
  const md = (await corre(1, ids.yt)) as { snapshots: string[]; noMetrics: string[] };
  assert.deepEqual(md.snapshots, [ids.yt], 'antes del cierre caía en noMetrics: «red autorizada sin lectura de cuenta todavía»');
  assert.deepEqual(md.noMetrics, []);
  const { rows } = await h.db.query<{ followers: string | number | null; media_count: string | number | null; views: string | number | null; source: string }>(
    `SELECT followers, media_count, views, source FROM account_metric_snapshot WHERE connection_id = $1 AND workspace_id = $2`, [ids.yt, W]);
  assert.equal(rows.length, 1);
  assert.ok(Number(rows[0]!.followers) > 0);
  assert.equal(rows[0]!.views, null, 'el acumulado del canal no es la vista del día');
  assert.equal(rows[0]!.source, 'api');
  const log = await h.db.query<{ endpoint: string }>(`SELECT endpoint FROM api_call_log WHERE connection_id = $1`, [ids.yt]);
  assert.deepEqual(log.rows.map((r) => r.endpoint), ['youtube.channels.list']);
  assert.ok(!h.sink.text().includes(YT_TOKENS.accessToken));
});

test('carrera con «Autorizar»: la cuenta que se autorizó a mitad de la lectura no se degrada a aggregator', async () => {
  authorizeDuringRead = true;
  const md = (await corre(2, ids.tt)) as { snapshots: string[]; superseded: string[] };
  assert.deepEqual(md.superseded, [ids.tt]);
  assert.deepEqual(md.snapshots, []);
  const conn = await h.db.query<{ access_mode: string; secret_ref: string }>(`SELECT access_mode, secret_ref FROM social_connection WHERE id = $1`, [ids.tt]);
  assert.equal(conn.rows[0]!.access_mode, 'direct_oauth', 'sin la guarda, el UPDATE la pasaba a aggregator y dejaba sus tokens huérfanos');
  assert.equal(conn.rows[0]!.secret_ref, 'enc:tiktok:carrera');
  const snaps = await h.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM account_metric_snapshot WHERE connection_id = $1`, [ids.tt]);
  assert.equal(snaps.rows[0]!.n, 0, 'la lectura por @ ya no le toca: no se guarda');
  const audit = await h.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'connection.source_changed'`, [ids.tt]);
  assert.equal(audit.rows[0]!.n, 0, 'ni bitácora de un cambio que no pasó');
  assert.equal(guard.attempts, 0);
});
