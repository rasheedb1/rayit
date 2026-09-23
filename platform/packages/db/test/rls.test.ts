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
 * Y lo de la ronda 4 del endurecimiento (0026): la unicidad por
 * inquilino (el correo de un contacto, el hash de un video, el id de
 * una etapa privada), la baja global en contact_suppression, las
 * secuencias que ya no se leen, y las FILAS HEREDADAS: una base
 * reconstruida hasta 0021 con empresas de la forma vieja, que con 0024
 * y 0025 quedaban a la vista de todos y 0026 adjudica a su workspace.
 *
 * Corre sobre Postgres embebido como mc_app (sin BYPASSRLS), con las
 * migraciones reales: si RLS o el cliente se rompen, esto se rompe.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  and, appUser, assertWorkspaceId, contact, creatorProfile, CURRENT_WORKSPACE, deal, dealPipeline, dealStageHistory,
  eq, featureFlag, isNull, membership, NestedTransactionError, pipelineStage, quote, quoteItem, rateCard, rateCardItem,
  sql, TransactionClosedError, type BaseTx, type WorkspaceTx,
} from '../src/index.ts';
import { listFeatureFlags, listPipelineStages } from '../src/queries/catalogos.ts';
import { getWorkspace } from '../src/queries/cimientos.ts';
import { createEmbeddedDb, type EmbeddedDb } from '../src/embedded.ts';
import { estadoDelEsquema } from '../src/esquema.ts';
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
/**
 * El disparador de 0025 §3: la fila nombra, en una clave ajena, otra
 * que quien escribe no puede leer. Es 23503 —el mismo código que un id
 * que no existe— a propósito: «no existe» y «no es tuyo» no se
 * distinguen desde fuera.
 */
const isReferenciaInvisible = (err: unknown) => /no existe o que esta transacción no puede ver/.test(fullMessage(err));
/** Rechazada por cualquiera de los tres candados: la política, el privilegio o la referencia. */
const isRechazada = (err: unknown) => isRlsViolation(err) || isPermissionDenied(err) || isReferenciaInvisible(err);
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
      // Desde 0025 lo corta antes el disparador de la referencia: para A,
      // el workspace B no existe. Si lo quitaran, lo cortaría la política.
      isRechazada,
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
      isRechazada,
    );
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) => tx.db.insert(dealStageHistory).values({ dealId: dealA, toStageId: 'nuevo' })),
      isRechazada,
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
      INSERT INTO membership (workspace_id, user_id, role_id) VALUES ('${WS_A}', '${USER_A}', system_role_id('creator', 'owner'));
      SELECT set_config('app.workspace_id', '${WS_B}', false);
      INSERT INTO membership (workspace_id, user_id, role_id) VALUES ('${WS_B}', '${USER_B}', system_role_id('creator', 'owner'));
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
      t.db.withWorkspace(WS_A, (tx) => tx.db.insert(membership).values({ workspaceId: WS_B, userId: USER_A, roleId: sql`system_role_id('creator', 'manager')` })),
      isRechazada,
    );
  });

  test('membership: B tampoco puede colgarse a CUALQUIERA dentro de B, que era el camino a la PII', async () => {
    // El hallazgo: membership_ws_isolation (0019) era FOR ALL sin WITH
    // CHECK propio, así que su USING gobernaba el INSERT. B insertaba
    // membership(current_workspace_id(), USER_A, 'owner') sin error y
    // acto seguido app_user_read («comparto workspace con esa persona»)
    // le abría el correo y el nombre de USER_A. Con 0024, mc_app ya no
    // tiene INSERT sobre membership: el alta es del worker y del seed.
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) =>
        tx.db.insert(membership).values({ workspaceId: CURRENT_WORKSPACE, userId: USER_A, roleId: sql`system_role_id('creator', 'owner')` }),
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
        t.db.withWorkspace(ws, (tx) => tx.db.update(membership).set({ roleId: sql`system_role_id('creator', 'owner')` }).where(eq(membership.userId, USER_A))),
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

  test('contact: lo público que GUARDA un workspace es suyo; lo público sin dueño es de todos (0025 §6)', async () => {
    // Hasta 0025 un contacto de fuente pública lo leía cualquiera, fuera
    // de quien fuera. Con company cerrada, esa era la puerta lateral que
    // quedaba: el contacto trae company_id, owner_workspace_id y un
    // correo con el dominio de la marca. «Qué marcas prospecta B» salía
    // de ahí, y de ahí sacaron los revisores los ids del ataque a company.
    await t.db.withWorkspace(WS_B, (tx) =>
      tx.db.insert(contact).values({ companyId: COMPANY_B, fullName: 'Prensa Fresko', email: 'prensa@fresko.co', source: 'press' }),
    );
    const vistosPorA = await t.db.withWorkspace(WS_A, (tx) => tx.db.select({ email: contact.email }).from(contact));
    assert.equal(
      vistosPorA.some((r) => r.email === 'prensa@fresko.co'),
      false,
      'desde A se leía el contacto de prensa que guardó B, con su dueño y el dominio de la marca',
    );
    // El dato de prospección compartido sigue existiendo: son las filas
    // SIN dueño, las del enriquecimiento del worker (aquí, el superusuario).
    await t.admin(
      `INSERT INTO contact (company_id, full_name, email, source) VALUES ('${COMPANY_B}', 'Prensa del catálogo', 'prensa@catalogo.co', 'press')`,
    );
    for (const ws of [WS_A, WS_B]) {
      const vistos = await t.db.withWorkspace(ws, (tx) => tx.db.select({ email: contact.email }).from(contact));
      assert.ok(vistos.some((r) => r.email === 'prensa@catalogo.co'), `${ws} no ve el contacto público del catálogo`);
    }
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
      isRechazada,
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
  // El id de una etapa privada es un uuid al azar: 0026 §2 lo exige por CHECK.
  const ETAPA_A = '0000e7a9-0000-4000-8000-00000000000a';

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
      isRechazada,
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

  test('…ni desde una transacción SIN workspace: esa rama es del rol que migra, no de mc_app (0025 §4)', async () => {
    // 0020 escribió el alta de las globales como «sin workspace fijado»,
    // con la idea de que la web no abre transacciones así. No es una
    // frontera: withCatalogs existe en el objeto que la web recibe. Desde
    // ahí mc_app creaba etapas y banderas para TODOS los inquilinos.
    await assert.rejects(
      t.db.withCatalogs((tx) =>
        tx.query("INSERT INTO pipeline_stage (id, label_es, position, default_probability) VALUES ('global-intrusa', 'Global', 99, 0.1)"),
      ),
      isRlsViolation,
    );
    await assert.rejects(
      t.db.withCatalogs((tx) => tx.query("INSERT INTO feature_flag (key, enabled) VALUES ('intrusa', true)")),
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
 * LA RONDA DE ENDURECIMIENTO (migración 0024).
 *
 * Cada prueba de aquí reproduce un camino que ANTES funcionaba, y está
 * escrita desde el ataque: leer, escribir y borrar desde el workspace
 * equivocado. Las cinco rondas de la fase 1 taparon los casos que les
 * nombraron; lo que cierra esta ronda es la CLASE, y esto es lo que lo
 * demuestra sobre la base de verdad.
 */
describe('endurecimiento (0024): workspace, app_user, company, catálogos y la bitácora de llamadas', () => {
  const WS_C = '0000000e-0000-4000-8000-000000000001';
  /** El que se registra en la prueba del alta de workspace. */
  const WS_NUEVO = '0000000e-0000-4000-8000-000000000002';
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

    test('crear un workspace es crear el de la transacción; sin workspace fijado no se crea ninguno (0025 §4)', async () => {
      await assert.rejects(
        t.db.withCatalogs((tx) => tx.query("INSERT INTO workspace (slug, name) VALUES ('intruso', 'Intruso')")),
        isRlsViolation,
      );
      await assert.rejects(
        t.db.withWorkspace(WS_A, (tx) => tx.query("INSERT INTO workspace (id, slug, name) VALUES ($1, 'otro', 'Otro')", [WS_NUEVO])),
        isRlsViolation,
        'desde A se creaba un workspace con otro id',
      );
      // El registro: withWorkspace(nuevoId) y su fila.
      await t.db.withWorkspace(WS_NUEVO, (tx) =>
        tx.query("INSERT INTO workspace (id, slug, name) VALUES (current_workspace_id(), 'nuevo', 'Nuevo')"),
      );
      assert.equal(await t.db.withWorkspace(WS_NUEVO, (tx) => countRows(tx, 'workspace')), 1);
    });

    test('el plan no se lo cambia el propio workspace: ni al darse de alta ni después (0024 §7.6, 0025 §4)', async () => {
      // El hallazgo del pulido: la política de UPDATE aísla la FILA, y con
      // UPDATE de tabla el propio workspace se subía a enterprise gratis.
      await assert.rejects(
        t.db.withWorkspace(WS_A, (tx) => tx.query("UPDATE workspace SET plan = 'enterprise'")),
        isPermissionDenied,
        'A se subía el plan a enterprise',
      );
      for (const columna of ["kind = 'agency'", 'deleted_at = now()']) {
        await assert.rejects(
          t.db.withWorkspace(WS_A, (tx) => tx.query(`UPDATE workspace SET ${columna}`)),
          isPermissionDenied,
          `A cambiaba ${columna}`,
        );
      }
      // Lo que sí es una pantalla de ajustes sigue funcionando.
      const tocados = await t.db.withWorkspace(WS_A, (tx) =>
        tx.query<{ id: string }>(
          'UPDATE workspace SET name = name, slug = slug, timezone = timezone, settings = settings, updated_at = now() RETURNING id::text AS id',
        ),
      );
      assert.deepEqual(tocados.rows.map((r) => r.id), [WS_A]);
      // Y el alta nace en el plan gratuito, sin poder elegir otro.
      const nuevo = '0000000e-0000-4000-8000-000000000003';
      await assert.rejects(
        t.db.withWorkspace(nuevo, (tx) =>
          tx.query("INSERT INTO workspace (id, slug, name, plan) VALUES (current_workspace_id(), 'gratis-no', 'X', 'enterprise')"),
        ),
        isRlsViolation,
        'el alta elegía el plan',
      );
      const { rows } = await t.db.withWorkspace(nuevo, (tx) =>
        tx.query<{ plan: string }>(
          "INSERT INTO workspace (id, slug, name) VALUES (current_workspace_id(), 'gratis-si', 'Gratis') RETURNING plan",
        ),
      );
      assert.equal(rows[0]?.plan, 'free');
      await t.admin(`DELETE FROM workspace WHERE id = '${nuevo}'`);
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
      // Tampoco SIN workspace fijado. 0024 dejó esa rama para «el
      // registro», con la idea de que la web no abre transacciones así;
      // pero withCatalogs existe en el objeto que la web recibe (solo lo
      // esconde el tipo), y desde ahí se precreaba la fila de cualquiera.
      // 0025 §4 le deja esa rama al rol que migra, no a mc_app.
      await assert.rejects(
        t.db.withCatalogs((tx) =>
          tx.query("INSERT INTO app_user (id, email, name) VALUES ($1, 'victima@ejemplo.com', 'Víctima')", [WS_C]),
        ),
        isRlsViolation,
      );
      // Lo que queda es registrarse uno mismo: la fila de
      // current_user_id(), que con CIM-3 fija el cliente de base desde
      // la sesión. Aquí se fija a mano para probar la rama.
      const YO = '0000000d-0000-4000-8000-0000000000c1';
      await t.db.withWorkspace(WS_C, async (tx) => {
        await tx.query("SELECT set_config('app.user_id', $1, true)", [YO]);
        await tx.query("INSERT INTO app_user (id, email, name) VALUES ($1, 'registro@ejemplo.com', 'Registro')", [YO]);
      });
      // Y lo que se acaba de crear no se ve desde un workspace que no
      // comparte membresía con esa persona.
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
  describe('company: el directorio compartido deja de ser la lista de prospectos de todos', () => {
    test('A da de alta una empresa y la BASE le pone el dueño', async () => {
      const { rows } = await t.db.withWorkspace(WS_A, (tx) =>
        tx.query<{ id: string; owner: string | null }>(
          "INSERT INTO company (name, legal_name) VALUES ('Café Alma S.A.S.', 'Café Alma S.A.S.') RETURNING id::text AS id, owner_workspace_id::text AS owner",
        ),
      );
      empresaDeA = rows[0]!.id;
      assert.equal(rows[0]?.owner, WS_A, 'el dueño lo pone la base (DEFAULT current_workspace_id())');
    });

    test('B no la LEE: qué marcas trabaja una agencia no es un catálogo público', async () => {
      // La ronda 1 dejó aquí `company_read USING (true)` con el
      // argumento de que el directorio es compartido. La consecuencia
      // medida: desde un workspace cualquiera se enumeraba la lista de
      // prospectos de otro, con su razón social —el mismo dato que 0020
      // cerró en `contact`—.
      const visto = await t.db.withWorkspace(WS_B, (tx) =>
        tx.query<{ name: string }>('SELECT name FROM company WHERE id = $1', [empresaDeA]),
      );
      assert.deepEqual(visto.rows, [], 'B leía «Café Alma S.A.S.» con su razón social');

      const sinWorkspace = await t.db.withCatalogs((tx) =>
        tx.query<{ name: string }>('SELECT name FROM company WHERE id = $1', [empresaDeA]),
      );
      assert.deepEqual(sinWorkspace.rows, [], 'sin workspace fijado tampoco');

      const propia = await t.db.withWorkspace(WS_A, (tx) =>
        tx.query<{ name: string }>('SELECT name FROM company WHERE id = $1', [empresaDeA]),
      );
      assert.equal(propia.rows[0]?.name, 'Café Alma S.A.S.', 'su dueño sí, claro');
    });

    test('vincularla no la abre: B ni siquiera puede nombrarla en su company_link (0025 §1 y §3)', async () => {
      // 0024 dejaba leer la empresa «vinculada» y «con historia», y
      // vincularla era escribir UNA fila con un id que se consigue. Ahora
      // la referencia a una fila que B no lee se rechaza antes de llegar
      // a la política, y aunque llegara, company_read ya no tiene esa
      // puerta.
      await assert.rejects(
        t.db.withWorkspace(WS_B, (tx) =>
          tx.query('INSERT INTO company_link (workspace_id, company_id, relationship) VALUES (current_workspace_id(), $1, $2)', [
            empresaDeA,
            'prospect',
          ]),
        ),
        isReferenciaInvisible,
      );
      const visto = await t.db.withWorkspace(WS_B, (tx) =>
        tx.query<{ name: string }>('SELECT name FROM company WHERE id = $1', [empresaDeA]),
      );
      assert.deepEqual(visto.rows, []);
    });

    test('y aunque el vínculo EXISTA (lo escribió el worker), la empresa de A sigue sin verse desde B', async () => {
      // Es la puerta en sí, sin el disparador delante: si alguien
      // recreara la rama «vinculada» de company_read, esto la delata.
      await t.admin(
        `INSERT INTO company_link (workspace_id, company_id, relationship) VALUES ('${WS_B}', '${empresaDeA}', 'prospect')`,
      );
      try {
        const visto = await t.db.withWorkspace(WS_B, (tx) =>
          tx.query<{ name: string }>('SELECT name FROM company WHERE id = $1', [empresaDeA]),
        );
        assert.deepEqual(visto.rows, [], 'B leía la empresa de A por tenerla vinculada');
      } finally {
        await t.admin(`DELETE FROM company_link WHERE workspace_id = '${WS_B}' AND company_id = '${empresaDeA}'`);
      }
    });

    test('vinculada o no, B no la renombra ni la borra', async () => {
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
        isRechazada,
      );
      // Una fila sin dueño es del catálogo compartido: la escribe una
      // migración, un seed o el worker, nunca una transacción de la web.
      await assert.rejects(
        t.db.withWorkspace(WS_B, (tx) => tx.query("INSERT INTO company (name, owner_workspace_id) VALUES ('Global', NULL)")),
        isRlsViolation,
      );
    });

    test('las del catálogo compartido (sin dueño) sí se leen, y no las edita ni las borra nadie', async () => {
      // COMPANY se creó con t.admin (sin workspace fijado): owner NULL.
      // Esa rama es la que mantiene vivo el directorio de verdad —lo que
      // llena un enriquecimiento o el worker— sin exponer a quién
      // prospecta cada quien.
      for (const ws of [WS_A, WS_B, WS_C]) {
        const visible = await t.db.withWorkspace(ws, (tx) =>
          tx.query<{ name: string }>('SELECT name FROM company WHERE id = $1', [COMPANY]),
        );
        assert.equal(visible.rows[0]?.name, 'Café Alma', `${ws} no ve el catálogo compartido`);
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
        isRechazada,
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

/**
 * La sección 6 de 0024: las hijas cuya clave ajena al padre admite NULL.
 *
 * 0018 cerró las hijas con la FK NOT NULL y dejó estas «a decisión del
 * dueño del módulo», con un test.todo. 0024 las cerró con la regla
 * general —`fk IS NULL OR EXISTS (padre)`— y era la única parte de la
 * migración sin ninguna prueba desde el ataque. La rama `fk IS NULL` es
 * la que más fácil se escribe mal: si se olvida, el worker deja de ver
 * el dato global; si se invierte, B ve el de A.
 */
describe('las hijas con clave ajena opcional (0024 §6)', () => {
  const WS_D = '0000000f-0000-4000-8000-000000000001';
  // Ids fijos: `admin` no devuelve filas, y así la prueba dice sin
  // rodeos qué cuelga de quién.
  const CAMPANA_DE_A = '0000001a-0000-4000-8000-000000000001';
  const CREADORA_DE_A = '0000001a-0000-4000-8000-000000000002';
  const ASSET_DE_A = '0000001a-0000-4000-8000-000000000003';
  const ANALISIS_DE_A = '0000001a-0000-4000-8000-000000000004';
  const POST_DE_A = '0000001a-0000-4000-8000-000000000005';
  const POST_GLOBAL = '0000001a-0000-4000-8000-000000000006';

  before(async () => {
    // El padre de A, y el dato sin padre de cada familia. Se siembran
    // como admin porque desde 0024 mc_app no escribe ninguna de estas
    // tablas: las llena el worker.
    await t.admin(`
      INSERT INTO workspace (id, slug, name) VALUES ('${WS_D}', 'workspace-d', 'Workspace D');
      INSERT INTO campaign (id, workspace_id, company_id, name)
        VALUES ('${CAMPANA_DE_A}', '${WS_A}', '${COMPANY}', 'Campaña de A');
      INSERT INTO creator_profile (id, workspace_id, display_name)
        VALUES ('${CREADORA_DE_A}', '${WS_A}', 'Creadora de A');
      INSERT INTO video_asset (id, workspace_id) VALUES ('${ASSET_DE_A}', '${WS_A}');
      INSERT INTO video_analysis (id, video_asset_id, workspace_id, analyzer_version)
        VALUES ('${ANALISIS_DE_A}', '${ASSET_DE_A}', '${WS_A}', 'v1.0.0');
      INSERT INTO external_post (id, platform_id, external_post_id, analysis_id)
        VALUES ('${POST_DE_A}', 'tiktok', 'ep-de-a', '${ANALISIS_DE_A}');
      INSERT INTO external_post (id, platform_id, external_post_id)
        VALUES ('${POST_GLOBAL}', 'tiktok', 'ep-global');

      INSERT INTO brand_account_snapshot (campaign_id, company_id, platform_id, day, followers)
        VALUES ('${CAMPANA_DE_A}', '${COMPANY}', 'tiktok', '2026-09-01', 1000);
      INSERT INTO brand_account_snapshot (campaign_id, company_id, platform_id, day, followers)
        VALUES (NULL, '${COMPANY}', 'instagram', '2026-09-01', 2000);
      INSERT INTO trait_lift (scope, creator_id, trait_key, trait_label, freq_outliers, freq_rest, lift, sample_outliers, sample_rest)
        VALUES ('creator', '${CREADORA_DE_A}', 'hook.type=method', 'Gancho de método', 0.4, 0.1, 4.0, 20, 80);
      INSERT INTO trait_lift (scope, creator_id, trait_key, trait_label, freq_outliers, freq_rest, lift, sample_outliers, sample_rest)
        VALUES ('niche', NULL, 'duration.lt40s', 'Menos de 40 s', 0.6, 0.3, 2.0, 30, 90);
      INSERT INTO external_post_score (external_post_id, is_outlier) VALUES ('${POST_DE_A}', true);
      INSERT INTO external_post_score (external_post_id, is_outlier) VALUES ('${POST_GLOBAL}', false);
      INSERT INTO external_post_snapshot (external_post_id, views) VALUES ('${POST_DE_A}', 111);
      INSERT INTO external_post_snapshot (external_post_id, views) VALUES ('${POST_GLOBAL}', 222);
    `);
  }, { timeout: 120_000 });

  /** Las cinco familias, con la consulta que separa la fila de A de la global. */
  const familias: Array<{ tabla: string; deA: () => string; global: () => string; sql: string }> = [
    {
      tabla: 'brand_account_snapshot',
      deA: () => CAMPANA_DE_A,
      global: () => 'instagram',
      sql: 'SELECT coalesce(campaign_id::text, platform_id) AS marca FROM brand_account_snapshot ORDER BY 1',
    },
    {
      tabla: 'trait_lift',
      deA: () => CREADORA_DE_A,
      global: () => 'duration.lt40s',
      sql: 'SELECT coalesce(creator_id::text, trait_key) AS marca FROM trait_lift ORDER BY 1',
    },
    {
      tabla: 'external_post',
      deA: () => POST_DE_A,
      global: () => POST_GLOBAL,
      sql: 'SELECT id::text AS marca FROM external_post ORDER BY 1',
    },
    {
      tabla: 'external_post_score',
      deA: () => POST_DE_A,
      global: () => POST_GLOBAL,
      sql: 'SELECT external_post_id::text AS marca FROM external_post_score ORDER BY 1',
    },
    {
      tabla: 'external_post_snapshot',
      deA: () => POST_DE_A,
      global: () => POST_GLOBAL,
      sql: 'SELECT external_post_id::text AS marca FROM external_post_snapshot ORDER BY 1',
    },
  ];

  for (const f of familias) {
    test(`${f.tabla}: A ve la suya y la global; D solo la global`, async () => {
      const visto = (ws: string) =>
        t.db.withWorkspace(ws, (tx) => tx.query<{ marca: string }>(f.sql)).then((r) => r.rows.map((x) => x.marca));

      const deA = await visto(WS_A);
      assert.ok(deA.includes(f.deA()), `A no ve lo suyo en ${f.tabla}`);
      assert.ok(deA.includes(f.global()), `A no ve el dato global de ${f.tabla}`);

      // WS_D no tiene campaña, ni creadora, ni análisis: solo puede ver
      // lo que no cuelga de nadie. Es la rama `fk IS NULL`.
      const deD = await visto(WS_D);
      assert.deepEqual(deD, [f.global()], `desde D se ve lo que cuelga del padre de A en ${f.tabla}`);
    });
  }

  test('y ninguna de las cinco se escribe desde la aplicación: las llena el worker', async () => {
    const escrituras: Array<[tabla: string, sql: string]> = [
      [
        'brand_account_snapshot',
        `INSERT INTO brand_account_snapshot (campaign_id, company_id, platform_id, day) VALUES (NULL, '${COMPANY}', 'youtube', '2026-09-02')`,
      ],
      ['brand_account_snapshot', 'UPDATE brand_account_snapshot SET followers = 0'],
      ['brand_account_snapshot', 'DELETE FROM brand_account_snapshot'],
      [
        'trait_lift',
        "INSERT INTO trait_lift (scope, trait_key, trait_label, freq_outliers, freq_rest, lift, sample_outliers, sample_rest) VALUES ('niche', 'x', 'X', 0.1, 0.1, 1, 1, 1)",
      ],
      ['trait_lift', 'DELETE FROM trait_lift'],
      ['external_post', "INSERT INTO external_post (platform_id, external_post_id) VALUES ('tiktok', 'intruso')"],
      ['external_post', 'UPDATE external_post SET caption = $$pisado$$'],
      ['external_post', 'DELETE FROM external_post'],
      ['external_post_score', 'UPDATE external_post_score SET is_outlier = false'],
      ['external_post_score', 'DELETE FROM external_post_score'],
      ['external_post_snapshot', 'UPDATE external_post_snapshot SET views = 0'],
      ['external_post_snapshot', 'DELETE FROM external_post_snapshot'],
    ];
    for (const [tabla, sql] of escrituras) {
      await assert.rejects(
        t.db.withWorkspace(WS_D, (tx) => tx.query(sql)),
        isRechazada,
        `${tabla} se puede escribir desde la aplicación: ${sql}`,
      );
    }
  });

  test('mc_worker las sigue viendo todas: es como el radar compara', async (ctx) => {
    if (t.kind !== 'pglite') return ctx.skip('requiere membresía en mc_worker');
    const n = await t.db.asWorker((tx) => countRows(tx, 'external_post'));
    assert.equal(n, 2);
  });
});

/**
 * getWorkspace nunca sirve al vecino, esté o no la política.
 *
 * Hasta integrar CIM-3 la consulta no llevaba WHERE —la política era la
 * que dejaba ver una fila— y comprobaba la que volvía, porque en la
 * ventana de ALLOW_STALE_SCHEMA=1 (0024 sin aplicar) `limit(1)` sin
 * ORDER BY devolvía un inquilino cualquiera y Finanzas formateaba con
 * SU moneda. Con CIM-3 (0028, workspace_read_member) una transacción con
 * identidad ve también los otros espacios de su persona, así que ahora
 * filtra por `current_workspace_id()` —la función de la transacción, no
 * un parámetro de JavaScript— y sigue comprobando la fila.
 */
describe('getWorkspace: nunca sirve al vecino', () => {
  test('con la política puesta, devuelve el workspace de la transacción', async () => {
    const ws = await t.db.withWorkspace(WS_A, getWorkspace);
    assert.equal(ws.id, WS_A);
  });

  test('con una política que abre a TODOS los inquilinos, getWorkspace sigue sin servir otro', async () => {
    // Es la ventana de ALLOW_STALE_SCHEMA llevada al extremo: `workspace`
    // sin la RLS de 0024, la consulta ve las filas de todos. Antes, sin
    // filtro, `limit(1)` devolvía una CUALQUIERA y la moneda, el locale y
    // la zona con que Finanzas formatea salían de otro inquilino. La
    // política de mentira es `id <> current_workspace_id()` y no `true` a
    // propósito: así el «cualquiera» es siempre otro, que es justo el caso
    // malo.
    await t.admin(
      'DROP POLICY workspace_read ON workspace; ' +
        'CREATE POLICY workspace_read ON workspace FOR SELECT USING (id <> current_workspace_id())',
    );
    try {
      const todos = await t.db.withWorkspace(WS_B, (tx) => countRows(tx, 'workspace'));
      assert.ok(todos > 1, 'la prueba no vale si la consulta solo puede ver una fila');
      // La política de mentira esconde justo la fila propia: lo único
      // que getWorkspace podría devolver es otro inquilino, y no lo hace.
      await assert.rejects(t.db.withWorkspace(WS_B, getWorkspace), /no existe en esta base/);
    } finally {
      await t.admin(
        'DROP POLICY workspace_read ON workspace; ' +
          'CREATE POLICY workspace_read ON workspace FOR SELECT USING (id = current_workspace_id())',
      );
    }
  });

  test('y si la fila no está, lo dice en vez de devolver undefined', async () => {
    const huerfano = '0000009f-0000-4000-8000-000000000001';
    await assert.rejects(t.db.withWorkspace(huerfano, getWorkspace), (err: unknown) => {
      assert.match(fullMessage(err), /no existe en esta base/);
      return true;
    });
  });

  test('y la política vuelve a estar, para las pruebas que siguen', async () => {
    const ws = await t.db.withWorkspace(WS_B, getWorkspace);
    assert.equal(ws.id, WS_B);
  });

  test('quien está en dos espacios ve los dos (CIM-3), y getWorkspace le da el de la transacción', async () => {
    // El caso que rompía la integración de CIM-3 con el endurecimiento:
    // con identidad fijada, workspace_read_member (0028) abre también los
    // otros espacios de la persona. Sin filtro, `limit(1)` devolvía el
    // que fuera, y la comprobación tumbaba cada pantalla de quien tiene
    // dos espacios.
    const persona = '0000009e-0000-4000-8000-000000000001';
    await t.admin(`
      INSERT INTO app_user (id, email, name) VALUES ('${persona}', 'dos-espacios@ejemplo.test', 'Dos espacios');
      INSERT INTO membership (workspace_id, user_id, role_id) VALUES ('${WS_A}', '${persona}', system_role_id('creator', 'owner')), ('${WS_B}', '${persona}', system_role_id('creator', 'owner'));
    `);
    try {
      for (const ws of [WS_A, WS_B]) {
        const visibles = await t.db.withWorkspace(ws, (tx) => countRows(tx, 'workspace'), { userId: persona });
        assert.equal(visibles, 2, 'la prueba no vale si la persona no ve sus dos espacios');
        const fila = await t.db.withWorkspace(ws, getWorkspace, { userId: persona });
        assert.equal(fila.id, ws);
      }
    } finally {
      await t.admin(`DELETE FROM membership WHERE user_id = '${persona}'; DELETE FROM app_user WHERE id = '${persona}';`);
    }
  });
});

/**
 * PULIDO, RONDA 1: un padre que aísla por PERSONA no aísla por inquilino.
 *
 * app_user («soy yo o comparto workspace con esa persona») y membership
 * («las de este workspace o las mías») dejan ver, a quien está en A y en
 * B, cosas de A desde B. Una tabla con workspace_id que se aislara con un
 * EXISTS sobre ellas filtraba las filas de A. Ninguna tabla del esquema
 * lo hace; esto prueba que la forma filtra de verdad —con la base, no
 * con la guardia— y que la guardia la nombra (esquema.test.ts tiene las
 * sondas de forma).
 */
describe('un padre por persona no aísla una tabla con inquilino (pulido, ronda 1)', () => {
  const PERSONA = '0000009f-0000-4000-8000-000000000001';
  const FILA = '0000009f-0000-4000-8000-0000000000a1';

  // Las tablas de prueba las crea el rol que migra en pglite; contra un
  // Postgres real (CI) ese rol no existe y las tres pruebas se saltan.
  const embebido = () => t.kind === 'pglite';

  before(async () => {
    if (!embebido()) return;
    await t.admin(`
      INSERT INTO app_user (id, email, name) VALUES ('${PERSONA}', 'en-a-y-en-b@ejemplo.test', 'En A y en B');
      INSERT INTO membership (workspace_id, user_id, role_id) VALUES ('${WS_A}', '${PERSONA}', system_role_id('creator', 'editor')), ('${WS_B}', '${PERSONA}', system_role_id('creator', 'editor'));
      SET ROLE mc_migrator_embedded;
      CREATE TABLE zz_persona (id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspace(id),
        created_by uuid REFERENCES app_user(id), nota text);
      ALTER TABLE zz_persona ENABLE ROW LEVEL SECURITY; ALTER TABLE zz_persona FORCE ROW LEVEL SECURITY;
      CREATE POLICY zz_persona_read ON zz_persona FOR SELECT
        USING (EXISTS (SELECT 1 FROM app_user u WHERE u.id = zz_persona.created_by));
      CREATE TABLE zz_miembro (id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspace(id), nota text);
      ALTER TABLE zz_miembro ENABLE ROW LEVEL SECURITY; ALTER TABLE zz_miembro FORCE ROW LEVEL SECURITY;
      CREATE POLICY zz_miembro_read ON zz_miembro FOR SELECT
        USING (EXISTS (SELECT 1 FROM membership m WHERE m.workspace_id = zz_miembro.workspace_id));
      REVOKE ALL ON zz_persona, zz_miembro FROM mc_app;
      GRANT SELECT ON zz_persona, zz_miembro TO mc_app;
      RESET ROLE;
      INSERT INTO zz_persona VALUES ('${FILA}', '${WS_A}', '${PERSONA}', 'secreto de A');
      INSERT INTO zz_miembro VALUES ('${FILA}', '${WS_A}', 'secreto de A');
    `);
  }, { timeout: 120_000 });

  after(async () => {
    if (!embebido()) return;
    await t.admin(`
      DROP TABLE zz_persona, zz_miembro;
      DELETE FROM membership WHERE user_id = '${PERSONA}'; DELETE FROM app_user WHERE id = '${PERSONA}';
    `);
  });

  test('por app_user: desde B, sin identidad fijada, se lee la fila de A que nombra a la persona compartida', async (ctx) => {
    if (!embebido()) return ctx.skip('las tablas de prueba solo se crean sobre pglite');
    const { rows } = await t.db.withWorkspace(WS_B, (tx) => tx.query<{ nota: string }>('SELECT nota FROM zz_persona'));
    assert.deepEqual(rows.map((r) => r.nota), ['secreto de A'], 'la forma filtra: por eso la guardia no la acepta');
  });

  test('por membership: con la identidad fijada (como corre la web con CIM-3), desde B se lee lo de A', async (ctx) => {
    if (!embebido()) return ctx.skip('las tablas de prueba solo se crean sobre pglite');
    const sinIdentidad = await t.db.withWorkspace(WS_B, (tx) => countRows(tx, 'zz_miembro'));
    assert.equal(sinIdentidad, 0);
    const conIdentidad = await t.db.withWorkspace(WS_B, (tx) => countRows(tx, 'zz_miembro'), { userId: PERSONA });
    assert.equal(conIdentidad, 1, 'la forma filtra en cuanto se fija app.user_id');
  });

  test('y la guardia nombra las dos políticas', async (ctx) => {
    if (!embebido()) return ctx.skip('las tablas de prueba solo se crean sobre pglite');
    const claves = (await estadoDelEsquema(t.db)).politicasAbiertas.map((p) => p.clave);
    assert.ok(claves.includes('zz_persona.zz_persona_read'), JSON.stringify(claves));
    assert.ok(claves.includes('zz_miembro.zz_miembro_read'), JSON.stringify(claves));
  });
});


/** El código de error de Postgres, buscado en la cadena de causas (Drizzle lo envuelve). */
function codigo(err: unknown): string | null {
  for (let e = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return null;
}

/**
 * RONDA 3 (migración 0025): una fila no puede nombrar otra que su
 * transacción no ve.
 *
 * La clave ajena la comprueba Postgres sin RLS, así que B podía
 * insertar company_link(B, <empresa de A>) y la rama «vinculada» de
 * company_read le abría la empresa de A. Los revisores lo reprodujeron
 * con el seed: antes 0 filas, después las seis empresas de A con su
 * dueño. Y no era cosa de company: una etapa privada en deal.stage_id o
 * un deal ajeno en quote.deal_id pasaban igual. Estas pruebas están
 * escritas desde el ataque; la guardia (src/esquema.ts) exige además el
 * disparador en toda clave de ese tipo que exista mañana.
 */
describe('las referencias solo nombran lo que quien escribe puede leer (0025)', () => {
  const WS_TESTIGO = '0000002b-0000-4000-8000-000000000001';
  const EMPRESA_DE_A = '0000002a-0000-4000-8000-000000000001';
  const ETAPA_DE_A = '0000e7a9-0000-4000-8000-0000000000da';
  let dealDeA = '';
  let creadoraDeB = '';

  before(async () => {
    await t.admin(`INSERT INTO workspace (id, slug, name) VALUES ('${WS_TESTIGO}', 'workspace-testigo', 'Testigo')`);
    await t.db.withWorkspace(WS_A, async (tx) => {
      await tx.query("INSERT INTO company (id, name, legal_name, domain) VALUES ($1, 'Marca de A', 'Marca de A S.A.S.', 'marca-de-a.co')", [
        EMPRESA_DE_A,
      ]);
      await tx.query(
        "INSERT INTO company_link (workspace_id, company_id, relationship) VALUES (current_workspace_id(), $1, 'client')",
        [EMPRESA_DE_A],
      );
      // Un contacto de prensa: fuente pública, que hasta 0025 leía cualquiera.
      await tx.query(
        "INSERT INTO contact (company_id, full_name, email, source) VALUES ($1, 'Prensa Marca de A', 'prensa@marca-de-a.co', 'press')",
        [EMPRESA_DE_A],
      );
      await tx.query(
        "INSERT INTO pipeline_stage (id, workspace_id, label_es, position, default_probability) VALUES ($1, current_workspace_id(), 'Privada', 51, 0.5)",
        [ETAPA_DE_A],
      );
      const { rows } = await tx.query<{ id: string }>(
        "INSERT INTO deal (workspace_id, company_id, name, stage_id) VALUES (current_workspace_id(), $1, 'Deal de A', 'nuevo') RETURNING id::text AS id",
        [EMPRESA_DE_A],
      );
      dealDeA = rows[0]!.id;
    });
    const { rows } = await t.db.withWorkspace(WS_B, (tx) =>
      tx.query<{ id: string }>(
        "INSERT INTO creator_profile (workspace_id, display_name) VALUES (current_workspace_id(), 'Creadora B') RETURNING id::text AS id",
      ),
    );
    creadoraDeB = rows[0]!.id;
  }, { timeout: 120_000 });

  const empresasDeAVistasDesde = (ws: string) =>
    t.db
      .withWorkspace(ws, (tx) =>
        tx.query<{ name: string }>('SELECT name FROM company WHERE owner_workspace_id = $1', [WS_A]),
      )
      .then((r) => r.rows.map((x) => x.name));

  test('el guion de los revisores: sacar ids de los contactos públicos, vincularlos y leer las empresas de A', async () => {
    // Paso 1: los ids. Hasta 0025 salían de contact, cuyos públicos
    // leía cualquiera. Ahora lo público que guardó A es de A.
    const ids = await t.db.withWorkspace(WS_B, (tx) =>
      tx.query<{ company_id: string }>('SELECT DISTINCT company_id::text AS company_id FROM contact'),
    );
    assert.equal(ids.rows.some((r) => r.company_id === EMPRESA_DE_A), false, 'B sacaba el id de la empresa de A de un contacto público');

    // Paso 2: aunque B consiga el id por otro lado, no puede vincularlo.
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) =>
        tx.query('INSERT INTO company_link (workspace_id, company_id) VALUES (current_workspace_id(), $1)', [EMPRESA_DE_A]),
      ),
      isReferenciaInvisible,
    );

    // Paso 3: y no lee nada. Antes: la empresa de A con su dueño.
    assert.deepEqual(await empresasDeAVistasDesde(WS_B), []);
    assert.ok((await empresasDeAVistasDesde(WS_A)).includes('Marca de A'), 'su dueño sí');
  });

  test('ni con un deal, una campaña, una factura, un reporte, una programación, una cotización, un contacto o una actividad', async () => {
    // Cada una de estas era una puerta de la company_read de 0024 (las
    // cuatro primeras) o una tabla más con company_id. Y todas son ON
    // DELETE CASCADE: si B pudiera colgarlas, el DELETE de A borraría
    // las filas de B.
    const intentos: Array<[tabla: string, sql: string, params: unknown[]]> = [
      ['deal', "INSERT INTO deal (workspace_id, company_id, name, stage_id) VALUES (current_workspace_id(), $1, 'x', 'nuevo')", [EMPRESA_DE_A]],
      ['campaign', "INSERT INTO campaign (workspace_id, company_id, name) VALUES (current_workspace_id(), $1, 'x')", [EMPRESA_DE_A]],
      [
        'invoice',
        "INSERT INTO invoice (workspace_id, company_id, number, subtotal, total, issued_on, due_on) VALUES (current_workspace_id(), $1, 'FV-X-1', 1, 1, CURRENT_DATE, CURRENT_DATE)",
        [EMPRESA_DE_A],
      ],
      [
        'report',
        "INSERT INTO report (workspace_id, company_id, slug, kind, payload) VALUES (current_workspace_id(), $1, 'r-x-1', 'campaign', '{}')",
        [EMPRESA_DE_A],
      ],
      [
        'report_schedule',
        "INSERT INTO report_schedule (workspace_id, company_id, kind, cron, channel) VALUES (current_workspace_id(), $1, 'monthly', '0 9 1 * *', 'email')",
        [EMPRESA_DE_A],
      ],
      [
        'quote',
        "INSERT INTO quote (workspace_id, company_id, creator_id, number, slug) VALUES (current_workspace_id(), $1, $2, 'COT-X-1', 'cot-x-1')",
        [EMPRESA_DE_A, creadoraDeB],
      ],
      ['contact', "INSERT INTO contact (company_id, full_name, source) VALUES ($1, 'x', 'press')", [EMPRESA_DE_A]],
      ['activity', "INSERT INTO activity (workspace_id, company_id, kind) VALUES (current_workspace_id(), $1, 'note')", [EMPRESA_DE_A]],
    ];
    for (const [tabla, sql, params] of intentos) {
      await assert.rejects(
        t.db.withWorkspace(WS_B, (tx) => tx.query(sql, params)),
        isReferenciaInvisible,
        `desde B se colgaba una fila de ${tabla} de la empresa de A`,
      );
    }
    // Tampoco moviendo una fila propia hacia ella.
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) => tx.query('UPDATE deal SET company_id = $1 WHERE id = $2', [EMPRESA_DE_A, dealB])),
      isReferenciaInvisible,
    );
    assert.deepEqual(await empresasDeAVistasDesde(WS_B), []);
  });

  test('no es cosa de company: tampoco la etapa privada de A ni el deal de A', async () => {
    // deal.stage_id → pipeline_stage es NO ACTION: un deal de B con la
    // etapa de A impedía que A la borrara.
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) =>
        tx.query("INSERT INTO deal (workspace_id, company_id, name, stage_id) VALUES (current_workspace_id(), $1, 'x', $2)", [COMPANY, ETAPA_DE_A]),
      ),
      isReferenciaInvisible,
    );
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) =>
        tx.query(
          "INSERT INTO quote (workspace_id, company_id, creator_id, deal_id, number, slug) VALUES (current_workspace_id(), $1, $2, $3, 'COT-X-2', 'cot-x-2')",
          [COMPANY, creadoraDeB, dealDeA],
        ),
      ),
      isReferenciaInvisible,
    );
    // Y A sigue pudiendo borrar su etapa: nadie la tiene tomada.
    await t.db.withWorkspace(WS_A, (tx) => tx.query('DELETE FROM pipeline_stage WHERE id = $1', [ETAPA_DE_A]));
  });

  test('«no existe» y «no es tuyo» dan el MISMO error: el disparador no es un oráculo', async () => {
    const intento = (id: string) =>
      t.db
        .withWorkspace(WS_B, (tx) =>
          tx.query('INSERT INTO company_link (workspace_id, company_id) VALUES (current_workspace_id(), $1)', [id]),
        )
        .then(
          () => null,
          (err: unknown) => ({ codigo: codigo(err), mensaje: fullMessage(err).replace(/^Failed query:[\s\S]*?← /, '') }),
        );
    const deA = await intento(EMPRESA_DE_A);
    const inexistente = await intento('0000002a-0000-4000-8000-0000000000ff');
    assert.equal(deA?.codigo, '23503', 'foreign_key_violation, como un id que no existe');
    assert.deepEqual(deA, inexistente, 'desde fuera se distinguía una empresa ajena de una que no existe');
  });

  test('una referencia que ya estaba no impide editar la fila; cambiarla por otra invisible, sí', async () => {
    // Una fila que el worker (o una migración) dejó apuntando a algo que
    // B no ve: el disparador solo mira la columna cuando CAMBIA.
    const CAMPANA = '0000002a-0000-4000-8000-000000000002';
    await t.admin(
      `INSERT INTO campaign (id, workspace_id, company_id, name) VALUES ('${CAMPANA}', '${WS_B}', '${EMPRESA_DE_A}', 'Heredada')`,
    );
    try {
      await t.db.withWorkspace(WS_B, (tx) => tx.query("UPDATE campaign SET name = 'Renombrada' WHERE id = $1", [CAMPANA]));
      await t.db.withWorkspace(WS_B, (tx) => tx.query('UPDATE campaign SET company_id = company_id WHERE id = $1', [CAMPANA]));
      // Pasarla a una del catálogo, que B sí ve, se puede.
      await t.db.withWorkspace(WS_B, (tx) => tx.query('UPDATE campaign SET company_id = $2 WHERE id = $1', [CAMPANA, COMPANY]));
      // Y devolverla a la de A, no.
      await assert.rejects(
        t.db.withWorkspace(WS_B, (tx) => tx.query('UPDATE campaign SET company_id = $2 WHERE id = $1', [CAMPANA, EMPRESA_DE_A])),
        isReferenciaInvisible,
      );
    } finally {
      await t.admin(`DELETE FROM campaign WHERE id = '${CAMPANA}'`);
    }
  });

  test('con su propia ficha o con la del catálogo, la campaña de B se lista con el nombre de su marca', async () => {
    // El caso que la ronda 2 resolvió abriendo company_read («una
    // campaña cuya empresa no se ve desaparece del JOIN»). Con §3 esa
    // campaña ya no se puede crear; la de B apunta a lo que B ve.
    const { rows } = await t.db.withWorkspace(WS_B, async (tx) => {
      const propia = await tx.query<{ id: string }>(
        "INSERT INTO company (name, domain) VALUES ('Marca de A (ficha de B)', 'marca-de-a.co') RETURNING id::text AS id",
      );
      await tx.query("INSERT INTO campaign (workspace_id, company_id, name) VALUES (current_workspace_id(), $1, 'Con la mía')", [propia.rows[0]!.id]);
      await tx.query("INSERT INTO campaign (workspace_id, company_id, name) VALUES (current_workspace_id(), $1, 'Con la del catálogo')", [COMPANY]);
      return tx.query<{ campana: string; marca: string }>(
        "SELECT c.name AS campana, co.name AS marca FROM campaign c JOIN company co ON co.id = c.company_id WHERE c.name LIKE 'Con la %' ORDER BY 1",
      );
    });
    assert.deepEqual(rows, [
      { campana: 'Con la del catálogo', marca: 'Café Alma' },
      { campana: 'Con la mía', marca: 'Marca de A (ficha de B)' },
    ]);
    // Y el testigo, que no trabaja con ninguna, no ve la ficha de B.
    const deTestigo = await t.db.withWorkspace(WS_TESTIGO, (tx) =>
      tx.query("SELECT 1 FROM company WHERE name = 'Marca de A (ficha de B)'"),
    );
    assert.deepEqual(deTestigo.rows, []);
  });

  test('el dominio es único por dueño: B no descubre qué marcas tiene A (0025 §2)', async () => {
    // Con el índice único global de 0007, dar de alta 'marca-de-a.co'
    // desde B fallaba con «duplicate key … company_domain_idx»: un
    // oráculo de la cartera de A. La prueba de arriba ya creó la ficha
    // de B con ese dominio sin error; lo que choca es repetir la PROPIA.
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) => tx.query("INSERT INTO company (name, domain) VALUES ('Otra vez', 'marca-de-a.co')")),
      (err: unknown) => codigo(err) === '23505' && /company_owner_domain_idx/.test(fullMessage(err)),
    );
    // Y el catálogo compartido sigue deduplicado por dominio.
    await t.admin("INSERT INTO company (name, domain) VALUES ('Catálogo', 'catalogo-0025.co')");
    await assert.rejects(t.admin("INSERT INTO company (name, domain) VALUES ('Catálogo 2', 'catalogo-0025.co')"), /company_catalog_domain_idx/);
  });

  test('toda tabla con una clave hacia company que mc_app escribe lleva el disparador', async () => {
    // La lista la pone la base, no esta prueba: si mañana alguien crea
    // otra tabla con company_id, o le quita el disparador a una, falla.
    const { rows } = await t.db.withCatalogs((tx) =>
      tx.query<{ hija: string; columna: string; tiene: boolean }>(`
        SELECT hija.relname AS hija, a.attname::text AS columna,
               EXISTS (
                 SELECT 1 FROM pg_trigger tg JOIN pg_proc f ON f.oid = tg.tgfoid
                  WHERE tg.tgrelid = hija.oid AND f.proname = 'assert_reference_visible'
                    AND tg.tgenabled <> 'D'
                    AND split_part(encode(tg.tgargs, 'escape'), '\\000', 1) = a.attname
                    AND split_part(encode(tg.tgargs, 'escape'), '\\000', 2) = 'company'
               ) AS tiene
          FROM pg_constraint k
          JOIN pg_class hija ON hija.oid = k.conrelid
          JOIN pg_class p ON p.oid = k.confrelid
          JOIN pg_attribute a ON a.attrelid = hija.oid AND a.attnum = k.conkey[1]
         WHERE k.contype = 'f' AND p.relname = 'company'
           AND (has_table_privilege('mc_app', hija.oid, 'INSERT') OR has_table_privilege('mc_app', hija.oid, 'UPDATE'))
         ORDER BY 1`),
    );
    assert.ok(rows.length >= 10, `solo ${rows.length} tablas apuntan a company: la prueba no está mirando nada`);
    assert.deepEqual(rows.filter((r) => !r.tiene).map((r) => `${r.hija}.${r.columna}`), []);
  });
});

/**
 * 0025 §5: las métricas se insertan, nunca se actualizan, y las escribe
 * quien las mide. mc_app conservaba UPDATE y DELETE sobre las propias y
 * sobre audit_log: dentro de su workspace, una pantalla reescribía las
 * vistas de un post o borraba su bitácora de auditoría.
 */
describe('las métricas propias y la auditoría no se reescriben desde la aplicación (0025 §5)', () => {
  const soloDelWorker: Array<[tabla: string, sql: string]> = [
    ['post_metric_snapshot', 'UPDATE post_metric_snapshot SET views = 0'],
    ['post_metric_snapshot', 'DELETE FROM post_metric_snapshot'],
    ['audience_breakdown', 'DELETE FROM audience_breakdown'],
    ['post_engagement_curve', 'UPDATE post_engagement_curve SET workspace_id = workspace_id'],
    ['post_retention_curve', 'DELETE FROM post_retention_curve'],
    ['post_impression_source', 'DELETE FROM post_impression_source'],
    ['post_score', 'UPDATE post_score SET workspace_id = workspace_id'],
    ['creator_baseline', 'DELETE FROM creator_baseline'],
    ['campaign_result', 'DELETE FROM campaign_result'],
    ['job_run', "INSERT INTO job_run (job_id, status, attempt) VALUES ('intruso', 'running', 1)"],
    ['job_run', "UPDATE job_run SET status = 'ok'"],
    ['audit_log', 'UPDATE audit_log SET workspace_id = workspace_id'],
    ['audit_log', 'DELETE FROM audit_log'],
    ['account_metric_snapshot', 'DELETE FROM account_metric_snapshot'],
  ];
  for (const [tabla, sql] of soloDelWorker) {
    test(`${tabla}: «${sql.split(' ')[0]}» desde un workspace no pasa del privilegio`, async () => {
      await assert.rejects(t.db.withWorkspace(WS_A, (tx) => tx.query(sql)), isPermissionDenied);
    });
  }

  test('leerlas sigue funcionando, que es lo que hace la web', async () => {
    for (const tabla of ['post_metric_snapshot', 'job_run', 'audit_log', 'campaign_result']) {
      assert.ok((await t.db.withWorkspace(WS_A, (tx) => countRows(tx, tabla))) >= 0);
    }
  });

  test('post_metric_snapshot: la web AÑADE lecturas de su post (CSV de RES-2), pero no del post de otro', async () => {
    // 0025 §5 le deja a mc_app el INSERT —la importación por CSV—, y con
    // él la sección 7 le engancha assert_reference_visible en post_id.
    const post = await t.db.withWorkspace(WS_A, async (tx) => {
      const { rows: [creadora] } = await tx.query<{ id: string }>(
        "INSERT INTO creator_profile (workspace_id, display_name) VALUES (current_workspace_id(), 'Creadora pms') RETURNING id::text AS id",
      );
      const { rows: [conexion] } = await tx.query<{ id: string }>(
        `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes)
         VALUES (current_workspace_id(), $1, 'instagram', 'pms-0025', 'pms-0025', 'vault://demo', '{}') RETURNING id::text AS id`,
        [creadora!.id],
      );
      const { rows: [p] } = await tx.query<{ id: string }>(
        `INSERT INTO post (workspace_id, creator_id, connection_id, platform_id, external_post_id, media_type, published_at)
         VALUES (current_workspace_id(), $1, $2, 'instagram', 'pms-0025-a', 'video', now() - interval '2 days')
         RETURNING id::text AS id`,
        [creadora!.id, conexion!.id],
      );
      return p!.id;
    });
    const insertar = (ws: string) =>
      t.db.withWorkspace(ws, (tx) =>
        tx.query(
          `INSERT INTO post_metric_snapshot (post_id, workspace_id, captured_at, age_hours, views, source)
           VALUES ($1, current_workspace_id(), now(), 48, 10, 'csv_import')`,
          [post],
        ),
      );
    await insertar(WS_A);
    await assert.rejects(insertar(WS_B), isReferenciaInvisible);
  });

  test('y el worker las sigue escribiendo, con sus propios GRANT (0014)', async (ctx) => {
    if (t.kind !== 'pglite') return ctx.skip('la membresía en mc_worker la decide TEST_DATABASE_URL');
    await t.db.asWorker((tx) =>
      tx.query("INSERT INTO job_run (job_id, status, attempt) SELECT id, 'skipped', 1 FROM job_definition LIMIT 1"),
    );
  });
});

// =====================================================================
// RONDA 4 (0026): la misma clase, en lo que la ronda 3 dejó abierto
// =====================================================================

/** El código SQLSTATE, buscado en la cadena de causas. */
const sqlstate = (err: unknown): string | null => {
  for (let e = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
};

describe('la unicidad es por inquilino: un 23505 ya no dice qué tiene otro workspace (0026 §2)', () => {
  const EMPRESA_DE_A = '0000026a-0000-4000-8000-000000000001';
  /** El correo del guion de los revisores: el de un contacto user_provided de A. */
  const CORREO = 'andrea.salazar@hogarlindo.co';
  const HASH = 'sha256:0026-mismo-archivo';

  before(async () => {
    await t.db.withWorkspace(WS_A, async (tx) => {
      await tx.query("INSERT INTO company (id, name) VALUES ($1, 'Hogar Lindo (de A)')", [EMPRESA_DE_A]);
      await tx.query('INSERT INTO company_link (workspace_id, company_id) VALUES (current_workspace_id(), $1)', [EMPRESA_DE_A]);
      await tx.query(
        "INSERT INTO contact (company_id, full_name, email, source) VALUES ($1, 'Andrea Salazar', $2, 'user_provided')",
        [EMPRESA_DE_A, CORREO],
      );
      await tx.query('INSERT INTO video_asset (workspace_id, content_hash) VALUES (current_workspace_id(), $1)', [HASH]);
    });
  }, { timeout: 120_000 });

  test('el guion de los revisores: B guarda a la misma persona sin chocar con la ficha de A', async () => {
    // Hasta 0026: «duplicate key value violates unique constraint
    // contact_email_idx», mientras que un correo que nadie tiene pasaba.
    // B aprendía que otra agencia tiene a esa persona en su CRM.
    const { vistosAntes, vistosDespues } = await t.db.withWorkspace(WS_B, async (tx) => {
      const antes = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM contact WHERE email = $1', [CORREO]);
      const { rows } = await tx.query<{ id: string }>("INSERT INTO company (name) VALUES ('Mi ficha') RETURNING id");
      const empresa = rows[0]!.id;
      await tx.query('INSERT INTO company_link (workspace_id, company_id) VALUES (current_workspace_id(), $1)', [empresa]);
      await tx.query(
        "INSERT INTO contact (company_id, full_name, email, source) VALUES ($1, 'x', $2, 'user_provided')",
        [empresa, CORREO],
      );
      const despues = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM contact WHERE email = $1', [CORREO]);
      return { vistosAntes: antes.rows[0]!.n, vistosDespues: despues.rows[0]!.n };
    });
    assert.equal(vistosAntes, 0, 'B no ve el contacto de A');
    assert.equal(vistosDespues, 1, 'y ahora ve el suyo, y solo el suyo');
    const deA = await t.db.withWorkspace(WS_A, (tx) =>
      tx.query<{ full_name: string }>('SELECT full_name FROM contact WHERE email = $1', [CORREO]),
    );
    assert.deepEqual(deA.rows.map((r) => r.full_name), ['Andrea Salazar'], 'y A sigue viendo solo el suyo');
  });

  test('dentro de un mismo workspace el correo sigue siendo único', async () => {
    await assert.rejects(
      t.db.withWorkspace(WS_A, (tx) =>
        tx.query("INSERT INTO contact (company_id, full_name, email, source) VALUES ($1, 'Otra vez', $2, 'inbound')", [
          EMPRESA_DE_A,
          CORREO,
        ]),
      ),
      (err: unknown) => sqlstate(err) === '23505' && /contact_owner_email_idx/.test(fullMessage(err)),
    );
  });

  test('video_asset: B registra el mismo archivo que A sin enterarse de que A lo tiene', async () => {
    await t.db.withWorkspace(WS_B, (tx) =>
      tx.query('INSERT INTO video_asset (workspace_id, content_hash) VALUES (current_workspace_id(), $1)', [HASH]),
    );
    // Y en su propio workspace deduplica igual que antes.
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) =>
        tx.query('INSERT INTO video_asset (workspace_id, content_hash) VALUES (current_workspace_id(), $1)', [HASH]),
      ),
      (err: unknown) => sqlstate(err) === '23505' && /video_asset_ws_content_hash_idx/.test(fullMessage(err)),
    );
  });

  test('una etapa privada no puede llevar un nombre por id: la base le pone uno al azar', async () => {
    // pipeline_stage.id es la clave primaria de TODA la tabla: con un id
    // legible, B chocaba con la etapa privada de A y aprendía su nombre.
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) =>
        tx.query(
          "INSERT INTO pipeline_stage (id, workspace_id, label_es, position, default_probability) VALUES ('cierre-cafe-alma', current_workspace_id(), 'x', 60, 0.5)",
        ),
      ),
      (err: unknown) => sqlstate(err) === '23514' && /pipeline_stage_private_id_random/.test(fullMessage(err)),
    );
    const { rows } = await t.db.withWorkspace(WS_B, (tx) =>
      tx.query<{ id: string }>(
        "INSERT INTO pipeline_stage (workspace_id, label_es, position, default_probability) VALUES (current_workspace_id(), 'Mía', 61, 0.5) RETURNING id",
      ),
    );
    assert.match(rows[0]!.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

/**
 * La baja global (0007) la llena SOLO una baja verificada de la propia
 * persona, que procesa el worker (0029 §1).
 *
 * Con 0026 §3 la llenaba un disparador SECURITY DEFINER desde el
 * opted_out que cualquier workspace escribe en su CRM. Reproducido por
 * los revisores como mc_app: B guarda un contacto con el correo de un
 * cliente de A y opted_out = true, y desde entonces cada contacto que A
 * guarde con ese correo nace dado de baja, con un motivo inventado, y el
 * outreach de A a sus propios clientes queda bloqueado para siempre. La
 * prueba de la ronda 4 —«A registra la baja; el contacto que B guarde
 * DESPUÉS nace dado de baja»— trataba como funcionalidad justo el
 * ataque. Aquí está al revés.
 */
describe('la baja global la llena solo una baja verificada, no el CRM de un workspace (0029 §1)', () => {
  const EMPRESA_A = '0000026a-0000-4000-8000-000000000002';
  const EMPRESA_B = '0000026b-0000-4000-8000-000000000002';
  const CLIENTE_DE_A = 'cliente@marca-0029.co';
  const VERIFICADO = 'pidio-la-baja@marca-0029.co';

  before(async () => {
    for (const [ws, empresa] of [[WS_A, EMPRESA_A], [WS_B, EMPRESA_B]] as const) {
      await t.db.withWorkspace(ws, async (tx) => {
        await tx.query("INSERT INTO company (id, name) VALUES ($1, 'Marca 0029')", [empresa]);
        await tx.query('INSERT INTO company_link (workspace_id, company_id) VALUES (current_workspace_id(), $1)', [empresa]);
      });
    }
  }, { timeout: 120_000 });

  /** Guarda un contacto en el CRM de `ws` y devuelve cómo nació. */
  const guardar = (ws: string, empresa: string, email: string) =>
    t.db
      .withWorkspace(ws, (tx) =>
        tx.query<{ opted_out: boolean; opted_out_reason: string | null }>(
          "INSERT INTO contact (company_id, email, source) VALUES ($1, $2, 'user_provided') RETURNING opted_out, opted_out_reason",
          [empresa, email],
        ),
      )
      .then((r) => r.rows[0]);

  test('el guion de los revisores: B marca de baja el correo de un cliente de A, y el contacto de A NO nace dado de baja', async () => {
    // B, con una empresa suya, da de alta a esa persona YA de baja.
    await t.db.withWorkspace(WS_B, (tx) =>
      tx.query(
        "INSERT INTO contact (full_name, email, source, company_id, opted_out, opted_out_at) VALUES ('X', $1, 'user_provided', $2, true, now())",
        [CLIENTE_DE_A, EMPRESA_B],
      ),
    );
    const deA = await guardar(WS_A, EMPRESA_A, CLIENTE_DE_A);
    assert.equal(deA?.opted_out, false, 'B daba de baja en toda la plataforma a un cliente de A');
    assert.equal(deA?.opted_out_reason, null, 'y le inventaba un motivo: «Pidió la baja de la plataforma»');
  });

  test('ni por UPDATE: B da de baja a alguien en su CRM, A le pone ese correo a un contacto suyo, y sigue sin baja', async () => {
    // Los otros dos caminos del disparador de 0026: la baja que B marca
    // con un UPDATE (no al crear), y el contacto de A que CAMBIA a ese
    // correo (no que nace con él).
    const OTRO_CLIENTE = 'cliente-2@marca-0029.co';
    await t.db.withWorkspace(WS_B, async (tx) => {
      await tx.query("INSERT INTO contact (company_id, email, source) VALUES ($1, $2, 'user_provided')", [EMPRESA_B, OTRO_CLIENTE]);
      await tx.query('UPDATE contact SET opted_out = true, opted_out_at = now() WHERE email = $1', [OTRO_CLIENTE]);
    });
    const [otro] = await t.db.withWorkspace(WS_A, (tx) =>
      tx.db
        .insert(contact)
        .values({ companyId: EMPRESA_A, fullName: 'Otro de A', email: 'otro@marca-0029.co', source: 'user_provided' })
        .returning({ id: contact.id }),
    );
    const { rows } = await t.db.withWorkspace(WS_A, (tx) =>
      tx.query<{ opted_out: boolean }>('UPDATE contact SET email = $2 WHERE id = $1 RETURNING opted_out', [
        otro!.id,
        OTRO_CLIENTE,
      ]),
    );
    assert.equal(rows[0]?.opted_out, false, 'con 0026, el contacto de A quedaba de baja al cambiarle el correo');
  });

  test('la baja del CRM de B se queda en SU contacto, y es definitiva para él', async () => {
    const { rows } = await t.db.withWorkspace(WS_B, (tx) =>
      tx.query<{ opted_out: boolean }>('SELECT opted_out FROM contact WHERE email = $1', [CLIENTE_DE_A]),
    );
    assert.deepEqual(rows, [{ opted_out: true }]);
  });

  test('una baja VERIFICADA la registra el worker, y entonces el contacto que cualquiera guarde nace dado de baja', async (ctx) => {
    if (t.kind !== 'pglite') return ctx.skip('la membresía en mc_worker la decide TEST_DATABASE_URL');
    // El enlace de baja lo pulsó la persona: el worker lo procesa.
    await t.db.asWorker((tx) =>
      tx.query("INSERT INTO contact_suppression (email, reason) VALUES ($1, 'unsubscribe_link')", [VERIFICADO]),
    );
    for (const [ws, empresa] of [[WS_A, EMPRESA_A], [WS_B, EMPRESA_B]] as const) {
      const c = await guardar(ws, empresa, VERIFICADO);
      assert.equal(c?.opted_out, true, 'ningún creador de la plataforma lo vuelve a contactar (0007)');
      assert.match(String(c?.opted_out_reason), /baja de la plataforma/);
    }
  });

  test('la lista no acepta una baja sin procedencia verificable, ni siquiera del worker', async (ctx) => {
    if (t.kind !== 'pglite') return ctx.skip('la membresía en mc_worker la decide TEST_DATABASE_URL');
    await assert.rejects(
      t.db.asWorker((tx) =>
        tx.query("INSERT INTO contact_suppression (email, reason) VALUES ('alguien@marca-0029.co', 'opted_out')"),
      ),
      (err: unknown) => /contact_suppression_reason_check/.test(fullMessage(err)),
    );
  });

  test('y el correo que B marcó en su CRM no está en la lista: la llenó solo el worker', async (ctx) => {
    if (t.kind !== 'pglite') return ctx.skip('la membresía en mc_worker la decide TEST_DATABASE_URL');
    const { rows } = await t.db.asWorker((tx) =>
      tx.query<{ email: string }>("SELECT email::text AS email FROM contact_suppression WHERE email LIKE '%marca-0029.co' ORDER BY 1"),
    );
    assert.deepEqual(rows.map((r) => r.email), [VERIFICADO]);
  });

  test('la lista no la lee ni la escribe la aplicación: solo el worker y el disparador que la aplica', async () => {
    for (const sql of [
      'SELECT email FROM contact_suppression',
      "INSERT INTO contact_suppression (email, reason) VALUES ('alguien@x.co', 'unsubscribe_link')",
      'DELETE FROM contact_suppression',
    ]) {
      await assert.rejects(t.db.withWorkspace(WS_B, (tx) => tx.query(sql)), isPermissionDenied, sql);
    }
  });

  test('el disparador que escribía la lista ya no existe; el que la aplica no lo ejecuta mc_app', async () => {
    const { rows } = await t.db.withWorkspace(WS_B, (tx) =>
      tx.query<{ f: string; puede: boolean }>(
        `SELECT p.proname::text AS f, has_function_privilege('mc_app', p.oid, 'EXECUTE') AS puede
           FROM pg_proc p WHERE p.proname IN ('contact_suppression_record', 'contact_suppression_apply') ORDER BY 1`,
      ),
    );
    assert.deepEqual(rows, [{ f: 'contact_suppression_apply', puede: false }]);
  });
});

/**
 * Borrar un workspace es la operación del worker, y no puede publicar
 * nada (0029 §2). Con company.owner_workspace_id ON DELETE SET NULL, cada
 * empresa privada del inquilino borrado pasaba a owner NULL, que para
 * company_read es «catálogo compartido». Reproducido por los revisores:
 * C crea «Prospecto secreto de C», se borra C, y B lee la empresa.
 */
describe('borrar un workspace no publica su CRM (0029 §2)', () => {
  const WS_C = '0000029c-0000-4000-8000-000000000001';
  const SECRETO = '0000029c-0000-4000-8000-0000000000e1';
  const VIDEO = '0000029c-0000-4000-8000-0000000000a1';
  const ANALISIS = '0000029c-0000-4000-8000-0000000000a2';
  const POST_ANALIZADO = '0000029c-0000-4000-8000-0000000000a3';

  before(async () => {
    await t.admin(`INSERT INTO workspace (id, slug, name) VALUES ('${WS_C}', 'workspace-c-0029', 'Workspace C')`);
    await t.db.withWorkspace(WS_C, (tx) =>
      tx.query("INSERT INTO company (id, name) VALUES ($1, 'Prospecto secreto de C')", [SECRETO]),
    );
    // El post ajeno que C pidió analizar: con análisis, es de C.
    await t.admin(`
      INSERT INTO video_asset (id, workspace_id) VALUES ('${VIDEO}', '${WS_C}');
      INSERT INTO video_analysis (id, video_asset_id, workspace_id, analyzer_version)
        VALUES ('${ANALISIS}', '${VIDEO}', '${WS_C}', 'v1.0.0');
      INSERT INTO external_post (id, platform_id, external_post_id, analysis_id)
        VALUES ('${POST_ANALIZADO}', 'tiktok', 'ep-de-c-0029', '${ANALISIS}');
    `);
    const { rows } = await t.db.withWorkspace(WS_B, (tx) =>
      tx.query<{ n: number }>('SELECT count(*)::int AS n FROM company WHERE id = $1', [SECRETO]),
    );
    assert.equal(rows[0]?.n, 0, 'antes de borrar, B no la ve: la prueba mira lo que cambia al borrar');
  }, { timeout: 120_000 });

  test('se borra C (como el worker, sin RLS) y B no lee su empresa: se fue con él', async () => {
    await t.admin(`DELETE FROM workspace WHERE id = '${WS_C}'`);
    const deB = await t.db.withWorkspace(WS_B, (tx) =>
      tx.query<{ n: number }>('SELECT count(*)::int AS n FROM company WHERE id = $1', [SECRETO]),
    );
    assert.equal(deB.rows[0]?.n, 0, 'con SET NULL, el «Prospecto secreto de C» pasaba al catálogo de todos');
    const catalogo = await t.db.withCatalogs((tx) =>
      tx.query<{ n: number }>('SELECT count(*)::int AS n FROM company WHERE id = $1', [SECRETO]),
    );
    assert.equal(catalogo.rows[0]?.n, 0, 'ni siquiera sin workspace fijado');
  });

  test('y el post que C analizó no pasa a ser dato global del radar', async () => {
    const deB = await t.db.withWorkspace(WS_B, (tx) =>
      tx.query<{ n: number }>('SELECT count(*)::int AS n FROM external_post WHERE id = $1', [POST_ANALIZADO]),
    );
    assert.equal(deB.rows[0]?.n, 0, 'con SET NULL en analysis_id, el post de C quedaba a la vista de todos');
  });
});

/**
 * Una fila global no nombra una privada (0029 §3). brand_account_snapshot
 * sin campaña se leía desde cualquier workspace, con el company_id, el
 * handle y los seguidores de una empresa privada de otro; y un contacto
 * del catálogo de una empresa privada decía a todos que existe.
 */
describe('una fila global no nombra lo que quien lee no ve (0029 §3)', () => {
  const EMPRESA_DE_A = '0000029a-0000-4000-8000-0000000000e1';
  const EMPRESA_CATALOGO = '0000029a-0000-4000-8000-0000000000e2';

  before(async () => {
    await t.db.withWorkspace(WS_A, (tx) =>
      tx.query("INSERT INTO company (id, name) VALUES ($1, 'Café Alma privada de A')", [EMPRESA_DE_A]),
    );
    await t.admin(`
      INSERT INTO company (id, name) VALUES ('${EMPRESA_CATALOGO}', 'Marca del catálogo 0029');
      INSERT INTO brand_account_snapshot (campaign_id, company_id, platform_id, handle, day, followers) VALUES
        (NULL, '${EMPRESA_DE_A}', 'instagram', '@Café Alma', '2026-09-03', 5000),
        (NULL, '${EMPRESA_CATALOGO}', 'instagram', '@catalogo', '2026-09-03', 7000);
      INSERT INTO contact (company_id, owner_workspace_id, full_name, email, source) VALUES
        ('${EMPRESA_DE_A}', NULL, 'Prensa de la marca de A', 'prensa@cafe-alma-0029.co', 'press'),
        ('${EMPRESA_CATALOGO}', NULL, 'Prensa del catálogo', 'prensa@catalogo-0029.co', 'press');
    `);
  }, { timeout: 120_000 });

  test('B no lee los seguidores de la empresa privada de A; los del catálogo, sí', async () => {
    const { rows } = await t.db.withWorkspace(WS_B, (tx) =>
      tx.query<{ handle: string }>(
        'SELECT handle FROM brand_account_snapshot WHERE company_id = ANY ($1::uuid[]) ORDER BY 1',
        [[EMPRESA_DE_A, EMPRESA_CATALOGO]],
      ),
    );
    assert.deepEqual(rows.map((r) => r.handle), ['@catalogo'], 'desde B se leía «@Café Alma» con sus seguidores');
  });

  test('A sí los lee: la empresa es suya', async () => {
    const { rows } = await t.db.withWorkspace(WS_A, (tx) =>
      tx.query<{ n: number }>('SELECT count(*)::int AS n FROM brand_account_snapshot WHERE company_id = $1', [EMPRESA_DE_A]),
    );
    assert.equal(rows[0]?.n, 1);
  });

  test('un contacto del catálogo de una empresa privada de A no lo ve B; el de una del catálogo, sí', async () => {
    const { rows } = await t.db.withWorkspace(WS_B, (tx) =>
      tx.query<{ email: string }>(
        "SELECT email::text AS email FROM contact WHERE email LIKE '%-0029.co' AND owner_workspace_id IS NULL ORDER BY 1",
      ),
    );
    assert.deepEqual(rows.map((r) => r.email), ['prensa@catalogo-0029.co']);
  });
});

describe('las secuencias no cuentan lo de los demás (0026 §4)', () => {
  test('el guion de los revisores: last_value de una secuencia ya no se lee', async () => {
    // Desde B devolvía 360 en account_metric_snapshot_id_seq: el volumen
    // de TODA la plataforma.
    for (const seq of ['account_metric_snapshot_id_seq', 'audit_log_id_seq', 'api_call_log_id_seq']) {
      await assert.rejects(t.db.withWorkspace(WS_B, (tx) => tx.query(`SELECT last_value FROM ${seq}`)), isPermissionDenied, seq);
    }
  });

  test('ni setval, ni nextval en las secuencias de tablas que la aplicación no escribe', async () => {
    await assert.rejects(
      t.db.withWorkspace(WS_B, (tx) => tx.query("SELECT setval('audit_log_id_seq', 1)")),
      isPermissionDenied,
    );
    await assert.rejects(
      // post_retention_curve: métrica que solo escribe el worker. (Hasta
      // integrar RES-2 era post_metric_snapshot; ahora la web inserta ahí
      // las lecturas de un CSV y conserva USAGE, ver 0025 §5.)
      t.db.withWorkspace(WS_B, (tx) => tx.query("SELECT nextval('post_retention_curve_id_seq')")),
      isPermissionDenied,
    );
  });

  test('pero donde sí inserta, el DEFAULT sigue funcionando: USAGE basta', async () => {
    const { rows } = await t.db.withWorkspace(WS_B, (tx) =>
      tx.query<{ id: string }>(
        "INSERT INTO audit_log (workspace_id, action, entity_type) VALUES (current_workspace_id(), 'prueba.0026', 'test') RETURNING id::text AS id",
      ),
    );
    assert.ok(Number(rows[0]?.id) > 0);
  });
});

/**
 * La prueba que pidieron los revisores de la ronda 3: filas HEREDADAS.
 *
 * 0024 §4 añadió company.owner_workspace_id y dejó las empresas que ya
 * existían sin dueño, «porque desde una migración no se puede leer
 * company_link». En Supabase son 11, todas en el company_link de Laura.
 * Con 0024 + 0025 tal cual, esas 11 pasaban al catálogo compartido: un
 * workspace nuevo las leía, y Laura ya no podía editar ninguna.
 *
 * Aquí se reconstruye esa base: migrada hasta 0021 (lo que tiene
 * Supabase), con filas de la forma vieja; luego se aplican 0024 y 0025
 * —y se comprueba que el agujero EXISTE— y después 0026 —y se comprueba
 * que se cerró—. Si alguien quita el relleno de 0026, la segunda mitad
 * falla.
 */
describe('filas heredadas: las empresas que ya existen pasan a su workspace (0026 §1)', () => {
  const L = '0000026c-0000-4000-8000-00000000000a'; // «Laura»: la agencia con todo en company_link
  const M = '0000026c-0000-4000-8000-00000000000b'; // otra agencia, con una marca en común
  const N = '0000026c-0000-4000-8000-00000000000c'; // un workspace nuevo, sin nada
  const DE_L = '0000026c-0000-4000-8000-0000000000e1';
  const SOLO_DEAL_DE_M = '0000026c-0000-4000-8000-0000000000e2';
  const COMPARTIDA = '0000026c-0000-4000-8000-0000000000e3';
  const CATALOGO = '0000026c-0000-4000-8000-0000000000e4';
  const CONTACTO_PRIVADO = '0000026c-0000-4000-8000-0000000000c1';
  let viejo: EmbeddedDb | null = null;

  const nombres = (db: EmbeddedDb, ws: string) =>
    db
      .withWorkspace(ws, (tx) => tx.query<{ name: string }>('SELECT name FROM company ORDER BY name'))
      .then((r) => r.rows.map((x) => x.name));
  const editar = (db: EmbeddedDb, ws: string, id: string) =>
    db
      .withWorkspace(ws, (tx) => tx.query("UPDATE company SET legal_name = 'Editada' WHERE id = $1 RETURNING id", [id]))
      .then((r) => r.rows.length);

  before(async () => {
    if (t.kind !== 'pglite') return;
    // La base como está Supabase hoy: hasta 0022 (CON-10, de main), la
    // última aplicada antes del endurecimiento.
    viejo = await createEmbeddedDb({ hasta: '0022_public_profile_access.sql' });
    await viejo.execAsSuperuser(`
      INSERT INTO workspace (id, slug, name) VALUES
        ('${L}', 'l-0026', 'Laura'), ('${M}', 'm-0026', 'Otra agencia'), ('${N}', 'n-0026', 'Nuevo');
      INSERT INTO company (id, name, domain) VALUES
        ('${DE_L}', 'Marca de Laura', 'marca-de-laura.co'),
        ('${SOLO_DEAL_DE_M}', 'Marca con deal de M', NULL),
        ('${COMPARTIDA}', 'Marca Compartida', 'compartida.co'),
        ('${CATALOGO}', 'Marca del Catálogo', 'catalogo-0026.co');
      INSERT INTO company_link (workspace_id, company_id) VALUES
        ('${L}', '${DE_L}'), ('${L}', '${COMPARTIDA}'), ('${M}', '${COMPARTIDA}');
      INSERT INTO deal (workspace_id, company_id, name, stage_id) VALUES
        ('${M}', '${SOLO_DEAL_DE_M}', 'Deal sin vínculo', 'nuevo'),
        ('${M}', '${COMPARTIDA}', 'Deal de M con la compartida', 'nuevo'),
        ('${L}', '${COMPARTIDA}', 'Deal de L con la compartida', 'nuevo');
      -- Un contacto privado anterior a 0020: sin dueño.
      INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source) VALUES
        ('${CONTACTO_PRIVADO}', '${DE_L}', NULL, 'Persona de Laura', 'persona@marca-de-laura.co', 'user_provided');
    `);
  }, { timeout: 180_000 });

  after(async () => {
    await viejo?.close();
  });

  test('con 0024 y 0025 tal cual, el agujero existe: el workspace nuevo lee las marcas de Laura y Laura no las edita', async (ctx) => {
    if (!viejo) return ctx.skip('reconstruir una base a medio migrar solo se puede sobre pglite');
    assert.deepEqual(await viejo.migrar('0025_referencias_visibles.sql'), [
      '0024_aislamiento_por_defecto.sql',
      '0025_referencias_visibles.sql',
    ]);
    assert.ok((await nombres(viejo, N)).includes('Marca de Laura'), 'sin dueño = catálogo: la ve cualquiera');
    assert.equal(await editar(viejo, L, DE_L), 0, 'y Laura ya no puede editar su propia marca');
  });

  test('con 0026, cada empresa es de quien la trabaja, y el nuevo solo ve el catálogo', async (ctx) => {
    if (!viejo) return ctx.skip('reconstruir una base a medio migrar solo se puede sobre pglite');
    const forzadasAntes = await viejo.queryAsSuperuser<{ relname: string }>(
      "SELECT relname::text AS relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relforcerowsecurity ORDER BY 1",
    );
    assert.deepEqual(await viejo.migrar('0026_duenos_unicos_secuencias.sql'), ['0026_duenos_unicos_secuencias.sql']);

    assert.deepEqual(await nombres(viejo, N), ['Marca del Catálogo'], 'lo que nadie nombra se queda en el catálogo');
    assert.deepEqual(await nombres(viejo, L), ['Marca Compartida', 'Marca de Laura', 'Marca del Catálogo']);
    assert.deepEqual(await nombres(viejo, M), ['Marca Compartida', 'Marca con deal de M', 'Marca del Catálogo']);
    assert.equal(await editar(viejo, L, DE_L), 1, 'Laura vuelve a editar lo suyo');
    assert.equal(await editar(viejo, M, SOLO_DEAL_DE_M), 1, 'un deal también es un voto, aunque no haya vínculo');
    assert.equal(await editar(viejo, L, CATALOGO), 0, 'el catálogo no lo edita nadie desde un workspace');

    // La compartida: la original para uno, una copia para el otro, y las
    // filas de cada uno apuntan a SU ficha.
    const fichas = await viejo.queryAsSuperuser<{ id: string; owner: string }>(
      "SELECT id::text AS id, owner_workspace_id::text AS owner FROM company WHERE name = 'Marca Compartida' ORDER BY owner_workspace_id",
    );
    assert.deepEqual(fichas.rows.map((f) => f.owner), [L, M], 'una ficha por workspace');
    assert.equal(fichas.rows[0]!.id, COMPARTIDA, 'la original, para el primero por id');
    const copiaDeM = fichas.rows[1]!.id;
    const apuntan = await viejo.queryAsSuperuser<{ tabla: string; ws: string; company: string }>(`
      SELECT 'link' AS tabla, workspace_id::text AS ws, company_id::text AS company
        FROM company_link WHERE company_id IN ('${COMPARTIDA}', '${copiaDeM}')
      UNION ALL
      SELECT 'deal', workspace_id::text, company_id::text
        FROM deal WHERE company_id IN ('${COMPARTIDA}', '${copiaDeM}')
      ORDER BY 1, 2`);
    assert.deepEqual(apuntan.rows, [
      { tabla: 'deal', ws: L, company: COMPARTIDA },
      { tabla: 'deal', ws: M, company: copiaDeM },
      { tabla: 'link', ws: L, company: COMPARTIDA },
      { tabla: 'link', ws: M, company: copiaDeM },
    ]);

    // El contacto privado sin dueño pasa al dueño de su empresa: desde
    // 0025 §6 no lo veía NADIE, ni Laura.
    const suyo = await viejo.withWorkspace(L, (tx) =>
      tx.query<{ n: number }>('SELECT count(*)::int AS n FROM contact WHERE id = $1', [CONTACTO_PRIVADO]),
    );
    assert.equal(suyo.rows[0]?.n, 1);

    // Y el FORCE que el relleno quitó para leer, vuelve: a las mismas.
    const forzadasDespues = await viejo.queryAsSuperuser<{ relname: string }>(
      "SELECT relname::text AS relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relforcerowsecurity ORDER BY 1",
    );
    assert.deepEqual(forzadasDespues.rows, forzadasAntes.rows);
  });
});
