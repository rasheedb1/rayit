/** CON-3 · queries/conexiones.ts sobre Postgres embebido con los seeds de la demo y otro workspace para el aislamiento. */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConnectionNotFound, CreatorNotInWorkspace, NoCreatorProfile, disconnectConnection, findConnectionByAccount, getDefaultCreatorId,
  listConnections, listConsents, recordConsent, upsertConnection, type UpsertConnectionInput,
} from '../src/index.ts';
import { filasDeBitacora } from './bitacora.ts';
import { openTestDb, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

const WORKSPACE_AJENO = '00000009-0000-4000-8000-000000000002';
const CREATOR_LAURA = '00000002-0000-4000-8000-000000000003';
const REF = 'enc:tiktok:6f1d2c3b-4a5e-4f60-8a71-9b2c3d4e5f60';

let t: TestDb;

before(async () => {
  t = await openTestDb();
  await t.admin(`
    INSERT INTO workspace (id, slug, name) VALUES ('${WORKSPACE_AJENO}', 'ajeno-conexiones', 'Ajeno') ON CONFLICT DO NOTHING;
  `);
}, { timeout: 600_000 });
after(async () => { await t.close(); });

const input = (over: Partial<UpsertConnectionInput> = {}): UpsertConnectionInput => ({
  creatorId: CREATOR_LAURA,
  platformId: 'tiktok',
  externalAccountId: 'open_id_nueva_cuenta',
  handle: 'laura.nueva',
  displayName: 'Laura nueva',
  avatarUrl: 'https://p16.tiktokcdn.com/avatar.jpg',
  profileUrl: 'https://www.tiktok.com/@laura.nueva',
  accountType: 'creator',
  secretRef: REF,
  scopes: ['user.info.basic', 'video.list'],
  accessExpiresAt: new Date('2026-09-23T12:00:00Z'),
  refreshExpiresAt: new Date('2027-09-22T12:00:00Z'),
  ...over,
});

describe('lectura sobre connection_health', () => {
  test('el workspace del seed ve sus cuatro conexiones, con scopes y última sincronización; el ajeno no ve ninguna', async () => {
    const rows = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listConnections(tx));
    // Son cuatro desde el seed 0002, que es quien las escribe: 0003
    // repite tres de ellas con ON CONFLICT DO NOTHING, así que los
    // scopes y la última sincronización son los de 0002. Y ahí
    // last_synced_at es relativo al reloj —la demo no puede enseñar
    // conexiones rancias el día que se siembra— así que se afirma que
    // están frescas, no la hora exacta.
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((r) => r.platformId), ['facebook', 'instagram', 'tiktok', 'youtube']);
    const ig = rows.find((r) => r.platformId === 'instagram')!;
    assert.equal(ig.handle, 'laura.cocinafacil');
    assert.deepEqual(ig.scopes, ['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement']);
    assert.equal(ig.status, 'active');
    assert.ok(ig.lastSyncedAt && ig.hoursSinceSync !== null && ig.hoursSinceSync >= 0 && ig.hoursSinceSync < 24);
    assert.ok(ig.postsTracked >= 1);
    assert.equal(await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => listConnections(tx)).then((r) => r.length), 0);
  });

  test('getDefaultCreatorId devuelve la creadora del seed y falla claro en un workspace sin perfil', async () => {
    assert.equal(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getDefaultCreatorId(tx)), CREATOR_LAURA);
    await assert.rejects(t.db.withWorkspace(WORKSPACE_AJENO, (tx) => getDefaultCreatorId(tx)), NoCreatorProfile);
  });
});

describe('alta, reconexión y consentimiento', () => {
  test('upsertConnection crea la fila; volver a conectar la misma cuenta la actualiza sin duplicar', async () => {
    const first = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => upsertConnection(tx, input()));
    assert.equal(first.created, true);
    const again = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => upsertConnection(tx, input({ handle: 'laura.renombrada', scopes: ['user.info.basic'], accessExpiresAt: new Date('2026-09-24T12:00:00Z') })));
    assert.equal(again.created, false);
    assert.equal(again.id, first.id);
    const rows = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listConnections(tx));
    const mine = rows.filter((r) => r.externalAccountId === 'open_id_nueva_cuenta');
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.handle, 'laura.renombrada');
    assert.deepEqual(mine[0]!.scopes, ['user.info.basic']);
    assert.equal(mine[0]!.accessExpiresAt, '2026-09-24T12:00:00.000Z');
    assert.equal(mine[0]!.secretRef, REF);
    assert.equal(mine[0]!.lastSyncedAt, null, 'sin sincronización todavía: null, no cero');
    const found = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => findConnectionByAccount(tx, 'tiktok', 'open_id_nueva_cuenta'));
    assert.deepEqual(found, { id: first.id, secretRef: REF, deletedAt: null, status: 'active' });

    // Bitácora (ACC-2): alta y reconexión, sin secret_ref, y con los permisos otorgados.
    const bitacora = await filasDeBitacora(t, WORKSPACE_LAURA, first.id);
    assert.deepEqual(bitacora.map((f) => f.action), ['connection.added', 'connection.reconnected']);
    assert.equal(bitacora[0]?.entity_type, 'social_connection');
    assert.equal(bitacora[0]?.before, null);
    assert.deepEqual(bitacora[1]?.before, { accessMode: 'direct_oauth', status: 'active', deleted: false }, 'lo que había antes de reconectar');
    assert.deepEqual(bitacora[1]?.after, {
      platformId: 'tiktok', externalAccountId: 'open_id_nueva_cuenta', handle: 'laura.renombrada', accountType: input().accountType,
      accessMode: 'direct_oauth', scopes: ['user.info.basic'], accessExpiresAt: '2026-09-24T12:00:00.000Z',
    });
    assert.equal(JSON.stringify(bitacora).includes(REF), false, 'la referencia del secreto no llega a la bitácora');
  });

  test('aislamiento: la misma cuenta desde otro workspace no se ve y crea su propia fila', async () => {
    await t.admin(`
      SELECT set_config('app.workspace_id', '${WORKSPACE_AJENO}', false);
      INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('00000009-0000-4000-8000-0000000000c3', '${WORKSPACE_AJENO}', 'Otra') ON CONFLICT DO NOTHING;
      SELECT set_config('app.workspace_id', '', false);
    `);
    assert.equal(await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => findConnectionByAccount(tx, 'tiktok', 'open_id_nueva_cuenta')), null);
    const other = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => upsertConnection(tx, input({ creatorId: '00000009-0000-4000-8000-0000000000c3', secretRef: 'enc:tiktok:00000000-0000-4000-8000-000000000009' })));
    assert.equal(other.created, true);
    const laura = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => findConnectionByAccount(tx, 'tiktok', 'open_id_nueva_cuenta'));
    assert.notEqual(laura!.id, other.id);
    // La FK a creator_profile NO pasa por RLS: sin la comprobación previa, el workspace ajeno colgaría su conexión de la creadora de Laura.
    await assert.rejects(
      t.db.withWorkspace(WORKSPACE_AJENO, (tx) => upsertConnection(tx, input({ externalAccountId: 'otra-cuenta', creatorId: CREATOR_LAURA }))),
      CreatorNotInWorkspace,
    );
  });

  test('recordConsent deja una fila activa por finalidad y revoca la anterior', async () => {
    const { id } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => findConnectionByAccount(tx, 'tiktok', 'open_id_nueva_cuenta')).then((r) => r!);
    const evidence = { ip: '203.0.113.7', userAgent: 'prueba', textShown: 'Texto', scopesRequested: ['user.info.basic'], scopesGranted: ['user.info.basic'], at: '2026-09-22T10:00:00.000Z' };
    await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      await recordConsent(tx, { connectionId: id, creatorId: CREATOR_LAURA, purpose: 'analytics', policyVersion: '2026-09-22', evidence });
      await recordConsent(tx, { connectionId: id, creatorId: CREATOR_LAURA, purpose: 'analytics', policyVersion: '2026-09-22', evidence });
      await recordConsent(tx, { connectionId: id, creatorId: CREATOR_LAURA, purpose: 'audience_demographics', policyVersion: '2026-09-22', evidence });
    });
    const consents = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listConsents(tx, id));
    assert.equal(consents.length, 3);
    const active = consents.filter((c) => c.revokedAt === null);
    assert.deepEqual(active.map((c) => c.purpose).sort(), ['analytics', 'audience_demographics']);
    assert.equal(consents.filter((c) => c.purpose === 'analytics' && c.revokedAt !== null).length, 1);
    assert.equal(await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => listConsents(tx, id)).then((r) => r.length), 0);

    // Bitácora (ACC-2): una fila por consentimiento, sin la evidencia (ip, user agent).
    const registrados = await Promise.all(consents.map((c) => filasDeBitacora(t, WORKSPACE_LAURA, c.id, 'consent.recorded')));
    assert.deepEqual(registrados.map((r) => r.length), [1, 1, 1]);
    assert.deepEqual(registrados[0]?.[0]?.after, { connectionId: id, purpose: consents[0]?.purpose, policyVersion: '2026-09-22' });
    assert.equal(JSON.stringify(registrados).includes('203.0.113.7'), false);
    // La segunda de analytics revocó la primera: esa revocación también queda.
    const revocada = consents.find((c) => c.purpose === 'analytics' && c.revokedAt !== null)!;
    const [rev] = await filasDeBitacora(t, WORKSPACE_LAURA, revocada.id, 'consent.revoked');
    assert.deepEqual(rev?.after, { purpose: 'analytics', revoked: true, reason: 'replaced' });
  });
});

describe('desconectar', () => {
  test('marca deleted_at y disabled, revoca consentimientos, borra el ciphertext y desaparece de la lista; reconectar reactiva', async () => {
    const found = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => findConnectionByAccount(tx, 'tiktok', 'open_id_nueva_cuenta')).then((r) => r!);
    await t.admin(`
      SELECT set_config('app.workspace_id', '${WORKSPACE_LAURA}', false);
      INSERT INTO connection_secret (secret_ref, workspace_id, ciphertext, iv, tag) VALUES ('${REF}', '${WORKSPACE_LAURA}', '\\x00', '\\x000000000000000000000000', '\\x00000000000000000000000000000000');
      SELECT set_config('app.workspace_id', '', false);
    `);
    await assert.rejects(t.db.withWorkspace(WORKSPACE_AJENO, (tx) => disconnectConnection(tx, found.id)), ConnectionNotFound);
    const out = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => disconnectConnection(tx, found.id));
    assert.equal(out.secretRef, REF);
    const desconectada = await filasDeBitacora(t, WORKSPACE_LAURA, found.id, 'connection.disconnected');
    assert.equal(desconectada.length, 1, 'el intento desde el workspace ajeno no dejó fila');
    assert.deepEqual(desconectada[0]?.before, { status: 'active', platformId: 'tiktok', accessMode: 'direct_oauth' });
    assert.deepEqual(desconectada[0]?.after, { status: 'disabled', platformId: 'tiktok', accessMode: 'direct_oauth' });
    // Los dos consentimientos vigentes se revocaron al desconectar, cada uno con su fila.
    const vigentes = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listConsents(tx, found.id))).filter((c) => c.purpose === 'audience_demographics' || c.revokedAt !== null);
    const porDesconexion = (await Promise.all(vigentes.map((c) => filasDeBitacora(t, WORKSPACE_LAURA, c.id, 'consent.revoked')))).flat()
      .filter((f) => (f.after as { reason: string }).reason === 'disconnected');
    assert.equal(porDesconexion.length, 2);
    assert.equal((await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listConnections(tx))).some((r) => r.id === found.id), false);
    const after = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => findConnectionByAccount(tx, 'tiktok', 'open_id_nueva_cuenta'));
    assert.equal(after!.status, 'disabled');
    assert.ok(after!.deletedAt);
    const consents = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listConsents(tx, found.id));
    assert.ok(consents.length > 0 && consents.every((c) => c.revokedAt !== null));
    const secret = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM connection_secret WHERE secret_ref = $1`, [REF]));
    assert.equal(Number(secret.rows[0]!.n), 0);
    await assert.rejects(t.db.withWorkspace(WORKSPACE_LAURA, (tx) => disconnectConnection(tx, found.id)), ConnectionNotFound);
    const back = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => upsertConnection(tx, input()));
    assert.equal(back.created, false);
    assert.equal(back.id, found.id);
    const row = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listConnections(tx))).find((r) => r.id === found.id)!;
    assert.equal(row.status, 'active');
    assert.equal(row.statusDetail, null);
  });
});
