import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { PostgresOutreachCallLog } from '../src/outreach/log.ts';
import { CREATOR_ID, executor, openMigratedPglite, seedConnections, WORKSPACE_ID } from './helpers/pglite.ts';

const ACCOUNT = '00000005-0000-4000-8000-0000000ac0f1';
let db: PGlite;

before(async () => {
  db = await openMigratedPglite();
  await seedConnections(db);
  await db.exec(`
    INSERT INTO outreach_channel_account (id, workspace_id, creator_id, channel, provider, provider_account_id, status)
    VALUES ('${ACCOUNT}', '${WORKSPACE_ID}', '${CREATOR_ID}', 'linkedin', 'unipile', 'acc_li_0001', 'connected');
  `);
});
after(async () => { await db.close(); });

test('api_call_log guarda las llamadas de outreach con provider y cuenta de canal (canales_outreach)', async () => {
  const sink = new PostgresOutreachCallLog(executor(db));
  await sink.record({
    provider: 'unipile', channel_account_id: ACCOUNT, endpoint: 'unipile.users.invite', http_status: 422, ok: false,
    error_code: 'errors/limit_exceeded', error_message: 'Límite', duration_ms: 12, rate_limited: true, retry_after_s: null,
  });
  await sink.record({
    provider: 'gmail', channel_account_id: null, endpoint: 'google.oauth.token', http_status: 400, ok: false,
    error_code: 'invalid_grant', error_message: null, duration_ms: 5, rate_limited: false, retry_after_s: null,
  });
  const { rows } = await db.query<{ provider: string; platform_id: string | null; channel_account_id: string | null }>(
    // Por proveedor y no por llegada: las dos van seguidas, y el reloj de
    // PGlite es de milisegundos (desde 0082 no hay id que las ordene).
    `SELECT provider, platform_id, channel_account_id FROM api_call_log WHERE provider IS NOT NULL ORDER BY provider`,
  );
  assert.deepEqual(rows, [
    { provider: 'gmail', platform_id: null, channel_account_id: null },
    { provider: 'unipile', platform_id: null, channel_account_id: ACCOUNT },
  ]);
});

test('una fila es de una red social o de un proveedor de outreach, nunca de los dos ni de ninguno', async () => {
  await assert.rejects(db.query(`INSERT INTO api_call_log (platform_id, provider, endpoint, ok) VALUES ('tiktok', 'gmail', 'x', true)`), /api_call_log_origin_check/);
  await assert.rejects(db.query(`INSERT INTO api_call_log (endpoint, ok) VALUES ('x', true)`), /api_call_log_origin_check/);
  await assert.rejects(
    db.query(`INSERT INTO api_call_log (platform_id, channel_account_id, endpoint, ok) VALUES ('tiktok', '${ACCOUNT}', 'x', true)`),
    /api_call_log_channel_account_check/,
  );
});

test('borrar la cuenta de canal deja la bitácora con channel_account_id NULL', async () => {
  await db.query(`DELETE FROM outreach_channel_account WHERE id = $1`, [ACCOUNT]);
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM api_call_log WHERE endpoint = 'unipile.users.invite' AND channel_account_id IS NULL`);
  assert.equal(rows[0]!.n, 1);
});
