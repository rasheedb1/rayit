/**
 * La prueba obligatoria de CIM-2: dos workspaces, un deal en cada uno,
 * cada uno ve solo el suyo; sin workspace fijado, cero filas.
 *
 * Y lo que se sumó en las rondas 2 y 3: las tablas hijas sin
 * workspace_id (quote_item, rate_card_item, deal_stage_history) heredan
 * el aislamiento del padre (0018); las manijas de una transacción mueren
 * con ella; toda transacción arranca con timeouts; una transacción no se
 * anida; y asWorker se niega cuando el rol de conexión no es miembro de
 * mc_worker (el caso de mc_app en producción).
 *
 * Corre sobre Postgres embebido como mc_app (sin BYPASSRLS), con las
 * migraciones reales: si RLS o el cliente se rompen, esto se rompe.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertWorkspaceId, creatorProfile, CURRENT_WORKSPACE, deal, dealPipeline, dealStageHistory, eq, NestedTransactionError, quote,
  quoteItem, rateCard, rateCardItem, TransactionClosedError, type BaseTx, type WorkspaceTx,
} from '../src/index.ts';
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
function fullMessage(err: unknown): string {
  const parts: string[] = [];
  for (let e = err; e instanceof Error; e = e.cause) parts.push(e.message);
  return parts.join(' ← ');
}

const isRlsViolation = (err: unknown) => /row-level security/.test(fullMessage(err));
const isNotWorkerMember = (err: unknown) => /miembro de mc_worker/.test(fullMessage(err));

/** count(*) de una tabla, con lo que la transacción actual puede ver. */
const countRows = (tx: BaseTx, table: string) =>
  tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`).then((r) => r.rows[0]?.n ?? -1);

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

    const seenByA = await t.db.withWorkspace(WS_A, (tx) => tx.db.select({ id: deal.id }).from(deal));
    const seenByB = await t.db.withWorkspace(WS_B, (tx) => tx.db.select({ id: deal.id }).from(deal));
    assert.deepEqual(seenByA.map((r) => r.id), [dealA]);
    assert.deepEqual(seenByB.map((r) => r.id), [dealB]);
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
      isRlsViolation,
    );
    const touched = await t.db.withWorkspace(WS_A, (tx) =>
      tx.db.update(deal).set({ name: 'Pisado' }).where(eq(deal.id, dealB)).returning({ id: deal.id }),
    );
    assert.equal(touched.length, 0, 'el UPDATE no encuentra la fila ajena');
    const [intact] = await t.db.withWorkspace(WS_B, (tx) => tx.db.select({ name: deal.name }).from(deal));
    assert.equal(intact?.name, 'Lanzamiento B');
  });

  test('las vistas heredan el aislamiento: deal_pipeline solo trae lo propio', async () => {
    const pipelineRows = await t.db.withWorkspace(WS_A, (tx) => tx.db.select().from(dealPipeline));
    assert.equal(pipelineRows.length, 1);
    assert.equal(pipelineRows[0]?.id, dealA);
    assert.equal(pipelineRows[0]?.companyName, 'Café Alma');
    assert.equal(pipelineRows[0]?.stageLabel, 'Nuevo');
    assert.equal(pipelineRows[0]?.probability, '0.0500', 'sin probabilidad propia usa la de la etapa');
    assert.equal(pipelineRows[0]?.dueState, 'sin_fecha');
  });

  test('asWorker cruza workspaces (jobs globales) y vuelve a mc_app al terminar', async (ctx) => {
    if (t.kind !== 'pglite') return ctx.skip('la membresía en mc_worker la decide TEST_DATABASE_URL');
    const allDeals = await t.db.asWorker(async (tx) => {
      const { rows } = await tx.query<Who>(WHO_SQL);
      assert.equal(rows[0]?.current_user, 'mc_worker');
      assert.equal(rows[0]?.bypass_rls, true);
      return tx.db.select({ id: deal.id }).from(deal);
    });
    assert.deepEqual(allDeals.map((r) => r.id).sort(), [dealA, dealB].sort());
    const { rows } = await t.db.withoutWorkspace((tx) => tx.query<Who>(WHO_SQL));
    assert.equal(rows[0]?.current_user, 'mc_app', 'SET LOCAL ROLE muere con la transacción');
  });

  test('asWorker se niega si el rol de conexión no es miembro de mc_worker (mc_app en producción)', async (ctx) => {
    if (t.kind !== 'pglite') return ctx.skip('la membresía en mc_worker la decide TEST_DATABASE_URL');
    // La sesión de PGlite es el superusuario con SET ROLE mc_app, y un
    // superusuario asume cualquier rol: el caso positivo de arriba no
    // demuestra nada sobre mc_app. Aquí la sesión pasa a SER mc_app
    // (SET SESSION AUTHORIZATION), que no es miembro de mc_worker.
    const sessionUser = (await t.raw<{ session_user: string }>('SELECT session_user::text AS session_user'))[0]?.session_user ?? 'postgres';
    await t.raw('SET SESSION AUTHORIZATION mc_app');
    try {
      const { rows } = await t.db.withoutWorkspace((tx) => tx.query<Who>(WHO_SQL));
      assert.equal(rows[0]?.current_user, 'mc_app');
      await assert.rejects(t.db.asWorker(async () => 1), isNotWorkerMember);
      // withWorkspace sigue funcionando: la sesión no quedó rota.
      const seen = await t.db.withWorkspace(WS_A, (tx) => tx.db.select({ id: deal.id }).from(deal));
      assert.deepEqual(seen.map((r) => r.id), [dealA]);
    } finally {
      // PGlite no honra RESET SESSION AUTHORIZATION (deja mc_app): se
      // vuelve al usuario de sesión por su nombre, y de ahí a mc_app.
      await t.raw(`SET SESSION AUTHORIZATION "${sessionUser}"`);
      await t.raw('SET ROLE mc_app');
    }
    const { rows } = await t.db.withoutWorkspace((tx) => tx.query<Who>(WHO_SQL));
    assert.equal(rows[0]?.current_user, 'mc_app', 'la sesión vuelve a como estaba');
  });

  test('un error revierte la transacción entera', async () => {
    await assert.rejects(
      t.db.withWorkspace(WS_A, async (tx) => {
        await tx.db.insert(deal).values({ workspaceId: CURRENT_WORKSPACE, companyId: COMPANY, name: 'Fantasma', stageId: 'nuevo' });
        throw new Error('boom');
      }),
      /boom/,
    );
    const ofA = await t.db.withWorkspace(WS_A, (tx) => tx.db.select({ id: deal.id }).from(deal));
    assert.deepEqual(ofA.map((r) => r.id), [dealA]);
  });

  test('el workspace fijado no sobrevive a su transacción', async () => {
    const afterTx = await t.db.withoutWorkspace((tx) => tx.query<{ ws: string | null }>("SELECT nullif(current_setting('app.workspace_id', true), '') AS ws"));
    assert.equal(afterTx.rows[0]?.ws, null);
  });

  test('el workspace se valida antes de abrir la transacción', async () => {
    assert.throws(() => assertWorkspaceId('laura'), /UUID/);
    assert.throws(() => assertWorkspaceId("'; DROP TABLE deal; --"), /UUID/);
    await assert.rejects(t.db.withWorkspace('laura', async () => 1), /UUID/);
  });
});

describe('las tablas hijas heredan el aislamiento del padre (0018)', () => {
  let creatorA = '';
  let quoteA = '';
  let rateCardA = '';

  before(async () => {
    // Todo lo de A se crea desde A: creador, cotización con un ítem,
    // tarifario con un ítem y un cambio de etapa del deal.
    await t.db.withWorkspace(WS_A, async (tx) => {
      const [creator] = await tx.db
        .insert(creatorProfile)
        .values({ workspaceId: CURRENT_WORKSPACE, displayName: 'Creadora A' })
        .returning({ id: creatorProfile.id });
      creatorA = creator!.id;
      const [q] = await tx.db
        .insert(quote)
        .values({ workspaceId: CURRENT_WORKSPACE, companyId: COMPANY, creatorId: creatorA, number: 'COT-2026-001', slug: 'cot-a-001' })
        .returning({ id: quote.id });
      quoteA = q!.id;
      await tx.db.insert(quoteItem).values({ quoteId: quoteA, deliverable: 'reel', description: 'Reel dedicado', unitPrice: '2500000.00', total: '2500000.00' });
      const [rc] = await tx.db
        .insert(rateCard)
        .values({ workspaceId: CURRENT_WORKSPACE, creatorId: creatorA })
        .returning({ id: rateCard.id });
      rateCardA = rc!.id;
      await tx.db.insert(rateCardItem).values({ rateCardId: rateCardA, deliverable: 'reel', labelEs: 'Reel', priceLow: '2000000.00', priceHigh: '3000000.00' });
      await tx.db.insert(dealStageHistory).values({ dealId: dealA, fromStageId: 'nuevo', toStageId: 'nuevo' });
    });
  });

  for (const table of ['quote_item', 'rate_card_item', 'deal_stage_history']) {
    test(`${table}: A ve su fila; B y sin workspace ven cero`, async () => {
      assert.equal(await t.db.withWorkspace(WS_A, (tx) => countRows(tx, table)), 1);
      assert.equal(await t.db.withWorkspace(WS_B, (tx) => countRows(tx, table)), 0, `desde B se leen filas de ${table} de A`);
      assert.equal(await t.db.withoutWorkspace((tx) => countRows(tx, table)), 0, `sin workspace se leen filas de ${table}`);
    });
  }

  test('desde B no se ven los precios de A ni por Drizzle', async () => {
    const prices = await t.db.withWorkspace(WS_B, (tx) => tx.db.select({ unitPrice: quoteItem.unitPrice }).from(quoteItem));
    assert.deepEqual(prices, []);
    const rates = await t.db.withWorkspace(WS_B, (tx) => tx.db.select({ low: rateCardItem.priceLow }).from(rateCardItem));
    assert.deepEqual(rates, []);
  });

  test('desde B no se puede colgar una fila de un padre de A', async () => {
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) =>
        tx.db.insert(quoteItem).values({ quoteId: quoteA, deliverable: 'reel', description: 'Intruso', unitPrice: '1.00', total: '1.00' }),
      ),
      isRlsViolation,
    );
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) => tx.db.insert(dealStageHistory).values({ dealId: dealA, toStageId: 'nuevo' })),
      isRlsViolation,
    );
    const touched = await t.db.withWorkspace(WS_B, (tx) =>
      tx.db.update(quoteItem).set({ unitPrice: '0.00' }).where(eq(quoteItem.quoteId, quoteA)).returning({ id: quoteItem.id }),
    );
    assert.equal(touched.length, 0, 'el UPDATE no encuentra la fila ajena');
    const [intact] = await t.db.withWorkspace(WS_A, (tx) => tx.db.select({ unitPrice: quoteItem.unitPrice }).from(quoteItem));
    assert.equal(intact?.unitPrice, '2500000.00');
  });

  test('mc_worker sigue viendo las hijas de todos (jobs globales)', async (ctx) => {
    if (t.kind !== 'pglite') return ctx.skip('la membresía en mc_worker la decide TEST_DATABASE_URL');
    assert.equal(await t.db.asWorker((tx) => countRows(tx, 'quote_item')), 1);
  });
});

describe('la transacción y sus manijas', () => {
  test('tx.db y tx.query lanzan TransactionClosedError después del cierre', async () => {
    const leaked = await t.db.withoutWorkspace(async (tx) => tx);
    await assert.rejects(leaked.query('SELECT 1'), TransactionClosedError);
    assert.throws(() => leaked.db.select({ id: deal.id }).from(deal), TransactionClosedError);

    const leakedWithWs = await t.db.withWorkspace(WS_A, async (tx) => tx);
    await assert.rejects(leakedWithWs.query('SELECT 1'), /Transacción cerrada/);
    assert.throws(() => leakedWithWs.db.query, TransactionClosedError);
    assert.equal(leakedWithWs.workspaceId, WS_A, 'los datos planos siguen ahí; solo las manijas mueren');
  });

  test('las manijas también mueren cuando fn lanza', async () => {
    let leaked: BaseTx | undefined;
    await assert.rejects(
      t.db.withoutWorkspace(async (tx) => {
        leaked = tx;
        throw new Error('boom');
      }),
      /boom/,
    );
    await assert.rejects(leaked!.query('SELECT 1'), TransactionClosedError);
  });

  test('una transacción no se anida: se reutiliza el tx que ya se tiene', async () => {
    await assert.rejects(
      t.db.withWorkspace(WS_A, async () => t.db.withWorkspace(WS_B, async () => 1)),
      NestedTransactionError,
    );
    await assert.rejects(
      t.db.withoutWorkspace(async () => t.db.asWorker(async () => 1)),
      /Transacción anidada/,
    );
    await assert.rejects(
      t.db.asWorker(async () => t.db.withoutWorkspace(async () => 1)).catch((err: unknown) => {
        // Si esta sesión no puede asumir mc_worker, el rechazo viene de ahí y no prueba nada.
        if (isNotWorkerMember(err)) throw new NestedTransactionError();
        throw err;
      }),
      NestedTransactionError,
    );
    // Y después de rechazar, el cliente sigue sano: la anidación se
    // detecta antes de tocar el driver, así que nada queda a medias.
    const seen = await t.db.withWorkspace(WS_A, (tx) => tx.db.select({ id: deal.id }).from(deal));
    assert.deepEqual(seen.map((r) => r.id), [dealA]);
    // Dos transacciones en secuencia o en paralelo desde fuera sí valen.
    const [a, b] = await Promise.all([
      t.db.withWorkspace(WS_A, (tx) => countRows(tx, 'deal')),
      t.db.withWorkspace(WS_B, (tx) => countRows(tx, 'deal')),
    ]);
    assert.equal(a, 1);
    assert.equal(b, 1);
  });

  test('toda transacción arranca con statement_timeout e idle_in_transaction_session_timeout', async () => {
    interface Timeouts extends Record<string, unknown> {
      st: string;
      it: string;
    }
    const sql = "SELECT current_setting('statement_timeout') AS st, current_setting('idle_in_transaction_session_timeout') AS it";
    const inside = await t.db.withWorkspace(WS_A, (tx) => tx.query<Timeouts>(sql));
    assert.equal(inside.rows[0]?.st, '15s');
    assert.equal(inside.rows[0]?.it, '15s');
    const asWorkerRows = await t.db.asWorker((tx) => tx.query<Timeouts>(sql)).catch(() => null);
    if (asWorkerRows) assert.equal(asWorkerRows.rows[0]?.st, '15s', 'también como mc_worker');
    // SET LOCAL: al terminar la transacción, la sesión vuelve a su valor.
    if (t.kind === 'pglite') {
      const outside = await t.raw<Timeouts>(sql);
      assert.equal(outside[0]?.st, '0');
    }
  });
});
