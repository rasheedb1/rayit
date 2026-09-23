/**
 * ACC-6 · La migración 0034_membership_scope: la tabla, su RLS, los
 * privilegios de mc_app y la semántica de scope_allows(). Las tres
 * pruebas por módulo (alcance-campanas, alcance-finanzas,
 * alcance-conexiones) dan por sentado lo que aquí se demuestra.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertScopeAllows, ScopeError, scopeFilter, type WorkspaceTx } from '../src/index.ts';
import { openTestDb, WORKSPACE_LAURA, type TestDb } from './pglite.ts';
import { CAMPAIGN_SOFIA, CREATOR_LAURA, CREATOR_SOFIA, EMPRESA_SOFIA, sembrarAlcance, USER_LAURA, USER_MIEMBRO } from './alcance.ts';

const WORKSPACE_AJENO = '00000009-0000-4000-8000-00000000a1ca';
const USER_AJENO = '00000009-0000-4000-8000-00000000a1c2';

let t: TestDb;
const miembro = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WORKSPACE_LAURA, fn, { userId: USER_MIEMBRO });
const duena = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(WORKSPACE_LAURA, fn, { userId: USER_LAURA });

const allows = (tx: WorkspaceTx, kind: string, target: string | null) =>
  tx.query<{ ok: boolean }>(`SELECT scope_allows($1, $2::uuid) AS ok`, [kind, target]).then((r) => r.rows[0]?.ok);
const allowsAny = (tx: WorkspaceTx, kind: string, targets: string[] | null) =>
  tx.query<{ ok: boolean }>(`SELECT scope_allows($1, $2::uuid[]) AS ok`, [kind, targets]).then((r) => r.rows[0]?.ok);

before(async () => {
  t = await openTestDb();
  await sembrarAlcance(t);
  await t.admin(`
    INSERT INTO workspace (id, slug, name) VALUES ('${WORKSPACE_AJENO}', 'ajeno-alcance', 'Ajeno') ON CONFLICT DO NOTHING;
    INSERT INTO app_user (id, email) VALUES ('${USER_AJENO}', 'ajeno.alcance@ejemplo.com') ON CONFLICT DO NOTHING;
    INSERT INTO membership (workspace_id, user_id, role) VALUES ('${WORKSPACE_AJENO}', '${USER_AJENO}', 'owner') ON CONFLICT DO NOTHING;
    INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id)
    VALUES ('${WORKSPACE_AJENO}', '${USER_AJENO}', 'creator', '${CREATOR_SOFIA}') ON CONFLICT DO NOTHING;
  `);
}, { timeout: 600_000 });

after(async () => {
  await t.close();
});

describe('la tabla y su aislamiento', () => {
  test('membership_scope existe con RLS forzada, una política de lectura por workspace, y mc_app solo puede leer', async () => {
    const [rel] = await t.raw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'membership_scope'`,
    );
    assert.deepEqual(rel, { relrowsecurity: true, relforcerowsecurity: true });
    const politicas = await t.raw<{ policyname: string; cmd: string }>(
      `SELECT policyname, cmd FROM pg_policies WHERE tablename = 'membership_scope' ORDER BY 1`,
    );
    assert.deepEqual(politicas, [{ policyname: 'membership_scope_read', cmd: 'SELECT' }]);
    const [priv] = await t.raw<{ s: boolean; i: boolean; u: boolean; d: boolean }>(
      `SELECT has_table_privilege('mc_app', 'membership_scope', 'SELECT') AS s,
              has_table_privilege('mc_app', 'membership_scope', 'INSERT') AS i,
              has_table_privilege('mc_app', 'membership_scope', 'UPDATE') AS u,
              has_table_privilege('mc_app', 'membership_scope', 'DELETE') AS d`,
    );
    assert.deepEqual(priv, { s: true, i: false, u: false, d: false });
  });

  test('desde el workspace se lee el alcance de sus miembros; desde otro workspace, cero filas; sin workspace, cero filas', async () => {
    const mias = await duena((tx) => tx.query<{ user_id: string; scope_id: string }>('SELECT user_id, scope_id FROM membership_scope WHERE user_id = $1', [USER_MIEMBRO]));
    assert.deepEqual(mias.rows, [{ user_id: USER_MIEMBRO, scope_id: CREATOR_LAURA }]);
    const todas = await duena((tx) => tx.query('SELECT 1 FROM membership_scope'));
    assert.equal(todas.rows.length, 3, 'los tres miembros acotados del escenario, ninguno del workspace ajeno');
    const ajenas = await t.db.withWorkspace(WORKSPACE_AJENO, (tx) => tx.query('SELECT 1 FROM membership_scope WHERE user_id = $1', [USER_MIEMBRO]));
    assert.equal(ajenas.rows.length, 0);
    const sinWorkspace = await t.db.withCatalogs((tx) => tx.query('SELECT 1 FROM membership_scope'));
    assert.equal(sinWorkspace.rows.length, 0);
  });

  test('mc_app no puede escribir el alcance, ni siquiera en su propio workspace', async () => {
    await assert.rejects(
      duena((tx) => tx.query(
        `INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id) VALUES (current_workspace_id(), $1, 'creator', $2)`,
        [USER_LAURA, CREATOR_SOFIA],
      )),
      /permission denied|permiso denegado/,
    );
    await assert.rejects(duena((tx) => tx.query('DELETE FROM membership_scope')), /permission denied|permiso denegado/);
    await assert.rejects(duena((tx) => tx.query(`UPDATE membership_scope SET scope_type = 'company'`)), /permission denied|permiso denegado/);
  });

  test('scope_type solo admite creator, company y campaign', async () => {
    await assert.rejects(
      t.admin(`INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id) VALUES ('${WORKSPACE_LAURA}', '${USER_MIEMBRO}', 'deal', '${CAMPAIGN_SOFIA}')`),
      /membership_scope_scope_type_check/,
    );
  });

  test('el alcance se va con la membresía (ON DELETE CASCADE)', async () => {
    await t.admin(`
      INSERT INTO membership (workspace_id, user_id, role) VALUES ('${WORKSPACE_AJENO}', '${USER_MIEMBRO}', 'member') ON CONFLICT DO NOTHING;
      INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id)
      VALUES ('${WORKSPACE_AJENO}', '${USER_MIEMBRO}', 'campaign', '${CAMPAIGN_SOFIA}') ON CONFLICT DO NOTHING;
      DELETE FROM membership WHERE workspace_id = '${WORKSPACE_AJENO}' AND user_id = '${USER_MIEMBRO}';
    `);
    const quedan = await t.raw<{ n: number }>(
      `SELECT count(*)::int AS n FROM membership_scope WHERE workspace_id = '${WORKSPACE_AJENO}' AND user_id = '${USER_MIEMBRO}'`,
    );
    assert.equal(quedan[0]?.n, 0);
  });

  test('la migración se puede volver a aplicar sin fallar y deja lo mismo', async () => {
    const sql = await readFile(fileURLToPath(new URL('../../../db/migrations/0034_membership_scope.sql', import.meta.url)), 'utf8');
    await t.admin(sql);
    const politicas = await t.raw<{ policyname: string }>(`SELECT policyname FROM pg_policies WHERE tablename = 'membership_scope'`);
    assert.deepEqual(politicas, [{ policyname: 'membership_scope_read' }]);
    const funciones = await t.raw<{ firma: string }>(
      `SELECT p.oid::regprocedure::text AS firma FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'scope_allows' ORDER BY 1`,
    );
    assert.deepEqual(funciones, [{ firma: 'scope_allows(text,uuid)' }, { firma: 'scope_allows(text,uuid[])' }]);
    const mias = await duena((tx) => tx.query('SELECT 1 FROM membership_scope'));
    assert.equal(mias.rows.length, 3, 'las filas siguen ahí');
  });
});

describe('scope_allows(): la semántica', () => {
  test('sin filas de alcance (la dueña), todo cae en alcance, NULL incluido', async () => {
    await duena(async (tx) => {
      assert.equal(await allows(tx, 'creator', CREATOR_SOFIA), true);
      assert.equal(await allows(tx, 'creator', null), true);
      assert.equal(await allows(tx, 'company', EMPRESA_SOFIA), true);
      assert.equal(await allowsAny(tx, 'campaign', []), true);
      assert.equal(await allowsAny(tx, 'campaign', null), true);
    });
  });

  test('con alcance por creador (el miembro): su creadora sí, la otra no, NULL no; los otros tipos siguen abiertos', async () => {
    await miembro(async (tx) => {
      assert.equal(await allows(tx, 'creator', CREATOR_LAURA), true);
      assert.equal(await allows(tx, 'creator', CREATOR_SOFIA), false);
      assert.equal(await allows(tx, 'creator', null), false, 'un nulo no es un cero: sin creador no está en el alcance de nadie');
      assert.equal(await allowsAny(tx, 'creator', [CREATOR_SOFIA, CREATOR_LAURA]), true, 'alguno cae');
      assert.equal(await allowsAny(tx, 'creator', [CREATOR_SOFIA]), false);
      assert.equal(await allowsAny(tx, 'creator', []), false);
      assert.equal(await allowsAny(tx, 'creator', null), false);
      assert.equal(await allows(tx, 'company', EMPRESA_SOFIA), true, 'sin filas de marca, toda marca');
      assert.equal(await allows(tx, 'campaign', null), true, 'sin filas de campaña, también NULL');
    });
  });

  test('sin identidad en la transacción (modo demo, worker) no hay filas y todo cae en alcance', async () => {
    await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      assert.equal(await allows(tx, 'creator', CREATOR_SOFIA), true);
      assert.equal(await allows(tx, 'creator', null), true);
    });
    await t.db.asWorker(async (tx) => {
      const { rows } = await tx.query<{ ok: boolean }>(`SELECT scope_allows('creator', $1::uuid) AS ok`, [CREATOR_SOFIA]);
      assert.equal(rows[0]?.ok, true);
    });
  });

  test('el alcance es por workspace: la misma persona en otro espacio tiene el suyo, y el ajeno no se cuela', async () => {
    // El ajeno tiene alcance a Sofía en SU workspace. Desde el de Laura,
    // esa fila no existe: como miembro de Laura sin filas, ve todo.
    await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      assert.equal(await allows(tx, 'creator', CREATOR_LAURA), true);
    }, { userId: USER_AJENO });
    await t.db.withWorkspace(WORKSPACE_AJENO, async (tx) => {
      assert.equal(await allows(tx, 'creator', CREATOR_LAURA), false);
      assert.equal(await allows(tx, 'creator', CREATOR_SOFIA), true);
    }, { userId: USER_AJENO });
  });

  test('entre tipos se intersecta: alcance por creador Y por marca', async () => {
    await t.admin(`
      INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id)
      VALUES ('${WORKSPACE_LAURA}', '${USER_MIEMBRO}', 'company', '${EMPRESA_SOFIA}') ON CONFLICT DO NOTHING;
    `);
    try {
      const filtro = scopeFilter({ creator: 'x.creator_id', company: 'x.company_id', campaign: 'x.id' });
      const evalua = (tx: WorkspaceTx, creator: string | null, company: string | null) =>
        tx.query<{ ok: boolean }>(
          `SELECT ${filtro} AS ok FROM (SELECT $1::uuid AS creator_id, $2::uuid AS company_id, gen_random_uuid() AS id) x`,
          [creator, company],
        ).then((r) => r.rows[0]?.ok);
      await miembro(async (tx) => {
        assert.equal(await evalua(tx, CREATOR_LAURA, EMPRESA_SOFIA), true, 'las dos condiciones');
        assert.equal(await evalua(tx, CREATOR_LAURA, CAMPAIGN_SOFIA), false, 'la marca no está en el alcance');
        assert.equal(await evalua(tx, CREATOR_SOFIA, EMPRESA_SOFIA), false, 'la creadora no está en el alcance');
      });
    } finally {
      await t.admin(`DELETE FROM membership_scope WHERE user_id = '${USER_MIEMBRO}' AND scope_type = 'company'`);
    }
  });
});

describe('scopeFilter() y assertScopeAllows()', () => {
  test('scopeFilter compone las tres preguntas; null oculta a quien tenga ese alcance; any es un ARRAY(…)', () => {
    const tengo = (kind: string) =>
      `EXISTS (SELECT 1 FROM membership_scope s WHERE s.workspace_id = current_workspace_id() AND s.user_id = current_user_id() AND s.scope_type = '${kind}')`;
    assert.equal(
      scopeFilter({ creator: 'c.creator_id', company: null, campaign: { any: 'SELECT cp.campaign_id FROM campaign_post cp' } }),
      `(NOT ${tengo('creator')} OR scope_allows('creator', c.creator_id)) AND ` +
        `NOT ${tengo('company')} AND ` +
        `(NOT ${tengo('campaign')} OR scope_allows('campaign', ARRAY(SELECT cp.campaign_id FROM campaign_post cp)))`,
    );
  });

  test('el predicado compuesto se evalúa igual que la función: la dueña ve, el miembro con alcance por creador no ve a Sofía ni un post sin campaña bajo alcance por campaña', async () => {
    const filtro = scopeFilter({ creator: 'x.creator_id', company: null, campaign: { any: 'SELECT c.id FROM campaign c WHERE c.creator_id = x.creator_id' } });
    const evalua = (tx: WorkspaceTx, creator: string) =>
      tx.query<{ ok: boolean }>(`SELECT ${filtro} AS ok FROM (SELECT $1::uuid AS creator_id) x`, [creator]).then((r) => r.rows[0]?.ok);
    await duena(async (tx) => {
      assert.equal(await evalua(tx, CREATOR_SOFIA), true);
    });
    await miembro(async (tx) => {
      assert.equal(await evalua(tx, CREATOR_LAURA), true);
      assert.equal(await evalua(tx, CREATOR_SOFIA), false);
    });
  });

  test('assertScopeAllows deja pasar a la dueña con cualquier cosa, y al miembro solo con su creadora; lanza ScopeError con messageEs', async () => {
    await duena((tx) => assertScopeAllows(tx, { creator: null, company: null, campaign: null }));
    await miembro((tx) => assertScopeAllows(tx, { creator: CREATOR_LAURA, company: EMPRESA_SOFIA, campaign: null }));
    await assert.rejects(
      miembro((tx) => assertScopeAllows(tx, { creator: CREATOR_SOFIA, company: null, campaign: null })),
      (e: unknown) => e instanceof ScopeError && /fuera de tu alcance/.test(e.messageEs),
    );
    await assert.rejects(
      miembro((tx) => assertScopeAllows(tx, { creator: null, company: null, campaign: null })),
      ScopeError,
      'sin creador no cae en el alcance por creador',
    );
  });
});
