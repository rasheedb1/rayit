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
  recordConsent, sessionHasPermission,
} from '../src/index.ts';
import { openTestDb, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

const WORKSPACE_AJENO = '00000009-0000-4000-8000-00000000ac08';
const CREATOR_LAURA = '00000002-0000-4000-8000-000000000003';
const USER_LAURA = '00000002-0000-4000-8000-000000000002';
/** Andrés Pardo, el mánager de la demo (seed 0003): membership 'admin'. */
const USER_MANAGER = '00000002-0000-4000-8000-000000000004';
const USER_EDITOR = '00000009-0000-4000-8000-0000000000a2';
const USER_AJENO = '00000009-0000-4000-8000-0000000000a3';
/**
 * «El mánager con la casilla de ACC-4»: ACC-4 todavía no existe, así que
 * se representa con un rol a medida del workspace (0034 lo admite: role
 * con workspace_id) con los permisos del Mánager de fábrica MÁS conectar
 * y desconectar, que es lo que la casilla otorga.
 */
const ROLE_MANAGER_CONECTA = '00000009-0000-4000-8000-00000000ac81';

let t: TestDb;
before(async () => {
  t = await openTestDb();
  await t.admin(`
    INSERT INTO workspace (id, slug, name) VALUES ('${WORKSPACE_AJENO}', 'ajeno-acc8', 'Ajeno') ON CONFLICT DO NOTHING;
    INSERT INTO app_user (id, email, name) VALUES
      ('${USER_EDITOR}', 'edita@ejemplo.com', 'Edita Ruiz'),
      ('${USER_AJENO}', 'ajeno@ejemplo.com', 'Otro')
    ON CONFLICT DO NOTHING;
    INSERT INTO membership (workspace_id, user_id, role_id) VALUES
      ('${WORKSPACE_LAURA}', '${USER_EDITOR}', system_role_id('creator', 'editor')),
      ('${WORKSPACE_AJENO}', '${USER_AJENO}', system_role_id('creator', 'owner'))
    ON CONFLICT DO NOTHING;
    INSERT INTO role (id, workspace_id, key, workspace_kind, label_es, is_system)
    VALUES ('${ROLE_MANAGER_CONECTA}', '${WORKSPACE_LAURA}', 'manager_conecta', 'creator', 'Mánager (también conecta mis cuentas)', false)
    ON CONFLICT DO NOTHING;
    INSERT INTO role_permission (role_id, permission_key)
      SELECT '${ROLE_MANAGER_CONECTA}', permission_key FROM role_permission WHERE role_id = system_role_id('creator', 'manager')
      UNION VALUES ('${ROLE_MANAGER_CONECTA}'::uuid, 'conexiones.cuenta.conectar'), ('${ROLE_MANAGER_CONECTA}'::uuid, 'conexiones.cuenta.desconectar')
    ON CONFLICT DO NOTHING;
    UPDATE membership SET role_id = '${ROLE_MANAGER_CONECTA}' WHERE workspace_id = '${WORKSPACE_LAURA}' AND user_id = '${USER_MANAGER}';
  `);
}, { timeout: 600_000 }); // Postgres embebido con migraciones y seeds: con la máquina cargada pasa de los dos minutos.
after(async () => { await t.close(); });

const asManager = <T,>(fn: Parameters<typeof t.db.withWorkspace<T>>[1]) => t.db.withWorkspace(WORKSPACE_LAURA, fn, { userId: USER_MANAGER });
const asLaura = <T,>(fn: Parameters<typeof t.db.withWorkspace<T>>[1]) => t.db.withWorkspace(WORKSPACE_LAURA, fn, { userId: USER_LAURA });

const account = { creatorId: CREATOR_LAURA, platformId: 'instagram' as const, handle: 'cafealma', externalAccountId: '17841400000000e01', displayName: 'Café Alma', avatarUrl: null, profileUrl: null, accountType: 'business' as const };

describe('quién actúa y a nombre de quién', () => {
  test('getSessionMember: el mánager con su rol; sin identidad, null; alguien de otro workspace, null', async () => {
    assert.deepEqual(await asManager(getSessionMember), { userId: USER_MANAGER, email: 'andres@ejemplo.com', name: 'Andrés Pardo', roleKey: 'manager_conecta' });
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, getSessionMember), null, 'modo demo: nadie');
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, getSessionMember, { userId: USER_AJENO }), null, 'no es miembro de este workspace');
    assert.equal((await t.db.withWorkspace(WORKSPACE_LAURA, getSessionMember, { userId: USER_EDITOR }))?.roleKey, 'editor');
  });

  test('sessionHasPermission lee role_permission: la titular y el mánager con la casilla conectan; el editor, alguien ajeno y el modo demo no', async () => {
    const can = (userId: string | undefined, ws = WORKSPACE_LAURA) => t.db.withWorkspace(ws, (tx) => sessionHasPermission(tx, 'conexiones.cuenta.conectar'), userId ? { userId } : undefined);
    assert.equal(await can(USER_LAURA), true, 'Dueño');
    assert.equal(await can(USER_MANAGER), true, 'Mánager con la casilla');
    assert.equal(await can(USER_EDITOR), false, 'Editor');
    assert.equal(await can(USER_AJENO), false, 'dueño de OTRO workspace');
    assert.equal(await can(undefined), false, 'sin sesión');
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => sessionHasPermission(tx, 'conexiones.cuenta.ver'), { userId: USER_EDITOR }), true, 'el Editor sí ve');
    // El Mánager de fábrica, sin la casilla, no conecta (decisión E).
    const plain = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM role_permission WHERE role_id = system_role_id('creator', 'manager') AND permission_key = 'conexiones.cuenta.conectar') AS ok`,
    ));
    assert.equal(plain.rows[0]!.ok, false);
  });

  test('getConsentCreator: el perfil del workspace con el app_user del titular', async () => {
    assert.deepEqual(await asManager(getConsentCreator), { id: CREATOR_LAURA, userId: USER_LAURA, displayName: 'Laura Méndez' });
  });
});

describe('aviso al titular y bitácora', () => {
  test('el aviso llega una sola vez mientras esté sin leer; otro workspace no lo ve; la bitácora de las consultas lleva onBehalfOf y actedBy', async () => {
    const { id } = await asManager((tx) => addPublicAccount(tx, account));
    const evidence = { v: 2, declaredOwner: true, onBehalfOf: { creatorId: CREATOR_LAURA }, actedBy: { userId: USER_MANAGER, email: 'andres@ejemplo.com', roleKey: 'manager_conecta' } };
    await asManager((tx) => recordConsent(tx, { connectionId: id, creatorId: CREATOR_LAURA, purpose: 'analytics', policyVersion: '2026-09-22', evidence }));
    const first = await asManager((tx) => notifyConnectionAdded(tx, { userId: USER_LAURA, connectionId: id, titleEs: 'Una cuenta se conectó en tu nombre', bodyEs: 'Andrés Pardo conectó @cafealma.' }));
    const second = await asManager((tx) => notifyConnectionAdded(tx, { userId: USER_LAURA, connectionId: id, titleEs: 'Una cuenta se conectó en tu nombre', bodyEs: 'Andrés Pardo conectó @cafealma.' }));
    assert.equal(first, true);
    assert.equal(second, false, 'ya había un aviso sin leer para esa cuenta y esa persona');
    const mine = await asLaura((tx) => tx.query<{ kind: string; user_id: string; entity_id: string; action_url: string; body_es: string }>(
      `SELECT kind, user_id, entity_id, action_url, body_es FROM notification WHERE kind = 'connection_added' AND entity_id = $1`, [id],
    ));
    assert.equal(mine.rows.length, 1);
    assert.deepEqual(mine.rows[0], { kind: 'connection_added', user_id: USER_LAURA, entity_id: id, action_url: '/conexiones', body_es: 'Andrés Pardo conectó @cafealma.' });
    const ajeno = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => tx.query(`SELECT 1 FROM notification WHERE kind = 'connection_added'`), { userId: USER_AJENO });
    // El seed también trae el aviso de la demo (c1): tampoco lo ve.
    assert.equal(ajeno.rows.length, 0, 'RLS: el otro workspace no ve el aviso');

    // addPublicAccount y recordConsent auditan solas (ACC-2); ACC-8 añade la delegación al `after`.
    const audit = await t.db.asWorker((tx) => tx.query<{ action: string; actor_user_id: string; actor_kind: string; after: Record<string, unknown>; workspace_id: string }>(
      `SELECT action, actor_user_id, actor_kind, after, workspace_id FROM audit_log
        WHERE (action = 'connection.added' AND entity_id = $1) OR (action = 'consent.recorded' AND after->>'connectionId' = $1::text) ORDER BY id`, [id],
    ));
    assert.deepEqual(audit.rows.map((r) => r.action), ['connection.added', 'consent.recorded']);
    for (const row of audit.rows) {
      assert.equal(row.actor_user_id, USER_MANAGER, 'el actor es quien actuó, no el titular');
      assert.equal(row.actor_kind, 'user');
      assert.equal(row.workspace_id, WORKSPACE_LAURA);
      assert.deepEqual(row.after['onBehalfOf'], { creatorId: CREATOR_LAURA });
      assert.deepEqual(row.after['actedBy'], { userId: USER_MANAGER, roleKey: 'manager_conecta' });
      assert.equal(JSON.stringify(row.after).includes('@ejemplo.com'), false, 'la bitácora no lleva el correo');
    }
    // La titular que agrega su propia cuenta: onBehalfOf sí, actedBy no.
    const own = await asLaura((tx) => addPublicAccount(tx, { ...account, handle: 'propia', externalAccountId: '17841400000000p01' }));
    const ownAudit = await t.db.asWorker((tx) => tx.query<{ actor_user_id: string; after: Record<string, unknown> }>(`SELECT actor_user_id, after FROM audit_log WHERE action = 'connection.added' AND entity_id = $1`, [own.id]));
    assert.equal(ownAudit.rows[0]!.actor_user_id, USER_LAURA);
    assert.deepEqual(ownAudit.rows[0]!.after['onBehalfOf'], { creatorId: CREATOR_LAURA });
    assert.equal('actedBy' in ownAudit.rows[0]!.after, false);
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
    const own = (await asLaura(listAccounts)).find((r) => r.handle === 'laura.cocinafacil' && r.platformId === 'tiktok')!;
    assert.equal(own.connectedBy, null, 'la de TikTok del seed la conectó la propia titular: null, no un guion');
    const seeded = (await asLaura(listAccounts)).find((r) => r.handle === 'laura.cocinafacil' && r.platformId === 'instagram')!;
    assert.equal(seeded.connectedBy?.name, 'Andrés Pardo', 'la de Instagram del seed la conectó el mánager de la demo (seed 0003)');
    await t.admin(`DELETE FROM membership WHERE workspace_id = '${WORKSPACE_LAURA}' AND user_id = '${USER_MANAGER}';`);
    const later = (await asLaura(listAccounts)).find((r) => r.handle === 'cafealma')!;
    assert.equal(later.connectedBy!.name, null, 'app_user ya no es visible desde este workspace');
    assert.equal(later.connectedBy!.email, 'andres@ejemplo.com', 'la evidencia conserva el correo de ese día');
    await t.admin(`INSERT INTO membership (workspace_id, user_id, role_id) VALUES ('${WORKSPACE_LAURA}', '${USER_MANAGER}', '${ROLE_MANAGER_CONECTA}') ON CONFLICT DO NOTHING;`);
  });

  test('quitar por un tercero anexa la revocación a cada consentimiento sin tocar el otorgamiento', async () => {
    const { id } = await asManager((tx) => addPublicAccount(tx, { ...account, platformId: 'youtube', handle: 'NutriveOficial', externalAccountId: 'UCnutrive', accountType: 'channel' }));
    await asManager((tx) => recordConsent(tx, { connectionId: id, creatorId: CREATOR_LAURA, purpose: 'analytics', policyVersion: '2026-09-22', evidence: { v: 2, declaredOwner: true, onBehalfOf: { creatorId: CREATOR_LAURA } } }));
    const gone = await asManager((tx) => disconnectConnection(tx, id, { at: '2026-09-23T15:00:00.000Z', actedBy: { userId: USER_MANAGER, email: 'andres@ejemplo.com', roleKey: 'manager_conecta' }, onBehalfOf: { creatorId: CREATOR_LAURA } }));
    assert.deepEqual(gone, { id, secretRef: 'public:youtube:nutriveoficial', platformId: 'youtube', handle: 'NutriveOficial', accessMode: 'public_profile', creatorId: CREATOR_LAURA });
    const consents = await asLaura((tx) => listConsents(tx, id));
    assert.equal(consents.every((c) => c.revokedAt !== null), true);
    const ev = await t.db.asWorker((tx) => tx.query<{ evidence: Record<string, unknown> }>(`SELECT evidence FROM data_consent WHERE connection_id = $1`, [id]));
    assert.equal(ev.rows[0]!.evidence['declaredOwner'], true, 'el otorgamiento sigue igual');
    assert.deepEqual((ev.rows[0]!.evidence['revocation'] as Record<string, unknown>)['actedBy'], { userId: USER_MANAGER, email: 'andres@ejemplo.com', roleKey: 'manager_conecta' });
    const removed = await t.db.asWorker((tx) => tx.query<{ actor_user_id: string; after: Record<string, unknown> }>(
      `SELECT actor_user_id, after FROM audit_log WHERE action = 'connection.disconnected' AND entity_id = $1`, [id],
    ));
    assert.equal(removed.rows[0]!.actor_user_id, USER_MANAGER);
    assert.deepEqual(removed.rows[0]!.after['actedBy'], { userId: USER_MANAGER, roleKey: 'manager_conecta' });
    assert.deepEqual(removed.rows[0]!.after['onBehalfOf'], { creatorId: CREATOR_LAURA });
    await assert.rejects(asManager((tx) => disconnectConnection(tx, id, {})), /No existe una conexión activa/);
  });
});
