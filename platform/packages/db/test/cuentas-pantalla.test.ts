/**
 * CON-B · lo que listAccounts le da a la fila de Cuentas además de lo de
 * CON-10 y CON-5: los huecos de CON-7 (metric_gap con el message_es de
 * metric_requirement), la fecha de la renovación que decide si un acceso
 * vencido «se renueva sola» (CON-3 → CON-4), la variación de siete días
 * ya calculada, y la cuenta híbrida (por @ y luego autorizada) como UNA
 * sola fila con su historial (CON-10). Todo con RLS: otro workspace no
 * ve ni la fila ni sus huecos.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addPublicAccount, listAccounts, recordAccountSnapshot, upgradePublicAccountToOAuth } from '../src/index.ts';
import { openTestDb, WORKSPACE_LAURA, type TestDb } from './pglite.ts';

const WORKSPACE_AJENO = '00000009-0000-4000-8000-000000000004';
const CREATOR_LAURA = '00000002-0000-4000-8000-000000000003';

let t: TestDb;
before(async () => {
  t = await openTestDb();
  await t.admin(`INSERT INTO workspace (id, slug, name) VALUES ('${WORKSPACE_AJENO}', 'ajeno-pantalla', 'Ajeno') ON CONFLICT DO NOTHING;`);
});
after(async () => { await t.close(); });

const base = { creatorId: CREATOR_LAURA, displayName: null, avatarUrl: null, profileUrl: null, accountType: 'unknown' as const };

async function fila(id: string) {
  return (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listAccounts(tx))).find((r) => r.id === id)!;
}

describe('CON-7 · qué dato falta y por qué', () => {
  test('el hueco llega a la fila con el texto del catálogo, y solo al workspace dueño', async () => {
    const { id } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => addPublicAccount(tx, { ...base, platformId: 'tiktok', handle: 'conhueco', externalAccountId: 'conhueco' }));
    assert.deepEqual((await fila(id)).gaps, [], 'sin huecos: vacío, no null');
    // metric_gap lo escribe el worker (mc_app no tiene INSERT, 0039): se siembra como dueño.
    await t.admin(`INSERT INTO metric_gap (workspace_id, connection_id, metric_group, requirement_id, day)
                   VALUES ('${WORKSPACE_LAURA}', '${id}', 'demografia_de_cuenta', 'tt.audience.auth', '2026-09-20')`);
    const { rows } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => tx.query<{ message_es: string }>(`SELECT message_es FROM metric_requirement WHERE id = 'tt.audience.auth'`));
    const r = await fila(id);
    assert.deepEqual(r.gaps, [{ metricGroup: 'demografia_de_cuenta', requirementId: 'tt.audience.auth', messageEs: rows[0]!.message_es, fixUrl: null, since: '2026-09-20' }]);
    assert.equal((await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => listAccounts(tx))).some((x) => x.id === id), false);
    const ajeno = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => tx.query(`SELECT 1 FROM metric_gap WHERE connection_id = $1`, [id]));
    assert.equal(ajeno.rows.length, 0, 'RLS: el hueco de otro workspace no se ve');
  });
});

describe('CON-3 → CON-4 · la renovación y la cuenta híbrida', () => {
  test('una cuenta por @ que el dueño autoriza sigue siendo UNA fila, con su historial y la fecha de su renovación', async () => {
    const { id } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => addPublicAccount(tx, { ...base, platformId: 'tiktok', handle: 'hibrida', externalAccountId: 'hibrida' }));
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordAccountSnapshot(tx, { connectionId: id, day: '2026-09-10', followers: 1000, following: null, mediaCount: null, views: null, raw: {} }));
    assert.equal((await fila(id)).refreshExpiresAt, null, 'por @ no hay renovación');
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => upgradePublicAccountToOAuth(tx, id, {
      externalAccountId: 'open_id_hibrida', handle: 'hibrida', displayName: null, avatarUrl: null, profileUrl: null, accountType: 'creator',
      secretRef: 'enc:tiktok:77777777-7777-4777-8777-777777777777', scopes: ['user.info.basic'],
      accessExpiresAt: new Date('2026-09-22T00:00:00Z'), refreshExpiresAt: new Date('2027-09-22T00:00:00Z'),
    }));
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordAccountSnapshot(tx, { connectionId: id, day: '2026-09-18', followers: 1050, following: null, mediaCount: null, views: null, raw: {}, source: 'api' }));
    const todas = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listAccounts(tx));
    const mias = todas.filter((r) => r.handle === 'hibrida');
    assert.equal(mias.length, 1, 'una sola fila: la de por @ se convirtió, no se duplicó');
    const r = mias[0]!;
    assert.equal(r.id, id);
    assert.equal(r.accessMode, 'direct_oauth');
    assert.equal(r.accessExpiresAt, '2026-09-22T00:00:00.000Z');
    assert.equal(r.refreshExpiresAt, '2027-09-22T00:00:00.000Z');
    // El historial por @ (10-sep) sigue siendo la base de la variación de la lectura con token (18-sep).
    assert.equal(r.latest?.day, '2026-09-18');
    assert.equal(r.followersWeekAgo, 1000);
    assert.equal(r.followersDelta7d, 0.05, 'la variación la calcula la base: (1050 - 1000) / 1000');
  });

  test('sin lectura de hace siete días la variación es null, no cero', async () => {
    const { id } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => addPublicAccount(tx, { ...base, platformId: 'tiktok', handle: 'sinhistoria', externalAccountId: 'sinhistoria' }));
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => recordAccountSnapshot(tx, { connectionId: id, day: '2026-09-18', followers: 500, following: null, mediaCount: null, views: null, raw: {} }));
    const r = await fila(id);
    assert.equal(r.followersDelta7d, null);
    assert.equal(r.followersWeekAgo, null);
  });
});
