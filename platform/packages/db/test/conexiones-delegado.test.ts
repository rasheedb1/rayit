/**
 * ACC-8 · consentimiento delegado en queries/conexiones.ts sobre Postgres
 * embebido con el seed: quién actúa (getSessionMember), a nombre de quién
 * (getConsentCreator), el aviso al titular (notification connection_added,
 * 0034), la bitácora (audit_log) y la evidencia de la revocación; otro
 * workspace no ve nada de eso.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addPublicAccount, disconnectConnection, getConsentCreator, getSessionMember, listAccounts, listConsents, notifyConnectionAdded,
  recordConnectionAudit, recordConsent,
} from '../src/index.ts';
import { openTestDb, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

const WORKSPACE_AJENO = '00000009-0000-4000-8000-00000000ac08';
const CREATOR_LAURA = '00000002-0000-4000-8000-000000000003';
const USER_LAURA = '00000002-0000-4000-8000-000000000002';
const USER_MANAGER = '00000009-0000-4000-8000-0000000000a1';
const USER_EDITOR = '00000009-0000-4000-8000-0000000000a2';
const USER_AJENO = '00000009-0000-4000-8000-0000000000a3';

let t: TestDb;
before(async () => {
  t = await openTestDb();
  await t.admin(`
    INSERT INTO workspace (id, slug, name) VALUES ('${WORKSPACE_AJENO}', 'ajeno-acc8', 'Ajeno') ON CONFLICT DO NOTHING;
    INSERT INTO app_user (id, email, name) VALUES
      ('${USER_MANAGER}', 'andres@ejemplo.com', 'Andrés Pardo'),
      ('${USER_EDITOR}', 'edita@ejemplo.com', 'Edita Ruiz'),
      ('${USER_AJENO}', 'ajeno@ejemplo.com', 'Otro')
    ON CONFLICT DO NOTHING;
    INSERT INTO membership (workspace_id, user_id, role) VALUES
      ('${WORKSPACE_LAURA}', '${USER_MANAGER}', 'admin'),
      ('${WORKSPACE_LAURA}', '${USER_EDITOR}', 'viewer'),
      ('${WORKSPACE_AJENO}', '${USER_AJENO}', 'owner')
    ON CONFLICT DO NOTHING;
  `);
}, { timeout: 120_000 });
after(async () => { await t.close(); });

const asManager = <T,>(fn: Parameters<typeof t.db.withWorkspace<T>>[1]) => t.db.withWorkspace(WORKSPACE_LAURA, fn, { userId: USER_MANAGER });
const asLaura = <T,>(fn: Parameters<typeof t.db.withWorkspace<T>>[1]) => t.db.withWorkspace(WORKSPACE_LAURA, fn, { userId: USER_LAURA });

const account = { creatorId: CREATOR_LAURA, platformId: 'instagram' as const, handle: 'cafealma', externalAccountId: '17841400000000e01', displayName: 'Café Alma', avatarUrl: null, profileUrl: null, accountType: 'business' as const };

describe('quién actúa y a nombre de quién', () => {
  test('getSessionMember: el mánager con su rol; sin identidad, null; alguien de otro workspace, null', async () => {
    assert.deepEqual(await asManager(getSessionMember), { userId: USER_MANAGER, email: 'andres@ejemplo.com', name: 'Andrés Pardo', roleKey: 'admin' });
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, getSessionMember), null, 'modo demo: nadie');
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, getSessionMember, { userId: USER_AJENO }), null, 'no es miembro de este workspace');
    assert.equal((await t.db.withWorkspace(WORKSPACE_LAURA, getSessionMember, { userId: USER_EDITOR }))?.roleKey, 'viewer');
  });

  test('getConsentCreator: el perfil del workspace con el app_user del titular', async () => {
    assert.deepEqual(await asManager(getConsentCreator), { id: CREATOR_LAURA, userId: USER_LAURA, displayName: 'Laura Méndez' });
  });
});

describe('aviso al titular y bitácora', () => {
  test('el aviso llega una sola vez mientras esté sin leer; otro workspace no lo ve; la bitácora nombra al mánager', async () => {
    const { id } = await asManager((tx) => addPublicAccount(tx, account));
    const evidence = { v: 2, declaredOwner: true, onBehalfOf: { creatorId: CREATOR_LAURA }, actedBy: { userId: USER_MANAGER, email: 'andres@ejemplo.com', roleKey: 'admin' } };
    await asManager((tx) => recordConsent(tx, { connectionId: id, creatorId: CREATOR_LAURA, purpose: 'analytics', policyVersion: '2026-09-22', evidence }));
    const first = await asManager((tx) => notifyConnectionAdded(tx, { userId: USER_LAURA, connectionId: id, titleEs: 'Una cuenta se conectó en tu nombre', bodyEs: 'Andrés Pardo conectó @cafealma.' }));
    const second = await asManager((tx) => notifyConnectionAdded(tx, { userId: USER_LAURA, connectionId: id, titleEs: 'Una cuenta se conectó en tu nombre', bodyEs: 'Andrés Pardo conectó @cafealma.' }));
    assert.equal(first, true);
    assert.equal(second, false, 'ya había un aviso sin leer para esa cuenta y esa persona');
    const mine = await asLaura((tx) => tx.query<{ kind: string; user_id: string; entity_id: string; action_url: string; body_es: string }>(
      `SELECT kind, user_id, entity_id, action_url, body_es FROM notification WHERE kind = 'connection_added'`,
    ));
    assert.equal(mine.rows.length, 1);
    assert.deepEqual(mine.rows[0], { kind: 'connection_added', user_id: USER_LAURA, entity_id: id, action_url: '/conexiones', body_es: 'Andrés Pardo conectó @cafealma.' });
    const ajeno = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => tx.query(`SELECT 1 FROM notification WHERE kind = 'connection_added'`), { userId: USER_AJENO });
    assert.equal(ajeno.rows.length, 0, 'RLS: el otro workspace no ve el aviso');

    await asManager((tx) => recordConnectionAudit(tx, { action: 'connection.added', connectionId: id, after: { connectionId: id, platformId: 'instagram', handle: 'cafealma', onBehalfOf: { creatorId: CREATOR_LAURA }, actedBy: { userId: USER_MANAGER, roleKey: 'admin' } } }));
    const audit = await t.db.asWorker((tx) => tx.query<{ actor_user_id: string; actor_kind: string; entity_id: string; after: Record<string, unknown>; workspace_id: string }>(
      `SELECT actor_user_id, actor_kind, entity_id, after, workspace_id FROM audit_log WHERE action = 'connection.added' AND entity_id = $1`, [id],
    ));
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0]!.actor_user_id, USER_MANAGER, 'el actor es quien actuó, no el titular');
    assert.equal(audit.rows[0]!.workspace_id, WORKSPACE_LAURA);
    assert.deepEqual(audit.rows[0]!.after['onBehalfOf'], { creatorId: CREATOR_LAURA });
    assert.equal(JSON.stringify(audit.rows[0]!.after).includes('@ejemplo.com'), false, 'la bitácora no lleva el correo');
    const ajenoAudit = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => tx.query(`SELECT 1 FROM audit_log WHERE entity_id = $1`, [id]), { userId: USER_AJENO });
    assert.equal(ajenoAudit.rows.length, 0, 'RLS: el otro workspace no ve la bitácora');
  });

  test('listAccounts dice quién conectó: el nombre mientras es miembro, el correo de la evidencia si ya no lo es', async () => {
    const row = (await asLaura(listAccounts)).find((r) => r.handle === 'cafealma')!;
    assert.ok(row.connectedBy, 'la cuenta la conectó un tercero');
    assert.equal(row.connectedBy!.userId, USER_MANAGER);
    assert.equal(row.connectedBy!.name, 'Andrés Pardo');
    assert.equal(row.connectedBy!.email, 'andres@ejemplo.com');
    assert.match(row.connectedBy!.at, /^\d{4}-\d{2}-\d{2}T/);
    const own = (await asLaura(listAccounts)).find((r) => r.handle === 'laura.cocinafacil' && r.platformId === 'instagram')!;
    assert.equal(own.connectedBy, null, 'la del seed la conectó la propia titular: null, no un guion');
    await t.admin(`DELETE FROM membership WHERE workspace_id = '${WORKSPACE_LAURA}' AND user_id = '${USER_MANAGER}';`);
    const later = (await asLaura(listAccounts)).find((r) => r.handle === 'cafealma')!;
    assert.equal(later.connectedBy!.name, null, 'app_user ya no es visible desde este workspace');
    assert.equal(later.connectedBy!.email, 'andres@ejemplo.com', 'la evidencia conserva el correo de ese día');
    await t.admin(`INSERT INTO membership (workspace_id, user_id, role) VALUES ('${WORKSPACE_LAURA}', '${USER_MANAGER}', 'admin') ON CONFLICT DO NOTHING;`);
  });

  test('quitar por un tercero anexa la revocación a cada consentimiento sin tocar el otorgamiento', async () => {
    const { id } = await asManager((tx) => addPublicAccount(tx, { ...account, platformId: 'youtube', handle: 'NutriveOficial', externalAccountId: 'UCnutrive', accountType: 'channel' }));
    await asManager((tx) => recordConsent(tx, { connectionId: id, creatorId: CREATOR_LAURA, purpose: 'analytics', policyVersion: '2026-09-22', evidence: { v: 2, declaredOwner: true, onBehalfOf: { creatorId: CREATOR_LAURA } } }));
    const gone = await asManager((tx) => disconnectConnection(tx, id, { at: '2026-09-23T15:00:00.000Z', actedBy: { userId: USER_MANAGER, email: 'andres@ejemplo.com', roleKey: 'admin' }, onBehalfOf: { creatorId: CREATOR_LAURA } }));
    assert.deepEqual(gone, { id, secretRef: 'public:youtube:nutriveoficial', platformId: 'youtube', handle: 'NutriveOficial', accessMode: 'public_profile', creatorId: CREATOR_LAURA });
    const consents = await asLaura((tx) => listConsents(tx, id));
    assert.equal(consents.every((c) => c.revokedAt !== null), true);
    const ev = await t.db.asWorker((tx) => tx.query<{ evidence: Record<string, unknown> }>(`SELECT evidence FROM data_consent WHERE connection_id = $1`, [id]));
    assert.equal(ev.rows[0]!.evidence['declaredOwner'], true, 'el otorgamiento sigue igual');
    assert.deepEqual((ev.rows[0]!.evidence['revocation'] as Record<string, unknown>)['actedBy'], { userId: USER_MANAGER, email: 'andres@ejemplo.com', roleKey: 'admin' });
    await assert.rejects(asManager((tx) => disconnectConnection(tx, id, {})), /No existe una conexión activa/);
  });
});
