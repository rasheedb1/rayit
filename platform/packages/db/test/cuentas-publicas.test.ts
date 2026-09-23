/** CON-10 · cuentas por @: alta, snapshot diario (reemplaza el mismo día), lista con último snapshot y Δ7d, fallos, aislamiento. */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addPublicAccount, CreatorNotInWorkspace, disconnectConnection, findPublicAccountByHandle, listAccounts, listConsents, markAccountLookupFailure, publicSecretRef, recordAccountSnapshot, recordConsent, upgradePublicAccountToOAuth } from '../src/index.ts';
import { openTestDb, WORKSPACE_LAURA, type TestDb } from './helpers/base.ts';

const WORKSPACE_AJENO = '00000009-0000-4000-8000-000000000003';
const CREATOR_LAURA = '00000002-0000-4000-8000-000000000003';

let t: TestDb;
before(async () => {
  t = await openTestDb();
  await t.admin(`INSERT INTO workspace (id, slug, name) VALUES ('${WORKSPACE_AJENO}', 'ajeno-cuentas', 'Ajeno') ON CONFLICT DO NOTHING;`);
});
after(async () => { await t.close(); });

const input = { creatorId: CREATOR_LAURA, platformId: 'instagram' as const, handle: 'nicolasduartea', externalAccountId: '17841400000009999', displayName: null, avatarUrl: null, profileUrl: 'https://www.instagram.com/nicolasduartea/', accountType: 'business' as const };

describe('alta por @', () => {
  test('crea la cuenta con access_mode public_profile, sin tokens, y volver a agregarla no duplica', async () => {
    const a = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => addPublicAccount(tx, input));
    assert.equal(a.created, true);
    const b = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => addPublicAccount(tx, { ...input, displayName: 'Nicolás' }));
    assert.equal(b.created, false);
    assert.equal(b.id, a.id);
    const rows = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listAccounts(tx));
    const mine = rows.find((r) => r.id === a.id)!;
    assert.equal(mine.accessMode, 'public_profile');
    assert.equal(mine.secretRef, publicSecretRef('instagram', 'nicolasduartea'));
    assert.equal(mine.displayName, 'Nicolás');
    assert.deepEqual(mine.scopes, []);
    assert.equal(mine.latest, null, 'sin snapshot todavía: null, no cero');
    assert.equal(mine.lastSyncedAt, null);
    await assert.rejects(t.db.withWorkspace(WORKSPACE_AJENO, (tx) => addPublicAccount(tx, input)), CreatorNotInWorkspace);
    assert.equal((await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => listAccounts(tx))).length, 0);
  });

  test('el consentimiento de una cuenta pública guarda la declaración de propiedad', async () => {
    const { id } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => addPublicAccount(tx, input));
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordConsent(tx, { connectionId: id, creatorId: CREATOR_LAURA, purpose: 'analytics', policyVersion: '2026-09-22', evidence: { declaredOwner: true, handle: 'nicolasduartea', ip: '203.0.113.7' } }));
    const consents = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listConsents(tx, id));
    assert.equal(consents.filter((c) => c.revokedAt === null).length, 1);
  });
});

describe('snapshots', () => {
  test('dos lecturas el mismo día dejan una fila; la historia da Δ7d; nunca inventa un cero', async () => {
    const { id } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => addPublicAccount(tx, input));
    await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      await recordAccountSnapshot(tx, { connectionId: id, day: '2026-09-15', followers: 1200, following: null, mediaCount: 40, views: null, raw: { a: 1 } });
      await recordAccountSnapshot(tx, { connectionId: id, day: '2026-09-22', followers: 1240, following: null, mediaCount: 41, views: null, raw: {} });
      await recordAccountSnapshot(tx, { connectionId: id, day: '2026-09-22', followers: 1250, following: null, mediaCount: 41, views: null, raw: {} });
    });
    const n = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM account_metric_snapshot WHERE connection_id = $1`, [id]));
    assert.equal(Number(n.rows[0]!.n), 2, 'una fila por día');
    const row = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listAccounts(tx))).find((r) => r.id === id)!;
    assert.deepEqual(row.latest, { day: '2026-09-22', followers: 1250, following: null, mediaCount: 41, views: null });
    assert.equal(row.followersWeekAgo, 1200);
    assert.ok(row.lastSyncedAt, 'la lectura marca last_synced_at');
    assert.equal(await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => tx.query(`SELECT 1 FROM account_metric_snapshot WHERE connection_id = $1`, [id])).then((r) => r.rows.length), 0, 'RLS: el otro workspace no ve los snapshots');
  });

  test('un fallo permanente pasa la cuenta a error con su detalle; quitar la cuenta conserva la historia', async () => {
    const { id } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => addPublicAccount(tx, { ...input, platformId: 'tiktok', handle: 'selvathegolden', externalAccountId: 'selvathegolden', profileUrl: 'https://www.tiktok.com/@selvathegolden', accountType: 'unknown' }));
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => markAccountLookupFailure(tx, id, 'TikTok no respondió.', false));
    let row = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listAccounts(tx))).find((r) => r.id === id)!;
    assert.equal(row.status, 'active');
    assert.equal(row.consecutiveFailures, 1);
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => markAccountLookupFailure(tx, id, 'No encontramos @selvathegolden.', true));
    row = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listAccounts(tx))).find((r) => r.id === id)!;
    assert.equal(row.status, 'error');
    assert.match(row.statusDetail!, /No encontramos/);
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => disconnectConnection(tx, id));
    assert.equal((await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listAccounts(tx))).some((r) => r.id === id), false);
    const again = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => addPublicAccount(tx, { ...input, platformId: 'tiktok', handle: 'selvathegolden', externalAccountId: 'selvathegolden', profileUrl: null, accountType: 'unknown' }));
    assert.equal(again.id, id, 'volver a agregarla reactiva la misma fila');
    assert.equal((await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listAccounts(tx))).find((r) => r.id === id)!.status, 'active');
  });
});

describe('de @ a autorizada', () => {
  test('autorizar convierte la misma fila (id e historial) en direct_oauth con open_id y tokens; otro workspace no la ve', async () => {
    const { id } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => addPublicAccount(tx, { ...input, platformId: 'tiktok', handle: 'selvathegolden', externalAccountId: 'selvathegolden', profileUrl: null, accountType: 'unknown' }));
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordAccountSnapshot(tx, { connectionId: id, day: '2026-09-22', followers: null, following: null, mediaCount: null, views: null, raw: {} }));
    assert.equal((await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => findPublicAccountByHandle(tx, 'tiktok', 'SelvaTheGolden')))?.id, id, 'busca sin distinguir mayúsculas');
    assert.equal(await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => findPublicAccountByHandle(tx, 'tiktok', 'selvathegolden')), null);
    // Una autorización anterior de la misma cuenta (mismo open_id) existe: al convertir la fila por @, la vieja se retira y libera el UNIQUE.
    const previous = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query<{ id: string }>(
      `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_mode)
       VALUES (current_workspace_id(), $1, 'tiktok', 'open_id_selva', 'selvathegolden', 'enc:tiktok:66666666-6666-4666-8666-666666666666', '{user.info.basic}', 'direct_oauth') RETURNING id`, [CREATOR_LAURA]));
    const previousId = previous.rows[0]!.id;
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => upgradePublicAccountToOAuth(tx, id, {
      externalAccountId: 'open_id_selva', handle: 'selvathegolden', displayName: 'Selva', avatarUrl: null, profileUrl: 'https://www.tiktok.com/@selvathegolden', accountType: 'creator',
      secretRef: 'enc:tiktok:44444444-4444-4444-8444-444444444444', scopes: ['user.info.basic', 'video.list'], accessExpiresAt: new Date('2026-09-24T00:00:00Z'), refreshExpiresAt: new Date('2027-09-23T00:00:00Z'),
    }));
    const row = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listAccounts(tx))).find((r) => r.id === id)!;
    assert.equal(row.accessMode, 'direct_oauth');
    assert.equal(row.externalAccountId, 'open_id_selva');
    assert.equal(row.secretRef, 'enc:tiktok:44444444-4444-4444-8444-444444444444');
    assert.deepEqual(row.scopes, ['user.info.basic', 'video.list']);
    assert.equal(row.latest?.day, '2026-09-22', 'el historial por @ se conserva');
    const old = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query<{ status: string; external_account_id: string; deleted_at: string | null }>(`SELECT status, external_account_id, deleted_at FROM social_connection WHERE id = $1`, [previousId]));
    assert.equal(old.rows[0]!.status, 'disabled');
    assert.ok(old.rows[0]!.deleted_at);
    assert.match(old.rows[0]!.external_account_id, /^open_id_selva~sustituida~/);
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => findPublicAccountByHandle(tx, 'tiktok', 'selvathegolden')), null, 'ya no es pública');
    await assert.rejects(t.db.withWorkspace(WORKSPACE_AJENO, (tx) => upgradePublicAccountToOAuth(tx, id, { externalAccountId: 'x', handle: null, displayName: null, avatarUrl: null, profileUrl: null, accountType: 'unknown', secretRef: 'enc:tiktok:55555555-5555-4555-8555-555555555555', scopes: [], accessExpiresAt: new Date(), refreshExpiresAt: null })));
  });
});

