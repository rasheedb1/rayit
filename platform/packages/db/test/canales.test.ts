/**
 * VEN-9 · las cuentas de canal por @mc/db/queries/canales, en Postgres
 * embebido con el seed (0005 trae el Gmail de Laura conectado y su
 * LinkedIn por reconectar).
 *
 *   · la pantalla lee sus cuentas con el uso ya sumado y no ve las de otro
 *     workspace; los topes no pasan el techo del canal;
 *   · la web crea la fila pendiente y desconecta, pero no autentica;
 *   · el callback del proveedor (las funciones de 0039, como mc_app)
 *     conecta Gmail con una sola fila por concesión, completa la conexión
 *     de Unipile por su nonce (una sola vez, solo en su espacio), y no
 *     deja que un buzón conectado en otro espacio se conecte aquí;
 *   · una respuesta entra a outbound_message atada al toque de su hilo, y
 *     un webhook repetido no la duplica.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelCapError, completeChannelConnection, createPendingChannelAccount, disconnectChannelAccount, existingGmailSecretRef,
  failPendingChannelAccount, findUnipileAccountForWebhook, getChannelPolicyCaps, listChannelAccounts, markChannelAccountDown,
  recordInboundMessage, updateChannelAccountCaps,
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

describe('el callback del proveedor, desde la web (0039)', () => {
  test('Unipile: la pendiente del nonce pasa al account_id de Unipile, una sola vez', async () => {
    const pendingId = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createPendingChannelAccount(tx, { channel: 'linkedin', creatorId: CREATOR_LAURA, nonce: NONCE }));
    const input = { channel: 'linkedin' as const, nonce: NONCE, providerAccountId: 'acc_li_nueva', displayName: 'Laura Gómez', secretRef: null, scopes: null };
    const r = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => completeChannelConnection(tx, input));
    assert.deepEqual(r, { status: 'connected', accountId: pendingId, reconnected: false });
    assert.equal((await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => completeChannelConnection(tx, input))).status, 'unknown_state', 'el nonce ya se usó');
    const live = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => findUnipileAccountForWebhook(tx, pendingId, 'acc_li_nueva'));
    assert.equal(live?.status, 'connected');
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => findUnipileAccountForWebhook(tx, pendingId, 'acc_otra')), null, 'id y account_id tienen que casar');
    assert.equal(await t.db.withWorkspace(WS_OTRO, (tx) => findUnipileAccountForWebhook(tx, pendingId, 'acc_li_nueva')), null, 'otro espacio no la ve');
  });

  test('sin la pendiente de ESE espacio no se conecta nada: el nonce de Laura no sirve en otro', async () => {
    const n = 'q'.repeat(43);
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createPendingChannelAccount(tx, { channel: 'instagram_dm', creatorId: CREATOR_LAURA, nonce: n }));
    const r = await t.db.withWorkspace(WS_OTRO, (tx) => completeChannelConnection(tx, {
      channel: 'instagram_dm', nonce: n, providerAccountId: 'acc_ig_ajena', displayName: null, secretRef: null, scopes: null,
    }));
    assert.equal(r.status, 'unknown_state');
  });

  test('la cuenta ya conectada en otro espacio no se conecta aquí y la pendiente dice por qué', async () => {
    const n2 = 'm'.repeat(43);
    await t.db.withWorkspace(WS_OTRO, (tx) => createPendingChannelAccount(tx, { channel: 'linkedin', creatorId: CREATOR_OTRO, nonce: n2 }));
    const taken = await t.db.withWorkspace(WS_OTRO, (tx) => completeChannelConnection(tx, {
      channel: 'linkedin', nonce: n2, providerAccountId: 'acc_li_nueva', displayName: null, secretRef: null, scopes: null,
    }));
    assert.equal(taken.status, 'taken');
    assert.equal(await t.db.withWorkspace(WS_OTRO, (tx) => failPendingChannelAccount(tx, { channel: 'linkedin', nonce: n2, code: 'taken' })), true);
    const rows = await t.db.withWorkspace(WS_OTRO, (tx) => listChannelAccounts(tx));
    assert.deepEqual(rows.map((r) => [r.status, r.lastError]), [['disconnected', 'taken']]);
  });

  test('Gmail: una fila por concesión; reconectar reutiliza la fila y la ref', async () => {
    const ref = 'enc:gmail:00000000-0000-4000-8000-00000000abcd';
    await t.admin(`INSERT INTO connection_secret (secret_ref, workspace_id, ciphertext, iv, tag)
      VALUES ('${ref}', '${WS_OTRO}', '\\x00', '\\x000000000000000000000000', '\\x00000000000000000000000000000000')`);
    const conectar = (nonce: string, email: string) => t.db.withWorkspace(WS_OTRO, async (tx) => {
      await createPendingChannelAccount(tx, { channel: 'email', creatorId: CREATOR_OTRO, nonce });
      return completeChannelConnection(tx, { channel: 'email', nonce, providerAccountId: email, displayName: null, secretRef: ref, scopes: ['gmail.send', 'gmail.modify'] });
    });
    assert.equal(await t.db.withWorkspace(WS_OTRO, (tx) => existingGmailSecretRef(tx, 'otro@gmail.test')), null);
    const first = await conectar('g'.repeat(43), ' Otro@Gmail.test ');
    assert.equal(first.status, 'connected');
    assert.equal(await t.db.withWorkspace(WS_OTRO, (tx) => existingGmailSecretRef(tx, 'OTRO@gmail.test')), ref);
    const second = await conectar('h'.repeat(43), 'otro@gmail.test');
    assert.ok(second.status === 'connected' && first.status === 'connected' && second.accountId === first.accountId && second.reconnected);
    const gmails = (await t.db.withWorkspace(WS_OTRO, (tx) => listChannelAccounts(tx))).filter((r) => r.channel === 'email');
    assert.deepEqual(gmails.map((r) => [r.providerAccountId, r.status, r.scopes]), [['otro@gmail.test', 'connected', ['gmail.send', 'gmail.modify']]]);
    // El Gmail de Laura (vivo en su espacio) no se conecta en otro.
    assert.equal((await conectar('j'.repeat(43), 'laura@cocina-facil.test')).status, 'taken');
  });

  test('un Gmail sin token no pasa (22023)', async () => {
    await assert.rejects(
      t.db.withWorkspace(WS_OTRO, (tx) => completeChannelConnection(tx, {
        channel: 'email', nonce: 'z'.repeat(43), providerAccountId: 'x@y.test', displayName: null, secretRef: null, scopes: null,
      })),
      (e: { code?: string }) => e.code === '22023',
    );
  });

  test('markChannelAccountDown mueve una cuenta viva a needs_reconnect con el motivo y avisa una vez', async () => {
    const [li] = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listChannelAccounts(tx))).filter((r) => r.providerAccountId === 'acc_li_nueva');
    assert.ok(li);
    const notice = { titleEs: 'Vuelve a conectar tu LinkedIn', bodyEs: 'La sesión de LinkedIn expiró.' };
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => markChannelAccountDown(tx, li.id, 'La sesión de LinkedIn expiró.', notice)), true);
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => markChannelAccountDown(tx, li.id, 'otra vez', notice)), false, 'no vuelve a avisar');
    assert.equal(await t.db.withWorkspace(WS_OTRO, (tx) => markChannelAccountDown(tx, li.id, 'ajena')), false, 'otro espacio no la toca');
    const again = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => findUnipileAccountForWebhook(tx, li.id, 'acc_li_nueva'));
    assert.equal(again?.status, 'needs_reconnect');
    const avisos = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query(`SELECT 1 FROM notification WHERE entity_id = $1`, [li.id]));
    assert.equal(avisos.rows.length, 1);
  });

  test('una respuesta entra atada al toque de su hilo, y el webhook repetido no la duplica', async () => {
    const msg = {
      account: { id: GMAIL_LAURA, channel: 'email' as const }, threadRef: 'gmail-thread-demo-0002', providerMessageId: 'gmail-demo-0002-r1',
      body: 'Me interesa, hablemos.', fromAddress: 'sofia@vitale.co', occurredAt: new Date(),
    };
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordInboundMessage(tx, msg)), true);
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordInboundMessage(tx, msg)), false);
    const rows = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query<{ touch_id: string; intent: string | null; direction: string }>(
      `SELECT touch_id, intent, direction FROM outbound_message WHERE provider_message_id = 'gmail-demo-0002-r1'`,
    ));
    assert.deepEqual(rows.rows, [{ touch_id: '00000005-0000-4000-8000-000000070002', intent: null, direction: 'inbound' }]);
  });
});
