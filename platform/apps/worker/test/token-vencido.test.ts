/**
 * QA de Conexiones (4-oct-2026) · un token VENCIDO con renovación viva
 * no es «vuelve a autorizar».
 *
 * Lo que pasó en producción con @selvathegolden: el access token de
 * TikTok (24 h) venció mientras el worker estuvo apagado; la primera
 * lectura recibió 401 y la cuenta quedó en needs_reauth, con el refresh
 * token vigente hasta 2027. Aquí se prueba el camino nuevo (_token.ts):
 *
 *   1. collect.account_metrics con el access vencido renueva en línea,
 *      lee con el token nuevo y deja el snapshot; la fila sigue 'active'
 *      con la fecha nueva y el log registra la renovación.
 *   2. Si la plataforma RECHAZA la renovación (invalid_grant), entonces
 *      sí: needs_reauth, aviso al creador y ninguna lectura con el token
 *      viejo.
 *   3. oauth.refresh también renueva una fila en 'error' (la lectura
 *      falló por otra cosa) y le conserva ese estado y su detalle.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { FixtureFetch, loadFixtures, withoutNetwork, type NetworkGuard } from '@mc/connectors';
import { allJobs } from '../src/jobs/index.ts';
import { tokenVencido } from '../src/jobs/conexiones/_token.ts';
import { jobRuns, startHarness, waitFor, type Harness, SETUP_TIMEOUT } from './helpers/harness.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';

const NOW = new Date('2026-09-25T05:10:00Z');
const WORKSPACE = '00000002-0000-4000-8000-000000000001';
const CREATOR = '00000002-0000-4000-8000-000000000003';
/** Vencido hace una hora; el refresh token vale hasta 2027. */
const VENCIDO = new Date('2026-09-25T04:00:00Z');
const REFRESH_HASTA = new Date('2027-09-24T05:48:00Z');

const RENOVABLE = { accessToken: 'act.vencido-pero-renovable-SECRETO', refreshToken: 'rft.vigente-SECRETO', accessExpiresAt: VENCIDO, refreshExpiresAt: REFRESH_HASTA, scopes: ['user.info.basic', 'user.info.stats'] };
/** El prefijo `revoked-` hace que el FakeTokenRefresher responda invalid_grant. */
const REVOCADO = { ...RENOVABLE, accessToken: 'revoked-act.vencido-SECRETO', refreshToken: 'rft.revocado-SECRETO' };
const EN_ERROR = { ...RENOVABLE, accessToken: 'act.en-error-SECRETO', refreshToken: 'rft.en-error-SECRETO' };

let h: Harness;
let guard: NetworkGuard;
let ids: { renovable: string; revocado: string; enError: string };

async function seed(db: PgliteDatabase): Promise<void> {
  const raw = db.raw;
  await raw.exec(`
    SELECT set_config('app.workspace_id', '${WORKSPACE}', false);
    INSERT INTO workspace (id, slug, name) VALUES ('${WORKSPACE}', 'laura', 'Laura');
    INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${CREATOR}', '${WORKSPACE}', 'Laura');
  `);
  const add = async (handle: string, ref: string, status: string, detail: string | null) => {
    const r = await raw.query<{ id: string }>(
      `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_mode, status, status_detail, access_expires_at, refresh_expires_at)
       VALUES ($1, $2, 'tiktok', $3, $3, $4, '{user.info.basic,user.info.stats}', 'direct_oauth', $5, $6, $7, $8) RETURNING id`,
      [WORKSPACE, CREATOR, handle, ref, status, detail, VENCIDO, REFRESH_HASTA],
    );
    return r.rows[0]!.id;
  };
  ids = {
    renovable: await add('selva.renovable', 'vault:tt-renovable', 'active', null),
    revocado: await add('selva.revocada', 'vault:tt-revocado', 'active', null),
    enError: await add('selva.en.error', 'vault:tt-en-error', 'error', 'La plataforma no respondió a tiempo.'),
  };
  await raw.exec("SELECT set_config('app.workspace_id', '', false)");
}

before(async () => {
  guard = withoutNetwork();
  const fetch = new FixtureFetch([...(await loadFixtures('tiktok', [['user.info', 'ok']]))]);
  h = await startHarness({ jobs: allJobs, now: () => NOW, seed, env: {}, http: { fetch: fetch.fetch } });
  await h.secrets.set('vault:tt-renovable', RENOVABLE);
  await h.secrets.set('vault:tt-revocado', REVOCADO);
  await h.secrets.set('vault:tt-en-error', EN_ERROR);
}, SETUP_TIMEOUT);
after(async () => { await h.stop(); guard.restore(); });

test('tokenVencido: vencido, o a menos de un minuto de vencer', () => {
  const ahora = new Date('2026-09-25T05:10:00Z');
  const con = (accessExpiresAt: Date) => ({ accessToken: 'x', accessExpiresAt, scopes: [] });
  assert.equal(tokenVencido(con(new Date('2026-09-25T04:00:00Z')), ahora), true);
  assert.equal(tokenVencido(con(new Date('2026-09-25T05:10:30Z')), ahora), true, 'a 30 s de vencer no sirve para una lectura');
  assert.equal(tokenVencido(con(new Date('2026-09-25T05:12:00Z')), ahora), false);
});

test('collect.account_metrics: el access vencido se renueva en línea y la cuenta se lee; la revocada pasa a needs_reauth sin leer', async () => {
  await h.worker.boss.send('collect.account_metrics', { source: 'test', workspaceId: WORKSPACE });
  const run = await waitFor(async () => (await jobRuns(h.db, 'collect.account_metrics')).find((r) => r.status !== 'running'), { label: 'collect.account_metrics', timeoutMs: 30_000 });
  assert.equal(run.status, 'ok', run.error ?? '');
  const md = run.metadata as { snapshots: string[]; errored: string[]; transient: string[] };
  assert.deepEqual([...md.snapshots].sort(), [ids.renovable, ids.enError].sort(), 'las dos renovables se leen; la de 0 fallos y la que estaba en error');
  assert.deepEqual(md.errored, [ids.revocado]);
  assert.deepEqual(md.transient, []);

  // Dos renovaciones: una por cuenta renovable (la revocada también lo intentó y la plataforma dijo que no).
  assert.deepEqual([...h.refresher.calls.map((c) => c.outcome)].sort(), ['permanent', 'success', 'success'], 'hubo tres intentos de renovación, uno por cuenta');

  const conns = await h.db.query<{ id: string; status: string; status_detail: string | null; access_expires_at: Date | string; consecutive_failures: number }>(
    `SELECT id, status, status_detail, access_expires_at, consecutive_failures FROM social_connection`,
  );
  const by = new Map(conns.rows.map((c) => [c.id, c]));
  const renovable = by.get(ids.renovable)!;
  assert.equal(renovable.status, 'active');
  assert.ok(new Date(renovable.access_expires_at).getTime() > NOW.getTime(), 'la fecha de vencimiento es la nueva');
  assert.equal(renovable.consecutive_failures, 0);
  const revocado = by.get(ids.revocado)!;
  assert.equal(revocado.status, 'needs_reauth');
  assert.match(revocado.status_detail ?? '', /invalid_grant/);

  const avisos = await h.db.query<{ entity_id: string; kind: string }>(`SELECT entity_id, kind FROM notification WHERE kind = 'connection_error'`);
  assert.deepEqual(avisos.rows.map((a) => a.entity_id), [ids.revocado], 'solo la revocada avisa al creador');

  const snaps = await h.db.query<{ connection_id: string; followers: string | number | null; source: string }>(`SELECT connection_id, followers, source FROM account_metric_snapshot ORDER BY connection_id`);
  assert.deepEqual(snaps.rows.map((s) => s.connection_id).sort(), [ids.renovable, ids.enError].sort());
  assert.ok(snaps.rows.every((s) => Number(s.followers) === 412000 && s.source === 'api'));

  const log = await h.db.query<{ connection_id: string; endpoint: string; ok: boolean }>(`SELECT connection_id, endpoint, ok FROM api_call_log ORDER BY id`);
  const de = (id: string) => log.rows.filter((r) => r.connection_id === id).map((r) => `${r.endpoint}:${r.ok}`);
  assert.deepEqual(de(ids.renovable), ['oauth.refresh:true', 'tiktok.user.info:true'], 'primero la renovación, después la lectura con el token nuevo');
  assert.deepEqual(de(ids.revocado), ['oauth.refresh:false'], 'ni una lectura con el token viejo');
  assert.equal(guard.attempts, 0);

  // Ningún token, viejo ni nuevo, en el log.
  const text = h.sink.text();
  for (const s of [RENOVABLE.accessToken, RENOVABLE.refreshToken, REVOCADO.accessToken, 'renewed-']) assert.ok(!text.includes(s), `el log no lleva ${s}`);
});

test('oauth.refresh: una fila en error también se renueva, y conserva su estado y su detalle', async () => {
  const antes = await h.db.query<{ status: string; status_detail: string | null; consecutive_failures: number }>(`SELECT status, status_detail, consecutive_failures FROM social_connection WHERE id = $1`, [ids.enError]);
  // La corrida anterior la leyó con el token renovado y la dejó 'active' (es el camino de collect: una lectura buena limpia el error).
  assert.equal(antes.rows[0]!.status, 'active');
  // Se devuelve a 'error' con el access otra vez vencido para probar el job solo.
  await h.db.query(`UPDATE social_connection SET status = 'error', status_detail = 'La cuenta ya no existe en la plataforma.', consecutive_failures = 3, access_expires_at = $2 WHERE id = $1`, [ids.enError, VENCIDO]);
  await h.secrets.set('vault:tt-en-error', EN_ERROR);

  const llamadas = h.refresher.calls.length;
  await h.worker.boss.send('oauth.refresh', { source: 'test', workspaceId: WORKSPACE });
  const run = await waitFor(async () => (await jobRuns(h.db, 'oauth.refresh')).find((r) => r.status !== 'running'), { label: 'oauth.refresh', timeoutMs: 30_000 });
  assert.equal(run.status, 'ok', run.error ?? '');
  const md = run.metadata as { renewed: string[]; needsReauth: string[]; transient: string[] };
  assert.deepEqual(md.renewed, [ids.enError], 'la fila en error entra en la selección');
  assert.deepEqual(md.needsReauth, []);
  assert.equal(h.refresher.calls.length, llamadas + 1);

  const despues = await h.db.query<{ status: string; status_detail: string | null; consecutive_failures: number; access_expires_at: Date | string }>(
    `SELECT status, status_detail, consecutive_failures, access_expires_at FROM social_connection WHERE id = $1`, [ids.enError],
  );
  const fila = despues.rows[0]!;
  assert.equal(fila.status, 'error', 'el token renovado no arregla lo que la lectura dijo');
  assert.equal(fila.status_detail, 'La cuenta ya no existe en la plataforma.');
  assert.equal(fila.consecutive_failures, 3);
  assert.ok(new Date(fila.access_expires_at).getTime() > NOW.getTime(), 'pero la fecha del acceso sí es la nueva');
});
