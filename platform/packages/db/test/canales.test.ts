/**
 * VEN-9 · las cuentas de canal por @mc/db/queries/canales, en Postgres
 * embebido con el seed (0005 trae el Gmail de Laura conectado y su
 * LinkedIn por reconectar).
 *
 *   · la pantalla lee sus cuentas con el uso ya sumado y no ve las de otro
 *     workspace; los topes no pasan el techo del canal;
 *   · la web crea la fila pendiente y desconecta, pero no autentica;
 *   · el callback del proveedor (las funciones de callback_de_canales, como mc_app)
 *     conecta Gmail con una sola fila por concesión, completa la conexión
 *     de Unipile por su nonce (una sola vez, solo en su espacio), y no
 *     deja que un buzón conectado en otro espacio se conecte aquí;
 *   · una respuesta entra a outbound_message atada al toque de su hilo, y
 *     un webhook repetido no la duplica.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_ERROR_CODE_RE, CHANNEL_ERROR_CODES, ChannelCapError, completeChannelConnection, createPendingChannelAccount, disconnectChannelAccount, existingGmailSecretRef,
  failPendingChannelAccount, findUnipileAccountForWebhook, getChannelPolicyCaps, listChannelAccounts, markChannelAccountDown,
  channelWebhookCount, getChannelLimits, getReconnectableUnipileAccount, markChannelAccountOk, parseReplyOptOutCode, parseUnipileStatusCode, recordInboundMessage,
  noteChannelAccountIssue, replyOptOutCode, setChannelWebhooks, unipileStatusCode, updateChannelAccountCaps,
} from '../src/queries/canales.ts';
import { createEmbeddedDb } from '../src/embedded.ts';
import { openTestDb, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

const CREATOR_LAURA = '00000002-0000-4000-8000-000000000003';
const GMAIL_LAURA = '00000005-0000-4000-8000-0000000ac001';
const LINKEDIN_LAURA = '00000005-0000-4000-8000-0000000ac002';
const WS_OTRO = '00000009-0000-4000-8000-00000000c0a1';
const CREATOR_OTRO = '00000009-0000-4000-8000-00000000c0a3';
const NONCE = 'n'.repeat(43);

let t: TestDb;

/*
 * Todo va dentro de un describe. Con --test-isolation=none, los before de raíz
 * de todos los archivos corren antes de la primera prueba; abrir aquí otra
 * base embebida con su seed sumaba ese arranque a la cuenta de la raíz, y en
 * una máquina cargada la suite entera de @mc/db se cancelaba a los 120 s.
 * Dentro del bloque, el arranque se cobra a este bloque (con su propio techo)
 * y la base se cierra al terminarlo.
 */
describe('canales', () => {
  before(async () => {
    t = await openTestDb();
    await t.admin(`
      INSERT INTO workspace (id, slug, name, kind, country, currency, timezone, locale, plan)
        VALUES ('${WS_OTRO}', 'otro-canales', 'Otro', 'creator', 'MX', 'MXN', 'America/Mexico_City', 'es-MX', 'creator')
        ON CONFLICT (id) DO NOTHING;
      INSERT INTO creator_profile (id, workspace_id, display_name, handle)
        VALUES ('${CREATOR_OTRO}', '${WS_OTRO}', 'Otro', 'otro.canales') ON CONFLICT (id) DO NOTHING;
    `);
  }, { timeout: 120_000 });
  after(async () => { await t?.close(); });

  /** Lee como mc_worker (sin RLS), fuera de toda transacción. */
  async function sel<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
    return t.db.asWorker(async (tx) => (await tx.query<T>(sql)).rows);
  }

  describe('la pantalla (mc_app)', () => {
    test('lista las cuentas del workspace con su uso; la pendiente no enseña su nonce', async () => {
      const rows = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listChannelAccounts(tx));
      const byId = new Map(rows.map((r) => [r.id, r]));
      assert.equal(byId.get(GMAIL_LAURA)?.status, 'connected');
      assert.equal(byId.get(GMAIL_LAURA)?.providerAccountId, 'laura@cocina-facil.test');
      assert.equal(byId.get(LINKEDIN_LAURA)?.status, 'needs_reconnect');
      // El uso de cada cuenta ya no viaja en la fila: lo da outbound_usage_daily (listChannelUsage, VEN-16).
      for (const r of rows) assert.equal('usedToday' in r, false);
      const otro = await t.db.withWorkspace(WS_OTRO, (tx) => listChannelAccounts(tx));
      assert.deepEqual(otro, [], 'otro workspace no ve las cuentas de Laura');
      // Sin fila de política, los valores por defecto de la tabla: Instagram nace apagado (canales_instagram_apagado_y_semana).
      assert.deepEqual(await t.db.withWorkspace(WS_OTRO, (tx) => getChannelPolicyCaps(tx)), { emailPerDay: 20, enabled: false, allowedChannels: ['email', 'linkedin'] });
      assert.deepEqual((await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getChannelPolicyCaps(tx))).allowedChannels, ['email', 'linkedin', 'instagram_dm'], 'la demo lo tiene encendido');
    });

    test('los límites salen de la vista: el correo lo fija la política, LinkedIn el proveedor; lo que rige nunca pasa del máximo', async () => {
      // La política de 20 correos al día de la demo de outreach (seed 0005); el seed 0006 de VEN-15 la sube a 80
      // para pintar la rampa del calentamiento, y aquí se prueba el techo de la política.
      await t.admin(`UPDATE outbound_policy SET max_emails_per_day = 20 WHERE workspace_id = '${WORKSPACE_LAURA}'`);
      const rows = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listChannelAccounts(tx));
      const gmail = rows.find((r) => r.id === GMAIL_LAURA)!;
      assert.deepEqual(gmail.limits, {
        effectiveDaily: 20, effectiveWeekly: 100, maxDaily: 20, maxWeekly: 140, dailyLimitedBy: 'policy', weeklyLimitedBy: 'policy', personalMailbox: false,
      });
      const li = rows.find((r) => r.id === LINKEDIN_LAURA)!;
      assert.equal(li.limits.maxDaily, 100);
      assert.equal(li.limits.maxWeekly, 200);
      assert.equal(li.limits.dailyLimitedBy, 'provider');
      // El semanal de LinkedIn (200) es el del proveedor, no 7 × 100.
      assert.equal(li.limits.weeklyLimitedBy, 'provider');
      // Un tope viejo por encima de la política (la demo tenía 40 con una política de 20): rige la política.
      await t.admin(`UPDATE outreach_channel_account SET daily_cap = 40 WHERE id = '${GMAIL_LAURA}'`);
      assert.equal((await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getChannelLimits(tx, GMAIL_LAURA)))?.effectiveDaily, 20);
      // Una cuenta personal de Gmail corta en 500 aunque la política diga más.
      await t.admin(`UPDATE outbound_policy SET max_emails_per_day = 900 WHERE workspace_id = '${WORKSPACE_LAURA}'`);
      await t.admin(`INSERT INTO outreach_channel_account (id, workspace_id, creator_id, channel, provider, provider_account_id, status)
        VALUES ('00000005-0000-4000-8000-0000000acf01', '${WORKSPACE_LAURA}', '${CREATOR_LAURA}', 'email', 'gmail_oauth', 'laura.personal@gmail.com', 'disconnected')`);
      const personal = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getChannelLimits(tx, '00000005-0000-4000-8000-0000000acf01'));
      assert.deepEqual([personal?.maxDaily, personal?.dailyLimitedBy, personal?.personalMailbox], [500, 'provider', true]);
      assert.deepEqual([personal?.maxWeekly, personal?.weeklyLimitedBy], [3500, 'provider'], 'Gmail personal: 3.500 a la semana, del proveedor');
      assert.equal((await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getChannelLimits(tx, GMAIL_LAURA)))?.maxDaily, 900);
      await t.admin(`UPDATE outbound_policy SET max_emails_per_day = 20 WHERE workspace_id = '${WORKSPACE_LAURA}';
                     UPDATE outreach_channel_account SET daily_cap = 20 WHERE id = '${GMAIL_LAURA}';
                     DELETE FROM outreach_channel_account WHERE id = '00000005-0000-4000-8000-0000000acf01'`);
      assert.equal(await t.db.withWorkspace(WS_OTRO, (tx) => getChannelLimits(tx, GMAIL_LAURA)), null, 'otro espacio no ve los límites de Laura');
    });

    test('los topes: dentro del máximo se guardan; por encima de la política o del proveedor, ChannelCapError sin tocar la base', async () => {
      await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
        assert.equal(await updateChannelAccountCaps(tx, LINKEDIN_LAURA, { dailyCap: 30, weeklyCap: 150 }), true);
        await assert.rejects(updateChannelAccountCaps(tx, LINKEDIN_LAURA, { dailyCap: 101, weeklyCap: 150 }), (e: unknown) => e instanceof ChannelCapError && e.field === 'dailyCap' && e.max === 100 && e.limitedBy === 'provider');
        // 2.000 cabe en el techo del CHECK, pero la política del espacio dice 20.
        await assert.rejects(updateChannelAccountCaps(tx, GMAIL_LAURA, { dailyCap: 2000, weeklyCap: null }), (e: unknown) => e instanceof ChannelCapError && e.field === 'dailyCap' && e.max === 20 && e.limitedBy === 'policy');
        await assert.rejects(updateChannelAccountCaps(tx, GMAIL_LAURA, { dailyCap: 10, weeklyCap: 141 }), (e: unknown) => e instanceof ChannelCapError && e.field === 'weeklyCap' && e.max === 140 && e.limitedBy === 'policy');
        // El diario no pasa del semanal.
        await assert.rejects(updateChannelAccountCaps(tx, LINKEDIN_LAURA, { dailyCap: 50, weeklyCap: 30 }), (e: unknown) => e instanceof ChannelCapError && e.problem === 'daily_above_weekly');
        assert.equal(await updateChannelAccountCaps(tx, GMAIL_LAURA, { dailyCap: null, weeklyCap: null }), true);
        const { rows } = await tx.query<{ daily_cap: number | null }>(`SELECT daily_cap FROM outreach_channel_account WHERE id = $1`, [LINKEDIN_LAURA]);
        assert.equal(rows[0]?.daily_cap, 30, 'lo rechazado no tocó la base');
      });
      assert.equal(await t.db.withWorkspace(WS_OTRO, (tx) => updateChannelAccountCaps(tx, LINKEDIN_LAURA, { dailyCap: 1, weeklyCap: 1 })), false);
    });

    test('reconectar sale de la fila: solo una cuenta caída del espacio y del canal pedido', async () => {
      assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getReconnectableUnipileAccount(tx, LINKEDIN_LAURA, 'linkedin')), 'unipile-demo-laura-linkedin');
      assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getReconnectableUnipileAccount(tx, LINKEDIN_LAURA, 'instagram_dm')), null);
      assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getReconnectableUnipileAccount(tx, GMAIL_LAURA, 'linkedin')), null);
      assert.equal(await t.db.withWorkspace(WS_OTRO, (tx) => getReconnectableUnipileAccount(tx, LINKEDIN_LAURA, 'linkedin')), null, 'la fila de otro espacio no existe para este');
    });

    test('los avisos y la liberación son del despachador: mc_app no los escribe (42501); desconectar deja la cuenta por soltar', async () => {
      const es42501 = (e: unknown) => (e as { code?: string }).code === '42501';
      await assert.rejects(t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query(`UPDATE outreach_channel_account SET provider_webhook_ids = '{wh_x}' WHERE id = $1`, [LINKEDIN_LAURA])), es42501);
      await assert.rejects(t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query(`UPDATE outreach_channel_account SET released_at = now() WHERE id = $1`, [LINKEDIN_LAURA])), es42501);
      await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
        // Por la función de canales_liberar_y_limites, solo en una cuenta viva de este espacio.
        assert.equal(await setChannelWebhooks(tx, LINKEDIN_LAURA, ['wh_a', 'wh_b'], 'a1b2c3d4e5f60718'), true);
        assert.equal(await setChannelWebhooks(tx, LINKEDIN_LAURA, ['wh_b'], 'a1b2c3d4e5f60718'), true);
        assert.equal(await channelWebhookCount(tx, LINKEDIN_LAURA), 2);
        assert.equal(await setChannelWebhooks(tx, GMAIL_LAURA, ['wh_c'], 'a1b2c3d4e5f60718'), false, 'un Gmail no tiene avisos de Unipile');
      });
      assert.equal(await t.db.withWorkspace(WS_OTRO, (tx) => setChannelWebhooks(tx, LINKEDIN_LAURA, ['wh_z'], 'a1b2c3d4e5f60718')), false);
      await t.admin(`UPDATE outreach_channel_account SET released_at = now() WHERE id = '${LINKEDIN_LAURA}'`);
      await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => disconnectChannelAccount(tx, LINKEDIN_LAURA));
      const rows = await sel<{ status: string; released_at: Date | null }>(`SELECT status, released_at FROM outreach_channel_account WHERE id = '${LINKEDIN_LAURA}'`);
      assert.deepEqual(rows[0], { status: 'disconnected', released_at: null });
      await t.admin(`UPDATE outreach_channel_account SET status = 'needs_reconnect', provider_webhook_ids = '{}' WHERE id = '${LINKEDIN_LAURA}'`);
    });

    test('la web crea la pendiente, pero no la autentica (42501)', async () => {
      const id = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createPendingChannelAccount(tx, { channel: 'instagram_dm', creatorId: CREATOR_LAURA, nonce: 'w'.repeat(43) }));
      await assert.rejects(
        t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query(`UPDATE outreach_channel_account SET status = 'connected' WHERE id = $1`, [id])),
        (e: { code?: string }) => e.code === '42501',
      );
      assert.ok(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => disconnectChannelAccount(tx, id)));
      assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => disconnectChannelAccount(tx, id)), null, 'dos veces no cambia nada');
      // Devuelve el nombre de la cuenta, para que la pantalla confirme cuál soltó.
      await t.admin(`UPDATE outreach_channel_account SET status = 'needs_reconnect', last_error = 'unipile_status:CREDENTIALS', last_error_at = now() WHERE id = '${LINKEDIN_LAURA}'`);
      const soltada = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => disconnectChannelAccount(tx, LINKEDIN_LAURA));
      assert.ok(soltada && soltada.name.length > 0);
      // Desconectar a propósito borra el motivo de la última caída: la fila «Sin conectar» no pide reconectar lo que se quitó.
      const motivo = await sel<{ last_error: string | null; last_error_at: Date | null }>(
        `SELECT last_error, last_error_at FROM outreach_channel_account WHERE id = '${LINKEDIN_LAURA}'`,
      );
      assert.deepEqual(motivo[0], { last_error: null, last_error_at: null });
      assert.equal(await t.db.withWorkspace(WS_OTRO, (tx) => disconnectChannelAccount(tx, LINKEDIN_LAURA)), null, 'otro espacio no la ve');
      await t.admin(`UPDATE outreach_channel_account SET status = 'needs_reconnect', provider_webhook_ids = '{}' WHERE id = '${LINKEDIN_LAURA}'`);
    });

    test('como mucho una pendiente por creador y canal: un intento nuevo reemplaza al que quedó a medias', async () => {
      const pendientes = async () => (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listChannelAccounts(tx)))
        .filter((r) => r.channel === 'instagram_dm' && r.status === 'pending');
      await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createPendingChannelAccount(tx, { channel: 'instagram_dm', creatorId: CREATOR_LAURA, nonce: 'a'.repeat(43) }));
      const segunda = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createPendingChannelAccount(tx, { channel: 'instagram_dm', creatorId: CREATOR_LAURA, nonce: 'b'.repeat(43) }));
      assert.deepEqual((await pendientes()).map((r) => r.id), [segunda], 'solo queda la del intento nuevo');
      // La vuelta del intento viejo ya no casa con nada; la del nuevo sí dice por qué no se conectó.
      assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => failPendingChannelAccount(tx, { channel: 'instagram_dm', nonce: 'a'.repeat(43), code: 'cancelled' })), false);
      assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => failPendingChannelAccount(tx, { channel: 'instagram_dm', nonce: 'b'.repeat(43), code: 'cancelled' })), true);
      assert.deepEqual(await pendientes(), []);
      // Otro canal no se toca.
      await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createPendingChannelAccount(tx, { channel: 'linkedin', creatorId: CREATOR_LAURA, nonce: 'c'.repeat(43) }));
      await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createPendingChannelAccount(tx, { channel: 'instagram_dm', creatorId: CREATOR_LAURA, nonce: 'd'.repeat(43) }));
      const li = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listChannelAccounts(tx))).filter((r) => r.channel === 'linkedin' && r.status === 'pending');
      assert.equal(li.length, 1);
      await t.admin(`DELETE FROM outreach_channel_account WHERE status = 'pending' OR provider_account_id IN ('pending:${'b'.repeat(43)}')`);
    });
  });

  describe('el callback del proveedor, desde la web (callback_de_canales)', () => {
    test('Unipile: la pendiente del nonce pasa al account_id de Unipile, una sola vez', async () => {
      const pendingId = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => createPendingChannelAccount(tx, { channel: 'linkedin', creatorId: CREATOR_LAURA, nonce: NONCE }));
      const input = { channel: 'linkedin' as const, nonce: NONCE, providerAccountId: 'acc_li_nueva', displayName: 'Laura Gómez', secretRef: null, scopes: null };
      const r = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => completeChannelConnection(tx, input));
      assert.deepEqual(r, { status: 'connected', accountId: pendingId, reconnected: false, replaced: null });
      assert.deepEqual(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => completeChannelConnection(tx, input)), { status: 'unknown_state', inUse: true },
        'el nonce ya se usó, y la cuenta está viva aquí: un aviso repetido no la manda a borrar');
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
      assert.deepEqual(taken, { status: 'taken', inUse: true }, 'la cuenta misma vive en otro espacio: no se borra en Unipile');
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
      assert.deepEqual(await conectar('j'.repeat(43), 'laura@cocina-facil.test'), { status: 'taken', inUse: true },
        'en uso en otro espacio: revocar tumbaría la concesión de ese espacio');
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
      assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => markChannelAccountDown(tx, li.id, unipileStatusCode('CREDENTIALS'), notice)), true);
      assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => markChannelAccountDown(tx, li.id, unipileStatusCode('STOPPED'), notice)), false, 'no vuelve a avisar');
      assert.equal(await t.db.withWorkspace(WS_OTRO, (tx) => markChannelAccountDown(tx, li.id, unipileStatusCode('ERROR'))), false, 'otro espacio no la toca');
      const again = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => findUnipileAccountForWebhook(tx, li.id, 'acc_li_nueva'));
      assert.equal(again?.status, 'needs_reconnect');
      const avisos = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query(`SELECT 1 FROM notification WHERE entity_id = $1`, [li.id]));
      assert.equal(avisos.rows.length, 1);
    });

    test('una respuesta entra atada al toque de su hilo, el enrolamiento deja de enviar y el webhook repetido no la duplica', async () => {
      // El despachador (VEN-10) fija la cuenta del toque al reclamarlo; la demo no la trae.
      await t.admin(`UPDATE outbound_touch SET channel_account_id = '${GMAIL_LAURA}' WHERE id = '00000005-0000-4000-8000-000000070002'`);
      const msg = {
        account: { id: GMAIL_LAURA, channel: 'email' as const }, threadRef: 'gmail-thread-demo-0002', providerMessageId: 'gmail-demo-0002-r1',
        body: 'Me interesa, hablemos.', fromAddress: 'sofia@vitale.co', occurredAt: new Date()
      };
      const first = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordInboundMessage(tx, msg));
      assert.deepEqual(first, { matched: true, inserted: true, enrollmentStopped: true, touchesCanceled: 3, optedOut: false });
      assert.equal((await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordInboundMessage(tx, msg))).inserted, false);
      const rows = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query<{ touch_id: string; intent: string | null; direction: string }>(
        `SELECT touch_id, intent, direction FROM outbound_message WHERE provider_message_id = 'gmail-demo-0002-r1'`,
      ));
      assert.deepEqual(rows.rows, [{ touch_id: '00000005-0000-4000-8000-000000070002', intent: null, direction: 'inbound' }]);
      const e = await sel<{ status: string }>(`SELECT status FROM outbound_enrollment WHERE id = '00000005-0000-4000-8000-0000000e0001'`);
      assert.equal(e[0]?.status, 'replied', 'el siguiente toque ya no sale');
      const touches = await sel<{ id: string; status: string; blocked_reason: string | null }>(
        `SELECT id, status, blocked_reason FROM outbound_touch WHERE enrollment_id = '00000005-0000-4000-8000-0000000e0001' ORDER BY step_index`,
      );
      assert.deepEqual(touches.map((x) => [x.status, x.blocked_reason]), [
        ['sent', null], ['sent', null], ['canceled', 'replied'], ['canceled', 'replied'], ['canceled', 'replied'],
      ]);
      const c = await sel<{ opted_out: boolean }>(`SELECT opted_out FROM contact WHERE id = '00000002-0000-4000-8000-0000000c0011'`);
      assert.equal(c[0]?.opted_out, false, 'una respuesta sin baja no da de baja');
    });

    test('una respuesta que pide la baja por LinkedIn: intención unsubscribe, ficha dada de baja y nada suyo vuelve a salir', async () => {
      const CONTACTO = '00000002-0000-4000-8000-0000000c0012';
      await t.admin(`
        INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, sequence_id, step_index, enrollment_id, step_id, channel, body, status,
                                    scheduled_for, claimed_at, sent_at, attempt_count, provider_message_id, thread_ref, status_changed_at,
                                    channel_account_id)
        VALUES ('00000005-0000-4000-8000-0000000700f1', '${WORKSPACE_LAURA}', '00000002-0000-4000-8000-0000000000e8', '${CONTACTO}',
                '00000005-0000-4000-8000-0000005e0001', 3, '00000005-0000-4000-8000-0000000e0003', '00000005-0000-4000-8000-0000005e0103',
                'linkedin', 'Hola Carolina', 'sent', now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour', 1,
                'unipile-msg-f1', 'chat_carolina', now() - interval '1 hour', '${LINKEDIN_LAURA}'),
               ('00000005-0000-4000-8000-0000000700f2', '${WORKSPACE_LAURA}', '00000002-0000-4000-8000-0000000000e8', '${CONTACTO}',
                '00000005-0000-4000-8000-0000005e0001', 5, '00000005-0000-4000-8000-0000000e0003', '00000005-0000-4000-8000-0000005e0105',
                'linkedin', 'Otra idea', 'scheduled', now() + interval '1 day', NULL, NULL, 0, NULL, NULL, now(), NULL);
      `);
      const r = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordInboundMessage(tx, {
        account: { id: LINKEDIN_LAURA, channel: 'linkedin' }, threadRef: 'chat_carolina', providerMessageId: 'li-in-f1',
        body: 'Por favor, no me escribas más.', fromAddress: 'Carolina', occurredAt: new Date()
      }));
      assert.equal(r.optedOut, true);
      const m = await sel<{ intent: string | null }>(`SELECT intent FROM outbound_message WHERE provider_message_id = 'li-in-f1'`);
      assert.equal(m[0]?.intent, 'unsubscribe');
      const c = await sel<{ opted_out: boolean; opted_out_reason: string | null; opted_out_code: string | null }>(
        `SELECT opted_out, opted_out_reason, opted_out_code FROM contact WHERE id = '${CONTACTO}'`,
      );
      // Un código que la ficha traduce (contacto_codigo_de_baja), nunca una frase en español congelada en la base.
      assert.deepEqual(c[0], { opted_out: true, opted_out_reason: null, opted_out_code: 'reply_optout:linkedin' });
      const e = await sel<{ status: string }>(`SELECT status FROM outbound_enrollment WHERE contact_id = '${CONTACTO}'`);
      assert.ok(e.every((x) => x.status === 'opted_out'), 'todos sus enrolamientos');
      const pending = await sel<{ status: string; blocked_reason: string }>(`SELECT status, blocked_reason FROM outbound_touch WHERE id = '00000005-0000-4000-8000-0000000700f2'`);
      assert.deepEqual(pending[0], { status: 'canceled', blocked_reason: 'opted_out' });
    });

    test("invitación aceptada: una respuesta en chat nuevo con 'no me escribas más' da de baja al contacto y cancela sus toques", async () => {
      const CONTACTO = '00000002-0000-4000-8000-0000000c0009';
      const INVITACION = '00000005-0000-4000-8000-0000000700a1';
      const SIGUIENTE = '00000005-0000-4000-8000-0000000700a2';
      const POR_CORREO = '00000005-0000-4000-8000-0000000700a3';
      // La invitación con nota no abre chat: el despachador (VEN-10) deja el provider_id de la persona en recipient_address y ningún hilo.
      await t.admin(`
        INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, channel, body, status, scheduled_for, claimed_at, sent_at,
                                    attempt_count, provider_message_id, thread_ref, recipient_address, channel_account_id)
        VALUES ('${INVITACION}', '${WORKSPACE_LAURA}', '00000002-0000-4000-8000-0000000000e6', '${CONTACTO}', 'linkedin',
                'Hola Laura, me encantaría conectar.', 'sent', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days',
                1, 'inv_laura_q', NULL, 'ACoAAB_laura_quintero', '${LINKEDIN_LAURA}'),
               ('${SIGUIENTE}', '${WORKSPACE_LAURA}', '00000002-0000-4000-8000-0000000000e6', '${CONTACTO}', 'linkedin',
                'Te comparto un video.', 'scheduled', now() + interval '1 day', NULL, NULL, 0, NULL, NULL, NULL, NULL),
               ('${POR_CORREO}', '${WORKSPACE_LAURA}', '00000002-0000-4000-8000-0000000000e6', '${CONTACTO}', 'email',
                'Hola Laura', 'draft', NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL);
      `);
      const antes = await sel<{ n: number }>(`SELECT count(*)::int AS n FROM outbound_message`);
      const aviso = {
        account: { id: LINKEDIN_LAURA, channel: 'linkedin' as const }, fromAddress: 'Laura Quintero', occurredAt: new Date(),
        threadRef: 'chat_nuevo_laura_q', providerMessageId: 'li-in-a1', body: 'Gracias por la invitación, pero no me escribas más.',
      };
      // Sin saber quién escribe, el chat nuevo no casa con nada: es lo que pasaba antes y la baja se perdía.
      const sinRemitente = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordInboundMessage(tx, aviso));
      assert.equal(sinRemitente.matched, false);
      // Otra persona en un chat nuevo tampoco: su id no es el de ningún destinatario de esta cuenta.
      const otra = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordInboundMessage(tx, { ...aviso, senderProviderId: 'ACoAAB_otra_persona' }));
      assert.equal(otra.matched, false);
      assert.equal((await sel<{ n: number }>(`SELECT count(*)::int AS n FROM outbound_message`))[0]!.n, antes[0]!.n, 'nada guardado');

      const r = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordInboundMessage(tx, { ...aviso, senderProviderId: 'ACoAAB_laura_quintero' }));
      assert.deepEqual(r, { matched: true, inserted: true, enrollmentStopped: false, touchesCanceled: 2, optedOut: true });
      const m = await sel<{ touch_id: string; intent: string; thread_ref: string }>(
        `SELECT touch_id, intent, thread_ref FROM outbound_message WHERE provider_message_id = 'li-in-a1'`,
      );
      assert.deepEqual(m[0], { touch_id: INVITACION, intent: 'unsubscribe', thread_ref: 'chat_nuevo_laura_q' });
      const c = await sel<{ opted_out: boolean; opted_out_code: string | null }>(`SELECT opted_out, opted_out_code FROM contact WHERE id = '${CONTACTO}'`);
      assert.deepEqual(c[0], { opted_out: true, opted_out_code: 'reply_optout:linkedin' });
      const toques = await sel<{ id: string; status: string; blocked_reason: string | null; thread_ref: string | null }>(
        `SELECT id, status, blocked_reason, thread_ref FROM outbound_touch WHERE id IN ('${INVITACION}', '${SIGUIENTE}', '${POR_CORREO}') ORDER BY id`,
      );
      assert.deepEqual(toques.map((x) => [x.id, x.status, x.blocked_reason, x.thread_ref]), [
        // El chat nuevo queda en la invitación: lo que siga en él casa por el hilo.
        [INVITACION, 'sent', null, 'chat_nuevo_laura_q'],
        [SIGUIENTE, 'canceled', 'opted_out', null],
        [POR_CORREO, 'canceled', 'opted_out', null],
      ], 'la baja se respeta en todos los canales');

      // El mismo aviso otra vez no duplica; uno nuevo en ese chat ya casa por el hilo, aunque no traiga remitente.
      assert.equal((await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordInboundMessage(tx, { ...aviso, senderProviderId: 'ACoAAB_laura_quintero' }))).inserted, false);
      const porHilo = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordInboundMessage(tx, { ...aviso, providerMessageId: 'li-in-a2', body: 'Gracias.' }));
      assert.equal(porHilo.matched, true);
      // Un correo no casa por remitente: su respuesta siempre llega en el hilo.
      const correo = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordInboundMessage(tx, {
        ...aviso, account: { id: GMAIL_LAURA, channel: 'email' }, providerMessageId: 'gm-a1', threadRef: 'hilo-inventado', senderProviderId: 'ACoAAB_laura_quintero',
      }));
      assert.equal(correo.matched, false);
      // El código y su lectura: solo los tres canales del CHECK de contacto_codigo_de_baja.
      assert.equal(replyOptOutCode('instagram_dm'), 'reply_optout:instagram_dm');
      assert.equal(replyOptOutCode('whatsapp'), null);
      assert.equal(parseReplyOptOutCode('reply_optout:email'), 'email');
      assert.equal(parseReplyOptOutCode('Pidió la baja'), null);
    });

    test('un mensaje en un chat sin toque nuestro, o con el toque de OTRA cuenta, no escribe ninguna fila (ni el cuerpo)', async () => {
      const OTRA_LI = '00000005-0000-4000-8000-0000000ac0e1';
      await t.admin(`
        INSERT INTO outreach_channel_account (id, workspace_id, creator_id, channel, provider, provider_account_id, display_name, status)
        VALUES ('${OTRA_LI}', '${WORKSPACE_LAURA}', '${CREATOR_LAURA}', 'linkedin', 'unipile', 'acc_li_segunda', 'Laura (2)', 'connected')
        ON CONFLICT (id) DO NOTHING;
      `);
      const antes = await sel<{ n: number }>(`SELECT count(*)::int AS n FROM outbound_message`);
      const base = { fromAddress: 'Un amigo', occurredAt: new Date() };
      // Un DM de un amigo: ningún toque en ese chat.
      const amigo = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordInboundMessage(tx, {
        ...base, account: { id: LINKEDIN_LAURA, channel: 'linkedin' }, threadRef: 'chat_de_un_amigo', providerMessageId: 'li-amigo-1',
        body: '¿Vamos a cenar el viernes? No me escribas más por aquí, jaja',
      }));
      assert.deepEqual(amigo, { matched: false, inserted: false, enrollmentStopped: false, touchesCanceled: 0, optedOut: false });
      // El chat de un toque de LINKEDIN_LAURA, pero el aviso llega por otra cuenta del mismo espacio.
      const cruzado = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordInboundMessage(tx, {
        ...base, account: { id: OTRA_LI, channel: 'linkedin' }, threadRef: 'chat_carolina', providerMessageId: 'li-cruzado-1', body: 'Hola',
      }));
      assert.equal(cruzado.matched, false);
      const despues = await sel<{ n: number }>(`SELECT count(*)::int AS n FROM outbound_message`);
      assert.equal(despues[0]!.n, antes[0]!.n, 'ninguna fila nueva');
      const cuerpo = await sel<{ n: number }>(`SELECT count(*)::int AS n FROM outbound_message WHERE body LIKE '%cenar el viernes%'`);
      assert.equal(cuerpo[0]!.n, 0, 'el cuerpo de un mensaje ajeno no queda en la base');
    });
  });

  describe('reconectar mientras el worker suelta la cuenta (canales_reclamar_al_soltar)', () => {
    const REF_VIEJA = 'enc:gmail:00000000-0000-4000-8000-00000000be01';
    const REF_NUEVA = 'enc:gmail:00000000-0000-4000-8000-00000000be02';
    const secreto = (ref: string) => `INSERT INTO connection_secret (secret_ref, workspace_id, ciphertext, iv, tag)
      VALUES ('${ref}', '${WS_OTRO}', '\\x00', '\\x000000000000000000000000', '\\x00000000000000000000000000000000') ON CONFLICT DO NOTHING`;
    const conectar = (nonce: string, ref: string) => t.db.withWorkspace(WS_OTRO, async (tx) => {
      await createPendingChannelAccount(tx, { channel: 'email', creatorId: CREATOR_OTRO, nonce });
      return completeChannelConnection(tx, { channel: 'email', nonce, providerAccountId: 'suelta@gmail.test', displayName: null, secretRef: ref, scopes: ['gmail.send', 'gmail.modify'] });
    });

    test('una fila desconectada no presta su ref; una reclamada no se revive (releasing); después, sí, con la ref nueva y sin el token viejo', async () => {
      await t.admin(secreto(REF_VIEJA));
      const first = await conectar('s'.repeat(43), REF_VIEJA);
      assert.equal(first.status, 'connected');
      const id = first.status === 'connected' ? first.accountId : '';
      assert.equal(await t.db.withWorkspace(WS_OTRO, (tx) => existingGmailSecretRef(tx, 'suelta@gmail.test')), REF_VIEJA, 'viva: presta su ref');
      await t.db.withWorkspace(WS_OTRO, (tx) => disconnectChannelAccount(tx, id));
      assert.equal(await t.db.withWorkspace(WS_OTRO, (tx) => existingGmailSecretRef(tx, 'suelta@gmail.test')), null, 'desconectada: ref nueva');

      // mc_app no puede reclamarla: es del despachador.
      await assert.rejects(
        t.db.withWorkspace(WS_OTRO, (tx) => tx.query(`UPDATE outreach_channel_account SET release_claimed_at = now() WHERE id = $1`, [id])),
        (e: { code?: string }) => e.code === '42501',
      );
      // El worker la reclama para soltarla; la persona reconecta en ese momento.
      await t.admin(`UPDATE outreach_channel_account SET release_claimed_at = now() WHERE id = '${id}'`);
      await t.admin(secreto(REF_NUEVA));
      assert.deepEqual(await conectar('u'.repeat(43), REF_NUEVA), { status: 'releasing', inUse: false });
      const quieta = await sel<{ status: string; secret_ref: string }>(`SELECT status, secret_ref FROM outreach_channel_account WHERE id = '${id}'`);
      assert.deepEqual(quieta[0], { status: 'disconnected', secret_ref: REF_VIEJA }, 'no se escribió nada');

      // Un reclamo de hace más de 15 minutos es de un job que murió: ya no frena.
      await t.admin(`UPDATE outreach_channel_account SET release_claimed_at = now() - interval '16 minutes' WHERE id = '${id}'`);
      const again = await conectar('v'.repeat(43), REF_NUEVA);
      assert.ok(again.status === 'connected' && again.accountId === id && again.reconnected);
      const viva = await sel<{ status: string; secret_ref: string; release_claimed_at: Date | null; released_at: Date | null }>(
        `SELECT status, secret_ref, release_claimed_at, released_at FROM outreach_channel_account WHERE id = '${id}'`,
      );
      assert.deepEqual(viva[0], { status: 'connected', secret_ref: REF_NUEVA, release_claimed_at: null, released_at: null });
      const vieja = await sel<{ n: number }>(`SELECT count(*)::int AS n FROM connection_secret WHERE secret_ref = '${REF_VIEJA}'`);
      assert.equal(vieja[0]!.n, 0, 'el token viejo, que ya nadie nombra, sale del vault');
    });
  });

  describe('un perfil es una cuenta: la identidad de Unipile (canales_identidad_y_rotacion)', () => {
    const ID_PERFIL = 'ACoAAB_perfil_0042';
    const conectar = (ws: string, creator: string, nonce: string, accountId: string, identity: string | null = ID_PERFIL) =>
      t.db.withWorkspace(ws, async (tx) => {
        await createPendingChannelAccount(tx, { channel: 'linkedin', creatorId: creator, nonce });
        return completeChannelConnection(tx, {
          channel: 'linkedin', nonce, providerAccountId: accountId, displayName: 'Perfil', secretRef: null, scopes: null, providerIdentity: identity,
        });
      });

    test('mc_app no escribe la identidad ni la huella de los avisos (42501): son del callback y del despachador', async () => {
      const es42501 = (e: unknown) => (e as { code?: string }).code === '42501';
      const IG = '00000005-0000-4000-8000-0000000ac0d1';
      await t.admin(`INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, status)
        VALUES ('${IG}', '${WORKSPACE_LAURA}', 'instagram_dm', 'unipile', 'acc_ig_candado', 'needs_reconnect')`);
      await assert.rejects(t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query(`UPDATE outreach_channel_account SET provider_identity = 'x' WHERE id = $1`, [IG])), es42501);
      await assert.rejects(t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query(`UPDATE outreach_channel_account SET provider_webhook_secret_fp = 'a1b2c3d4e5f60718' WHERE id = $1`, [IG])), es42501);
      await t.admin(`DELETE FROM outreach_channel_account WHERE id = '${IG}'`);
      // La sonda de «¿vive en otro espacio?» no es de la web: solo la llama outreach_channel_connect.
      await assert.rejects(
        t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query(`SELECT outreach_channel_live_elsewhere(current_workspace_id(), 'email', 'gmail_oauth', 'x@y.test')`)),
        es42501,
      );
    });

    test('el mismo perfil con otra cuenta de Unipile: conectado → duplicate; caído → su fila adopta la cuenta nueva y devuelve la vieja', async () => {
      const first = await conectar(WS_OTRO, CREATOR_OTRO, 'a'.repeat(43), 'acc_perfil_1');
      assert.equal(first.status, 'connected');
      const filaId = first.status === 'connected' ? first.accountId : '';
      await t.admin(`UPDATE outreach_channel_account SET provider_webhook_ids = '{wh_viejo_m,wh_viejo_s}' WHERE id = '${filaId}'`);

      // Conectado: la cuenta nueva sobra. No se escribe nada y la web la borra en Unipile.
      const dup = await conectar(WS_OTRO, CREATOR_OTRO, 'b'.repeat(43), 'acc_perfil_2');
      assert.deepEqual(dup, { status: 'duplicate', accountId: filaId });
      const vivas = await sel<{ n: number }>(`SELECT count(*)::int AS n FROM outreach_channel_account WHERE provider_identity = '${ID_PERFIL}'`);
      assert.equal(vivas[0]!.n, 1, 'un perfil, una fila');

      // Caído: la fila del perfil (con su historial y sus contadores) adopta la cuenta nueva.
      await t.db.withWorkspace(WS_OTRO, (tx) => markChannelAccountDown(tx, filaId, 'unipile_status:CREDENTIALS'));
      const adopt = await conectar(WS_OTRO, CREATOR_OTRO, 'c'.repeat(43), 'acc_perfil_3');
      assert.deepEqual(adopt, {
        status: 'connected', accountId: filaId, reconnected: true,
        replaced: { providerAccountId: 'acc_perfil_1', webhookIds: ['wh_viejo_m', 'wh_viejo_s'] },
      });
      const fila = await sel<{ provider_account_id: string; status: string; provider_webhook_ids: string[] }>(
        `SELECT provider_account_id, status, provider_webhook_ids FROM outreach_channel_account WHERE id = '${filaId}'`,
      );
      assert.deepEqual(fila[0], { provider_account_id: 'acc_perfil_3', status: 'connected', provider_webhook_ids: [] });
    });

    test('el mismo perfil vivo en OTRO espacio: taken, y la cuenta nueva no la usa nadie (la web la borra)', async () => {
      const r = await conectar(WORKSPACE_LAURA, CREATOR_LAURA, 'd'.repeat(43), 'acc_perfil_4');
      assert.deepEqual(r, { status: 'taken', inUse: false });
      const nada = await sel<{ n: number }>(`SELECT count(*)::int AS n FROM outreach_channel_account WHERE provider_account_id = 'acc_perfil_4'`);
      assert.equal(nada[0]!.n, 0, 'no se escribió nada');
    });

    test('«unknown_state» con una cuenta que nadie usa (el primer enlace de un doble clic): in_use false, sin escribir nada', async () => {
      const r = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => completeChannelConnection(tx, {
        channel: 'instagram_dm', nonce: 'e'.repeat(43), providerAccountId: 'acc_ig_huerfana', displayName: null, secretRef: null, scopes: null, providerIdentity: 'ig_1',
      }));
      assert.deepEqual(r, { status: 'unknown_state', inUse: false });
      const nada = await sel<{ n: number }>(`SELECT count(*)::int AS n FROM outreach_channel_account WHERE provider_account_id = 'acc_ig_huerfana'`);
      assert.equal(nada[0]!.n, 0, 'la sonda se deshizo');
    });

    test('markChannelAccountOk: una caída vuelve a connected con su aviso de éxito; una conectada no se toca', async () => {
      const [li] = (await t.db.withWorkspace(WS_OTRO, (tx) => listChannelAccounts(tx))).filter((r) => r.providerAccountId === 'acc_perfil_3');
      assert.ok(li);
      await t.db.withWorkspace(WS_OTRO, (tx) => markChannelAccountDown(tx, li.id, 'unipile_status:CREDENTIALS'));
      const notice = { titleEs: 'Tu LinkedIn volvió', bodyEs: 'Ya puede enviar.' };
      assert.equal(await t.db.withWorkspace(WS_OTRO, (tx) => markChannelAccountOk(tx, li.id, notice)), true);
      assert.equal(await t.db.withWorkspace(WS_OTRO, (tx) => markChannelAccountOk(tx, li.id, notice)), false, 'ya estaba bien: no avisa otra vez');
      assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => markChannelAccountOk(tx, li.id)), false, 'otro espacio no la toca');
      const fila = await sel<{ status: string; last_error: string | null }>(`SELECT status, last_error FROM outreach_channel_account WHERE id = '${li.id}'`);
      assert.deepEqual(fila[0], { status: 'connected', last_error: null });
      const avisos = await sel<{ severity: string }>(`SELECT severity FROM notification WHERE entity_id = '${li.id}' AND severity = 'success'`);
      assert.equal(avisos.length, 1);
    });

    test('los códigos de last_error: unipile_status parametrizado y limpio', () => {
      assert.equal(unipileStatusCode('CREDENTIALS'), 'unipile_status:CREDENTIALS');
      assert.equal(unipileStatusCode('<b>x</b>'), 'unipile_status:BXB');
      assert.equal(unipileStatusCode(null), 'unipile_status:UNKNOWN');
      assert.equal(parseUnipileStatusCode('unipile_status:STOPPED'), 'STOPPED');
      assert.equal(parseUnipileStatusCode('taken'), null);
    });

    test('canales_last_error_codigo: last_error solo acepta códigos, y todos los que escribe el código tienen esa forma', async () => {
      for (const code of [...Object.values(CHANNEL_ERROR_CODES), unipileStatusCode('CREDENTIALS'), unipileStatusCode('<b>x</b>'), unipileStatusCode(null)]) {
        assert.match(code, CHANNEL_ERROR_CODE_RE, `«${code}» cabe en el CHECK de canales_last_error_codigo`);
      }
      // Ni siquiera el despachador escribe una frase: la base lo impide (23514).
      await assert.rejects(
        t.admin(`UPDATE outreach_channel_account SET last_error = 'LinkedIn cerró la sesión.' WHERE id = '${LINKEDIN_LAURA}'`),
        (e: { code?: string }) => e.code === '23514',
      );
      await assert.rejects(
        t.db.withWorkspace(WORKSPACE_LAURA, (tx) => noteChannelAccountIssue(tx, GMAIL_LAURA, 'Google dijo invalid_grant')),
        (e: { code?: string }) => e.code === '23514',
      );
    });
  });
});

describe('canales_last_error_codigo · last_error de antes, en frase', () => {
  test('la frase del seed viejo pasa a su código, cualquier otra a «unknown», y una fila vieja se puede seguir actualizando', { timeout: 120_000 }, async () => {
    const antes = await createEmbeddedDb({ seeds: false, hasta: '0043_contacto_codigo_de_baja.sql' });
    try {
      await antes.execAsSuperuser(`
        INSERT INTO workspace (id, slug, name) VALUES ('${WS_OTRO}', 'ws-0044', 'ws canales_last_error_codigo');
        INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${CREATOR_OTRO}', '${WS_OTRO}', 'Otro');
        INSERT INTO outreach_channel_account (id, workspace_id, creator_id, channel, provider, provider_account_id, status, last_error) VALUES
          ('00000009-0000-4000-8000-0000000a4401', '${WS_OTRO}', '${CREATOR_OTRO}', 'linkedin', 'unipile', 'acc_frase_seed', 'needs_reconnect',
           'LinkedIn cerró la sesión. Vuelve a conectar la cuenta.'),
          ('00000009-0000-4000-8000-0000000a4402', '${WS_OTRO}', '${CREATOR_OTRO}', 'linkedin', 'unipile', 'acc_frase_otra', 'error',
           'Unipile dijo: Internal Server Error'),
          ('00000009-0000-4000-8000-0000000a4403', '${WS_OTRO}', '${CREATOR_OTRO}', 'instagram_dm', 'unipile', 'acc_codigo', 'connected',
           'webhooks_missing');
      `);
      assert.deepEqual(await antes.migrar('0044_canales_last_error_codigo.sql'), ['0044_canales_last_error_codigo.sql']);
      const { rows } = await antes.queryAsSuperuser<{ provider_account_id: string; last_error: string }>(
        `SELECT provider_account_id, last_error FROM outreach_channel_account ORDER BY provider_account_id`,
      );
      assert.deepEqual(rows, [
        { provider_account_id: 'acc_codigo', last_error: 'webhooks_missing' },
        { provider_account_id: 'acc_frase_otra', last_error: 'unknown' },
        { provider_account_id: 'acc_frase_seed', last_error: 'unipile_status:CREDENTIALS' },
      ]);
      // El keepalive actualiza otras columnas de esas filas: con el CHECK en pie, no falla.
      await antes.execAsSuperuser(`UPDATE outreach_channel_account SET keepalive_checked_at = now()`);
      const forzada = await antes.queryAsSuperuser<{ f: boolean }>(`SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = 'outreach_channel_account'`);
      assert.equal(forzada.rows[0]?.f, true, 'la RLS forzada vuelve a quedar puesta');
    } finally {
      await antes.close();
    }
  });
});
