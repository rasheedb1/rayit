/**
 * CON-3 · Fase 6: oauth.refresh con el EncryptedSecretStore real y los
 * refreshers de TikTok e Instagram sobre fixtures. TikTok rota el refresh
 * token y lo guardado es el nuevo; Instagram a menos de 24 h se renueva;
 * Instagram vencido pasa a needs_reauth con su notification sin llamar a
 * Meta. Al final, ninguna columna de texto de ninguna tabla ni el log del
 * worker contienen un token viejo ni uno nuevo.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  createInstagramRefresher, createTikTokRefresher, dumpTextColumns, EncryptedSecretStore, findSecretInDump, FixtureFetch, HttpCore,
  InMemoryCallLogSink, INSTAGRAM_LOGIN_SCOPES, keyringOf, loadFixtures, QuotaManager, TIKTOK_LOGIN_SCOPES, TokenCipher, withoutNetwork,
  type NetworkGuard, type OAuthAppConfig,
} from '@mc/connectors';
import { allJobs } from '../src/jobs/index.ts';
import { jobRuns, startHarness, waitFor, type Harness } from './helpers/harness.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';

const NOW = new Date('2026-09-22T10:00:00Z');
const hours = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
const WORKSPACE = '00000002-0000-4000-8000-000000000001';
const CREATOR = '00000002-0000-4000-8000-000000000003';
const REF_TT = 'enc:tiktok:11111111-1111-4111-8111-111111111111';
const REF_IG = 'enc:instagram:22222222-2222-4222-8222-222222222222';
const REF_IG_OLD = 'enc:instagram:33333333-3333-4333-8333-333333333333';

const OLD = {
  tt: { accessToken: 'act.demo-access-tiktok-0001-SECRETO', refreshToken: 'rft.demo-refresh-tiktok-0001-SECRETO' },
  ig: { accessToken: 'IGAA-long-demo-0001-SECRETO' },
  igOld: { accessToken: 'IGAA-long-demo-VENCIDO-SECRETO' },
};
const NEW = { tt: ['act.demo-access-tiktok-0002-SECRETO', 'rft.demo-refresh-tiktok-0002-SECRETO'], ig: ['IGAA-long-demo-0002-SECRETO'] };
const ALL_SECRETS = [OLD.tt.accessToken, OLD.tt.refreshToken, OLD.ig.accessToken, OLD.igOld.accessToken, ...NEW.tt, ...NEW.ig, 'CLIENT-SECRET-SECRETO'];

const cipher = new TokenCipher(keyringOf({ v1: new Uint8Array(randomBytes(32)) }));
const app = (provider: OAuthAppConfig['provider'], scopes: readonly string[]): OAuthAppConfig => ({ provider, clientId: `id-${provider}`, clientSecret: 'CLIENT-SECRET-SECRETO', redirectUri: 'https://on-cue-web.vercel.app/x', scopes });

let h: Harness;
let guard: NetworkGuard;
let fetch: FixtureFetch;
let calls: InMemoryCallLogSink;
let ids: { tt: string; ig: string; igOld: string };

async function seed(db: PgliteDatabase): Promise<void> {
  const raw = db.raw;
  await raw.exec(`
    SELECT set_config('app.workspace_id', '${WORKSPACE}', false);
    INSERT INTO workspace (id, slug, name) VALUES ('${WORKSPACE}', 'laura', 'Laura');
    INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${CREATOR}', '${WORKSPACE}', 'Laura');
  `);
  const insert = async (platform: string, ext: string, ref: string, expires: Date, refreshExpires: Date | null) => {
    const r = await raw.query<{ id: string }>(
      `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_expires_at, refresh_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, '{x}', $7, $8) RETURNING id`,
      [WORKSPACE, CREATOR, platform, ext, '@' + ext, ref, expires, refreshExpires],
    );
    return r.rows[0]!.id;
  };
  ids = {
    tt: await insert('tiktok', 'tt-near', REF_TT, hours(0.2), hours(24 * 300)),
    ig: await insert('instagram', 'ig-soon', REF_IG, hours(20), null),
    igOld: await insert('instagram', 'ig-old', REF_IG_OLD, hours(-1), null),
  };
  // Los secretos se escriben como el worker (mc_worker) fijando el workspace de la ref nueva.
  const store = new EncryptedSecretStore({ db, cipher, workspaceId: WORKSPACE });
  await store.set(REF_TT, { ...OLD.tt, accessExpiresAt: hours(0.2), refreshExpiresAt: hours(24 * 300), scopes: [...TIKTOK_LOGIN_SCOPES] });
  await store.set(REF_IG, { ...OLD.ig, accessExpiresAt: hours(20), scopes: [...INSTAGRAM_LOGIN_SCOPES] });
  await store.set(REF_IG_OLD, { ...OLD.igOld, accessExpiresAt: hours(-1), scopes: [...INSTAGRAM_LOGIN_SCOPES] });
  // Como en producción: el worker NO tiene app.workspace_id en sesión. Sin esto la prueba taparía un set() que falla por NOT NULL.
  await raw.exec("SELECT set_config('app.workspace_id', '', false)");
}

before(async () => {
  guard = withoutNetwork();
  fetch = new FixtureFetch([...(await loadFixtures('tiktok', [['oauth.token', 'refresh.ok']])), ...(await loadFixtures('instagram', [['oauth.refresh', 'ok']]))]);
  calls = new InMemoryCallLogSink();
  const core = new HttpCore({ callLog: calls, fetch: fetch.fetch, now: () => NOW, quota: new QuotaManager({ now: () => NOW }) });
  h = await startHarness({
    jobs: allJobs,
    now: () => NOW,
    seed,
    secrets: (db) => new EncryptedSecretStore({ db, cipher }),
    refreshers: [createTikTokRefresher(core, { login: app('tiktok', TIKTOK_LOGIN_SCOPES) }), createInstagramRefresher(core, app('instagram', INSTAGRAM_LOGIN_SCOPES))],
    env: { OAUTH_REFRESH_MARGIN_MINUTES: '30' },
  });
}, { timeout: 600_000 });

after(async () => {
  await h.stop();
  guard.restore();
});

interface ConnRow extends Record<string, unknown> { id: string; status: string; status_detail: string | null; access_expires_at: Date | string; refresh_expires_at: Date | string | null; scopes: string[] }
async function conn(id: string): Promise<ConnRow> {
  const { rows } = await h.db.query<ConnRow>(`SELECT id, status, status_detail, access_expires_at, refresh_expires_at, scopes FROM social_connection WHERE id = $1`, [id]);
  return rows[0]!;
}

test('TikTok rota el refresh token y lo guardado (cifrado) es el nuevo; Instagram < 24 h se renueva; Instagram vencido → needs_reauth sin llamar', async () => {
  await h.worker.boss.send('oauth.refresh', { source: 'test' });
  const run = await waitFor(async () => (await jobRuns(h.db, 'oauth.refresh')).find((r) => r.status !== 'running'), { label: 'oauth.refresh real', timeoutMs: 30_000 });
  assert.equal(run.status, 'ok', run.error ?? '');
  assert.equal(run.items_processed, 3);
  assert.equal(run.items_failed, 0);
  const md = run.metadata as { due: number; renewed: string[]; needsReauth: string[] };
  assert.equal(md.due, 3, 'tiktok dentro de 30 min; las dos de Instagram dentro de los 7 días');
  assert.deepEqual([...md.renewed].sort(), [ids.tt, ids.ig].sort());
  assert.deepEqual(md.needsReauth, [ids.igOld]);

  // TikTok: fila y almacén con el token rotado.
  const tt = await conn(ids.tt);
  assert.equal(tt.status, 'active');
  assert.equal(new Date(tt.access_expires_at).toISOString(), '2026-09-23T10:00:00.000Z');
  assert.equal(new Date(tt.refresh_expires_at!).toISOString(), '2027-09-22T10:00:00.000Z');
  assert.deepEqual(tt.scopes, [...TIKTOK_LOGIN_SCOPES]);
  const ttTokens = await h.secrets.get(REF_TT);
  assert.equal(ttTokens!.accessToken, NEW.tt[0]);
  assert.equal(ttTokens!.refreshToken, NEW.tt[1], 'el refresh token nuevo, no el viejo');

  // Instagram: token de 60 días, sin refresh token, scopes conservados.
  const ig = await conn(ids.ig);
  assert.equal(ig.status, 'active');
  assert.equal(new Date(ig.access_expires_at).toISOString(), new Date(NOW.getTime() + 5_184_000_000).toISOString());
  assert.equal(ig.refresh_expires_at, null);
  const igTokens = await h.secrets.get(REF_IG);
  assert.equal(igTokens!.accessToken, NEW.ig[0]);
  assert.equal(igTokens!.refreshToken, undefined);
  assert.deepEqual(igTokens!.scopes, [...INSTAGRAM_LOGIN_SCOPES]);

  // Instagram vencido: needs_reauth, notificación, y el almacén intacto.
  const old = await conn(ids.igOld);
  assert.equal(old.status, 'needs_reauth');
  assert.match(old.status_detail!, /venció/);
  assert.match(old.status_detail!, /refresh_expired/);
  const notes = await h.db.query<{ entity_id: string; title_es: string; action_url: string }>(`SELECT entity_id, title_es, action_url FROM notification`);
  assert.equal(notes.rows.length, 1);
  assert.equal(notes.rows[0]!.entity_id, ids.igOld);
  assert.match(notes.rows[0]!.title_es, /Instagram/);
  assert.equal((await h.secrets.get(REF_IG_OLD))!.accessToken, OLD.igOld.accessToken);

  // Dos llamadas HTTP (tiktok, instagram): la vencida no llegó a Meta. Sin red real.
  assert.equal(fetch.calls.length, 2);
  assert.equal(guard.attempts, 0);
  const log = await h.db.query<{ connection_id: string; ok: boolean; error_code: string | null }>(`SELECT connection_id, ok, error_code FROM api_call_log WHERE endpoint = 'oauth.refresh' ORDER BY id`);
  assert.equal(log.rows.length, 3, 'una fila por conexión, la escribe el job');
  assert.equal(log.rows.find((r) => r.connection_id === ids.igOld)?.error_code, 'refresh_expired');
});

test('el worker guarda sin workspace en sesión: la fila de connection_secret conservó su workspace y sigue siendo una', async () => {
  const rows = await h.db.query<{ workspace_id: string }>(`SELECT workspace_id FROM connection_secret WHERE secret_ref = $1`, [REF_TT]);
  assert.equal(rows.rows[0]!.workspace_id, WORKSPACE);
  const total = await h.db.query<{ n: number | string }>(`SELECT count(*)::int AS n FROM connection_secret`);
  assert.equal(Number(total.rows[0]!.n), 3, 'tres refs sembradas, ninguna duplicada');
  const ws = await h.db.query<{ ws: string | null }>(`SELECT current_setting('app.workspace_id', true) AS ws`);
  assert.ok(!ws.rows[0]!.ws, 'la sesión no tiene workspace');
});

test('payload.marginMinutes manda sobre el margen de la plataforma', async () => {
  const { cutoffsFor, marginFor } = await import('../src/jobs/conexiones/oauth-refresh.ts');
  assert.equal(marginFor('instagram', 30, {}), 7 * 24 * 60);
  assert.equal(marginFor('instagram', 30, { OAUTH_REFRESH_MARGIN_MINUTES_INSTAGRAM: '60' }), 60);
  assert.equal(marginFor('instagram', 30, {}, 0), 0);
  assert.equal(marginFor('tiktok', 30, {}), 30);
  const c = cutoffsFor(NOW, 30, {}, 5);
  assert.equal(c.get('instagram')!.toISOString(), new Date(NOW.getTime() + 5 * 60_000).toISOString());
});

test('R4: ningún token (viejo ni nuevo) en ninguna columna de texto de public ni de pgboss, ni en el log del worker', async () => {
  const raw = { query: (text: string, params?: readonly unknown[]) => h.db.raw.query(text, params as unknown[]) };
  const dump = [...(await dumpTextColumns(raw, 'public')), ...(await dumpTextColumns(raw, 'pgboss'))];
  assert.ok(dump.some((d) => d.table === 'connection_secret' && d.column === 'ciphertext'));
  assert.equal(findSecretInDump(dump, ALL_SECRETS), null);
  const logText = h.sink.text();
  for (const s of ALL_SECRETS) assert.ok(!logText.includes(s), `token en el log del worker: ${s.slice(0, 12)}…`);
  assert.ok(!JSON.stringify(calls.entries).includes('SECRETO'));
});
