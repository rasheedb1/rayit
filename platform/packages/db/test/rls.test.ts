/**
 * La prueba obligatoria de CIM-2: dos workspaces, un deal en cada uno,
 * cada uno ve solo el suyo; sin workspace fijado, cero filas.
 *
 * Y lo que se sumó en la ronda 4: membership y contact, las dos tablas
 * que quedaban sin política (0019), y que el helper de pruebas se niega
 * a correr `admin` / `raw` dentro de una transacción en vez de colgarse.
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
  and, appUser, assertWorkspaceId, contact, creatorProfile, CURRENT_WORKSPACE, deal, dealPipeline, dealStageHistory,
  eq, featureFlag, isNull, membership, NestedTransactionError, pipelineStage, quote, quoteItem, rateCard, rateCardItem,
  TransactionClosedError, type BaseTx, type WorkspaceTx,
} from '../src/index.ts';
import { listFeatureFlags, listPipelineStages } from '../src/queries/catalogos.ts';
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
}, { timeout: 120_000 });

after(async () => {
  await t.close();
});

describe('aislamiento por workspace', () => {
  test('las consultas corren como mc_app, sin BYPASSRLS', async (ctx) => {
    if (t.kind !== 'pglite') return ctx.skip('el rol lo decide TEST_DATABASE_URL');
    const { rows } = await t.db.withCatalogs((tx) => tx.query<Who>(WHO_SQL));
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
    const orm = await t.db.withCatalogs((tx) => tx.db.select({ id: deal.id }).from(deal));
    assert.equal(orm.length, 0);
    const raw = await t.db.withCatalogs((tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM deal'));
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
    const { rows } = await t.db.withCatalogs((tx) => tx.query<Who>(WHO_SQL));
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
      const { rows } = await t.db.withCatalogs((tx) => tx.query<Who>(WHO_SQL));
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
    const { rows } = await t.db.withCatalogs((tx) => tx.query<Who>(WHO_SQL));
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
    const afterTx = await t.db.withCatalogs((tx) => tx.query<{ ws: string | null }>("SELECT nullif(current_setting('app.workspace_id', true), '') AS ws"));
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
      assert.equal(await t.db.withCatalogs((tx) => countRows(tx, table)), 0, `sin workspace se leen filas de ${table}`);
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
    const leaked = await t.db.withCatalogs(async (tx) => tx);
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
      t.db.withCatalogs(async (tx) => {
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
      t.db.withCatalogs(async () => t.db.asWorker(async () => 1)),
      /Transacción anidada/,
    );
    await assert.rejects(
      t.db.asWorker(async () => t.db.withCatalogs(async () => 1)).catch((err: unknown) => {
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

describe('membership y contact: las dos tablas que 0019 cerró', () => {
  const USER_A = '0000000d-0000-4000-8000-00000000000a';
  const USER_B = '0000000d-0000-4000-8000-00000000000b';
  const COMPANY_B = '0000000c-0000-4000-8000-000000000002';

  before(async () => {
    // Los usuarios y las membresías se crean como superusuario: app_user
    // sigue sin RLS (CIM-3) y membership necesita el workspace fijado.
    await t.admin(`
      INSERT INTO app_user (id, email, name) VALUES
        ('${USER_A}', 'a@ejemplo.com', 'Persona A'),
        ('${USER_B}', 'b@ejemplo.com', 'Persona B');
      INSERT INTO company (id, name) VALUES ('${COMPANY_B}', 'Fresko');
      SELECT set_config('app.workspace_id', '${WS_A}', false);
      INSERT INTO membership (workspace_id, user_id, role) VALUES ('${WS_A}', '${USER_A}', 'owner');
      SELECT set_config('app.workspace_id', '${WS_B}', false);
      INSERT INTO membership (workspace_id, user_id, role) VALUES ('${WS_B}', '${USER_B}', 'owner');
      SELECT set_config('app.workspace_id', '', false);
      INSERT INTO company_link (workspace_id, company_id, relationship) VALUES ('${WS_A}', '${COMPANY}', 'client');
      INSERT INTO company_link (workspace_id, company_id, relationship) VALUES ('${WS_B}', '${COMPANY_B}', 'client');
    `);
  }, { timeout: 120_000 });

  test('membership: cada workspace ve solo sus membresías; sin workspace, ninguna', async () => {
    const usuariosDe = (ws: string) =>
      t.db.withWorkspace(ws, (tx) => tx.db.select({ userId: membership.userId }).from(membership));
    assert.deepEqual((await usuariosDe(WS_A)).map((r) => r.userId), [USER_A]);
    assert.deepEqual((await usuariosDe(WS_B)).map((r) => r.userId), [USER_B]);
    assert.equal(await t.db.withCatalogs((tx) => countRows(tx, 'membership')), 0, 'sin workspace se enumeraban todas');
  });

  test('membership: desde A no se puede colgar a alguien de B', async () => {
    await assert.rejects(
      t.db.withWorkspace(WS_A, (tx) => tx.db.insert(membership).values({ workspaceId: WS_B, userId: USER_A, role: 'admin' })),
      isRlsViolation,
    );
  });

  test('membership: mc_worker las ve todas (es como CIM-3 leerá "a qué workspaces pertenezco")', async (ctx) => {
    if (t.kind !== 'pglite') return ctx.skip('la membresía en mc_worker la decide TEST_DATABASE_URL');
    assert.equal(await t.db.asWorker((tx) => countRows(tx, 'membership')), 2);
  });

  test('contact: un contacto user_provided de A no lo ve B', async () => {
    const [propio] = await t.db.withWorkspace(WS_A, (tx) =>
      tx.db
        .insert(contact)
        .values({ companyId: COMPANY, fullName: 'Marcela Ruiz', email: 'marcela@cafealma.co', phone: '+573001112233', source: 'user_provided' })
        .returning({ id: contact.id }),
    );
    assert.ok(propio);
    const correosDe = (ws: string) =>
      t.db.withWorkspace(ws, (tx) => tx.db.select({ email: contact.email }).from(contact));
    assert.deepEqual((await correosDe(WS_A)).map((r) => r.email), ['marcela@cafealma.co']);
    assert.deepEqual(await correosDe(WS_B), [], 'desde B se leía el correo y el teléfono de un contacto de A');
    assert.equal(await t.db.withCatalogs((tx) => countRows(tx, 'contact')), 0, 'sin workspace se enumeraba la PII');
  });

  test('contact: los de fuente pública son de todos (es el dato de prospección compartido)', async () => {
    await t.db.withWorkspace(WS_B, (tx) =>
      tx.db.insert(contact).values({ companyId: COMPANY_B, fullName: 'Prensa Fresko', email: 'prensa@fresko.co', source: 'press' }),
    );
    const vistosPorA = await t.db.withWorkspace(WS_A, (tx) => tx.db.select({ email: contact.email }).from(contact));
    assert.ok(
      vistosPorA.some((r) => r.email === 'prensa@fresko.co'),
      'un contacto de prensa de una empresa ajena debería verse: es público',
    );
  });

  test('contact: desde B no se puede escribir un contacto de una empresa que no tiene vinculada', async () => {
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) =>
        tx.db.insert(contact).values({ companyId: COMPANY, fullName: 'Intruso', source: 'user_provided' }),
      ),
      isRlsViolation,
    );
  });
});

describe('el helper de pruebas no se cuelga: raw/admin fuera de la transacción', () => {
  test('llamar a admin() dentro de withWorkspace lanza en vez de esperar para siempre', async (ctx) => {
    if (t.kind !== 'pglite') return ctx.skip('sobre Postgres real admin usa otro pool y no hay cola compartida');
    // Antes esto no resolvía ni lanzaba: la cola de exclusión de PGlite
    // es la misma para raw y para las transacciones.
    await assert.rejects(
      t.db.withWorkspace(WS_A, async () => t.admin('SELECT 1')),
      (err: unknown) => err instanceof Error && err.name === 'RawInsideTransactionError',
    );
    // Y el cliente sigue sano después del rechazo.
    const seen = await t.db.withWorkspace(WS_A, (tx) => tx.db.select({ id: deal.id }).from(deal));
    assert.deepEqual(seen.map((r) => r.id), [dealA]);
  });

  test('t.raw() dentro de una transacción también lanza, con el mismo nombre', async (ctx) => {
    if (t.kind !== 'pglite') return ctx.skip('sobre Postgres real raw usa el pool y no hay cola compartida');
    await assert.rejects(
      t.db.withCatalogs(async () => t.raw('SELECT 1')),
      /RawInsideTransactionError|no se llaman dentro de una transacción/,
    );
  });

  test('fuera de transacción siguen funcionando', async () => {
    await t.admin('SELECT 1');
    const filas = await t.raw<{ uno: number }>('SELECT 1::int AS uno');
    assert.equal(filas[0]?.uno, 1);
  });
});

/**
 * Lo que la ronda 5 cerró con la migración 0020. Cada prueba de aquí
 * reproduce un camino que ANTES funcionaba: están escritas desde el
 * ataque, no desde la política.
 */
describe('contact: la PII tiene dueño, y la baja es definitiva (0020)', () => {
  const COMPANY_C = '0000000c-0000-4000-8000-000000000003';
  const USER_A = '0000000d-0000-4000-8000-00000000000a';
  const USER_B = '0000000d-0000-4000-8000-00000000000b';
  let contactoDeA = '';

  const contactosDe = (ws: string) =>
    t.db.withWorkspace(ws, (tx) =>
      tx.db.select({ id: contact.id, email: contact.email, optedOut: contact.optedOut }).from(contact),
    );
  const soloAna = (rows: Array<{ id: string; email: string | null; optedOut: boolean }>) =>
    rows.find((r) => r.id === contactoDeA);

  before(async () => {
    await t.admin(`INSERT INTO company (id, name) VALUES ('${COMPANY_C}', 'Hogar Lindo')`);
    await t.db.withWorkspace(WS_A, async (tx) => {
      await tx.query(
        'INSERT INTO company_link (workspace_id, company_id, relationship) VALUES (current_workspace_id(), $1, $2)',
        [COMPANY_C, 'client'],
      );
      const [c] = await tx.db
        .insert(contact)
        .values({ companyId: COMPANY_C, fullName: 'Ana Privada', email: 'ana@hogarlindo.co', phone: '+573001234567', source: 'user_provided' })
        .returning({ id: contact.id, owner: contact.ownerWorkspaceId });
      assert.equal(c?.owner, WS_A, 'el dueño lo pone la base (DEFAULT current_workspace_id())');
      contactoDeA = c!.id;
    });
  }, { timeout: 120_000 });

  test('B no lo ve aunque se vincule a la MISMA empresa: el candado ya no es company_link', async () => {
    // company es un catálogo global sin RLS, así que B puede vincularse
    // a cualquier empresa con una sola fila. Con 0019 eso bastaba para
    // leer el nombre, el correo y el teléfono que guardó A.
    await t.db.withWorkspace(WS_B, (tx) =>
      tx.query(
        'INSERT INTO company_link (workspace_id, company_id, relationship) VALUES (current_workspace_id(), $1, $2)',
        [COMPANY_C, 'prospect'],
      ),
    );
    assert.equal(soloAna(await contactosDe(WS_B)), undefined, 'desde B se leía la PII de A con solo insertarse un company_link');
    // Y A lo sigue viendo, que es el otro lado de la misma política.
    assert.equal(soloAna(await contactosDe(WS_A))?.email, 'ana@hogarlindo.co');
  });

  test('B no le cambia el correo ni lo borra: la USING de 0019 servía también de escritura', async () => {
    const pisado = await t.db.withWorkspace(WS_B, (tx) =>
      tx.db.update(contact).set({ email: 'secuestrado@b.co' }).where(eq(contact.id, contactoDeA)).returning({ id: contact.id }),
    );
    assert.deepEqual(pisado, [], 'B reescribía el correo de A y el outreach de A se iba a la dirección de B');
    const borrado = await t.db.withWorkspace(WS_B, (tx) =>
      tx.db.delete(contact).where(eq(contact.id, contactoDeA)).returning({ id: contact.id }),
    );
    assert.deepEqual(borrado, [], 'B borraba contactos de A');
    assert.equal(soloAna(await contactosDe(WS_A))?.email, 'ana@hogarlindo.co');
  });

  test('B no puede crear un contacto a nombre de A, ni siquiera marcándolo público', async () => {
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) =>
        tx.db.insert(contact).values({ companyId: COMPANY_C, ownerWorkspaceId: WS_A, fullName: 'Falso', source: 'press' }),
      ),
      isRlsViolation,
    );
    // Lo que sí puede es guardar el SUYO sobre la misma empresa: es
    // prospección, y queda con B de dueño.
    const [propio] = await t.db.withWorkspace(WS_B, (tx) =>
      tx.db
        .insert(contact)
        .values({ companyId: COMPANY_C, fullName: 'Prensa Hogar Lindo', email: 'prensa@hogarlindo.co', source: 'press' })
        .returning({ owner: contact.ownerWorkspaceId }),
    );
    assert.equal(propio?.owner, WS_B);
  });

  test('la baja no vuelve atrás, ni para su dueño', async () => {
    await t.db.withWorkspace(WS_A, (tx) =>
      tx.db.update(contact).set({ optedOut: true, optedOutAt: new Date().toISOString() }).where(eq(contact.id, contactoDeA)),
    );
    await assert.rejects(
      t.db.withWorkspace(WS_A, (tx) => tx.db.update(contact).set({ optedOut: false }).where(eq(contact.id, contactoDeA))),
      (err: unknown) => /definitiva/.test(fullMessage(err)),
    );
    assert.equal(soloAna(await contactosDe(WS_A))?.optedOut, true);
  });

  test('la baja de un contacto ajeno la registra el worker, no otro workspace', async () => {
    // La baja es global (0007), pero un UPDATE con WHERE tiene que poder
    // LEER la fila: abrirle a otro workspace «solo para dar de baja»
    // sería abrirle la lectura de la PII. Así que A no puede tocar el
    // contacto de B ni para eso…
    const [suyo] = await t.db.withWorkspace(WS_B, (tx) =>
      tx.db
        .insert(contact)
        .values({ companyId: COMPANY_C, fullName: 'Beto Privado', email: 'beto@hogarlindo.co', source: 'user_provided' })
        .returning({ id: contact.id }),
    );
    await t.db.withWorkspace(WS_A, (tx) =>
      tx.query('UPDATE contact SET opted_out = true, email = $2 WHERE id = $1', [suyo!.id, 'secuestrado@a.co']),
    );
    const deB = (await contactosDe(WS_B)).find((r) => r.id === suyo!.id);
    assert.equal(deB?.optedOut, false, 'A tocó un contacto de B');
    assert.equal(deB?.email, 'beto@hogarlindo.co');
  });

  test('…y el worker sí, porque salta RLS (es como el outreach respeta la baja)', async (ctx) => {
    if (t.kind !== 'pglite') return ctx.skip('la membresía en mc_worker la decide TEST_DATABASE_URL');
    const [victima] = (await contactosDe(WS_B)).filter((r) => r.email === 'beto@hogarlindo.co');
    await t.db.asWorker((tx) => tx.query('UPDATE contact SET opted_out = true, opted_out_at = now() WHERE id = $1', [victima!.id]));
    const deB = (await contactosDe(WS_B)).find((r) => r.id === victima!.id);
    assert.equal(deB?.optedOut, true);
  });

  test('mc_worker sigue viendo y escribiendo los de todos (rebotes, bajas globales)', async (ctx) => {
    if (t.kind !== 'pglite') return ctx.skip('la membresía en mc_worker la decide TEST_DATABASE_URL');
    const n = await t.db.asWorker((tx) => countRows(tx, 'contact'));
    assert.ok(n >= 3, `el worker ve ${n} contactos, de todos los workspaces`);
    await t.db.asWorker((tx) => tx.query('UPDATE contact SET bounced = true WHERE id = $1', [contactoDeA]));
  });

  test('app_user: desde B no se lee el correo de las personas de A', async () => {
    const correos = (ws: string) =>
      t.db.withWorkspace(ws, (tx) => tx.db.select({ id: appUser.id, email: appUser.email }).from(appUser));
    assert.deepEqual((await correos(WS_A)).map((r) => r.id), [USER_A], 'B veía a las personas de A, con su correo');
    assert.deepEqual((await correos(WS_B)).map((r) => r.id), [USER_B]);
    assert.equal(await t.db.withCatalogs((tx) => countRows(tx, 'app_user')), 0, 'sin workspace se enumeraban todos los correos');
  });
});

describe('pipeline_stage y feature_flag: catálogos con dueño (0020)', () => {
  const ETAPA_A = 'etapa-secreta-a';

  before(async () => {
    await t.db.withWorkspace(WS_A, (tx) =>
      tx.db.insert(pipelineStage).values({
        id: ETAPA_A,
        workspaceId: CURRENT_WORKSPACE,
        labelEs: 'Cierre con Café Alma',
        position: 10,
        defaultProbability: '0.9000',
      }),
    );
  }, { timeout: 120_000 });

  test('A ve su etapa y las globales; B solo las globales', async () => {
    const etapasDe = (ws: string) => t.db.withWorkspace(ws, (tx) => listPipelineStages(tx));
    const deA = await etapasDe(WS_A);
    const deB = await etapasDe(WS_B);
    assert.ok(deA.some((e) => e.id === ETAPA_A));
    assert.equal(deB.some((e) => e.id === ETAPA_A), false, 'B leía la etapa privada de A, con su nombre');
    assert.ok(deB.some((e) => e.id === 'nuevo'), 'las globales se siguen viendo desde cualquier workspace');
    assert.equal(deA.length, deB.length + 1);
  });

  test('sin workspace fijado quedan las globales, que es como se leen antes de la sesión', async () => {
    const globales = await listPipelineStages(t.db);
    assert.ok(globales.length >= 7);
    assert.equal(globales.some((e) => e.id === ETAPA_A), false);
    assert.equal(globales.every((e) => e.workspaceId === null), true);
  });

  test('B no le enciende una bandera a A', async () => {
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) =>
        tx.db.insert(featureFlag).values({ key: 'outbound_send', workspaceId: WS_A, enabled: true }),
      ),
      isRlsViolation,
    );
    // La suya sí, y A no la ve.
    await t.db.withWorkspace(WS_B, (tx) =>
      tx.db.insert(featureFlag).values({ key: 'outbound_send', workspaceId: CURRENT_WORKSPACE, enabled: true }),
    );
    const deA = await t.db.withWorkspace(WS_A, (tx) => listFeatureFlags(tx));
    assert.equal(deA.some((f) => f.workspaceId === WS_B), false);
    const [global] = await t.db.withWorkspace(WS_A, (tx) =>
      tx.db.select().from(featureFlag).where(and(eq(featureFlag.key, 'outbound_send'), isNull(featureFlag.workspaceId))),
    );
    assert.equal(global?.enabled, false, 'la bandera global sigue apagada: nadie la tocó');
  });

  test('nadie edita ni borra una fila global desde un workspace', async () => {
    const tocadas = await t.db.withWorkspace(WS_B, (tx) =>
      tx.db.update(pipelineStage).set({ labelEs: 'Pisado' }).where(isNull(pipelineStage.workspaceId)).returning({ id: pipelineStage.id }),
    );
    assert.deepEqual(tocadas, []);
    const borradas = await t.db.withWorkspace(WS_B, (tx) =>
      tx.db.delete(pipelineStage).where(isNull(pipelineStage.workspaceId)).returning({ id: pipelineStage.id }),
    );
    assert.deepEqual(borradas, []);
    // Y tampoco se crea una global nueva desde un workspace: eso es un
    // seed o una migración, donde no hay workspace fijado.
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) =>
        tx.db.insert(pipelineStage).values({ id: 'global-intrusa', labelEs: 'Global', position: 99, defaultProbability: '0.1000' }),
      ),
      isRlsViolation,
    );
  });
});

describe('una consulta capturada dentro de la transacción no corre fuera de ella', () => {
  test('un builder esperado después del cierre lanza TransactionClosedError', async () => {
    // El Proxy de tx.db solo lanza en el ACCESO a la propiedad: aquí el
    // acceso ocurre DENTRO (y pasa) y la espera FUERA, donde antes
    // corría sobre una conexión ya devuelta al pool, sin transacción y
    // sin workspace. Se devuelve envuelto en un objeto a propósito: un
    // builder de Drizzle es «thenable», así que devolverlo pelado lo
    // haría esperar la propia transacción.
    const { q } = await t.db.withWorkspace(WS_A, async (tx) => ({ q: tx.db.select({ id: deal.id }).from(deal) }));
    await assert.rejects(async () => {
      await q;
    }, (err: unknown) => /Transacción cerrada/.test(fullMessage(err)));
  });

  test('lo mismo con una transacción de catálogos', async () => {
    const { q } = await t.db.withCatalogs(async (tx) => ({ q: tx.db.select({ id: deal.id }).from(deal) }));
    await assert.rejects(async () => {
      await q;
    }, (err: unknown) => /Transacción cerrada/.test(fullMessage(err)));
  });
});
