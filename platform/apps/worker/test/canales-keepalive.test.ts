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
import {
  EncryptedSecretStore, keyringOf, signChannelState, TokenCipher, webhookSecretFingerprint, withoutNetwork, type NetworkGuard, type OAuthTokens,
} from '@mc/connectors';
import { FakeGmail, FakeUnipile } from '@mc/connectors/testing';
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
  assert.equal(rows[0]?.default_cron, '17 * * * *', 'cada hora, por lotes (0042)');
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
  assert.equal(revocado?.last_error, 'gmail_revoked', 'un código: la pantalla lo traduce');
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

test('un fallo transitorio de Google no tumba la cuenta: deja el código transient (nunca el texto del proveedor) y cuenta el fallo', async () => {
  // Ya se miró en esta hora: vuelve a la cola como si hubiera pasado un día.
  await db.raw.query(`UPDATE outreach_channel_account SET keepalive_checked_at = NULL WHERE id = $1`, [GMAIL_POR_VENCER]);
  gmail.failNext('transient', 'backendError', 503);
  const r = await runChannelsKeepalive({ db, secrets: store, google: gmail, unipile: null, now: NOW });
  assert.equal(r.failed, 1);
  const a = await cuenta(GMAIL_POR_VENCER);
  assert.equal(a?.status, 'connected');
  assert.equal(a?.last_error, 'transient', 'un código; la frase la pone la pantalla');
  assert.doesNotMatch(a?.last_error ?? '', /backendError|Internal|error/i, 'ni el código ni el mensaje de Google');
});

test('una segunda corrida no vuelve a avisar de lo que ya estaba caído', async () => {
  const r = await runChannelsKeepalive({ db, secrets: store, google: gmail, unipile, now: NOW });
  assert.equal(r.markedDown, 0);
  const { rows } = await db.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM notification WHERE kind = 'connection_error' AND workspace_id = $1`, [WS]);
  assert.equal(rows[0]!.n, 2);
});

// ---------------------------------------------------------------------
// Soltar y reconectar a la vez (0041)
// ---------------------------------------------------------------------

/**
 * Lo que hace el callback de Google de la web en el espacio: la fila
 * pendiente de ese nonce y outreach_channel_connect con la ref donde ya
 * guardó el token nuevo. Devuelve lo que dijo la función. (Como mc_app lo
 * prueba @mc/db, test/canales.test.ts; aquí importa el orden con el job.)
 */
async function reconectarComoLaWeb(email: string, nonce: string, secretRef: string): Promise<string> {
  return db.raw.transaction(async (tx) => {
    await tx.query(`SELECT set_config('app.workspace_id', $1, true)`, [WS]);
    await tx.query(
      `INSERT INTO outreach_channel_account (workspace_id, creator_id, channel, provider, provider_account_id, status)
       VALUES (current_workspace_id(), $1, 'email', 'gmail_oauth', 'pending:' || $2, 'pending')`,
      [CREATOR, nonce],
    );
    const { rows } = await tx.query<{ result: string }>(
      `SELECT result FROM outreach_channel_connect('email', $1, $2, NULL, $3, '{gmail.send,gmail.modify}', NULL)`, [nonce, email, secretRef],
    );
    return rows[0]!.result;
  });
}

test('reconectar mientras el job revoca: la conexión espera (releasing) y el job no revoca una concesión nueva', async () => {
  const ID = '0000000b-0000-4000-8000-0000000ac0b1';
  await store.set(ref(5), tokens('rt-5', 30));
  await db.raw.query(
    `INSERT INTO outreach_channel_account (id, workspace_id, creator_id, channel, provider, provider_account_id, display_name, secret_ref, status, scopes)
     VALUES ($1, $2, $3, 'email', 'gmail_oauth', 'carrera@x.test', 'carrera@x.test', $4, 'disconnected', '{gmail.send}')`,
    [ID, WS, CREATOR, ref(5)],
  );
  // La persona reconecta justo mientras el job habla con Google: entre el reclamo y el revoke.
  const nueva = ref(6);
  await store.set(nueva, tokens('rt-6', 60));
  let during = '';
  const google = {
    revoke: async (t: OAuthTokens) => {
      during = await reconectarComoLaWeb('carrera@x.test', 'r'.repeat(43), nueva);
      await gmail.revoke(t);
    },
  };
  const r = await runChannelsRelease({ db, secrets: store, google, unipile, now: NOW });
  assert.equal(during, 'releasing', 'la fila reclamada no se revive a medio soltar');
  assert.equal(r.googleRevoked, 1);
  assert.ok(gmail.revokeCalls.includes('rt-5'), 'se revocó el token de la fila desconectada, leído de SU ref');
  assert.ok(!gmail.revokeCalls.includes('rt-6'), 'nunca el de la reconexión');
  const soltadaRow = await db.raw.query<{ status: string; secret_ref: string | null; released_at: Date | null; release_claimed_at: Date | null }>(
    `SELECT status, secret_ref, released_at, release_claimed_at FROM outreach_channel_account WHERE id = $1`, [ID],
  );
  assert.equal(soltadaRow.rows[0]?.status, 'disconnected');
  assert.equal(soltadaRow.rows[0]?.secret_ref, null);
  assert.ok(soltadaRow.rows[0]?.released_at);
  assert.equal(soltadaRow.rows[0]?.release_claimed_at, null);
  assert.equal(await store.get(ref(5)), null, 'el token viejo salió del vault');

  // Un minuto después, la misma reconexión entra: revive la fila con la concesión nueva, que nadie revocó.
  assert.equal(await reconectarComoLaWeb('carrera@x.test', 's'.repeat(43), nueva), 'connected');
  const viva = await cuenta(ID);
  assert.deepEqual([viva?.status, viva?.secret_ref], ['connected', nueva]);
  await gmail.refresh((await store.get(nueva))!); // la concesión nueva sigue viva en Google
});

test('reconectar ANTES de que el job la reclame: el job no la toca (ni revoca ni borra el token)', async () => {
  const ID = '0000000b-0000-4000-8000-0000000ac0b2';
  await store.set(ref(7), tokens('rt-7', 30));
  await db.raw.query(
    `INSERT INTO outreach_channel_account (id, workspace_id, creator_id, channel, provider, provider_account_id, display_name, secret_ref, status, scopes)
     VALUES ($1, $2, $3, 'email', 'gmail_oauth', 'antes@x.test', 'antes@x.test', $4, 'disconnected', '{gmail.send}')`,
    [ID, WS, CREATOR, ref(7)],
  );
  await store.set(ref(8), tokens('rt-8', 60));
  assert.equal(await reconectarComoLaWeb('antes@x.test', 't'.repeat(43), ref(8)), 'connected');
  const revocados = gmail.revokeCalls.length;
  await runChannelsRelease({ db, secrets: store, google: gmail, unipile, now: NOW });
  assert.equal(gmail.revokeCalls.length, revocados, 'nada que soltar: la fila está viva');
  assert.deepEqual([(await cuenta(ID))?.status, (await cuenta(ID))?.secret_ref], ['connected', ref(8)]);
  assert.equal(await store.get(ref(7)), null, 'la conexión borró el token viejo, que ya nadie nombraba');
});

test('una cuenta de Unipile conectada sin avisos los recupera en el keepalive; si Unipile falla, queda marcada', async () => {
  const ID = '0000000b-0000-4000-8000-0000000ac0c1';
  const hace = new Date(NOW.getTime() - 60 * 60_000);
  await db.raw.query(
    `INSERT INTO outreach_channel_account (id, workspace_id, creator_id, channel, provider, provider_account_id, display_name, status, last_error, updated_at)
     VALUES ($1, $2, $3, 'instagram_dm', 'unipile', 'acc_ig_sordo', '@sorda', 'connected', 'webhooks_missing', $4)`,
    [ID, WS, CREATOR, hace],
  );
  unipile.addAccount({ id: 'acc_ig_sordo', provider: 'INSTAGRAM' });
  const webhooks = { secret: 'SECRETO-DE-PRUEBA', secretFingerprint: webhookSecretFingerprint('SECRETO-DE-PRUEBA'), routeKey: new Uint8Array(32).fill(5), requestUrl: 'https://app.test/api/webhooks/unipile' };

  unipile.failNext('createWebhook', 'transient', 'errors/service_unavailable', 503);
  const mal = await runChannelsKeepalive({ db, secrets: store, google: null, unipile, webhooks, now: NOW });
  assert.equal(mal.webhooksRestored, 0);
  const tras = await db.raw.query<{ last_error: string; provider_webhook_ids: string[] }>(
    `SELECT last_error, provider_webhook_ids FROM outreach_channel_account WHERE id = $1`, [ID],
  );
  assert.equal(tras.rows[0]?.last_error, 'webhooks_missing', 'la pantalla sigue ofreciendo «Volver a intentar»');

  // Al día siguiente sale: los dos avisos, con la ruta firmada de ESTA cuenta, y el código fuera. (El UPDATE de la
  // corrida anterior movió updated_at al reloj de verdad: «mañana» es una hora después de ese reloj.)
  await db.raw.query(`UPDATE outreach_channel_account SET provider_webhook_ids = '{}' WHERE id = $1`, [ID]);
  const antes = unipile.webhooks.length;
  const manana = new Date(Date.now() + 60 * 60_000);
  const bien = await runChannelsKeepalive({ db, secrets: store, google: null, unipile, webhooks, now: manana });
  // Esta y las demás cuentas de Unipile conectadas sin avisos de la prueba (el LinkedIn que volvió, la del otro espacio).
  assert.ok(bien.webhooksRestored >= 1);
  const nuevos = unipile.webhooks.slice(antes).filter((w) => w.accountId === 'acc_ig_sordo');
  assert.deepEqual(nuevos.map((w) => w.source).sort(), ['account_status', 'messaging']);
  const fila = await db.raw.query<{ last_error: string | null; provider_webhook_ids: string[] }>(
    `SELECT last_error, provider_webhook_ids FROM outreach_channel_account WHERE id = $1`, [ID],
  );
  assert.equal(fila.rows[0]?.last_error, null);
  assert.ok(fila.rows[0]!.provider_webhook_ids.length >= 2);
});

// ---------------------------------------------------------------------
// Por lotes, rotación del secreto, conciliación y limpieza (0042)
// ---------------------------------------------------------------------

test('por lotes: cada corrida toma como mucho el lote, de la comprobación más vieja a la más nueva, y la siguiente sigue', async () => {
  // Todo lo anterior ya se comprobó hoy: solo cuentan las tres de esta prueba.
  await db.raw.query(`UPDATE outreach_channel_account SET keepalive_checked_at = $1`, [NOW]);
  const ids = ['0000000b-0000-4000-8000-0000000ac0e1', '0000000b-0000-4000-8000-0000000ac0e2', '0000000b-0000-4000-8000-0000000ac0e3'];
  for (const [i, id] of ids.entries()) {
    const r = `enc:gmail:0000000b-0000-4000-8000-00000000e00${i}`;
    await store.set(r, tokens(`rt-lote-${i}`, 30));
    await db.raw.query(
      `INSERT INTO outreach_channel_account (id, workspace_id, creator_id, channel, provider, provider_account_id, secret_ref, status, scopes)
       VALUES ($1, $2, $3, 'email', 'gmail_oauth', $4, $5, 'connected', '{gmail.send}')`,
      [id, WS, CREATOR, `lote${i}@x.test`, r],
    );
  }
  const primera = await runChannelsKeepalive({ db, secrets: store, google: gmail, unipile: null, now: NOW, batchSize: 2 });
  assert.equal(primera.gmailRefreshed, 2, 'el lote es de dos');
  const vistas = await db.raw.query<{ id: string }>(`SELECT id FROM outreach_channel_account WHERE id = ANY($1::uuid[]) AND keepalive_checked_at IS NOT NULL ORDER BY id`, [ids]);
  assert.deepEqual(vistas.rows.map((x) => x.id), ids.slice(0, 2), 'las dos primeras por id (las tres sin comprobar empatan)');

  const segunda = await runChannelsKeepalive({ db, secrets: store, google: gmail, unipile: null, now: NOW, batchSize: 2 });
  assert.equal(segunda.gmailRefreshed, 1, 'la que quedó va en la corrida siguiente');
  const tercera = await runChannelsKeepalive({ db, secrets: store, google: gmail, unipile: null, now: NOW, batchSize: 2 });
  assert.equal(tercera.gmailRefreshed + tercera.gmailUnchanged, 0, 'ya se miraron todas hoy: la hora siguiente no repite');
  // Veinte horas después, vuelven a la cola.
  const manana = new Date(NOW.getTime() + 21 * 3600_000);
  const otroDia = await runChannelsKeepalive({ db, secrets: store, google: gmail, unipile: null, now: manana, batchSize: 10 });
  assert.ok(otroDia.gmailRefreshed + otroDia.gmailUnchanged >= 3);
});

test('sin tiempo (la señal del job vencida) no toma ninguna cuenta: quedan para la corrida siguiente', async () => {
  await db.raw.query(`UPDATE outreach_channel_account SET keepalive_checked_at = NULL WHERE id = '0000000b-0000-4000-8000-0000000ac0e1'`);
  const antes = gmail.refreshCalls;
  const r = await runChannelsKeepalive({ db, secrets: store, google: gmail, unipile: null, now: NOW, signal: AbortSignal.abort() });
  assert.equal(gmail.refreshCalls, antes);
  assert.ok(r.deferred >= 1);
  const fila = await db.raw.query<{ keepalive_checked_at: Date | null }>(`SELECT keepalive_checked_at FROM outreach_channel_account WHERE id = '0000000b-0000-4000-8000-0000000ac0e1'`);
  assert.equal(fila.rows[0]?.keepalive_checked_at, null);
});

test('rotar el secreto: los avisos dados de alta con el viejo se vuelven a dar de alta con el nuevo y los viejos se borran', async () => {
  const ID = '0000000b-0000-4000-8000-0000000ac0f5';
  const hace = new Date(NOW.getTime() - 60 * 60_000);
  await db.raw.query(
    `INSERT INTO outreach_channel_account (id, workspace_id, creator_id, channel, provider, provider_account_id, status, provider_webhook_ids,
                                           provider_webhook_secret_fp, updated_at)
     VALUES ($1, $2, $3, 'linkedin', 'unipile', 'acc_rotar', 'connected', '{wh_viejo_1,wh_viejo_2}', $4, $5)`,
    [ID, WS, CREATOR, webhookSecretFingerprint('SECRETO-VIEJO'), hace],
  );
  unipile.addAccount({ id: 'acc_rotar' });
  const webhooks = { secret: 'SECRETO-NUEVO', secretFingerprint: webhookSecretFingerprint('SECRETO-NUEVO'), routeKey: new Uint8Array(32).fill(6), requestUrl: 'https://app.test/api/webhooks/unipile' };
  const antes = new Set(unipile.webhooks.map((w) => w.id));
  const r = await runChannelsKeepalive({ db, secrets: store, google: null, unipile, webhooks, now: new Date(Date.now() + 60 * 60_000) });
  assert.ok(r.webhooksRotated >= 1);
  const nuevos = unipile.webhooks.filter((w) => !antes.has(w.id) && w.accountId === 'acc_rotar');
  assert.deepEqual(nuevos.map((w) => w.source).sort(), ['account_status', 'messaging']);
  assert.ok(nuevos.every((w) => w.headers['x-on-cue-secret'] === 'SECRETO-NUEVO'), 'con el secreto actual');
  assert.ok(unipile.deletedWebhooks.includes('wh_viejo_1') && unipile.deletedWebhooks.includes('wh_viejo_2'), 'los viejos se borran');
  const fila = await db.raw.query<{ provider_webhook_ids: string[]; provider_webhook_secret_fp: string }>(
    `SELECT provider_webhook_ids, provider_webhook_secret_fp FROM outreach_channel_account WHERE id = $1`, [ID],
  );
  assert.deepEqual([...fila.rows[0]!.provider_webhook_ids].sort(), nuevos.map((w) => w.id).sort());
  assert.equal(fila.rows[0]!.provider_webhook_secret_fp, webhookSecretFingerprint('SECRETO-NUEVO'));
  // Al día: la corrida siguiente no la vuelve a tocar.
  const otra = await runChannelsKeepalive({ db, secrets: store, google: null, unipile, webhooks, now: new Date(Date.now() + 2 * 60 * 60_000) });
  assert.equal(unipile.webhooks.filter((w) => w.accountId === 'acc_rotar').length, 2);
  assert.equal(otra.webhooksRotated, 0);
});

test('conciliación: una cuenta de Unipile de NUESTRA hosted auth sin fila y con más de un día se borra; las demás no', async () => {
  const llave = new Uint8Array(32).fill(9);
  const estado = (n: string) => signChannelState({ workspaceId: WS, creatorId: CREATOR, channel: 'linkedin', nonce: n.repeat(43) }, llave, NOW);
  const ajeno = signChannelState({ workspaceId: WS, creatorId: CREATOR, channel: 'linkedin', nonce: 'y'.repeat(43) }, new Uint8Array(32).fill(1), NOW);
  const viejo = new Date(NOW.getTime() - 3 * 24 * 3600_000);
  unipile.addAccount({ id: 'acc_huerfana', provider: 'INSTAGRAM', hostedAuthName: estado('h'), createdAt: viejo });
  unipile.addAccount({ id: 'acc_de_otro_entorno', hostedAuthName: ajeno, createdAt: viejo });
  unipile.addAccount({ id: 'acc_recien_creada', hostedAuthName: estado('r'), createdAt: new Date(NOW.getTime() - 60_000) });
  unipile.addAccount({ id: 'acc_con_fila', hostedAuthName: estado('f'), createdAt: viejo });
  await db.raw.query(
    `INSERT INTO outreach_channel_account (workspace_id, creator_id, channel, provider, provider_account_id, status)
     VALUES ($1, $2, 'linkedin', 'unipile', 'acc_con_fila', 'connected')`, [WS, CREATOR],
  );
  const r = await runChannelsKeepalive({ db, secrets: store, google: null, unipile, stateKeys: [llave], now: NOW });
  assert.equal(r.orphansDeleted, 1);
  assert.ok(unipile.deletedAccounts.includes('acc_huerfana'));
  for (const id of ['acc_de_otro_entorno', 'acc_recien_creada', 'acc_con_fila']) assert.ok(!unipile.deletedAccounts.includes(id), id);
  // Sin las llaves de estado no se concilia nada.
  unipile.addAccount({ id: 'acc_huerfana_2', hostedAuthName: estado('i'), createdAt: viejo });
  await runChannelsKeepalive({ db, secrets: store, google: null, unipile, now: NOW });
  assert.ok(!unipile.deletedAccounts.includes('acc_huerfana_2'));
});

test('limpieza: los intentos fallidos o cancelados ya soltados hace más de una semana se borran; los recientes se quedan', async () => {
  const VIEJO = '0000000b-0000-4000-8000-0000000ac0a1';
  const RECIENTE = '0000000b-0000-4000-8000-0000000ac0a2';
  await db.raw.query(
    `INSERT INTO outreach_channel_account (id, workspace_id, creator_id, channel, provider, provider_account_id, status, last_error, released_at) VALUES
       ($1, $3, $4, 'linkedin', 'unipile', 'pending:${'k'.repeat(43)}', 'disconnected', 'cancelled', $5),
       ($2, $3, $4, 'linkedin', 'unipile', 'pending:${'l'.repeat(43)}', 'disconnected', 'auth_failed', $6)`,
    [VIEJO, RECIENTE, WS, CREATOR, new Date(NOW.getTime() - 8 * 24 * 3600_000), new Date(NOW.getTime() - 24 * 3600_000)],
  );
  const r = await runChannelsKeepalive({ db, secrets: store, google: null, unipile: null, now: NOW });
  assert.ok(r.failedAttemptsRemoved >= 1);
  assert.equal(await cuenta(VIEJO), undefined);
  assert.ok(await cuenta(RECIENTE), 'la pantalla la enseña todavía');
});
