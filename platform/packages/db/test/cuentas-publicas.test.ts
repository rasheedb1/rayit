/** CON-10 · cuentas por @: alta, snapshot diario (la primera lectura del día queda; mc_app no la corrige), lista con último snapshot y Δ7d, fallos, aislamiento. */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addPublicAccount, CreatorNotInWorkspace, disconnectConnection, listAccounts, listConsents, markAccountLookupFailure, publicSecretRef, recordAccountSnapshot, recordConsent } from '../src/index.ts';
import { openTestDb, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

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
    // La segunda lectura del 22 no corrige la primera: las métricas se
    // insertan, nunca se actualizan (0025 §5).
    assert.deepEqual(row.latest, { day: '2026-09-22', followers: 1240, following: null, mediaCount: 41, views: null });
    assert.equal(row.followersWeekAgo, 1200);
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query(`UPDATE account_metric_snapshot SET followers = 1 WHERE connection_id = $1`, [id])),
      /permission denied/,
      'la web no puede corregir una métrica',
    );
    assert.ok(row.lastSyncedAt, 'la lectura marca last_synced_at');
    assert.equal(await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => tx.query(`SELECT 1 FROM account_metric_snapshot WHERE connection_id = $1`, [id])).then((r) => r.rows.length), 0, 'RLS: el otro workspace no ve los snapshots');
  });

  test('actualizar dos veces el mismo día no mueve last_synced_at: la frescura anunciada es la del dato guardado', async () => {
    const { id } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => addPublicAccount(tx, { ...input, platformId: 'youtube', handle: 'frescura', externalAccountId: 'UCfrescura', profileUrl: null, accountType: 'unknown' }));
    const synced = async (): Promise<string> => {
      const r = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query<{ at: string }>(`SELECT last_synced_at::text AS at FROM social_connection WHERE id = $1`, [id]));
      return r.rows[0]!.at;
    };
    const first = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordAccountSnapshot(tx, { connectionId: id, day: '2026-09-23', followers: 500, following: null, mediaCount: 10, views: 9000, raw: {} }));
    assert.equal(first, 'guardada');
    const morning = await synced();
    assert.ok(morning, 'la primera lectura del día marca last_synced_at');
    // Una lectura fallida en medio: la segunda lectura, que sí responde, limpia el fallo.
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => markAccountLookupFailure(tx, id, 'YouTube no respondió.', false));
    const second = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordAccountSnapshot(tx, { connectionId: id, day: '2026-09-23', followers: 520, following: null, mediaCount: 10, views: 9100, raw: {} }));
    assert.equal(second, 'ya_hay_lectura_de_hoy');
    assert.equal(await synced(), morning, 'last_synced_at sigue en la hora de la primera lectura');
    const row = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listAccounts(tx))).find((r) => r.id === id)!;
    assert.equal(row.latest?.followers, 500, 'la cifra mostrada es la de la primera lectura, y su frescura también');
    assert.equal(row.consecutiveFailures, 0);
    assert.equal(row.statusDetail, null);
    const next = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordAccountSnapshot(tx, { connectionId: id, day: '2026-09-24', followers: 530, following: null, mediaCount: 11, views: 9200, raw: {} }));
    assert.equal(next, 'guardada', 'al día siguiente se vuelve a guardar');
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
