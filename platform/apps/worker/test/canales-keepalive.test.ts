/**
 * VEN-9 · sales.channels_keepalive sobre Postgres embebido, como
 * mc_worker, con el vault real (EncryptedSecretStore) y los dobles de
 * Google y Unipile (FakeGmail, FakeUnipile). Sin red.
 *
 * El «terminado cuando»: un Gmail con el token por vencer se refresca y el
 * token nuevo queda en el vault con la MISMA ref (una fila por concesión).
 * Además: un token lejos de vencer no se toca; un refresh token revocado
 * deja la cuenta en needs_reconnect con un aviso; un fallo transitorio no
 * la tumba; Unipile caído la marca y Unipile de vuelta la recupera; sin
 * llaves no se toca nada; y la limpieza borra lo pendiente viejo y suelta
 * lo desconectado en el proveedor (sales.channels_release): Google
 * revocado y token fuera del vault; cuenta y avisos borrados en Unipile,
 * salvo que la misma cuenta siga viva en otra fila.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EncryptedSecretStore, FakeGmail, FakeUnipile, keyringOf, TokenCipher, withoutNetwork, type NetworkGuard, type OAuthTokens } from '@mc/connectors';
import { allJobs } from '../src/jobs/index.ts';
import { CHANNELS_KEEPALIVE_JOB_ID, runChannelsKeepalive } from '../src/jobs/ventas/canales.keepalive.ts';
import { CHANNELS_RELEASE_JOB_ID, runChannelsRelease } from '../src/jobs/ventas/canales.release.ts';
import type { PgliteDatabase } from '../src/runner/db-pglite.ts';
import { openTestDatabase } from './helpers/harness.ts';

const NOW = new Date('2026-09-23T06:30:00Z');
const WS = '0000000b-0000-4000-8000-000000000001';
const CREATOR = '0000000b-0000-4000-8000-000000000003';
const GMAIL_POR_VENCER = '0000000b-0000-4000-8000-0000000ac001';
const GMAIL_LEJOS = '0000000b-0000-4000-8000-0000000ac002';
const GMAIL_REVOCADO = '0000000b-0000-4000-8000-0000000ac003';
const GMAIL_DESCONECTADO = '0000000b-0000-4000-8000-0000000ac004';
const LINKEDIN = '0000000b-0000-4000-8000-0000000ac005';
const INSTAGRAM_CAIDO = '0000000b-0000-4000-8000-0000000ac006';
const PENDIENTE_VIEJA = '0000000b-0000-4000-8000-0000000ac007';
const LINKEDIN_DESCONECTADO = '0000000b-0000-4000-8000-0000000ac008';
const LINKEDIN_COMPARTIDO = '0000000b-0000-4000-8000-0000000ac009';
const PENDIENTE_FALLIDA = '0000000b-0000-4000-8000-0000000ac00a';
const WS_OTRO = '0000000b-0000-4000-8000-000000000f01';
const ref = (n: number) => `enc:gmail:0000000b-0000-4000-8000-00000000f00${n}`;

let db: PgliteDatabase;
let store: EncryptedSecretStore;
let guard: NetworkGuard;
const gmail = new FakeGmail({ now: () => NOW });
const unipile = new FakeUnipile();

const tokens = (refreshToken: string, minutes: number): OAuthTokens => ({
  accessToken: `access-${refreshToken}`, refreshToken, accessExpiresAt: new Date(NOW.getTime() + minutes * 60_000), scopes: ['gmail.send', 'gmail.modify'],
});

interface Cuenta extends Record<string, unknown> { status: string; secret_ref: string | null; last_error: string | null; last_ok_at: Date | null }
async function cuenta(id: string): Promise<Cuenta | undefined> {
  const { rows } = await db.raw.query<Cuenta>(`SELECT status, secret_ref, last_error, last_ok_at FROM outreach_channel_account WHERE id = $1`, [id]);
  return rows[0];
}

before(async () => {
  guard = withoutNetwork();
  db = await openTestDatabase();
  store = new EncryptedSecretStore({ db, cipher: new TokenCipher(keyringOf({ v1: new Uint8Array(randomBytes(32)) })), workspaceId: WS });
  await db.raw.exec(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS}', 'keepalive', 'Laura', 'America/Bogota');
    INSERT INTO creator_profile (id, workspace_id, display_name, handle) VALUES ('${CREATOR}', '${WS}', 'Laura', 'laura.keepalive');
  `);
  await store.set(ref(1), tokens('rt-1', 30));
  await store.set(ref(2), tokens('rt-2', 26 * 60));
  await store.set(ref(3), tokens('rt-3', 30));
  await store.set(ref(4), tokens('rt-4', 30));
  gmail.revoked.add('rt-3');
  await db.raw.exec(`
    INSERT INTO outreach_channel_account (id, workspace_id, creator_id, channel, provider, provider_account_id, display_name, secret_ref, status, scopes, updated_at) VALUES
      ('${GMAIL_POR_VENCER}', '${WS}', '${CREATOR}', 'email', 'gmail_oauth', 'a@x.test', 'a@x.test', '${ref(1)}', 'connected', '{gmail.send}', now()),
      ('${GMAIL_LEJOS}', '${WS}', '${CREATOR}', 'email', 'gmail_oauth', 'b@x.test', 'b@x.test', '${ref(2)}', 'connected', '{gmail.send}', now()),
      ('${GMAIL_REVOCADO}', '${WS}', '${CREATOR}', 'email', 'gmail_oauth', 'c@x.test', 'c@x.test', '${ref(3)}', 'connected', '{gmail.send}', now()),
      ('${GMAIL_DESCONECTADO}', '${WS}', '${CREATOR}', 'email', 'gmail_oauth', 'd@x.test', 'd@x.test', '${ref(4)}', 'disconnected', '{gmail.send}', now()),
      ('${LINKEDIN}', '${WS}', '${CREATOR}', 'linkedin', 'unipile', 'acc_li', 'Laura', NULL, 'needs_reconnect', '{}', now()),
      ('${INSTAGRAM_CAIDO}', '${WS}', '${CREATOR}', 'instagram_dm', 'unipile', 'acc_ig', '@laura', NULL, 'connected', '{}', now()),
      ('${PENDIENTE_VIEJA}', '${WS}', '${CREATOR}', 'linkedin', 'unipile', 'pending:${'p'.repeat(43)}', NULL, NULL, 'pending', '{}', '${new Date(NOW.getTime() - 72 * 3600_000).toISOString()}'),
      ('${PENDIENTE_FALLIDA}', '${WS}', '${CREATOR}', 'linkedin', 'unipile', 'pending:${'q'.repeat(43)}', NULL, NULL, 'disconnected', '{}', now());
    INSERT INTO outreach_channel_account (id, workspace_id, creator_id, channel, provider, provider_account_id, display_name, status, provider_webhook_ids) VALUES
      ('${LINKEDIN_DESCONECTADO}', '${WS}', '${CREATOR}', 'linkedin', 'unipile', 'acc_li_viejo', 'Laura', 'disconnected', '{wh_m,wh_s}');
    INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS_OTRO}', 'keepalive-otro', 'Otra', 'America/Bogota');
    -- La misma cuenta de Unipile, desconectada aquí y viva en otro espacio: no se borra en Unipile.
    INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, status, provider_webhook_ids) VALUES
      ('${LINKEDIN_COMPARTIDO}', '${WS}', 'linkedin', 'unipile', 'acc_compartida', 'disconnected', '{wh_c}'),
      ('0000000b-0000-4000-8000-0000000ac0f1', '${WS_OTRO}', 'linkedin', 'unipile', 'acc_compartida', 'connected', '{}');
  `);
  unipile.addAccount({ id: 'acc_li', health: 'ok' });
  unipile.addAccount({ id: 'acc_ig', provider: 'INSTAGRAM', health: 'needs_reconnect', rawStatus: 'CREDENTIALS' });
  unipile.addAccount({ id: 'acc_li_viejo' });
  unipile.addAccount({ id: 'acc_compartida' });
});

interface Soltada extends Record<string, unknown> { released_at: Date | null; provider_webhook_ids: string[] }
async function soltada(id: string): Promise<Soltada | undefined> {
  const { rows } = await db.raw.query<Soltada>(`SELECT released_at, provider_webhook_ids FROM outreach_channel_account WHERE id = $1`, [id]);
  return rows[0];
}

after(async () => {
  guard.restore();
  await db.close();
  assert.equal(guard.attempts, 0, 'el keepalive no salió a la red');
});

test('los dos jobs están registrados con el id de job_definition (0038, 0040)', async () => {
  assert.ok(allJobs.some((j) => j.id === CHANNELS_KEEPALIVE_JOB_ID));
  assert.ok(allJobs.some((j) => j.id === CHANNELS_RELEASE_JOB_ID));
  const release = await db.raw.query<{ default_cron: string }>(`SELECT default_cron FROM job_definition WHERE id = $1`, [CHANNELS_RELEASE_JOB_ID]);
  assert.equal(release.rows[0]?.default_cron, '*/5 * * * *');
  const { rows } = await db.raw.query<{ default_cron: string }>(`SELECT default_cron FROM job_definition WHERE id = $1`, [CHANNELS_KEEPALIVE_JOB_ID]);
  assert.equal(rows[0]?.default_cron, '30 6 * * *');
});

test('sin llaves de Google ni de Unipile no toca ninguna cuenta, pero limpia', async () => {
  const r = await runChannelsKeepalive({ db, secrets: store, google: null, unipile: null, now: NOW });
  assert.deepEqual(r.skipped, { gmail: true, unipile: true });
  assert.equal(gmail.refreshCalls, 0);
  assert.equal((await cuenta(GMAIL_POR_VENCER))?.status, 'connected');
  assert.equal((await store.get(ref(1)))?.accessToken, 'access-rt-1');
  // Borrar lo pendiente viejo no necesita llaves: es de la base.
  assert.equal(r.pendingRemoved, 1);
  // Soltar en el proveedor sí: sin llaves, lo desconectado espera (el token sigue cifrado en el vault para poder revocarlo).
  assert.equal(r.release.waitingForKeys, 3, 'el Gmail y los dos LinkedIn desconectados esperan');
  assert.equal(r.release.secretsPurged, 0);
  assert.ok(await store.get(ref(4)), 'el token del Gmail desconectado sigue: sin llaves no se puede revocar');
  assert.equal((await soltada(LINKEDIN_DESCONECTADO))?.released_at, null);
  // La pendiente que falló no tiene nada en el proveedor: se suelta sin llaves.
  assert.ok((await soltada(PENDIENTE_FALLIDA))?.released_at);
});

test('el Gmail por vencer se refresca con la misma ref; el lejano no; el revocado pide reconectar con aviso', async () => {
  const before = gmail.refreshCalls;
  const r = await runChannelsKeepalive({ db, secrets: store, google: gmail, unipile, now: NOW });

  const nuevo = await store.get(ref(1));
  assert.ok(nuevo && nuevo.accessToken !== 'access-rt-1', 'hay un access token nuevo');
  assert.equal(nuevo.refreshToken, 'rt-1', 'el refresh token se conserva');
  assert.ok(nuevo.accessExpiresAt.getTime() > NOW.getTime() + 30 * 60_000);
  const a = await cuenta(GMAIL_POR_VENCER);
  assert.equal(a?.secret_ref, ref(1), 'una fila por concesión: la ref no cambia');
  assert.equal(a?.status, 'connected');
  assert.equal(a?.last_error, null);
  const { rows: secretos } = await db.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM connection_secret WHERE workspace_id = $1`, [WS]);
  assert.equal(secretos[0]!.n, 3, 'ninguna fila nueva en el vault (y la del desconectado ya se borró)');

  assert.equal((await store.get(ref(2)))?.accessToken, 'access-rt-2', 'lejos de vencer no se toca');
  assert.equal(r.gmailUnchanged, 1);
  assert.equal(r.gmailRefreshed, 1);
  assert.equal(gmail.refreshCalls - before, 2, 'solo se pidió para el que vencía y el revocado');

  const revocado = await cuenta(GMAIL_REVOCADO);
  assert.equal(revocado?.status, 'needs_reconnect');
  assert.match(revocado?.last_error ?? '', /Google ya no acepta/);
  const { rows: avisos } = await db.raw.query<{ entity_id: string; action_url: string }>(
    `SELECT entity_id, action_url FROM notification WHERE kind = 'connection_error' AND workspace_id = $1 ORDER BY entity_id`, [WS],
  );
  assert.deepEqual(avisos.map((x) => x.entity_id), [GMAIL_REVOCADO, INSTAGRAM_CAIDO]);
  assert.ok(avisos.every((x) => x.action_url === '/ventas/canales'));

  // Unipile: el LinkedIn volvió (Unipile dice OK) y el Instagram cayó.
  assert.equal((await cuenta(LINKEDIN))?.status, 'connected');
  assert.equal((await cuenta(INSTAGRAM_CAIDO))?.status, 'needs_reconnect');
  assert.equal(r.recovered, 1);
  assert.equal(r.markedDown, 2);

  // Limpieza: la pendiente vieja no está; el Gmail desconectado se revocó en Google y su token salió del vault.
  assert.equal(await cuenta(PENDIENTE_VIEJA), undefined);
  assert.deepEqual(gmail.revokeCalls, ['rt-4']);
  assert.equal(r.release.googleRevoked, 1);
  assert.equal(r.release.secretsPurged, 1);
  assert.equal((await cuenta(GMAIL_DESCONECTADO))?.secret_ref, null);
  assert.equal(await store.get(ref(4)), null);
  assert.ok((await soltada(GMAIL_DESCONECTADO))?.released_at);
  // Unipile: los dos avisos y la cuenta desconectada, borrados; la compartida solo pierde su aviso.
  assert.deepEqual(unipile.deletedWebhooks.sort(), ['wh_c', 'wh_m', 'wh_s']);
  assert.deepEqual(unipile.deletedAccounts, ['acc_li_viejo'], 'acc_compartida sigue viva en otro espacio: no se borra');
  assert.equal(r.release.sharedKept, 1);
  assert.deepEqual(await soltada(LINKEDIN_DESCONECTADO).then((x) => x?.provider_webhook_ids), []);
  assert.ok(unipile.calls.filter((c) => c.method === 'deleteAccount').every((c) => c.channelAccountId === LINKEDIN_DESCONECTADO), 'con la cuenta de canal para la bitácora');
});

test('sales.channels_release: lo ya soltado no se vuelve a tocar; desconectar otra vez vuelve a la cola', async () => {
  const antes = unipile.deletedAccounts.length;
  const r = await runChannelsRelease({ db, secrets: store, google: gmail, unipile, now: NOW });
  assert.equal(r.released, 0);
  assert.equal(unipile.deletedAccounts.length, antes);
  // Reconectada y vuelta a desconectar: el disparador de 0040 la deja otra vez por soltar.
  await db.raw.query(`UPDATE outreach_channel_account SET status = 'connected' WHERE id = $1`, [LINKEDIN_DESCONECTADO]);
  await db.raw.query(`UPDATE outreach_channel_account SET status = 'disconnected' WHERE id = $1`, [LINKEDIN_DESCONECTADO]);
  assert.equal((await soltada(LINKEDIN_DESCONECTADO))?.released_at, null);
  unipile.addAccount({ id: 'acc_li_viejo' });
  unipile.failNext('deleteAccount', 'transient', 'errors/service_unavailable', 503);
  const fallo = await runChannelsRelease({ db, secrets: store, google: gmail, unipile, now: NOW });
  assert.equal(fallo.failed, 1, 'un 503 deja la fila en la cola');
  assert.equal((await soltada(LINKEDIN_DESCONECTADO))?.released_at, null);
  const ok = await runChannelsRelease({ db, secrets: store, google: gmail, unipile, now: NOW });
  assert.equal(ok.unipileAccountsDeleted, 1);
  assert.ok((await soltada(LINKEDIN_DESCONECTADO))?.released_at);
});

test('un fallo transitorio de Google no tumba la cuenta: deja el motivo y cuenta el fallo', async () => {
  gmail.failNext('transient', 'backendError', 503);
  const r = await runChannelsKeepalive({ db, secrets: store, google: gmail, unipile: null, now: NOW });
  assert.equal(r.failed, 1);
  const a = await cuenta(GMAIL_POR_VENCER);
  assert.equal(a?.status, 'connected');
  assert.match(a?.last_error ?? '', /mañana/);
});

test('una segunda corrida no vuelve a avisar de lo que ya estaba caído', async () => {
  const r = await runChannelsKeepalive({ db, secrets: store, google: gmail, unipile, now: NOW });
  assert.equal(r.markedDown, 0);
  const { rows } = await db.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM notification WHERE kind = 'connection_error' AND workspace_id = $1`, [WS]);
  assert.equal(rows[0]!.n, 2);
});
