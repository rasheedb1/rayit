/**
 * La prueba obligatoria de CIM-2: dos workspaces, un deal en cada uno,
 * cada uno ve solo el suyo; sin workspace fijado, cero filas.
 *
 * Corre sobre Postgres embebido como mc_app (sin BYPASSRLS), con las
 * migraciones reales: si RLS o el cliente se rompen, esto se rompe.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { assertWorkspaceId, CURRENT_WORKSPACE, deal, dealPipeline, type WorkspaceTx } from '../src/index.ts';
import { openTestDb, type TestDb } from './pglite.ts';

const WS_A = '0000000a-0000-4000-8000-000000000001';
const WS_B = '0000000b-0000-4000-8000-000000000001';
const COMPANY = '0000000c-0000-4000-8000-000000000001';

interface Who extends Record<string, unknown> {
  current_user: string;
  bypass_rls: boolean;
}
const WHO_SQL = `SELECT current_user::text AS current_user,
  (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls`;

/** Drizzle envuelve el error de Postgres ("Failed query: …") y deja el original en cause. */
function mensajeCompleto(err: unknown): string {
  const partes: string[] = [];
  for (let e = err; e instanceof Error; e = e.cause) partes.push(e.message);
  return partes.join(' ← ');
}

let t: TestDb;
let dealA = '';
let dealB = '';

before(async () => {
  t = await openTestDb({ seeds: false });
  await t.admin(`
    INSERT INTO workspace (id, slug, name) VALUES
      ('${WS_A}', 'workspace-a', 'Workspace A'),
      ('${WS_B}', 'workspace-b', 'Workspace B');
    INSERT INTO company (id, name) VALUES ('${COMPANY}', 'Café Alma');
  `);
});

after(async () => {
  await t.close();
});

describe('aislamiento por workspace', () => {
  test('las consultas corren como mc_app, sin BYPASSRLS', async (ctx) => {
    if (t.kind !== 'pglite') return ctx.skip('el rol lo decide TEST_DATABASE_URL');
    const { rows } = await t.db.withoutWorkspace((tx) => tx.query<Who>(WHO_SQL));
    assert.equal(rows[0]?.current_user, 'mc_app');
    assert.equal(rows[0]?.bypass_rls, false);
  });

  test('cada workspace inserta su deal y ve solo el suyo', async () => {
    const insert = (name: string) => (tx: WorkspaceTx) =>
      tx.db
        .insert(deal)
        .values({ workspaceId: CURRENT_WORKSPACE, companyId: COMPANY, name, stageId: 'nuevo', amount: '1000000.00' })
        .returning({ id: deal.id, workspaceId: deal.workspaceId });

    const [a] = await t.db.withWorkspace(WS_A, insert('Lanzamiento A'));
    const [b] = await t.db.withWorkspace(WS_B, insert('Lanzamiento B'));
    assert.ok(a && b);
    assert.equal(a.workspaceId, WS_A, 'current_workspace_id() dentro de la transacción es el workspace fijado');
    assert.equal(b.workspaceId, WS_B);
    dealA = a.id;
    dealB = b.id;

    const vistoPorA = await t.db.withWorkspace(WS_A, (tx) => tx.db.select({ id: deal.id }).from(deal));
    const vistoPorB = await t.db.withWorkspace(WS_B, (tx) => tx.db.select({ id: deal.id }).from(deal));
    assert.deepEqual(vistoPorA.map((r) => r.id), [dealA]);
    assert.deepEqual(vistoPorB.map((r) => r.id), [dealB]);
  });

  test('sin workspace fijado, cero filas', async () => {
    const orm = await t.db.withoutWorkspace((tx) => tx.db.select({ id: deal.id }).from(deal));
    assert.equal(orm.length, 0);
    const raw = await t.db.withoutWorkspace((tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM deal'));
    assert.equal(raw.rows[0]?.n, 0);
  });

  test('desde A no se puede escribir en B', async () => {
    await assert.rejects(
      t.db.withWorkspace(WS_A, (tx) =>
        tx.db.insert(deal).values({ workspaceId: WS_B, companyId: COMPANY, name: 'Intruso', stageId: 'nuevo' }),
      ),
      (err: unknown) => /row-level security/.test(mensajeCompleto(err)),
    );
    const tocadas = await t.db.withWorkspace(WS_A, (tx) =>
      tx.db.update(deal).set({ name: 'Pisado' }).where(eq(deal.id, dealB)).returning({ id: deal.id }),
    );
    assert.equal(tocadas.length, 0, 'el UPDATE no encuentra la fila ajena');
    const [intacto] = await t.db.withWorkspace(WS_B, (tx) => tx.db.select({ name: deal.name }).from(deal));
    assert.equal(intacto?.name, 'Lanzamiento B');
  });

  test('las vistas heredan el aislamiento: deal_pipeline solo trae lo propio', async () => {
    const filas = await t.db.withWorkspace(WS_A, (tx) => tx.db.select().from(dealPipeline));
    assert.equal(filas.length, 1);
    assert.equal(filas[0]?.id, dealA);
    assert.equal(filas[0]?.companyName, 'Café Alma');
    assert.equal(filas[0]?.stageLabel, 'Nuevo');
    assert.equal(filas[0]?.probability, '0.0500', 'sin probabilidad propia usa la de la etapa');
    assert.equal(filas[0]?.dueState, 'sin_fecha');
  });

  test('asWorker cruza workspaces (jobs globales) y vuelve a mc_app al terminar', async (ctx) => {
    if (t.kind !== 'pglite') return ctx.skip('la membresía en mc_worker la decide TEST_DATABASE_URL');
    const todos = await t.db.asWorker(async (tx) => {
      const { rows } = await tx.query<Who>(WHO_SQL);
      assert.equal(rows[0]?.current_user, 'mc_worker');
      assert.equal(rows[0]?.bypass_rls, true);
      return tx.db.select({ id: deal.id }).from(deal);
    });
    assert.deepEqual(todos.map((r) => r.id).sort(), [dealA, dealB].sort());
    const { rows } = await t.db.withoutWorkspace((tx) => tx.query<Who>(WHO_SQL));
    assert.equal(rows[0]?.current_user, 'mc_app', 'SET LOCAL ROLE muere con la transacción');
  });

  test('un error revierte la transacción entera', async () => {
    await assert.rejects(
      t.db.withWorkspace(WS_A, async (tx) => {
        await tx.db.insert(deal).values({ workspaceId: CURRENT_WORKSPACE, companyId: COMPANY, name: 'Fantasma', stageId: 'nuevo' });
        throw new Error('boom');
      }),
      /boom/,
    );
    const deA = await t.db.withWorkspace(WS_A, (tx) => tx.db.select({ id: deal.id }).from(deal));
    assert.deepEqual(deA.map((r) => r.id), [dealA]);
  });

  test('el workspace fijado no sobrevive a su transacción', async () => {
    const despues = await t.db.withoutWorkspace((tx) => tx.query<{ ws: string | null }>("SELECT nullif(current_setting('app.workspace_id', true), '') AS ws"));
    assert.equal(despues.rows[0]?.ws, null);
  });

  test('el workspace se valida antes de abrir la transacción', async () => {
    assert.throws(() => assertWorkspaceId('laura'), /UUID/);
    assert.throws(() => assertWorkspaceId("'; DROP TABLE deal; --"), /UUID/);
    await assert.rejects(t.db.withWorkspace('laura', async () => 1), /UUID/);
  });
});
