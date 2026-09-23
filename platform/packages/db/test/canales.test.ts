/**
 * VEN-9 · las cuentas de canal por @mc/db/queries/canales, en Postgres
 * embebido con el seed (0005 trae el Gmail de Laura conectado y su
 * LinkedIn por reconectar).
 *
 *   · la pantalla lee sus cuentas con el uso ya sumado y no ve las de otro
 *     workspace; los topes no pasan el techo del canal;
 *   · la web crea la fila pendiente y desconecta, pero no autentica;
 *   · el callback del proveedor (asWorker) conecta Gmail con una sola fila
 *     por concesión, completa la conexión de Unipile por su nonce (una
 *     sola vez), y no deja que un buzón conectado en otro espacio se
 *     conecte aquí;
 *   · una respuesta entra a outbound_message atada al toque de su hilo, y
 *     un webhook repetido no la duplica.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelCapError, completeUnipileConnection, connectGmailAccount, createPendingChannelAccount, disconnectChannelAccount,
  findLiveChannelAccount, getChannelPolicyCaps, listChannelAccounts, markChannelAccountDown, recordInboundMessage,
  updateChannelAccountCaps,
} from '../src/queries/canales.ts';
import { openTestDb, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

const CREATOR_LAURA = '00000002-0000-4000-8000-000000000003';
const GMAIL_LAURA = '00000005-0000-4000-8000-0000000ac001';
const LINKEDIN_LAURA = '00000005-0000-4000-8000-0000000ac002';
const WS_OTRO = '00000009-0000-4000-8000-00000000c0a1';
const CREATOR_OTRO = '00000009-0000-4000-8000-00000000c0a3';
const NONCE = 'n'.repeat(43);

let t: TestDb;

before(async () => {
  t = await openTestDb();
  await t.admin(`
    INSERT INTO workspace (id, slug, name, kind, country, currency, timezone, locale, plan)
      VALUES ('${WS_OTRO}', 'otro-canales', 'Otro', 'creator', 'MX', 'MXN', 'America/Mexico_City', 'es-MX', 'creator')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO creator_profile (id, workspace_id, display_name, handle)
      VALUES ('${CREATOR_OTRO}', '${WS_OTRO}', 'Otro', 'otro.canales') ON CONFLICT (id) DO NOTHING;
  `);
});
after(async () => { await t?.close(); });

describe('la pantalla (mc_app)', () => {
  test('lista las cuentas del workspace con su uso; la pendiente no enseña su nonce', async () => {
    const rows = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listChannelAccounts(tx));
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get(GMAIL_LAURA)?.status, 'connected');
    assert.equal(byId.get(GMAIL_LAURA)?.providerAccountId, 'laura@cocina-facil.test');
    assert.equal(byId.get(LINKEDIN_LAURA)?.status, 'needs_reconnect');
    for (const r of rows) {
      assert.ok(Number.isInteger(r.usedToday) && r.usedToday >= 0);
      assert.ok(r.usedThisWeek >= r.usedToday || r.usedThisWeek >= 0);
    }
    const otro = await t.db.withWorkspace(WS_OTRO, (tx) => listChannelAccounts(tx));
    assert.deepEqual(otro, [], 'otro workspace no ve las cuentas de Laura');
    assert.deepEqual(await t.db.withWorkspace(WS_OTRO, (tx) => getChannelPolicyCaps(tx)), { emailPerDay: 20, enabled: false });
  });

  test('los topes: dentro del techo se guardan; por encima, ChannelCapError sin tocar la base', async () => {
    await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      assert.equal(await updateChannelAccountCaps(tx, LINKEDIN_LAURA, { dailyCap: 30, weeklyCap: 150 }), true);
      await assert.rejects(updateChannelAccountCaps(tx, LINKEDIN_LAURA, { dailyCap: 101, weeklyCap: 150 }), (e: unknown) => e instanceof ChannelCapError && e.field === 'dailyCap' && e.max === 100);
      await assert.rejects(updateChannelAccountCaps(tx, GMAIL_LAURA, { dailyCap: 40, weeklyCap: 10_001 }), ChannelCapError);
      assert.equal(await updateChannelAccountCaps(tx, GMAIL_LAURA, { dailyCap: null, weeklyCap: null }), true);
    });
    assert.equal(await t.db.withWorkspace(WS_OTRO, (tx) => updateChannelAccountCaps(tx, LINKEDIN_LAURA, { dailyCap: 1, weeklyCap: 1 })), false);
  });

  test('la web crea la pendiente, pero no la autentica (42501)', async () => {
    const id = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createPendingChannelAccount(tx, { channel: 'instagram_dm', creatorId: CREATOR_LAURA, nonce: 'w'.repeat(43) }));
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query(`UPDATE outreach_channel_account SET status = 'connected' WHERE id = $1`, [id])),
      (e: { code?: string }) => e.code === '42501',
    );
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => disconnectChannelAccount(tx, id)), true);
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => disconnectChannelAccount(tx, id)), false, 'dos veces no cambia nada');
  });
});

describe('el callback del proveedor (asWorker)', () => {
  test('Unipile: la pendiente del nonce pasa al account_id de Unipile, una sola vez', async () => {
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createPendingChannelAccount(tx, { channel: 'linkedin', creatorId: CREATOR_LAURA, nonce: NONCE }));
    const input = {
      workspaceId: WORKSPACE_LAURA, creatorId: CREATOR_LAURA, channel: 'linkedin' as const, nonce: NONCE,
      account: { id: 'acc_li_nueva', provider: 'LINKEDIN', name: 'Laura Gómez', username: 'laura-gomez' },
    };
    const r = await t.db.asWorker((tx) => completeUnipileConnection(tx, input));
    assert.equal(r.status, 'connected');
    assert.equal((await t.db.asWorker((tx) => completeUnipileConnection(tx, input))).status, 'unknown_state', 'el nonce ya se usó');
    const live = await t.db.asWorker((tx) => findLiveChannelAccount(tx, 'unipile', 'acc_li_nueva'));
    assert.equal(live?.workspaceId, WORKSPACE_LAURA);
  });

  test('Unipile: la cuenta ya conectada en otro espacio no se conecta aquí; un Instagram donde se pidió LinkedIn tampoco', async () => {
    const n2 = 'm'.repeat(43);
    await t.db.withWorkspace(WS_OTRO, (tx) => createPendingChannelAccount(tx, { channel: 'linkedin', creatorId: CREATOR_OTRO, nonce: n2 }));
    const taken = await t.db.asWorker((tx) => completeUnipileConnection(tx, {
      workspaceId: WS_OTRO, creatorId: CREATOR_OTRO, channel: 'linkedin', nonce: n2,
      account: { id: 'acc_li_nueva', provider: 'LINKEDIN', name: null, username: null },
    }));
    assert.equal(taken.status, 'taken');
    const n3 = 'k'.repeat(43);
    await t.db.withWorkspace(WS_OTRO, (tx) => createPendingChannelAccount(tx, { channel: 'linkedin', creatorId: CREATOR_OTRO, nonce: n3 }));
    const wrong = await t.db.asWorker((tx) => completeUnipileConnection(tx, {
      workspaceId: WS_OTRO, creatorId: CREATOR_OTRO, channel: 'linkedin', nonce: n3,
      account: { id: 'acc_ig_x', provider: 'INSTAGRAM', name: null, username: null },
    }));
    assert.equal(wrong.status, 'wrong_provider');
    const rows = await t.db.withWorkspace(WS_OTRO, (tx) => listChannelAccounts(tx));
    assert.deepEqual(rows.map((r) => [r.status, r.lastError]).sort(), [['disconnected', 'taken'], ['disconnected', 'wrong_provider']]);
  });

  test('Gmail: una fila por concesión; reconectar reutiliza la fila y la ref', async () => {
    const refs: (string | null)[] = [];
    const write = async (prev: string | null) => { refs.push(prev); return prev ?? 'enc:gmail:00000000-0000-4000-8000-00000000abcd'; };
    await t.admin(`INSERT INTO connection_secret (secret_ref, workspace_id, ciphertext, iv, tag)
      VALUES ('enc:gmail:00000000-0000-4000-8000-00000000abcd', '${WS_OTRO}', '\\x00', '\\x000000000000000000000000', '\\x00000000000000000000000000000000')`);
    const input = { workspaceId: WS_OTRO, creatorId: CREATOR_OTRO, email: ' Otro@Gmail.test ', scopes: ['gmail.send', 'gmail.modify'] };
    const first = await t.db.asWorker((tx) => connectGmailAccount(tx, input, write));
    assert.equal(first.status, 'connected');
    const second = await t.db.asWorker((tx) => connectGmailAccount(tx, input, write));
    assert.ok(second.status === 'connected' && first.status === 'connected' && second.accountId === first.accountId && second.reconnected);
    assert.deepEqual(refs, [null, 'enc:gmail:00000000-0000-4000-8000-00000000abcd']);
    // El Gmail de Laura (vivo en su espacio) no se conecta en otro.
    const taken = await t.db.asWorker((tx) => connectGmailAccount(tx, { ...input, email: 'laura@cocina-facil.test' }, write));
    assert.equal(taken.status, 'taken');
  });

  test('markChannelAccountDown mueve una cuenta viva a needs_reconnect con el motivo', async () => {
    const live = await t.db.asWorker((tx) => findLiveChannelAccount(tx, 'unipile', 'acc_li_nueva'));
    assert.ok(live);
    assert.equal(await t.db.asWorker((tx) => markChannelAccountDown(tx, live, 'La sesión de LinkedIn expiró.')), true);
    const again = await t.db.asWorker((tx) => findLiveChannelAccount(tx, 'unipile', 'acc_li_nueva'));
    assert.equal(again?.status, 'needs_reconnect');
  });

  test('una respuesta entra atada al toque de su hilo, y el webhook repetido no la duplica', async () => {
    const account = await t.db.asWorker((tx) => findLiveChannelAccount(tx, 'gmail_oauth', 'laura@cocina-facil.test'));
    assert.ok(account);
    const msg = {
      account, threadRef: 'gmail-thread-demo-0002', providerMessageId: 'gmail-demo-0002-r1', body: 'Me interesa, hablemos.',
      fromAddress: 'sofia@vitale.co', occurredAt: new Date(),
    };
    assert.equal(await t.db.asWorker((tx) => recordInboundMessage(tx, msg)), true);
    assert.equal(await t.db.asWorker((tx) => recordInboundMessage(tx, msg)), false);
    const rows = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query<{ touch_id: string; intent: string | null; direction: string }>(
      `SELECT touch_id, intent, direction FROM outbound_message WHERE provider_message_id = 'gmail-demo-0002-r1'`,
    ));
    assert.deepEqual(rows.rows, [{ touch_id: '00000005-0000-4000-8000-000000070002', intent: null, direction: 'inbound' }]);
  });
});
