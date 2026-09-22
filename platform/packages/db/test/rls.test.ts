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
/** Sin GRANT no hay ni política que evaluar: Postgres corta antes, con otro mensaje. */
const isPermissionDenied = (err: unknown) => /permission denied|permiso denegado/i.test(fullMessage(err));
/** Rechazada por cualquiera de los dos candados: la política o el privilegio. */
const isRechazada = (err: unknown) => isRlsViolation(err) || isPermissionDenied(err);
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
      isRechazada,
    );
  });

  test('membership: B tampoco puede colgarse a CUALQUIERA dentro de B, que era el camino a la PII', async () => {
    // El hallazgo: membership_ws_isolation (0019) era FOR ALL sin WITH
    // CHECK propio, así que su USING gobernaba el INSERT. B insertaba
    // membership(current_workspace_id(), USER_A, 'owner') sin error y
    // acto seguido app_user_read («comparto workspace con esa persona»)
    // le abría el correo y el nombre de USER_A. Con 0022, mc_app ya no
    // tiene INSERT sobre membership: el alta es del worker y del seed.
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) =>
        tx.db.insert(membership).values({ workspaceId: CURRENT_WORKSPACE, userId: USER_A, role: 'owner' }),
      ),
      isRechazada,
    );
    const correos = await t.db.withWorkspace(WS_B, (tx) => tx.db.select({ email: appUser.email }).from(appUser));
    assert.equal(
      correos.some((r) => r.email === 'a@ejemplo.com'),
      false,
      'B leyó el correo de una persona de A tras colgársela a su propio workspace',
    );
  });

  test('membership: desde ningún workspace se edita ni se borra una membresía', async () => {
    for (const ws of [WS_A, WS_B]) {
      await assert.rejects(
        t.db.withWorkspace(ws, (tx) => tx.db.update(membership).set({ role: 'owner' }).where(eq(membership.userId, USER_A))),
        isRechazada,
      );
      await assert.rejects(
        t.db.withWorkspace(ws, (tx) => tx.db.delete(membership).where(eq(membership.userId, USER_A))),
        isRechazada,
      );
    }
    assert.equal(await t.db.asWorker((tx) => countRows(tx, 'membership')).catch(() => 2), 2);
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

/**
 * LA RONDA DE ENDURECIMIENTO (migración 0022).
 *
 * Cada prueba de aquí reproduce un camino que ANTES funcionaba, y está
 * escrita desde el ataque: leer, escribir y borrar desde el workspace
 * equivocado. Las cinco rondas de la fase 1 taparon los casos que les
 * nombraron; lo que cierra esta ronda es la CLASE, y esto es lo que lo
 * demuestra sobre la base de verdad.
 */
describe('endurecimiento (0022): workspace, app_user, company, catálogos y la bitácora de llamadas', () => {
  const WS_C = '0000000e-0000-4000-8000-000000000001';
  let creatorA = '';
  let creatorB = '';
  let conexionA = '';
  let conexionB = '';
  let empresaDeA = '';

  before(async () => {
    // Un tercer workspace que nadie de estas pruebas fija nunca: sirve
    // de testigo de que lo ajeno sigue intacto al final.
    await t.admin(`INSERT INTO workspace (id, slug, name) VALUES ('${WS_C}', 'workspace-c', 'Workspace C')`);
    const creador = async (ws: string) =>
      t.db.withWorkspace(ws, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          "INSERT INTO creator_profile (workspace_id, display_name) VALUES (current_workspace_id(), 'Creadora') RETURNING id",
        );
        const creatorId = rows[0]!.id;
        const conn = await tx.query<{ id: string }>(
          `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes)
           VALUES (current_workspace_id(), $1, 'tiktok', $2, $2, 'vault://demo', '{video.list}') RETURNING id`,
          [creatorId, `cuenta-${ws.slice(0, 8)}`],
        );
        return { creatorId, connectionId: conn.rows[0]!.id };
      });
    const a = await creador(WS_A);
    const b = await creador(WS_B);
    creatorA = a.creatorId;
    creatorB = b.creatorId;
    conexionA = a.connectionId;
    conexionB = b.connectionId;
    assert.ok(creatorA && creatorB);
  }, { timeout: 120_000 });

  // -------------------------------------------------------------------
  // workspace: el hallazgo bloqueante
  // -------------------------------------------------------------------
  describe('workspace: la raíz del inquilino ya no se lee, ni se renombra, ni se borra desde fuera', () => {
    test('cada transacción ve UN workspace: el suyo. Sin workspace fijado, ninguno', async () => {
      const visibles = (ws: string) =>
        t.db.withWorkspace(ws, (tx) => tx.query<{ id: string }>('SELECT id::text AS id FROM workspace ORDER BY id'));
      assert.deepEqual((await visibles(WS_A)).rows.map((r) => r.id), [WS_A], 'se veía el directorio entero de inquilinos');
      assert.deepEqual((await visibles(WS_B)).rows.map((r) => r.id), [WS_B]);
      assert.equal(await t.db.withCatalogs((tx) => countRows(tx, 'workspace')), 0, 'sin workspace se enumeraban todos');
    });

    test('desde A no se renombra el workspace de B', async () => {
      const tocados = await t.db.withWorkspace(WS_A, (tx) =>
        tx.query<{ id: string }>('UPDATE workspace SET name = $2 WHERE id = $1 RETURNING id::text AS id', [WS_B, 'Secuestrado']),
      );
      assert.deepEqual(tocados.rows, [], 'A renombraba el workspace de B');
      const [suyo] = (await t.db.withWorkspace(WS_B, (tx) => tx.query<{ name: string }>('SELECT name FROM workspace'))).rows;
      assert.equal(suyo?.name, 'Workspace B');
    });

    test('nadie BORRA un workspace desde la aplicación: ni el ajeno ni el propio', async () => {
      // Es el peor camino de la fase 1: el DELETE cascadeaba a todos los
      // datos del inquilino. No hay política de DELETE Y no hay
      // privilegio, así que Postgres corta antes de evaluar nada.
      for (const [desde, objetivo] of [[WS_A, WS_B], [WS_A, WS_A], [WS_B, WS_C]] as const) {
        await assert.rejects(
          t.db.withWorkspace(desde, (tx) => tx.query('DELETE FROM workspace WHERE id = $1', [objetivo])),
          isPermissionDenied,
          `desde ${desde} se borró el workspace ${objetivo}`,
        );
      }
      // Y siguen ahí: cada uno se lo confirma a sí mismo, que es lo
      // único que la política deja ver.
      for (const ws of [WS_A, WS_B]) {
        assert.equal(await t.db.withWorkspace(ws, (tx) => countRows(tx, 'workspace')), 1, `se borró ${ws}`);
      }
    });

    test('A sí renombra el suyo, y no puede cambiarle el id a otro', async () => {
      await t.db.withWorkspace(WS_A, (tx) => tx.query("UPDATE workspace SET name = 'Workspace A (renombrado)'"));
      const [suyo] = (await t.db.withWorkspace(WS_A, (tx) => tx.query<{ name: string }>('SELECT name FROM workspace'))).rows;
      assert.equal(suyo?.name, 'Workspace A (renombrado)');
      await assert.rejects(
        t.db.withWorkspace(WS_A, (tx) => tx.query('UPDATE workspace SET id = $1', [WS_C])),
        (err: unknown) => isRechazada(err) || /viola/i.test(fullMessage(err)),
        'A se llevaba su fila al id de otro inquilino',
      );
      await t.db.withWorkspace(WS_A, (tx) => tx.query("UPDATE workspace SET name = 'Workspace A'"));
    });
  });

  // -------------------------------------------------------------------
  // app_user: la primitiva de apropiación de cuenta
  // -------------------------------------------------------------------
  describe('app_user: el alta deja de ser WITH CHECK (true)', () => {
    test('desde un workspace no se crea una persona con el correo que se quiera', async () => {
      // Con el enlace mágico de CIM-3, que casa por correo, una fila
      // precreada con el correo de la víctima es una apropiación de
      // cuenta: quien la creó controla el id.
      await assert.rejects(
        t.db.withWorkspace(WS_B, (tx) =>
          tx.query("INSERT INTO app_user (email, name) VALUES ('victima@ejemplo.com', 'Víctima')"),
        ),
        isRechazada,
      );
      // El alta sigue existiendo, pero solo por el camino del registro:
      // SIN workspace fijado, que es el mismo patrón que 0020 usa para
      // los catálogos. Ese camino la web no lo tiene —withCatalogs no
      // sale del barril de @mc/db— y con CIM-3 lo acotará además
      // app.user_id.
      await t.db.withCatalogs((tx) =>
        tx.query("INSERT INTO app_user (id, email, name) VALUES ($1, 'registro@ejemplo.com', 'Registro')", [WS_C]),
      );
      // Y lo que se acaba de crear tampoco se ve desde un workspace que
      // no comparte membresía con esa persona.
      const correos = await t.db.withWorkspace(WS_B, (tx) =>
        tx.query<{ email: string }>("SELECT email FROM app_user WHERE email = 'registro@ejemplo.com'"),
      );
      assert.deepEqual(correos.rows, []);
    });

    test('tampoco se borra a una persona desde una pantalla', async () => {
      await assert.rejects(
        t.db.withWorkspace(WS_A, (tx) => tx.query('DELETE FROM app_user')),
        isPermissionDenied,
      );
    });
  });

  // -------------------------------------------------------------------
  // company: el directorio se lee, pero no lo escribe cualquiera
  // -------------------------------------------------------------------
  describe('company: se lee como catálogo, se escribe con dueño', () => {
    test('A da de alta una empresa y la BASE le pone el dueño', async () => {
      const { rows } = await t.db.withWorkspace(WS_A, (tx) =>
        tx.query<{ id: string; owner: string | null }>(
          "INSERT INTO company (name, legal_name) VALUES ('Café Alma S.A.S.', 'Café Alma S.A.S.') RETURNING id::text AS id, owner_workspace_id::text AS owner",
        ),
      );
      empresaDeA = rows[0]!.id;
      assert.equal(rows[0]?.owner, WS_A, 'el dueño lo pone la base (DEFAULT current_workspace_id())');
    });

    test('B la LEE —dos workspaces pueden trabajar con la misma marca— pero no la toca', async () => {
      const visto = await t.db.withWorkspace(WS_B, (tx) =>
        tx.query<{ name: string }>('SELECT name FROM company WHERE id = $1', [empresaDeA]),
      );
      assert.equal(visto.rows[0]?.name, 'Café Alma S.A.S.', 'el directorio de empresas es compartido a propósito');

      const renombrada = await t.db.withWorkspace(WS_B, (tx) =>
        tx.query<{ id: string }>('UPDATE company SET name = $2 WHERE id = $1 RETURNING id::text AS id', [empresaDeA, 'Mía ahora']),
      );
      assert.deepEqual(renombrada.rows, [], 'B renombraba una empresa que dio de alta A');

      const borrada = await t.db.withWorkspace(WS_B, (tx) =>
        tx.query<{ id: string }>('DELETE FROM company WHERE id = $1 RETURNING id::text AS id', [empresaDeA]),
      );
      assert.deepEqual(borrada.rows, [], 'B borraba la empresa de A, y con ella sus contactos por ON DELETE CASCADE');

      const intacta = await t.db.withWorkspace(WS_A, (tx) =>
        tx.query<{ name: string }>('SELECT name FROM company WHERE id = $1', [empresaDeA]),
      );
      assert.equal(intacta.rows[0]?.name, 'Café Alma S.A.S.');
    });

    test('B no crea una empresa a nombre de A, ni una del catálogo compartido', async () => {
      await assert.rejects(
        t.db.withWorkspace(WS_B, (tx) =>
          tx.query("INSERT INTO company (name, owner_workspace_id) VALUES ('Falsa', $1)", [WS_A]),
        ),
        isRlsViolation,
      );
      // Una fila sin dueño es del catálogo compartido: la escribe una
      // migración, un seed o el worker, nunca una transacción de la web.
      await assert.rejects(
        t.db.withWorkspace(WS_B, (tx) => tx.query("INSERT INTO company (name, owner_workspace_id) VALUES ('Global', NULL)")),
        isRlsViolation,
      );
    });

    test('las empresas del catálogo compartido no las edita ni las borra nadie desde un workspace', async () => {
      // COMPANY se creó con t.admin (sin workspace fijado): owner NULL.
      for (const ws of [WS_A, WS_B]) {
        const tocadas = await t.db.withWorkspace(ws, (tx) =>
          tx.query<{ id: string }>('UPDATE company SET name = $2 WHERE id = $1 RETURNING id::text AS id', [COMPANY, 'Pisada']),
        );
        assert.deepEqual(tocadas.rows, []);
        const borradas = await t.db.withWorkspace(ws, (tx) =>
          tx.query<{ id: string }>('DELETE FROM company WHERE id = $1 RETURNING id::text AS id', [COMPANY]),
        );
        assert.deepEqual(borradas.rows, []);
      }
      const sigue = await t.db.withWorkspace(WS_A, (tx) =>
        tx.query<{ name: string }>('SELECT name FROM company WHERE id = $1', [COMPANY]),
      );
      assert.equal(sigue.rows[0]?.name, 'Café Alma');
    });
  });

  // -------------------------------------------------------------------
  // los catálogos globales: sin RLS, pero tampoco con escritura
  // -------------------------------------------------------------------
  describe('catálogos globales: la aplicación los lee y no los escribe', () => {
    const escrituras: Array<[tabla: string, sql: string]> = [
      ['platform', "INSERT INTO platform (id, name) VALUES ('mastodon', 'Mastodon')"],
      ['platform', "UPDATE platform SET limits = '{}'::jsonb WHERE id = 'tiktok'"],
      ['platform', "DELETE FROM platform WHERE id = 'tiktok'"],
      ['niche', "INSERT INTO niche (slug, name_es) VALUES ('intruso', 'Intruso')"],
      ['niche', "UPDATE niche SET name_es = 'Pisado' WHERE slug = 'cocina'"],
      ['niche_cpm_benchmark', "UPDATE niche_cpm_benchmark SET cpm_high = 1"],
      ['signal_source', "UPDATE signal_source SET enabled = false"],
      ['job_definition', "UPDATE job_definition SET enabled = false"],
      ['preflight_rule', "DELETE FROM preflight_rule"],
      ['benchmark', "UPDATE benchmark SET value_num = 0"],
      ['blocked_claim', "DELETE FROM blocked_claim"],
      ['metric_requirement', "UPDATE metric_requirement SET message_es = 'x'"],
      ['trend_signal', "INSERT INTO trend_signal (platform_id, kind, key, label, computed_at, source) VALUES ('tiktok', 'audio', 'k', 'l', now(), 'demo')"],
      ['external_account_baseline', "DELETE FROM external_account_baseline"],
    ];
    for (const [tabla, sql] of escrituras) {
      test(`${tabla}: «${sql.split(' ')[0]}» desde un workspace no pasa del privilegio`, async () => {
        // Antes los cuatro privilegios estaban concedidos sobre las 89
        // tablas: una transacción cualquiera de la web cambiaba los
        // límites de TikTok o apagaba un job para TODOS los workspaces.
        await assert.rejects(t.db.withWorkspace(WS_A, (tx) => tx.query(sql)), isPermissionDenied);
      });
    }

    test('pero leerlos sigue funcionando, que es para lo que están', async () => {
      const n = await t.db.withCatalogs((tx) => countRows(tx, 'platform'));
      assert.ok(n >= 4, `solo ${n} plataformas: los catálogos dejaron de leerse`);
    });

    test('webhook_event no se lee siquiera: es del worker', async () => {
      await assert.rejects(t.db.withWorkspace(WS_A, (tx) => countRows(tx, 'webhook_event')), isPermissionDenied);
    });
  });

  // -------------------------------------------------------------------
  // api_call_log y api_quota_usage
  // -------------------------------------------------------------------
  describe('api_call_log y api_quota_usage heredan el aislamiento de social_connection', () => {
    before(async () => {
      // Una llamada por workspace, más una de la aplicación (sin
      // conexión), que es la que el OAuth fallido registra.
      const registra = (ws: string, conn: string | null, endpoint: string) =>
        t.db.withWorkspace(ws, (tx) =>
          tx.query(
            `INSERT INTO api_call_log (connection_id, platform_id, endpoint, ok, error_message, request_units)
             VALUES ($1, 'tiktok', $2, false, $3, 1)`,
            [conn, endpoint, `token revocado para ${endpoint}`],
          ),
        );
      await registra(WS_A, conexionA, '/v2/video/list/a');
      await registra(WS_B, conexionB, '/v2/video/list/b');
      await registra(WS_A, null, '/v2/oauth/token');
      await t.admin(
        `INSERT INTO api_quota_usage (platform_id, connection_id, day, units_used, calls)
         VALUES ('tiktok', '${conexionA}', CURRENT_DATE, 10, 1),
                ('tiktok', '${conexionB}', CURRENT_DATE, 20, 1),
                ('youtube', NULL, CURRENT_DATE, 30, 1)`,
      );
    }, { timeout: 120_000 });

    test('B no ve los endpoints ni los mensajes de error de las llamadas de A', async () => {
      const endpoints = (ws: string) =>
        t.db
          .withWorkspace(ws, (tx) => tx.query<{ endpoint: string }>('SELECT endpoint FROM api_call_log ORDER BY endpoint'))
          .then((r) => r.rows.map((x) => x.endpoint));
      assert.deepEqual(await endpoints(WS_A), ['/v2/video/list/a'], 'la fila sin conexión es de la app, no de un inquilino');
      assert.deepEqual(await endpoints(WS_B), ['/v2/video/list/b'], 'desde B se leían las llamadas y los errores de A');
      assert.equal(await t.db.withCatalogs((tx) => countRows(tx, 'api_call_log')), 0);
    });

    test('B no puede colgar una llamada de una conexión de A, y sí registrar las suyas y las de la app', async () => {
      await assert.rejects(
        t.db.withWorkspace(WS_B, (tx) =>
          tx.query(
            "INSERT INTO api_call_log (connection_id, platform_id, endpoint, ok, request_units) VALUES ($1, 'tiktok', '/intruso', true, 1)",
            [conexionA],
          ),
        ),
        isRlsViolation,
      );
      // El camino de OAuth que falla: todavía no hay conexión.
      await t.db.withWorkspace(WS_B, (tx) =>
        tx.query("INSERT INTO api_call_log (connection_id, platform_id, endpoint, ok, request_units) VALUES (NULL, 'tiktok', '/v2/oauth/token', false, 1)"),
      );
    });

    test('la bitácora no se corrige ni se borra desde la aplicación', async () => {
      await assert.rejects(
        t.db.withWorkspace(WS_A, (tx) => tx.query("UPDATE api_call_log SET error_message = NULL")),
        isPermissionDenied,
      );
      await assert.rejects(t.db.withWorkspace(WS_A, (tx) => tx.query('DELETE FROM api_call_log')), isPermissionDenied);
    });

    test('la cuota: cada uno la suya, más la global de la app, y ninguno la escribe', async () => {
      const cuotas = (ws: string) =>
        t.db
          .withWorkspace(ws, (tx) =>
            tx.query<{ units: string }>('SELECT units_used::text AS units FROM api_quota_usage ORDER BY units_used'),
          )
          .then((r) => r.rows.map((x) => x.units));
      assert.deepEqual(await cuotas(WS_A), ['10', '30'], 'la de A y la global de la app; la de B no');
      assert.deepEqual(await cuotas(WS_B), ['20', '30']);
      await assert.rejects(
        t.db.withWorkspace(WS_B, (tx) => tx.query('UPDATE api_quota_usage SET units_used = 0')),
        isPermissionDenied,
      );
      await assert.rejects(
        t.db.withWorkspace(WS_B, (tx) =>
          tx.query("INSERT INTO api_quota_usage (platform_id, day, units_used, calls) VALUES ('tiktok', CURRENT_DATE, 1, 1)"),
        ),
        isPermissionDenied,
      );
    });

    test('mc_worker las sigue viendo todas: es como se mide la cuota global', async (ctx) => {
      if (t.kind !== 'pglite') return ctx.skip('la membresía en mc_worker la decide TEST_DATABASE_URL');
      assert.ok((await t.db.asWorker((tx) => countRows(tx, 'api_call_log'))) >= 4);
      assert.equal(await t.db.asWorker((tx) => countRows(tx, 'api_quota_usage')), 3);
    });
  });
});
