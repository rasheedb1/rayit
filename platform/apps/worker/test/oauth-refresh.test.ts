/**
 * Caso 5 de CON-2 · Fase 5: tres conexiones, tres destinos, ningún token
 * en job_run ni en los logs.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTokenRefresher } from '@mc/connectors';
import { allJobs } from '../src/jobs/index.ts';
import { mapLimit } from '../src/jobs/conexiones/oauth-refresh.ts';
import { jobRuns, startHarness, waitFor, type Harness } from './helpers/harness.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';

const NOW = new Date('2026-09-21T12:00:00Z');
const minutes = (m: number) => new Date(NOW.getTime() + m * 60_000);

interface Seed {
  workspaceId: string;
  otherWorkspaceId: string;
  near: string;
  far: string;
  revoked: string;
  flaky: string;
  csv: string;
  other: string;
}

const SECRETS = {
  near: { accessToken: 'ACCESS-NEAR-9f8e7d', refreshToken: 'REFRESH-NEAR-1a2b3c' },
  far: { accessToken: 'ACCESS-FAR-4d5e6f', refreshToken: 'REFRESH-FAR-7g8h9i' },
  revoked: { accessToken: 'revoked-ACCESS-REV-0j1k2l', refreshToken: 'REFRESH-REV-3m4n5o' },
  flaky: { accessToken: 'flaky-ACCESS-FLK-6p7q8r', refreshToken: 'REFRESH-FLK-9s0t1u' },
  other: { accessToken: 'ACCESS-OTHER-2v3w4x', refreshToken: 'REFRESH-OTHER-5y6z7a' },
};
const ALL_TOKEN_STRINGS = Object.values(SECRETS).flatMap((s) => [s.accessToken, s.refreshToken]);

let seed: Seed;

async function seedConnections(db: PgliteDatabase): Promise<void> {
  const raw = db.raw;
  const ws = await raw.query<{ id: string }>(`INSERT INTO workspace (slug, name) VALUES ('ws-a', 'A') RETURNING id`);
  const ws2 = await raw.query<{ id: string }>(`INSERT INTO workspace (slug, name) VALUES ('ws-b', 'B') RETURNING id`);
  const workspaceId = ws.rows[0]!.id;
  const otherWorkspaceId = ws2.rows[0]!.id;
  const cp = await raw.query<{ id: string }>(`INSERT INTO creator_profile (workspace_id, display_name) VALUES ($1, 'A') RETURNING id`, [workspaceId]);
  const cp2 = await raw.query<{ id: string }>(`INSERT INTO creator_profile (workspace_id, display_name) VALUES ($1, 'B') RETURNING id`, [otherWorkspaceId]);
  const insert = async (wsId: string, creator: string, ext: string, ref: string, expires: Date, extra = '') => {
    const r = await raw.query<{ id: string }>(
      `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_expires_at, refresh_expires_at ${extra ? ', ' + extra.split('=')[0] : ''})
       VALUES ($1, $2, 'tiktok', $3, $4, $5, '{user.info.basic}', $6, $7 ${extra ? ', ' + extra.split('=')[1] : ''}) RETURNING id`,
      [wsId, creator, ext, '@' + ext, ref, expires, minutes(60 * 24 * 200)],
    );
    return r.rows[0]!.id;
  };
  seed = {
    workspaceId,
    otherWorkspaceId,
    near: await insert(workspaceId, cp.rows[0]!.id, 'near', 'vault:near', minutes(10)),
    far: await insert(workspaceId, cp.rows[0]!.id, 'far', 'vault:far', minutes(180)),
    revoked: await insert(workspaceId, cp.rows[0]!.id, 'revoked', 'vault:revoked', minutes(5)),
    flaky: await insert(workspaceId, cp.rows[0]!.id, 'flaky', 'vault:flaky', minutes(20)),
    csv: await insert(workspaceId, cp.rows[0]!.id, 'csv', 'vault:csv', minutes(1), "access_mode='manual_csv'"),
    other: await insert(otherWorkspaceId, cp2.rows[0]!.id, 'other', 'vault:other', minutes(15)),
  };
}

let h: Harness;

before(async () => {
  h = await startHarness({
    jobs: allJobs,
    now: () => NOW,
    seed: seedConnections,
    refreshers: [new FakeTokenRefresher('tiktok', { now: () => NOW })],
    env: { OAUTH_REFRESH_MARGIN_MINUTES: '30' },
  });
  for (const [key, s] of Object.entries(SECRETS)) {
    await h.secrets.set(`vault:${key}`, { ...s, accessExpiresAt: minutes(10), refreshExpiresAt: minutes(60 * 24 * 200), scopes: ['user.info.basic'] });
  }
});

after(async () => {
  await h.stop();
});

interface ConnRow extends Record<string, unknown> {
  id: string;
  status: string;
  status_detail: string | null;
  access_expires_at: Date | string;
  consecutive_failures: number;
  last_error_at: Date | string | null;
}

async function conn(id: string): Promise<ConnRow> {
  const { rows } = await h.db.query<ConnRow>(`SELECT id, status, status_detail, access_expires_at, consecutive_failures, last_error_at FROM social_connection WHERE id = $1`, [id]);
  return rows[0]!;
}

test('5 · renueva la que vence pronto, deja intacta la lejana y marca needs_reauth la revocada', async () => {
  const jobId = await h.worker.boss.send('oauth.refresh', { source: 'test' });
  // max_attempts = 5 con fallos transitorios: esperamos la primera corrida (partial) y paramos ahí.
  const run = await waitFor(async () => (await jobRuns(h.db, 'oauth.refresh')).find((r) => r.status !== 'running'), { label: 'primera corrida' });

  assert.equal(run.status, 'partial', 'renovó unas y una falló transitoriamente');
  assert.equal(run.items_processed, 3, 'near + other renovadas, revoked resuelta como needs_reauth');
  assert.equal(run.items_failed, 1, 'flaky');
  const md = run.metadata as { due: number; renewed: string[]; needsReauth: string[]; transient: string[]; marginMinutes: number };
  assert.equal(md.due, 4, 'far está fuera del margen y csv no es direct_oauth');
  assert.equal(md.marginMinutes, 30);
  assert.deepEqual([...md.renewed].sort(), [seed.near, seed.other].sort());
  assert.deepEqual(md.needsReauth, [seed.revoked]);
  assert.deepEqual(md.transient, [seed.flaky]);
  assert.equal(run.metadata['bossJobId'], jobId);

  // near: renovada, con fecha nueva y activa
  const near = await conn(seed.near);
  assert.equal(near.status, 'active');
  assert.equal(near.status_detail, null);
  assert.equal(new Date(near.access_expires_at).toISOString(), '2026-09-22T12:00:00.000Z', 'vence 24 h después de "ahora"');
  assert.equal(near.consecutive_failures, 0);
  const nearTokens = await h.secrets.get('vault:near');
  assert.match(nearTokens!.accessToken, /^renewed-/);
  assert.notEqual(nearTokens!.refreshToken, SECRETS.near.refreshToken, 'el refresh token rotó en el almacén');

  // far: intacta
  const far = await conn(seed.far);
  assert.equal(far.status, 'active');
  assert.equal(new Date(far.access_expires_at).toISOString(), minutes(180).toISOString());
  assert.equal((await h.secrets.get('vault:far'))!.accessToken, SECRETS.far.accessToken);

  // revoked: needs_reauth con causa en español y notificación
  const revoked = await conn(seed.revoked);
  assert.equal(revoked.status, 'needs_reauth');
  assert.match(revoked.status_detail!, /volver a autorizar/);
  assert.match(revoked.status_detail!, /invalid_grant/);
  assert.equal(revoked.consecutive_failures, 1);
  assert.ok(revoked.last_error_at);
  const notes = await h.db.query<{ kind: string; severity: string; title_es: string; body_es: string; entity_id: string; workspace_id: string; action_url: string }>(
    `SELECT kind, severity, title_es, body_es, entity_id, workspace_id, action_url FROM notification`,
  );
  assert.equal(notes.rows.length, 1);
  assert.equal(notes.rows[0]!.kind, 'connection_error');
  assert.equal(notes.rows[0]!.severity, 'critical');
  assert.equal(notes.rows[0]!.entity_id, seed.revoked);
  assert.equal(notes.rows[0]!.workspace_id, seed.workspaceId);
  assert.match(notes.rows[0]!.title_es, /TikTok/);
  assert.equal(notes.rows[0]!.action_url, '/conexiones');

  // flaky: sigue activa, con el fallo anotado
  const flaky = await conn(seed.flaky);
  assert.equal(flaky.status, 'active');
  assert.equal(flaky.consecutive_failures, 1);
  assert.equal((await h.secrets.get('vault:flaky'))!.accessToken, SECRETS.flaky.accessToken, 'no se tocó el almacén');

  // csv: ni se miró (no es direct_oauth)
  assert.equal((await conn(seed.csv)).status, 'active');

  // api_call_log: una fila por llamada real (near, other, revoked, flaky), sin cuerpo
  const calls = await h.db.query<{ connection_id: string; endpoint: string; http_status: number; ok: boolean; error_code: string | null; duration_ms: number; rate_limited: boolean }>(
    `SELECT connection_id, endpoint, http_status, ok, error_code, duration_ms, rate_limited FROM api_call_log ORDER BY id`,
  );
  assert.equal(calls.rows.length, 4);
  assert.ok(calls.rows.every((c) => c.endpoint === 'oauth.refresh' && typeof c.duration_ms === 'number'));
  const byConn = new Map(calls.rows.map((c) => [c.connection_id, c]));
  assert.equal(byConn.get(seed.near)?.ok, true);
  assert.equal(byConn.get(seed.near)?.http_status, 200);
  assert.equal(byConn.get(seed.revoked)?.ok, false);
  assert.equal(byConn.get(seed.revoked)?.error_code, 'invalid_grant');
  assert.equal(byConn.get(seed.revoked)?.http_status, 400);
  assert.equal(byConn.get(seed.flaky)?.error_code, 'upstream_unavailable');
  assert.equal(byConn.get(seed.flaky)?.http_status, 503);

  // Ningún token en job_run.metadata ni en los logs.
  const metadataText = JSON.stringify(run.metadata);
  const logText = h.sink.text();
  for (const t of ALL_TOKEN_STRINGS) {
    assert.ok(!metadataText.includes(t), `token en metadata: ${t}`);
    assert.ok(!logText.includes(t), `token en logs: ${t}`);
  }
  assert.ok(!logText.includes('renewed-'), 'ni siquiera el token renovado aparece en los logs');
  // mc_worker no tiene acceso al esquema pgboss (a propósito); se mira como superusuario.
  const jobTable = await h.db.raw.query<{ output: unknown; data: unknown }>(`SELECT output, data FROM pgboss.job WHERE name = 'oauth.refresh'`);
  const bossText = JSON.stringify(jobTable.rows);
  for (const t of ALL_TOKEN_STRINGS) assert.ok(!bossText.includes(t), `token en pgboss.job: ${t}`);
});

test('el reintento solo toca lo que quedó pendiente (flaky), porque near ya no vence pronto', async () => {
  const runs = await waitFor(async () => {
    const r = await jobRuns(h.db, 'oauth.refresh');
    return r.length >= 2 && r[1]!.status !== 'running' ? r : null;
  }, { timeoutMs: 20_000, label: 'segundo intento' });
  const second = runs[1]!;
  assert.equal(second.attempt, 2);
  const md = second.metadata as { due: number; renewed: string[]; needsReauth: string[]; transient: string[] };
  assert.equal(md.due, 1, 'solo flaky sigue dentro del margen y activa');
  assert.deepEqual(md.transient, [seed.flaky]);
  assert.deepEqual(md.renewed, []);
  assert.equal((await conn(seed.flaky)).consecutive_failures, 2);
  assert.equal(h.refresher.calls.length, 0, 'el refresher del harness no se usó: el job usó el registrado');
});

test('payload con connectionId renueva esa conexión aunque no esté dentro del margen', async () => {
  const before = (await jobRuns(h.db, 'oauth.refresh')).length;
  await h.worker.boss.send('oauth.refresh', { connectionId: seed.far, workspaceId: seed.workspaceId });
  const run = await waitFor(async () => {
    const r = await jobRuns(h.db, 'oauth.refresh');
    const mine = r.filter((x) => x.metadata['due'] === 1 && (x.metadata['renewed'] as string[])?.includes(seed.far));
    return r.length > before && mine.find((x) => x.status !== 'running');
  }, { timeoutMs: 20_000, label: 'far por id' });
  assert.equal(run.status, 'ok');
  const far = await conn(seed.far);
  assert.equal(new Date(far.access_expires_at).toISOString(), '2026-09-22T12:00:00.000Z');
});

test('refresh_expires_at vencido pasa a needs_reauth sin llamar a la plataforma', async () => {
  const raw = h.db.raw;
  const cp = await raw.query<{ id: string }>(`SELECT id FROM creator_profile WHERE workspace_id = $1`, [seed.workspaceId]);
  const r = await raw.query<{ id: string }>(
    `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, secret_ref, access_expires_at, refresh_expires_at)
     VALUES ($1, $2, 'youtube', 'yt-old', 'vault:old', $3, $4) RETURNING id`,
    [seed.workspaceId, cp.rows[0]!.id, minutes(5), minutes(-1)],
  );
  const id = r.rows[0]!.id;
  await h.secrets.set('vault:old', { accessToken: 'ACCESS-OLD', accessExpiresAt: minutes(5), scopes: [] });
  const callsBefore = Number((await h.db.query<{ n: number | string }>(`SELECT count(*)::int AS n FROM api_call_log`)).rows[0]!.n);
  await h.worker.boss.send('oauth.refresh', { connectionId: id });
  await waitFor(async () => (await conn(id)).status === 'needs_reauth', { timeoutMs: 20_000, label: 'old' });
  const row = await conn(id);
  assert.match(row.status_detail!, /permiso de renovación venció/);
  const callsAfter = Number((await h.db.query<{ n: number | string }>(`SELECT count(*)::int AS n FROM api_call_log`)).rows[0]!.n);
  assert.equal(callsAfter, callsBefore, 'sin llamada a la API');
  const notes = await h.db.query<{ title_es: string }>(`SELECT title_es FROM notification WHERE entity_id = $1`, [id]);
  assert.match(notes.rows[0]!.title_es, /YouTube/);
});

test('mapLimit respeta el límite de concurrencia', async () => {
  let active = 0;
  let peak = 0;
  const seen: number[] = [];
  await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    seen.push(n);
    active--;
  });
  assert.equal(peak, 3);
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
});
