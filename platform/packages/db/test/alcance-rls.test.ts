/**
 * ACC-7 · El alcance por creador también en la base (0082).
 *
 * Las pruebas de ACC-6 (alcance-campanas, alcance-finanzas,
 * alcance-conexiones) demuestran que CADA función exportada compone
 * scopeFilter(). Esta demuestra lo que pasa cuando alguien NO lo compone:
 * una consulta cruda sobre social_connection, post, campaign o deal, como
 * el miembro con alcance a Laura, no devuelve nada de Sofía; la dueña lo
 * sigue viendo todo; y la guardia del esquema reporta la tabla si se le
 * quita la política.
 *
 * Escenario: el de ACC-6 (test/alcance.ts: Laura y Sofía en el workspace
 * de Laura, la dueña sin alcance, el miembro con alcance a Laura), más un
 * negocio de Sofía, y una agencia pequeña con dos creadores para los
 * roles que ven a todos (Administrador) y los que no (Ejecutivo).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  CUERPOS_DEL_ALCANCE, estadoDelEsquema, explicarEsquema, TABLAS_CON_ALCANCE_POR_CREADOR, TABLAS_CON_CREADOR_SIN_POLITICA,
} from '../src/esquema.ts';
import type { SqlExecutor, WorkspaceTx } from '../src/client.ts';
import { findPgError, withSavepoint } from '../src/pg-error.ts';
import { listCampaigns } from '../src/queries/campanas.ts';
import { reclassifyInboxMessage } from '../src/queries/bandejas.ts';
import { applyIntent, loadIntentMessage } from '../src/queries/outreach/intent.ts';
import {
  acceptSignal, createDeal, createSignal, hasOpenDealOutOfScope, listDealCreatorOptions, listPipeline, listSignals, setDealCreator, VentasError,
} from '../src/queries/ventas.ts';
import { CREATOR_SCOPE_TABLES, ScopeError, scopeErrorOf, soleCreatorFor, writeOrScopeError, type ScopeSavepoint } from '../src/scope.ts';
import { migratorRole, openTestDb, SETUP_TIMEOUT, WORKSPACE_LAURA, COMPANY_CAFE_ALMA, type TestDb } from './pglite.ts';
import { DESCRIBE_DB_TIMEOUT_MS } from './tiempos.ts';
import {
  CAMPAIGN_SOFIA, CONEXION_SOFIA, CREATOR_LAURA, CREATOR_SOFIA, EMPRESA_SOFIA, POST_SOFIA, sembrarAlcance, USER_LAURA, USER_MIEMBRO,
  USER_MIEMBRO_MARCA,
} from './alcance.ts';

const DEAL_SOFIA = '0000000a-0000-4000-8000-0000000dea01';
/** Un negocio de Sofía con su cotización enviada, para aceptarla por el enlace público. */
const DEAL_SOFIA_ENLACE = '0000000a-0000-4000-8000-0000000dea02';
const QUOTE_SOFIA_ENLACE = '0000000a-0000-4000-8000-0000c0700002';
const SLUG_SOFIA_ENLACE = 'cot-sofia-acc7';

// La agencia: dos creadores, una dueña y una administradora (que no
// pueden llevar alcance, 0082 §2) y un ejecutivo acotado a A.
const WS_AGENCIA = '0000000c-0000-4000-8000-000000000001';
const CREADOR_A = '0000000c-0000-4000-8000-0000000000a3';
const CREADOR_B = '0000000c-0000-4000-8000-0000000000b3';
const MARCA_AGENCIA = '0000000c-0000-4000-8000-0000000000e1';
const CAMPANA_A = '0000000c-0000-4000-8000-000000ca000a';
const CAMPANA_B = '0000000c-0000-4000-8000-000000ca000b';
const DUENA_AGENCIA = '0000000c-0000-4000-8000-000000000002';
const ADMIN_AGENCIA = '0000000c-0000-4000-8000-000000000012';
const EJECUTIVO_A = '0000000c-0000-4000-8000-000000000022';

/** La migración, para volver a crear la política tal cual después de quitarla. */
const MIGRACION = fileURLToPath(new URL('../../../db/migrations/0082_alcance_por_creador.sql', import.meta.url));
/** La de scope_allows(), para devolverla a su sitio después de la sonda. */
const MIGRACION_0040 = fileURLToPath(new URL('../../../db/migrations/0040_scope_allows.sql', import.meta.url));

/** Las cuatro tablas, con un id de Sofía en cada una. */
const DE_SOFIA: Readonly<Record<string, string>> = {
  social_connection: CONEXION_SOFIA,
  post: POST_SOFIA,
  campaign: CAMPAIGN_SOFIA,
  deal: DEAL_SOFIA,
};

let t: TestDb;
const como = <T>(ws: string, userId: string | undefined, fn: (tx: WorkspaceTx) => Promise<T>) =>
  t.db.withWorkspace(ws, fn, userId ? { userId } : {});
const miembro = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => como(WORKSPACE_LAURA, USER_MIEMBRO, fn);
const duena = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => como(WORKSPACE_LAURA, USER_LAURA, fn);

/** Una consulta CRUDA, sin scopeFilter(): lo que escribiría alguien que se olvida del alcance. */
const crudas = (tx: WorkspaceTx, tabla: string) =>
  tx.query<{ id: string; creator_id: string | null }>(`SELECT id, creator_id FROM ${tabla} ORDER BY id`).then((r) => r.rows);

before(async () => {
  t = await openTestDb();
  await sembrarAlcance(t);
  await t.admin(`
    INSERT INTO deal (id, workspace_id, company_id, creator_id, name, stage_id, amount, currency)
    VALUES ('${DEAL_SOFIA}', '${WORKSPACE_LAURA}', '${EMPRESA_SOFIA}', '${CREATOR_SOFIA}', 'Playa 2027 con Marca de Sofía', 'nuevo', 3000000.00, 'COP'),
           ('${DEAL_SOFIA_ENLACE}', '${WORKSPACE_LAURA}', '${EMPRESA_SOFIA}', '${CREATOR_SOFIA}', 'Montaña con Marca de Sofía', 'propuesta', 1000000.00, 'COP')
    ON CONFLICT DO NOTHING;
    INSERT INTO quote (id, workspace_id, company_id, creator_id, deal_id, number, slug, currency, subtotal, tax, total,
                       agreed_metrics, report_cuts_hours, payment_terms_days, status, sent_at, public_snapshot)
    VALUES ('${QUOTE_SOFIA_ENLACE}', '${WORKSPACE_LAURA}', '${EMPRESA_SOFIA}', '${CREATOR_SOFIA}', '${DEAL_SOFIA_ENLACE}', 'COT-2026-907',
            '${SLUG_SOFIA_ENLACE}', 'COP', 1000000.00, 190000.00, 1190000.00, '{views}', '{168}', 30, 'sent', now(),
            '{"timezone": "America/Bogota"}')
    ON CONFLICT DO NOTHING;

    INSERT INTO workspace (id, slug, name, kind) VALUES ('${WS_AGENCIA}', 'acc7-agencia', 'Agencia ACC-7', 'agency') ON CONFLICT DO NOTHING;
    INSERT INTO app_user (id, email) VALUES
      ('${DUENA_AGENCIA}', 'duena.acc7@ejemplo.com'), ('${ADMIN_AGENCIA}', 'admin.acc7@ejemplo.com'), ('${EJECUTIVO_A}', 'ejecutivo.acc7@ejemplo.com')
    ON CONFLICT DO NOTHING;
    INSERT INTO membership (workspace_id, user_id, role_id) VALUES
      ('${WS_AGENCIA}', '${DUENA_AGENCIA}', system_role_id('agency', 'owner')),
      ('${WS_AGENCIA}', '${ADMIN_AGENCIA}', system_role_id('agency', 'admin')),
      ('${WS_AGENCIA}', '${EJECUTIVO_A}', system_role_id('agency', 'manager'))
    ON CONFLICT DO NOTHING;
    INSERT INTO creator_profile (id, workspace_id, display_name, country, languages, niche_slugs) VALUES
      ('${CREADOR_A}', '${WS_AGENCIA}', 'Creador A', 'CO', '{es}', '{cocina}'),
      ('${CREADOR_B}', '${WS_AGENCIA}', 'Creadora B', 'MX', '{es}', '{viajes}')
    ON CONFLICT DO NOTHING;
    INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id) VALUES
      ('${WS_AGENCIA}', '${EJECUTIVO_A}', 'creator', '${CREADOR_A}')
    ON CONFLICT DO NOTHING;
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${MARCA_AGENCIA}', 'Marca de la agencia', '${WS_AGENCIA}') ON CONFLICT DO NOTHING;
    INSERT INTO company_link (workspace_id, company_id, relationship) VALUES ('${WS_AGENCIA}', '${MARCA_AGENCIA}', 'client') ON CONFLICT DO NOTHING;
    INSERT INTO campaign (id, workspace_id, company_id, creator_id, name, status) VALUES
      ('${CAMPANA_A}', '${WS_AGENCIA}', '${MARCA_AGENCIA}', '${CREADOR_A}', 'Campaña de A', 'planned'),
      ('${CAMPANA_B}', '${WS_AGENCIA}', '${MARCA_AGENCIA}', '${CREADOR_B}', 'Campaña de B', 'planned')
    ON CONFLICT DO NOTHING;
  `);
}, SETUP_TIMEOUT);

after(async () => {
  await t.close();
});

/** El 42501 con el que la política por creador rechaza una fila nueva, y que @mc/db traduce a ScopeError. */
const rechazoDeRls = (err: unknown) => findPgError(err, '42501') !== null && scopeErrorOf(err) instanceof ScopeError;

describe('una consulta cruda, sin scopeFilter(), sobre las cuatro tablas', { timeout: DESCRIBE_DB_TIMEOUT_MS }, () => {
  test('las cuatro son exactamente las de la guardia y las de scope.ts', () => {
    assert.deepEqual(Object.keys(DE_SOFIA).sort(), Object.keys(TABLAS_CON_ALCANCE_POR_CREADOR).sort());
    assert.deepEqual([...CREATOR_SCOPE_TABLES].sort(), Object.keys(TABLAS_CON_ALCANCE_POR_CREADOR).sort());
  });

  for (const [tabla, idSofia] of Object.entries(DE_SOFIA)) {
    test(`${tabla}: el miembro con alcance a Laura no recibe ninguna fila de Sofía, y sí las de Laura`, async () => {
      const filas = await miembro((tx) => crudas(tx, tabla));
      assert.ok(filas.length > 0, `el miembro ve las de Laura en ${tabla}: la política no vacía la tabla`);
      assert.deepEqual(filas.filter((f) => f.creator_id !== CREATOR_LAURA), [], 'solo filas de Laura, y ninguna sin creador');
      const porId = await miembro((tx) => tx.query(`SELECT 1 FROM ${tabla} WHERE id = $1`, [idSofia]));
      assert.equal(porId.rows.length, 0, 'ni pidiéndola por su id, que es lo que haría una ficha');
      const contadas = await miembro((tx) =>
        tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tabla} WHERE creator_id = $1`, [CREATOR_SOFIA]));
      assert.equal(contadas.rows[0]?.n, 0, 'ni en un conteo');
    });

    test(`${tabla}: la dueña lo sigue viendo todo, y sin persona (modo demo) también`, async () => {
      const deLaDuena = await duena((tx) => crudas(tx, tabla));
      assert.ok(deLaDuena.some((f) => f.id === idSofia), `la dueña ve la fila de Sofía en ${tabla}`);
      const delMiembro = await miembro((tx) => crudas(tx, tabla));
      assert.deepEqual(
        deLaDuena.filter((f) => f.creator_id === CREATOR_LAURA),
        delMiembro,
        'lo de Laura es lo mismo para las dos: el miembro solo pierde lo de los otros creadores',
      );
      assert.deepEqual(await como(WORKSPACE_LAURA, undefined, (tx) => crudas(tx, tabla)), deLaDuena);
    });
  }

  test('lo que dice la guardia que cubre, y lo que dice que NO (ACC-10), es verdad', async () => {
    await t.admin(`
      INSERT INTO deal_stage_history (deal_id, from_stage_id, to_stage_id) VALUES ('${DEAL_SOFIA}', NULL, 'nuevo');
      INSERT INTO post_metric_snapshot (workspace_id, post_id, captured_at, age_hours, views)
      VALUES ('${WORKSPACE_LAURA}', '${POST_SOFIA}', now() - interval '1 hour', 24, 1234);
    `);
    const visto = await miembro(async (tx) => {
      const n = async (sql: string, params: unknown[]) => Number((await tx.query<{ n: number }>(sql, params)).rows[0]?.n);
      return {
        historial: await n('SELECT count(*)::int AS n FROM deal_stage_history WHERE deal_id = $1', [DEAL_SOFIA]),
        pipeline: await n('SELECT count(*)::int AS n FROM deal_pipeline WHERE id = $1', [DEAL_SOFIA]),
        metricas: await n('SELECT count(*)::int AS n FROM post_metric_snapshot WHERE post_id = $1', [POST_SOFIA]),
        cotizacion: await n('SELECT count(*)::int AS n FROM quote WHERE creator_id = $1', [CREATOR_SOFIA]),
      };
    });
    assert.equal(visto.historial, 0, 'deal_stage_history hereda por su EXISTS sobre deal');
    assert.equal(visto.pipeline, 0, 'deal_pipeline hereda: es una vista con security_invoker sobre deal');
    // Lo que NO cubre, como dicen TABLAS_CON_ALCANCE_POR_CREADOR y la
    // cabecera de 0082. El día que ACC-10 lo cierre, esta prueba falla y
    // se da la vuelta.
    assert.ok(visto.metricas > 0, 'post_metric_snapshot solo tiene política de workspace (ACC-10)');
    assert.ok(visto.cotizacion > 0, 'quote no está en la red (TABLAS_CON_CREADOR_SIN_POLITICA, ACC-10)');
    assert.ok('quote' in TABLAS_CON_CREADOR_SIN_POLITICA && 'data_consent' in TABLAS_CON_CREADOR_SIN_POLITICA);
  });

  test('lo que se lee a través de ellas hereda el filtro: vistas y JOIN', async () => {
    const leido = await miembro(async (tx) => ({
      tablero: (await tx.query<{ creator_id: string }>('SELECT creator_id FROM creator_post_board')).rows,
      salud: (await tx.query<{ creator_id: string }>('SELECT creator_id FROM connection_health')).rows,
      asociados: (await tx.query<{ id: string }>(
        'SELECT p.id FROM campaign_post cp JOIN post p ON p.id = cp.post_id JOIN campaign c ON c.id = cp.campaign_id',
      )).rows,
    }));
    assert.ok(leido.tablero.length > 0 && leido.salud.length > 0, 'las vistas no salen vacías');
    assert.deepEqual([...leido.tablero, ...leido.salud].filter((r) => r.creator_id !== CREATOR_LAURA), []);
    assert.ok(leido.asociados.length > 0);
    assert.equal(leido.asociados.some((r) => r.id === POST_SOFIA), false);
  });
});

describe('escribir sin scopeFilter(): la misma condición vale para la fila nueva', { timeout: DESCRIBE_DB_TIMEOUT_MS }, () => {
  test('el miembro no crea una campaña ni un negocio a nombre de Sofía', async () => {
    await assert.rejects(
      miembro((tx) => tx.query(
        `INSERT INTO campaign (workspace_id, company_id, creator_id, name, status)
         VALUES (current_workspace_id(), $1, $2, 'Colada', 'planned')`,
        [COMPANY_CAFE_ALMA, CREATOR_SOFIA],
      )),
      rechazoDeRls,
    );
    await assert.rejects(
      miembro((tx) => tx.query(
        `INSERT INTO deal (workspace_id, company_id, creator_id, name, stage_id) VALUES (current_workspace_id(), $1, $2, 'Colado', 'nuevo')`,
        [COMPANY_CAFE_ALMA, CREATOR_SOFIA],
      )),
      rechazoDeRls,
    );
  });

  test('el miembro no pasa una fila de Laura a Sofía, ni toca ni borra las de Sofía', async () => {
    await assert.rejects(
      miembro((tx) => tx.query('UPDATE campaign SET creator_id = $1 WHERE creator_id = $2', [CREATOR_SOFIA, CREATOR_LAURA])),
      rechazoDeRls,
    );
    const tocadas = await miembro(async (tx) => ({
      campana: (await tx.query("UPDATE campaign SET name = 'Tocada' WHERE id = $1 RETURNING id", [CAMPAIGN_SOFIA])).rows.length,
      cuenta: (await tx.query("UPDATE social_connection SET status = 'disabled' WHERE id = $1 RETURNING id", [CONEXION_SOFIA])).rows.length,
      post: (await tx.query('DELETE FROM post WHERE id = $1 RETURNING id', [POST_SOFIA])).rows.length,
      negocio: (await tx.query('DELETE FROM deal WHERE id = $1 RETURNING id', [DEAL_SOFIA])).rows.length,
    }));
    assert.deepEqual(tocadas, { campana: 0, cuenta: 0, post: 0, negocio: 0 });
    const siguen = await duena(async (tx) => (await tx.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM campaign WHERE id = $1 AND name <> 'Tocada')
            + (SELECT count(*) FROM social_connection WHERE id = $2 AND status = 'active')
            + (SELECT count(*) FROM post WHERE id = $3)
            + (SELECT count(*) FROM deal WHERE id = $4) AS n`,
      [CAMPAIGN_SOFIA, CONEXION_SOFIA, POST_SOFIA, DEAL_SOFIA],
    )).rows[0]?.n);
    assert.equal(Number(siguen), 4, 'las cuatro filas de Sofía siguen intactas');
  });
});

describe('los roles que ven a todos los creadores, y los que no', { timeout: DESCRIBE_DB_TIMEOUT_MS }, () => {
  const campanasDe = (userId: string) =>
    como(WS_AGENCIA, userId, (tx) => tx.query<{ id: string }>('SELECT id FROM campaign ORDER BY id').then((r) => r.rows.map((x) => x.id)));
  const veTodos = (ws: string, userId: string) =>
    como(ws, userId, (tx) => tx.query<{ v: boolean }>('SELECT session_sees_all_creators() AS v').then((r) => r.rows[0]?.v));

  test('en una agencia: la dueña y la administradora ven a los dos creadores, el ejecutivo acotado solo al suyo', async () => {
    assert.deepEqual(await campanasDe(DUENA_AGENCIA), [CAMPANA_A, CAMPANA_B]);
    assert.deepEqual(await campanasDe(ADMIN_AGENCIA), [CAMPANA_A, CAMPANA_B]);
    assert.deepEqual(await campanasDe(EJECUTIVO_A), [CAMPANA_A]);
    assert.deepEqual(
      [await veTodos(WS_AGENCIA, DUENA_AGENCIA), await veTodos(WS_AGENCIA, ADMIN_AGENCIA), await veTodos(WS_AGENCIA, EJECUTIVO_A)],
      [true, true, false],
    );
  });

  test('una sola regla: para la misma persona, listCampaigns() (scopeFilter) y el SELECT crudo (la política) dan los mismos ids', async () => {
    const personas: ReadonlyArray<readonly [string, string, string]> = [
      ['la dueña de la agencia', WS_AGENCIA, DUENA_AGENCIA],
      ['la administradora de la agencia', WS_AGENCIA, ADMIN_AGENCIA],
      ['el ejecutivo acotado a A', WS_AGENCIA, EJECUTIVO_A],
      ['la dueña de un espacio de creador', WORKSPACE_LAURA, USER_LAURA],
      ['el miembro acotado a Laura', WORKSPACE_LAURA, USER_MIEMBRO],
    ];
    for (const [quien, ws, userId] of personas) {
      const { lista, cruda, acotada } = await como(ws, userId, async (tx) => ({
        lista: (await listCampaigns(tx)).map((c) => c.id).sort(),
        cruda: (await tx.query<{ id: string }>('SELECT id FROM campaign')).rows.map((r) => r.id).sort(),
        acotada: (await tx.query<{ a: boolean }>('SELECT NOT session_sees_all_creators() AS a')).rows[0]?.a,
      }));
      assert.ok(lista.length > 0, quien);
      assert.deepEqual(lista, cruda, `${quien}: la aplicación y la base no dicen lo mismo`);
      const tieneAlcance = await como(ws, userId, (tx) =>
        tx.query<{ v: boolean }>('SELECT session_has_scope() AS v').then((r) => r.rows[0]?.v));
      assert.equal(tieneAlcance, acotada, `${quien}: session_has_scope() (Equipo) y la política la ven igual`);
    }
  });

  test('Dueño y Administrador no llevan alcance: la base rechaza la fila, y el cambio de rol de quien lo tiene', async () => {
    const esRolCompleto = (err: unknown) => findPgError(err, '23514', 'membership_full_role_unscoped') !== null;
    for (const [ws, userId, creador] of [
      [WORKSPACE_LAURA, USER_LAURA, CREATOR_LAURA],
      [WS_AGENCIA, DUENA_AGENCIA, CREADOR_A],
      [WS_AGENCIA, ADMIN_AGENCIA, CREADOR_A],
    ] as const) {
      await assert.rejects(
        t.admin(`INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id) VALUES ('${ws}', '${userId}', 'creator', '${creador}')`),
        esRolCompleto,
      );
      await assert.rejects(
        t.admin(`INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id) VALUES ('${ws}', '${userId}', 'company', '${MARCA_AGENCIA}')`),
        esRolCompleto,
        'ningún tipo de alcance: Dueño y Administrador ven el espacio entero',
      );
    }
    // El ejecutivo acotado no pasa a Administrador sin que antes se le quite el alcance…
    await assert.rejects(
      t.admin(`UPDATE membership SET role_id = system_role_id('agency', 'admin') WHERE workspace_id = '${WS_AGENCIA}' AND user_id = '${EJECUTIVO_A}'`),
      esRolCompleto,
    );
    // …ni la fila de alcance se mueve a la administradora.
    await assert.rejects(
      t.admin(`UPDATE membership_scope SET user_id = '${ADMIN_AGENCIA}' WHERE workspace_id = '${WS_AGENCIA}' AND user_id = '${EJECUTIVO_A}'`),
      esRolCompleto,
    );
    // A un rol que no ve todo, sí: el ejecutivo pasa a Solo lectura con su alcance.
    await t.admin(`UPDATE membership SET role_id = system_role_id('agency', 'viewer') WHERE workspace_id = '${WS_AGENCIA}' AND user_id = '${EJECUTIVO_A}'`);
    await t.admin(`UPDATE membership SET role_id = system_role_id('agency', 'manager') WHERE workspace_id = '${WS_AGENCIA}' AND user_id = '${EJECUTIVO_A}'`);
    assert.deepEqual(await campanasDe(EJECUTIVO_A), [CAMPANA_A]);
  });

  test('una fila de alcance cuya membresía la transacción no ve se rechaza (fallar cerrado)', async () => {
    await assert.rejects(
      t.admin(`SET ROLE ${migratorRole(t)};
               INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id)
               VALUES ('${WS_AGENCIA}', '${EJECUTIVO_A}', 'creator', '${CREADOR_B}');`),
      (err: unknown) => findPgError(err, '23514', 'membership_full_role_unscoped') !== null,
    ).finally(() => t.admin('RESET ROLE'));
    assert.deepEqual(await campanasDe(EJECUTIVO_A), [CAMPANA_A], 'el ejecutivo sigue acotado solo a A');
  });

  test('un alcance por marca no es un alcance por creador: la base no lo acota (eso sigue siendo de scopeFilter())', async () => {
    assert.equal(await veTodos(WORKSPACE_LAURA, USER_MIEMBRO_MARCA), true);
    const filas = await como(WORKSPACE_LAURA, USER_MIEMBRO_MARCA, (tx) => crudas(tx, 'campaign'));
    assert.ok(filas.some((f) => f.id === CAMPAIGN_SOFIA) && filas.some((f) => f.creator_id === CREATOR_LAURA));
  });

  test('una persona de otro espacio no gana nada: la tenencia sigue antes que el alcance', async () => {
    const desdeLaAgencia = await como(WS_AGENCIA, DUENA_AGENCIA, (tx) => crudas(tx, 'campaign'));
    assert.equal(desdeLaAgencia.some((f) => f.id === CAMPAIGN_SOFIA), false);
  });
});

describe('Ventas con la red puesta: los negocios nacen con su creador', { timeout: DESCRIBE_DB_TIMEOUT_MS }, () => {
  const ejecutivo = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => como(WS_AGENCIA, EJECUTIVO_A, fn);
  /** El creador del negocio, leído por el worker (sin política): lo que quedó escrito, lo vea quien lo vea. */
  const creadorDe = (dealId: string) =>
    t.db.asWorker((tx) => tx.query<{ creator_id: string | null }>('SELECT creator_id FROM deal WHERE id = $1', [dealId]))
      .then((r) => r.rows[0]?.creator_id ?? null);

  test('el ejecutivo acotado abre un negocio en Ventas y lo ve', async () => {
    const opciones = await ejecutivo((tx) => listDealCreatorOptions(tx));
    assert.deepEqual(opciones, { creators: [{ id: CREADOR_A, name: 'Creador A' }], required: false, seesAll: false }, 'solo el suyo, y no se pregunta');
    const id = await ejecutivo((tx) => createDeal(tx, { companyId: MARCA_AGENCIA, name: 'Serie de A', amount: '500000' }));
    assert.equal(await creadorDe(id), CREADOR_A, 'nace a nombre del único creador de su alcance');
    const pipeline = await ejecutivo((tx) => listPipeline(tx, { companyId: MARCA_AGENCIA }));
    assert.ok(pipeline.some((d) => d.id === id), 'y lo ve en el pipeline');
  });

  test('el ejecutivo acepta una señal del radar y el negocio es de su creador', async () => {
    const senal = await ejecutivo((tx) => createSignal(tx, { companyName: 'Marca del radar ACC-7', domain: 'radar-acc7.co', headlineEs: 'Lanza una línea nueva' }));
    assert.ok(senal.id);
    const r = await ejecutivo((tx) => acceptSignal(tx, senal.id!));
    assert.equal(r.dealCreated, true);
    assert.equal(await creadorDe(r.dealId), CREADOR_A);
  });

  test('con dos creadores en su alcance tiene que elegir, y no puede elegir uno de fuera', async () => {
    const CREADOR_C = '0000000c-0000-4000-8000-0000000000c3';
    await t.admin(`
      INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${CREADOR_C}', '${WS_AGENCIA}', 'Creadora C') ON CONFLICT DO NOTHING;
      INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id) VALUES ('${WS_AGENCIA}', '${EJECUTIVO_A}', 'creator', '${CREADOR_C}');
    `);
    try {
      const opciones = await ejecutivo((tx) => listDealCreatorOptions(tx));
      assert.deepEqual(opciones.creators.map((c) => c.id), [CREADOR_A, CREADOR_C]);
      assert.equal(opciones.required, true);
      await assert.rejects(
        ejecutivo((tx) => createDeal(tx, { companyId: MARCA_AGENCIA, name: 'Sin elegir' })),
        (e: unknown) => e instanceof VentasError && e.code === 'DealCreatorRequired',
      );
      await assert.rejects(ejecutivo((tx) => createDeal(tx, { companyId: MARCA_AGENCIA, name: 'De B', creatorId: CREADOR_B })), ScopeError);
      await assert.rejects(
        ejecutivo((tx) => createDeal(tx, { companyId: MARCA_AGENCIA, name: 'De nadie', creatorId: '0000000c-0000-4000-8000-00000000dead' })),
        (e: unknown) => e instanceof VentasError && e.code === 'InvalidCreator',
      );
      const id = await ejecutivo((tx) => createDeal(tx, { companyId: MARCA_AGENCIA, name: 'De C', creatorId: CREADOR_C }));
      assert.equal(await creadorDe(id), CREADOR_C);
    } finally {
      await t.admin(`DELETE FROM membership_scope WHERE user_id = '${EJECUTIVO_A}' AND scope_id = '${CREADOR_C}'`);
    }
  });

  test('quien ve a todos con varios creadores puede dejarlo sin creador, como hasta hoy; con uno solo, es ese', async () => {
    const opciones = await como(WS_AGENCIA, DUENA_AGENCIA, (tx) => listDealCreatorOptions(tx));
    assert.equal(opciones.required, false);
    assert.ok(opciones.creators.length >= 2);
    const sinCreador = await como(WS_AGENCIA, DUENA_AGENCIA, (tx) => createDeal(tx, { companyId: MARCA_AGENCIA, name: 'De la agencia' }));
    assert.equal(await creadorDe(sinCreador), null);
    const deB = await como(WS_AGENCIA, DUENA_AGENCIA, (tx) => createDeal(tx, { companyId: MARCA_AGENCIA, name: 'De B', creatorId: CREADOR_B }));
    assert.equal(await creadorDe(deB), CREADOR_B);
    // El ejecutivo no ve ninguno de los dos: uno es de nadie y el otro de B.
    const suyos = (await ejecutivo((tx) => listPipeline(tx, { companyId: MARCA_AGENCIA }))).map((d) => d.id);
    assert.equal(suyos.includes(sinCreador) || suyos.includes(deB), false);
  });

  test('en un espacio de creador con una sola creadora, el negocio es suyo sin preguntar', async () => {
    const WS_UNA = '0000000d-0000-4000-8000-000000000001';
    const DUENA_UNA = '0000000d-0000-4000-8000-000000000002';
    const CREADORA_UNA = '0000000d-0000-4000-8000-000000000003';
    const MARCA_UNA = '0000000d-0000-4000-8000-0000000000e1';
    await t.admin(`
      INSERT INTO workspace (id, slug, name, kind) VALUES ('${WS_UNA}', 'acc7-una', 'Una creadora', 'creator') ON CONFLICT DO NOTHING;
      INSERT INTO app_user (id, email) VALUES ('${DUENA_UNA}', 'una.acc7@ejemplo.com') ON CONFLICT DO NOTHING;
      INSERT INTO membership (workspace_id, user_id, role_id) VALUES ('${WS_UNA}', '${DUENA_UNA}', system_role_id('creator', 'owner')) ON CONFLICT DO NOTHING;
      INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${CREADORA_UNA}', '${WS_UNA}', 'Una') ON CONFLICT DO NOTHING;
      INSERT INTO company (id, name, owner_workspace_id) VALUES ('${MARCA_UNA}', 'Marca de Una', '${WS_UNA}') ON CONFLICT DO NOTHING;
      INSERT INTO company_link (workspace_id, company_id, relationship) VALUES ('${WS_UNA}', '${MARCA_UNA}', 'prospect') ON CONFLICT DO NOTHING;
    `);
    const opciones = await como(WS_UNA, DUENA_UNA, (tx) => listDealCreatorOptions(tx));
    assert.deepEqual(opciones, { creators: [{ id: CREADORA_UNA, name: 'Una' }], required: false, seesAll: true });
    const id = await como(WS_UNA, DUENA_UNA, (tx) => createDeal(tx, { companyId: MARCA_UNA, name: 'Primer negocio' }));
    assert.equal(await creadorDe(id), CREADORA_UNA);
  });
});

describe('un alcance a un creador dado de baja no cuenta (ronda 2, hallazgos 3 y 7)', { timeout: DESCRIBE_DB_TIMEOUT_MS }, () => {
  const ejecutivo = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => como(WS_AGENCIA, EJECUTIVO_A, fn);
  const CREADOR_BORRADO = '0000000c-0000-4000-8000-0000000000d3';
  const creadorDe = (dealId: string) =>
    t.db.asWorker((tx) => tx.query<{ creator_id: string | null }>('SELECT creator_id FROM deal WHERE id = $1', [dealId]))
      .then((r) => r.rows[0]?.creator_id ?? null);

  before(async () => {
    await t.admin(`
      INSERT INTO creator_profile (id, workspace_id, display_name, deleted_at)
        VALUES ('${CREADOR_BORRADO}', '${WS_AGENCIA}', 'Creador dado de baja', now()) ON CONFLICT DO NOTHING;
      INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id)
        VALUES ('${WS_AGENCIA}', '${EJECUTIVO_A}', 'creator', '${CREADOR_BORRADO}') ON CONFLICT DO NOTHING;
    `);
  });
  after(async () => {
    await t.admin(`DELETE FROM membership_scope WHERE user_id = '${EJECUTIVO_A}' AND scope_id = '${CREADOR_BORRADO}'`);
  });

  test('alcance a uno borrado y a uno vivo: el selector, el alta y el worker dicen lo mismo, y el negocio nace del vivo', async () => {
    const opciones = await ejecutivo((tx) => listDealCreatorOptions(tx));
    assert.deepEqual(opciones, { creators: [{ id: CREADOR_A, name: 'Creador A' }], required: false, seesAll: false });
    assert.deepEqual(await ejecutivo((tx) => soleCreatorFor(tx, WS_AGENCIA)), { creatorId: CREADOR_A, seesAll: false });
    const id = await ejecutivo((tx) => createDeal(tx, { companyId: MARCA_AGENCIA, name: 'Con uno borrado en el alcance' }));
    assert.equal(await creadorDe(id), CREADOR_A);
    // Elegir el borrado a mano no vale: no es un creador vivo.
    await assert.rejects(
      ejecutivo((tx) => createDeal(tx, { companyId: MARCA_AGENCIA, name: 'Del borrado', creatorId: CREADOR_BORRADO })),
      (e: unknown) => e instanceof VentasError && e.code === 'InvalidCreator',
    );
  });

  test('alcance solo a uno borrado: no ve a nadie, el selector lo dice y el alta no inventa un creador', async () => {
    await t.admin(`DELETE FROM membership_scope WHERE user_id = '${EJECUTIVO_A}' AND scope_id = '${CREADOR_A}'`);
    try {
      assert.deepEqual(await ejecutivo((tx) => listDealCreatorOptions(tx)), { creators: [], required: true, seesAll: false });
      assert.deepEqual(await ejecutivo((tx) => soleCreatorFor(tx, WS_AGENCIA)), { creatorId: null, seesAll: false });
      await assert.rejects(
        ejecutivo((tx) => createDeal(tx, { companyId: MARCA_AGENCIA, name: 'De nadie' })),
        (e: unknown) => e instanceof VentasError && e.code === 'NoCreatorInScope',
      );
      assert.deepEqual(await ejecutivo((tx) => crudas(tx, 'campaign')), [], 'y la política no le enseña ninguna campaña');
    } finally {
      await t.admin(`INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id)
                     VALUES ('${WS_AGENCIA}', '${EJECUTIVO_A}', 'creator', '${CREADOR_A}') ON CONFLICT DO NOTHING`);
    }
  });

  test('en el worker (sin persona) es el único creador vivo del espacio, o ninguno', async () => {
    assert.deepEqual(await t.db.asWorker((tx) => soleCreatorFor(tx, WS_AGENCIA)), { creatorId: null, seesAll: true });
    assert.deepEqual(await t.db.asWorker((tx) => soleCreatorFor(tx, WORKSPACE_LAURA)), { creatorId: null, seesAll: true });
  });
});

describe('la bandeja: «Me interesa» con alcance por creador (ronda 2, hallazgos 1 y 9)', { timeout: DESCRIBE_DB_TIMEOUT_MS }, () => {
  const ejecutivo = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => como(WS_AGENCIA, EJECUTIVO_A, fn);
  const duenaAgencia = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => como(WS_AGENCIA, DUENA_AGENCIA, fn);
  const CREADOR_E = '0000000c-0000-4000-8000-0000000000e3';
  /** Una marca sin negocios, y una con un negocio abierto de B. */
  const MARCA_NUEVA = '0000000c-0000-4000-8000-0000000000e7';
  const MARCA_DE_B = '0000000c-0000-4000-8000-0000000000e8';
  const DEAL_DE_B = '0000000c-0000-4000-8000-00000000dea8';
  const CONTACTO_NUEVA = '0000000c-0000-4000-8000-0000000c0e07';
  const CONTACTO_DE_B = '0000000c-0000-4000-8000-0000000c0e08';
  const MSG_NUEVA = '0000000c-0000-4000-8000-0000000a5007';
  const MSG_DE_B = '0000000c-0000-4000-8000-0000000a5008';
  const MSG_ENLAZADO = '0000000c-0000-4000-8000-0000000a5009';
  const ahora = new Date('2026-10-07T15:00:00Z');
  const corregir = (quien: typeof ejecutivo, messageId: string) =>
    quien((tx) => reclassifyInboxMessage(tx, { messageId, intent: 'interested', now: ahora }));
  const negociosDe = (companyId: string) =>
    t.db.asWorker((tx) => tx.query<{ id: string; creator_id: string | null; stage_id: string }>(
      'SELECT id, creator_id, stage_id FROM deal WHERE company_id = $1 ORDER BY created_at', [companyId],
    )).then((r) => r.rows);
  const intencionDe = (messageId: string) =>
    t.db.asWorker((tx) => tx.query<{ intent: string | null }>('SELECT intent FROM outbound_message WHERE id = $1', [messageId]))
      .then((r) => r.rows[0]?.intent ?? null);

  before(async () => {
    await t.admin(`
      INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${CREADOR_E}', '${WS_AGENCIA}', 'Creadora E') ON CONFLICT DO NOTHING;
      INSERT INTO company (id, name, owner_workspace_id) VALUES
        ('${MARCA_NUEVA}', 'Marca nueva ACC-7', '${WS_AGENCIA}'), ('${MARCA_DE_B}', 'Marca de B ACC-7', '${WS_AGENCIA}')
      ON CONFLICT DO NOTHING;
      INSERT INTO company_link (workspace_id, company_id, relationship) VALUES
        ('${WS_AGENCIA}', '${MARCA_NUEVA}', 'prospect'), ('${WS_AGENCIA}', '${MARCA_DE_B}', 'prospect')
      ON CONFLICT DO NOTHING;
      INSERT INTO deal (id, workspace_id, company_id, creator_id, name, stage_id)
        VALUES ('${DEAL_DE_B}', '${WS_AGENCIA}', '${MARCA_DE_B}', '${CREADOR_B}', 'Lo de B', 'contactado') ON CONFLICT DO NOTHING;
      INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source) VALUES
        ('${CONTACTO_NUEVA}', '${MARCA_NUEVA}', '${WS_AGENCIA}', 'Nora Nueva', 'nora@nueva-acc7.test', 'user_provided'),
        ('${CONTACTO_DE_B}', '${MARCA_DE_B}', '${WS_AGENCIA}', 'Beto De B', 'beto@deb-acc7.test', 'user_provided')
      ON CONFLICT DO NOTHING;
      INSERT INTO outbound_message (id, workspace_id, contact_id, deal_id, direction, channel, thread_ref, provider_message_id, body,
                                    occurred_at, intent, intent_confidence, intent_source, classified_at) VALUES
        ('${MSG_NUEVA}', '${WS_AGENCIA}', '${CONTACTO_NUEVA}', NULL, 'inbound', 'email', 'hilo-acc7-n', 'acc7-n', 'Cuéntame más.',
         '2026-10-07T14:00:00Z', 'ambiguous', 0.4, 'model', now()),
        ('${MSG_DE_B}', '${WS_AGENCIA}', '${CONTACTO_DE_B}', NULL, 'inbound', 'email', 'hilo-acc7-b', 'acc7-b', 'Me interesa.',
         '2026-10-07T14:00:00Z', 'ambiguous', 0.4, 'model', now()),
        ('${MSG_ENLAZADO}', '${WS_AGENCIA}', '${CONTACTO_NUEVA}', '${DEAL_DE_B}', 'inbound', 'email', 'hilo-acc7-e', 'acc7-e', 'Sí.',
         '2026-10-07T14:30:00Z', 'ambiguous', 0.4, 'model', now())
      ON CONFLICT DO NOTHING;
    `);
  });

  test('acotado a dos creadores y la marca sin negocio: la intención queda, el negocio no se abre, y lo dice', async () => {
    await t.admin(`INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id)
                   VALUES ('${WS_AGENCIA}', '${EJECUTIVO_A}', 'creator', '${CREADOR_E}') ON CONFLICT DO NOTHING`);
    try {
      const r = await corregir(ejecutivo, MSG_NUEVA);
      assert.deepEqual(r, { ok: true, intent: 'interested', dealMoved: false, optOut: false, optOutReview: false, dealNeedsCreator: 'pick' });
      assert.equal(await intencionDe(MSG_NUEVA), 'interested');
      assert.deepEqual(await negociosDe(MARCA_NUEVA), [], 'ni un negocio sin creador (que la política rechazaría) ni uno adivinado');
    } finally {
      await t.admin(`DELETE FROM membership_scope WHERE user_id = '${EJECUTIVO_A}' AND scope_id = '${CREADOR_E}'`);
    }
    // Con un solo creador en su alcance, la misma corrección abre el negocio a su nombre.
    const r = await corregir(ejecutivo, MSG_NUEVA);
    assert.equal(r.ok && r.dealNeedsCreator, null);
    const negocios = await negociosDe(MARCA_NUEVA);
    assert.equal(negocios.length, 1);
    assert.equal(negocios[0]?.creator_id, CREADOR_A);
    assert.equal(negocios[0]?.stage_id, 'conversacion');
  });

  test('la marca ya tiene un negocio abierto de otro creador: no abre un segundo, no toca nada y lo dice', async () => {
    assert.equal(await ejecutivo((tx) => hasOpenDealOutOfScope(tx, MARCA_DE_B)), true);
    assert.deepEqual(await corregir(ejecutivo, MSG_DE_B), { ok: false, code: 'out_of_scope' });
    assert.equal(await intencionDe(MSG_DE_B), 'ambiguous', 'la intención no cambió');
    assert.deepEqual(await negociosDe(MARCA_DE_B), [{ id: DEAL_DE_B, creator_id: CREADOR_B, stage_id: 'contactado' }]);
    // Quien ve a todos sí: mueve el negocio de B, sin abrir otro.
    assert.equal(await duenaAgencia((tx) => hasOpenDealOutOfScope(tx, MARCA_DE_B)), false);
    const r = await corregir(duenaAgencia, MSG_DE_B);
    assert.equal(r.ok && r.dealMoved, true);
    assert.deepEqual(await negociosDe(MARCA_DE_B), [{ id: DEAL_DE_B, creator_id: CREADOR_B, stage_id: 'conversacion' }]);
  });

  test('el mensaje apunta a un negocio que no ve: tampoco, aunque la marca tenga uno suyo', async () => {
    assert.deepEqual(await corregir(ejecutivo, MSG_ENLAZADO), { ok: false, code: 'out_of_scope' });
    assert.equal(await intencionDe(MSG_ENLAZADO), 'ambiguous');
    assert.equal(await ejecutivo((tx) => hasOpenDealOutOfScope(tx, MARCA_NUEVA)), false, 'el de la marca nueva es de A: lo ve');
  });
});

describe('el negocio de una respuesta es del creador de la cuenta que envió (ronda 3, hallazgos 1 y 13)', { timeout: DESCRIBE_DB_TIMEOUT_MS }, () => {
  const ejecutivo = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => como(WS_AGENCIA, EJECUTIVO_A, fn);
  const duenaAgencia = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => como(WS_AGENCIA, DUENA_AGENCIA, fn);
  const CUENTA_A = '0000000c-0000-4000-8000-0000000ac0a1';
  const CUENTA_B = '0000000c-0000-4000-8000-0000000ac0b1';
  const BRIEF_B = '0000000c-0000-4000-8000-0000000b1ef0';
  const CADENCIA_B = '0000000c-0000-4000-8000-00000005e0b0';
  const CREADOR_DE_BAJA = '0000000c-0000-4000-8000-0000000000f3';
  // Una marca, un contacto y una respuesta por caso: el worker con la cuenta de A, la bandeja con la de B,
  // la bandeja con la de A, la cadencia del brief de B, y dos sin creador de origen (el worker y la bandeja).
  const CASOS = ['a1', 'b1', 'a2', 'c1', 'e1', 'f1'] as const;
  const marca = (k: string) => `0000000c-0000-4000-8000-0000000e10${k}`;
  const contacto = (k: string) => `0000000c-0000-4000-8000-0000000c10${k}`;
  const mensaje = (k: string) => `0000000c-0000-4000-8000-0000000a10${k}`;
  const cuentaDe: Record<(typeof CASOS)[number], string | null> = { a1: CUENTA_A, b1: CUENTA_B, a2: CUENTA_A, c1: null, e1: null, f1: null };
  const ahora = new Date('2026-10-07T15:00:00Z');
  const interesada = { intent: 'interested' as const, confidence: 0.92, returnDate: null, referral: null, source: 'fake' as const };
  const negociosDe = (companyId: string) =>
    t.db.asWorker((tx) => tx.query<{ id: string; creator_id: string | null }>(
      'SELECT id, creator_id FROM deal WHERE company_id = $1 ORDER BY created_at', [companyId],
    )).then((r) => r.rows);
  const corregir = (quien: typeof ejecutivo, messageId: string) =>
    quien((tx) => reclassifyInboxMessage(tx, { messageId, intent: 'interested', now: ahora }));

  before(async () => {
    const filas = CASOS.map((k) => ({ k, marca: marca(k), contacto: contacto(k), mensaje: mensaje(k), cuenta: cuentaDe[k] }));
    await t.admin(`
      INSERT INTO creator_profile (id, workspace_id, display_name, deleted_at)
        VALUES ('${CREADOR_DE_BAJA}', '${WS_AGENCIA}', 'Creador que se fue', now()) ON CONFLICT DO NOTHING;
      INSERT INTO outreach_channel_account (id, workspace_id, creator_id, channel, provider, provider_account_id, display_name, status) VALUES
        ('${CUENTA_A}', '${WS_AGENCIA}', '${CREADOR_A}', 'email', 'gmail_oauth', 'a.acc7@gmail.test', 'Creador A', 'disconnected'),
        ('${CUENTA_B}', '${WS_AGENCIA}', '${CREADOR_B}', 'email', 'gmail_oauth', 'b.acc7@gmail.test', 'Creadora B', 'disconnected')
      ON CONFLICT DO NOTHING;
      INSERT INTO outbound_brief (id, workspace_id, creator_id, title, status)
        VALUES ('${BRIEF_B}', '${WS_AGENCIA}', '${CREADOR_B}', 'Brief de B', 'active') ON CONFLICT DO NOTHING;
      INSERT INTO outbound_sequence (id, workspace_id, brief_id, name, channel)
        VALUES ('${CADENCIA_B}', '${WS_AGENCIA}', '${BRIEF_B}', 'Cadencia de B', 'email') ON CONFLICT DO NOTHING;
      INSERT INTO company (id, name, owner_workspace_id) VALUES
        ${filas.map((f) => `('${f.marca}', 'Marca ${f.k} ACC-7 r4', '${WS_AGENCIA}')`).join(', ')}
      ON CONFLICT DO NOTHING;
      INSERT INTO company_link (workspace_id, company_id, relationship) VALUES
        ${filas.map((f) => `('${WS_AGENCIA}', '${f.marca}', 'prospect')`).join(', ')}
      ON CONFLICT DO NOTHING;
      INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source) VALUES
        ${filas.map((f) => `('${f.contacto}', '${f.marca}', '${WS_AGENCIA}', 'Contacto ${f.k}', '${f.k}@r4-acc7.test', 'user_provided')`).join(', ')}
      ON CONFLICT DO NOTHING;
      INSERT INTO outbound_enrollment (workspace_id, sequence_id, contact_id)
        VALUES ('${WS_AGENCIA}', '${CADENCIA_B}', '${contacto('c1')}') ON CONFLICT DO NOTHING;
      INSERT INTO outbound_message (id, workspace_id, contact_id, channel_account_id, enrollment_id, direction, channel, thread_ref,
                                    provider_message_id, body, occurred_at) VALUES
        ${filas.map((f) => `('${f.mensaje}', '${WS_AGENCIA}', '${f.contacto}', ${f.cuenta ? `'${f.cuenta}'` : 'NULL'},
          ${f.k === 'c1' ? `(SELECT id FROM outbound_enrollment WHERE contact_id = '${f.contacto}')` : 'NULL'},
          'inbound', 'email', 'hilo-r4-${f.k}', 'r4-${f.k}', 'Me interesa, cuéntame.', '2026-10-07T14:00:00Z')`).join(', ')}
      ON CONFLICT DO NOTHING;
    `);
  });

  test('el worker abre el negocio de la cuenta de A a nombre de A, y el ejecutivo acotado a A lo ve en el pipeline', async () => {
    // Con tres creadores vivos en la agencia, «el único» no existe: sin la cuenta, el negocio nacía sin creador.
    assert.deepEqual(await t.db.asWorker((tx) => soleCreatorFor(tx, WS_AGENCIA)), { creatorId: null, seesAll: true });
    const fx = await t.db.asWorker(async (tx) => {
      const m = await loadIntentMessage(tx, mensaje('a1'));
      assert.ok(m);
      return applyIntent(tx, m, interesada, ahora);
    });
    assert.equal(fx.dealCreated, true);
    assert.deepEqual((await negociosDe(marca('a1'))).map((d) => d.creator_id), [CREADOR_A]);
    const pipeline = await ejecutivo((tx) => listPipeline(tx, { companyId: marca('a1') }));
    assert.deepEqual(pipeline.map((d) => [d.id, d.creatorId]), [[fx.dealId, CREADOR_A]]);
  });

  test('sin cuenta de un creador, el brief de la cadencia dice de quién es; con una cuenta del espacio, como antes', async () => {
    const aplicar = (k: string) => t.db.asWorker(async (tx) => {
      const m = await loadIntentMessage(tx, mensaje(k));
      assert.ok(m);
      return applyIntent(tx, m, interesada, ahora);
    });
    assert.equal((await aplicar('c1')).dealCreated, true);
    assert.deepEqual((await negociosDe(marca('c1'))).map((d) => d.creator_id), [CREADOR_B], 'del brief de B');
    assert.equal((await aplicar('e1')).dealCreated, true);
    assert.deepEqual((await negociosDe(marca('e1'))).map((d) => d.creator_id), [null], 'sin origen y con varios: sin creador');
  });

  test('desde la bandeja, el ejecutivo acotado a A no abre a nombre de B lo que llegó por la cuenta de B', async () => {
    assert.deepEqual(await corregir(ejecutivo, mensaje('b1')), { ok: false, code: 'out_of_scope' });
    assert.deepEqual(await negociosDe(marca('b1')), [], 'no se abre a nombre de B, ni de A');
    const r = await corregir(duenaAgencia, mensaje('b1'));
    assert.equal(r.ok && r.dealNeedsCreator, null);
    assert.deepEqual((await negociosDe(marca('b1'))).map((d) => d.creator_id), [CREADOR_B], 'quien ve a todos lo abre, y es de B');
  });

  test('acotado a dos creadores, la cuenta de A ya dice de quién es: no hay que elegir', async () => {
    const CREADOR_E = '0000000c-0000-4000-8000-0000000000e3';
    await t.admin(`INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id)
                   VALUES ('${WS_AGENCIA}', '${EJECUTIVO_A}', 'creator', '${CREADOR_E}') ON CONFLICT DO NOTHING`);
    try {
      const r = await corregir(ejecutivo, mensaje('a2'));
      assert.deepEqual(r, { ok: true, intent: 'interested', dealMoved: true, optOut: false, optOutReview: false, dealNeedsCreator: null });
      assert.deepEqual((await negociosDe(marca('a2'))).map((d) => d.creator_id), [CREADOR_A]);
    } finally {
      await t.admin(`DELETE FROM membership_scope WHERE user_id = '${EJECUTIVO_A}' AND scope_id = '${CREADOR_E}'`);
    }
  });

  test('acotado solo a un creador que se fue: «none», no «elige de cuál es»', async () => {
    await t.admin(`
      DELETE FROM membership_scope WHERE user_id = '${EJECUTIVO_A}' AND scope_id = '${CREADOR_A}';
      INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id)
        VALUES ('${WS_AGENCIA}', '${EJECUTIVO_A}', 'creator', '${CREADOR_DE_BAJA}') ON CONFLICT DO NOTHING;
    `);
    try {
      const r = await corregir(ejecutivo, mensaje('f1'));
      assert.deepEqual(r, { ok: true, intent: 'interested', dealMoved: false, optOut: false, optOutReview: false, dealNeedsCreator: 'none' });
      assert.deepEqual(await negociosDe(marca('f1')), []);
    } finally {
      await t.admin(`
        DELETE FROM membership_scope WHERE user_id = '${EJECUTIVO_A}' AND scope_id = '${CREADOR_DE_BAJA}';
        INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id)
          VALUES ('${WS_AGENCIA}', '${EJECUTIVO_A}', 'creator', '${CREADOR_A}') ON CONFLICT DO NOTHING;
      `);
    }
  });

  // Ronda 4, hallazgo 6: la marca ya tiene un negocio abierto de B y la respuesta llega por la cuenta
  // de A. Worker y bandeja tienen que decidir lo mismo: el de B no se toca, y el de A es de A.
  const MARCA_MIXTA = (k: string) => `0000000c-0000-4000-8000-0000000e20${k}`;
  const NEGOCIO_DE_B = (k: string) => `0000000c-0000-4000-8000-0000000d20${k}`;
  const CONTACTO_MIXTA = (k: string) => `0000000c-0000-4000-8000-0000000c20${k}`;
  const MENSAJE_MIXTA = (k: string) => `0000000c-0000-4000-8000-0000000a20${k}`;
  const marcaConNegocioDeB = (k: string) => t.admin(`
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${MARCA_MIXTA(k)}', 'Marca mixta ${k} ACC-7 r5', '${WS_AGENCIA}');
    INSERT INTO company_link (workspace_id, company_id, relationship) VALUES ('${WS_AGENCIA}', '${MARCA_MIXTA(k)}', 'prospect');
    INSERT INTO deal (id, workspace_id, company_id, creator_id, name, stage_id)
      VALUES ('${NEGOCIO_DE_B(k)}', '${WS_AGENCIA}', '${MARCA_MIXTA(k)}', '${CREADOR_B}', 'Lo de B con la mixta ${k}', 'contactado');
    INSERT INTO contact (id, company_id, owner_workspace_id, full_name, email, source)
      VALUES ('${CONTACTO_MIXTA(k)}', '${MARCA_MIXTA(k)}', '${WS_AGENCIA}', 'Contacto mixta ${k}', 'mixta-${k}@r5-acc7.test', 'user_provided');
    INSERT INTO outbound_message (id, workspace_id, contact_id, channel_account_id, direction, channel, thread_ref,
                                  provider_message_id, body, occurred_at)
      VALUES ('${MENSAJE_MIXTA(k)}', '${WS_AGENCIA}', '${CONTACTO_MIXTA(k)}', '${CUENTA_A}', 'inbound', 'email', 'hilo-r5-${k}',
              'r5-${k}', 'Me interesa, cuéntame.', '2026-10-07T14:00:00Z');
  `);
  const negocioDeB = (k: string) =>
    t.db.asWorker((tx) => tx.query<{ stage_id: string }>('SELECT stage_id FROM deal WHERE id = $1', [NEGOCIO_DE_B(k)]))
      .then((r) => r.rows[0]?.stage_id);
  const enlaceDelMensaje = (k: string) =>
    t.db.asWorker((tx) => tx.query<{ deal_id: string | null }>('SELECT deal_id FROM outbound_message WHERE id = $1', [MENSAJE_MIXTA(k)]))
      .then((r) => r.rows[0]?.deal_id ?? null);

  test('marca con negocio abierto de B y respuesta por la cuenta de A: el worker no toca el de B, abre el de A y el ejecutivo de A lo ve', async () => {
    await marcaConNegocioDeB('a1');
    const fx = await t.db.asWorker(async (tx) => {
      const m = await loadIntentMessage(tx, MENSAJE_MIXTA('a1'));
      assert.ok(m);
      return applyIntent(tx, m, interesada, ahora);
    });
    assert.equal(fx.dealCreated, true, 'abre uno para A');
    assert.notEqual(fx.dealId, NEGOCIO_DE_B('a1'));
    assert.equal(await negocioDeB('a1'), 'contactado', 'el de B sigue donde estaba');
    assert.equal(await enlaceDelMensaje('a1'), fx.dealId, 'el mensaje queda en el negocio de A, no en el de B');
    const negocios = await negociosDe(MARCA_MIXTA('a1'));
    assert.deepEqual(negocios.map((d) => d.creator_id).sort(), [CREADOR_A, CREADOR_B].sort());
    const pipeline = await ejecutivo((tx) => listPipeline(tx, { companyId: MARCA_MIXTA('a1') }));
    assert.deepEqual(pipeline.map((d) => [d.id, d.creatorId]), [[fx.dealId, CREADOR_A]], 'el ejecutivo de A ve el suyo, y solo el suyo');
    // Una segunda respuesta por la cuenta de A ya encuentra el de A: no abre un tercero.
    await t.admin(`
      INSERT INTO outbound_message (id, workspace_id, contact_id, channel_account_id, direction, channel, thread_ref,
                                    provider_message_id, body, occurred_at)
        VALUES ('${MENSAJE_MIXTA('a2')}', '${WS_AGENCIA}', '${CONTACTO_MIXTA('a1')}', '${CUENTA_A}', 'inbound', 'email', 'hilo-r5-w2',
                'r5-w2', 'Sigo interesada.', '2026-10-07T14:30:00Z')`);
    const otra = await t.db.asWorker(async (tx) => {
      const m = await loadIntentMessage(tx, MENSAJE_MIXTA('a2'));
      assert.ok(m);
      return applyIntent(tx, m, interesada, ahora);
    });
    assert.equal(otra.dealCreated, false);
    assert.equal(otra.dealId, fx.dealId);
    assert.equal((await negociosDe(MARCA_MIXTA('a1'))).length, 2);
  });

  test('lo mismo desde la bandeja: el ejecutivo de A corrige a «Me interesa» y abre el de A, sin out_of_scope ni tocar el de B', async () => {
    await marcaConNegocioDeB('b1');
    const r = await corregir(ejecutivo, MENSAJE_MIXTA('b1'));
    assert.deepEqual(r, { ok: true, intent: 'interested', dealMoved: true, optOut: false, optOutReview: false, dealNeedsCreator: null });
    assert.equal(await negocioDeB('b1'), 'contactado');
    const negocios = await negociosDe(MARCA_MIXTA('b1'));
    assert.deepEqual(negocios.map((d) => d.creator_id).sort(), [CREADOR_A, CREADOR_B].sort());
    assert.equal(await enlaceDelMensaje('b1'), negocios.find((d) => d.creator_id === CREADOR_A)?.id);
  });
});

describe('el radar con alcance por creador: la marca ya tiene un negocio abierto de otro creador (ronda 4, hallazgo 1)', { timeout: DESCRIBE_DB_TIMEOUT_MS }, () => {
  const ejecutivo = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => como(WS_AGENCIA, EJECUTIVO_A, fn);
  const duenaAgencia = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => como(WS_AGENCIA, DUENA_AGENCIA, fn);
  const MARCA_RADAR = '0000000c-0000-4000-8000-0000000e3001';
  const NEGOCIO_RADAR_B = '0000000c-0000-4000-8000-0000000d3001';
  const negocios = () =>
    t.db.asWorker((tx) => tx.query<{ id: string; creator_id: string | null }>(
      'SELECT id, creator_id FROM deal WHERE company_id = $1 ORDER BY created_at', [MARCA_RADAR],
    )).then((r) => r.rows);
  const estadoDe = (signalId: string) =>
    t.db.asWorker((tx) => tx.query<{ status: string }>('SELECT status FROM signal WHERE id = $1', [signalId])).then((r) => r.rows[0]?.status);

  before(async () => {
    await t.admin(`
      INSERT INTO company (id, name, owner_workspace_id) VALUES ('${MARCA_RADAR}', 'Hostal del radar ACC-7', '${WS_AGENCIA}') ON CONFLICT DO NOTHING;
      INSERT INTO company_link (workspace_id, company_id, relationship) VALUES ('${WS_AGENCIA}', '${MARCA_RADAR}', 'prospect') ON CONFLICT DO NOTHING;
      INSERT INTO deal (id, workspace_id, company_id, creator_id, name, stage_id)
        VALUES ('${NEGOCIO_RADAR_B}', '${WS_AGENCIA}', '${MARCA_RADAR}', '${CREADOR_B}', 'Lo de B con el hostal', 'propuesta') ON CONFLICT DO NOTHING;
    `);
  });

  test('el ejecutivo acotado acepta una señal de una marca con un negocio abierto de B: no abre otro, la señal sigue pendiente, y la tarjeta lo decía', async () => {
    const senal = await ejecutivo((tx) => createSignal(tx, { companyId: MARCA_RADAR, headlineEs: 'Abre una sede en la playa' }));
    assert.ok(senal.id);
    const tarjeta = (await ejecutivo((tx) => listSignals(tx))).find((s) => s.id === senal.id);
    assert.ok(tarjeta);
    assert.deepEqual([tarjeta.openDealId, tarjeta.openDealHidden], [null, true], 'antes de aceptar, la tarjeta ya sabe que hay uno que no ve');

    const r = await ejecutivo((tx) => acceptSignal(tx, senal.id!));
    assert.deepEqual([r.dealId, r.dealCreated, r.dealHiddenOutOfScope], [null, false, true]);
    assert.deepEqual(await negocios(), [{ id: NEGOCIO_RADAR_B, creator_id: CREADOR_B }], 'ni un segundo negocio ni tocar el de B');
    assert.equal(await estadoDe(senal.id!), 'pending', 'la señal queda para quien lleva el negocio');

    // La dueña, con la misma señal, la suma al negocio de B: la regla es la misma, ella sí lo ve.
    const tarjetaDuena = (await duenaAgencia((tx) => listSignals(tx))).find((s) => s.id === senal.id);
    assert.deepEqual([tarjetaDuena?.openDealId, tarjetaDuena?.openDealHidden], [NEGOCIO_RADAR_B, false]);
    const deLaDuena = await duenaAgencia((tx) => acceptSignal(tx, senal.id!));
    assert.deepEqual([deLaDuena.dealId, deLaDuena.dealCreated, deLaDuena.dealHiddenOutOfScope], [NEGOCIO_RADAR_B, false, false]);
    assert.equal(await estadoDe(senal.id!), 'accepted');
    assert.equal((await negocios()).length, 1);
  });

  test('si el ejecutivo quiere uno para su creador, lo abre desde la ficha eligiéndolo: es explícito, y la marca queda con uno de cada uno', async () => {
    const id = await ejecutivo((tx) => createDeal(tx, { companyId: MARCA_RADAR, name: 'Lo de A con el hostal' }));
    assert.deepEqual((await negocios()).map((d) => d.creator_id), [CREADOR_B, CREADOR_A]);
    // Y desde entonces el radar le suma las señales a ese, el que ve.
    const senal = await ejecutivo((tx) => createSignal(tx, { companyId: MARCA_RADAR, headlineEs: 'Pauta en Meta para la temporada' }));
    const r = await ejecutivo((tx) => acceptSignal(tx, senal.id!));
    assert.deepEqual([r.dealId, r.dealCreated, r.dealHiddenOutOfScope], [id, false, false]);
  });
});

describe('de qué creador es un negocio: verlo y cambiarlo (ronda 2, hallazgo 6)', { timeout: DESCRIBE_DB_TIMEOUT_MS }, () => {
  const ejecutivo = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => como(WS_AGENCIA, EJECUTIVO_A, fn);
  const duenaAgencia = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => como(WS_AGENCIA, DUENA_AGENCIA, fn);
  const DEAL_SIN = '0000000c-0000-4000-8000-00000000dea9';

  before(async () => {
    await t.admin(`INSERT INTO deal (id, workspace_id, company_id, creator_id, name, stage_id)
                   VALUES ('${DEAL_SIN}', '${WS_AGENCIA}', '${MARCA_AGENCIA}', NULL, 'Sin creador ACC-7', 'nuevo') ON CONFLICT DO NOTHING`);
  });

  test('el pipeline dice el creador de cada negocio, o que no tiene', async () => {
    const filas = await duenaAgencia((tx) => listPipeline(tx, { companyId: MARCA_AGENCIA }));
    const sin = filas.find((d) => d.id === DEAL_SIN);
    assert.deepEqual([sin?.creatorId, sin?.creatorName], [null, null]);
    assert.ok(filas.some((d) => d.creatorId === CREADOR_A && d.creatorName === 'Creador A'));
  });

  test('la dueña lo asigna (con su bitácora) y el ejecutivo pasa a verlo; él no lo deja sin creador ni lo pasa a otro', async () => {
    assert.deepEqual(await duenaAgencia((tx) => setDealCreator(tx, DEAL_SIN, CREADOR_A)), { changed: true, creatorName: 'Creador A' });
    assert.deepEqual(
      await duenaAgencia((tx) => setDealCreator(tx, DEAL_SIN, CREADOR_A)),
      { changed: false, creatorName: 'Creador A' },
      'lo mismo no cambia nada',
    );
    const bitacora = await duenaAgencia((tx) => tx.query<{ action: string; before: unknown; after: unknown }>(
      'SELECT action, before, after FROM audit_log WHERE entity_id = $1 ORDER BY id', [DEAL_SIN],
    )).then((r) => r.rows);
    assert.deepEqual(bitacora, [{ action: 'deal.creator_changed', before: { creatorId: null }, after: { creatorId: CREADOR_A } }]);
    assert.ok((await ejecutivo((tx) => listPipeline(tx, { companyId: MARCA_AGENCIA }))).some((d) => d.id === DEAL_SIN));

    await assert.rejects(ejecutivo((tx) => setDealCreator(tx, DEAL_SIN, null)), ScopeError, 'sin creador se le iría de las manos');
    await assert.rejects(ejecutivo((tx) => setDealCreator(tx, DEAL_SIN, CREADOR_B)), ScopeError, 'B no es de su alcance');
    await assert.rejects(
      ejecutivo((tx) => setDealCreator(tx, DEAL_SIN, '0000000c-0000-4000-8000-00000000dead')),
      (e: unknown) => e instanceof VentasError && e.code === 'InvalidCreator',
    );
    // La dueña lo devuelve a «sin creador»: el ejecutivo deja de verlo, y no lo puede tocar.
    assert.deepEqual(await duenaAgencia((tx) => setDealCreator(tx, DEAL_SIN, null)), { changed: true, creatorName: null });
    await assert.rejects(
      ejecutivo((tx) => setDealCreator(tx, DEAL_SIN, CREADOR_A)),
      (e: unknown) => e instanceof VentasError && e.code === 'DealNotFound',
    );
  });

  test('con su cotización enviada o su campaña viva de otro creador, el negocio no cambia de creador (DealCreatorLocked)', async () => {
    const CREADOR_E = '0000000c-0000-4000-8000-0000000000e3';
    const DEAL_COT = '0000000c-0000-4000-8000-00000000deb1';
    const DEAL_CAMP = '0000000c-0000-4000-8000-00000000deb2';
    const CAMP_B = '0000000c-0000-4000-8000-000000ca00b2';
    const bloqueado = (e: unknown) => e instanceof VentasError && e.code === 'DealCreatorLocked';
    await t.admin(`
      INSERT INTO deal (id, workspace_id, company_id, creator_id, name, stage_id) VALUES
        ('${DEAL_COT}', '${WS_AGENCIA}', '${MARCA_AGENCIA}', NULL, 'Con cotización de A', 'propuesta'),
        ('${DEAL_CAMP}', '${WS_AGENCIA}', '${MARCA_AGENCIA}', '${CREADOR_A}', 'Con campaña de B', 'propuesta')
      ON CONFLICT DO NOTHING;
      INSERT INTO quote (workspace_id, company_id, creator_id, deal_id, number, slug, currency, subtotal, tax, total,
                         agreed_metrics, report_cuts_hours, payment_terms_days, status, sent_at, public_snapshot)
      VALUES ('${WS_AGENCIA}', '${MARCA_AGENCIA}', '${CREADOR_A}', '${DEAL_COT}', 'COT-2026-971', 'cot-acc7-r4-bloqueo', 'COP',
              1000000.00, 190000.00, 1190000.00, '{views}', '{168}', 30, 'sent', now(), '{"timezone": "America/Bogota"}');
      INSERT INTO campaign (id, workspace_id, company_id, creator_id, deal_id, name, status)
        VALUES ('${CAMP_B}', '${WS_AGENCIA}', '${MARCA_AGENCIA}', '${CREADOR_B}', '${DEAL_CAMP}', 'Campaña de B del negocio de A', 'planned')
      ON CONFLICT DO NOTHING;
      INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id)
        VALUES ('${WS_AGENCIA}', '${EJECUTIVO_A}', 'creator', '${CREADOR_E}') ON CONFLICT DO NOTHING;
    `);
    try {
      // La cotización enviada es de A: a B no, ni «sin creador» lo deja partido; a A sí, que lo pone en orden.
      await assert.rejects(duenaAgencia((tx) => setDealCreator(tx, DEAL_COT, CREADOR_B)), bloqueado);
      assert.deepEqual(await duenaAgencia((tx) => setDealCreator(tx, DEAL_COT, CREADOR_A)), { changed: true, creatorName: 'Creador A' });
      await assert.rejects(duenaAgencia((tx) => setDealCreator(tx, DEAL_COT, null)), bloqueado);
      // La campaña de B no la ve el ejecutivo (acotado a A y E), y aun así no pasa el negocio a E.
      assert.equal((await ejecutivo((tx) => crudas(tx, 'campaign'))).some((c) => c.id === CAMP_B), false);
      await assert.rejects(ejecutivo((tx) => setDealCreator(tx, DEAL_CAMP, CREADOR_E)), bloqueado);
      // Nada cambió, y no quedó bitácora de un cambio que no pasó.
      const creadores = await t.db.asWorker((tx) => tx.query<{ id: string; creator_id: string | null }>(
        'SELECT id, creator_id FROM deal WHERE id = ANY($1::uuid[]) ORDER BY id', [[DEAL_COT, DEAL_CAMP]],
      )).then((r) => r.rows);
      assert.deepEqual(creadores, [{ id: DEAL_COT, creator_id: CREADOR_A }, { id: DEAL_CAMP, creator_id: CREADOR_A }]);
      // Con la campaña cancelada, el acuerdo ya no está atado a B.
      await t.admin(`UPDATE campaign SET status = 'cancelled' WHERE id = '${CAMP_B}'`);
      assert.deepEqual(await ejecutivo((tx) => setDealCreator(tx, DEAL_CAMP, CREADOR_E)), { changed: true, creatorName: 'Creadora E' });
      // Sin espacio fijado, la función no responde por nadie.
      const sinEspacio = await t.db.withCatalogs((tx) => tx.query<{ v: boolean }>('SELECT deal_creator_locked($1, $2) AS v', [DEAL_COT, CREADOR_B]));
      assert.equal(sinEspacio.rows[0]?.v, false);
    } finally {
      await t.admin(`DELETE FROM membership_scope WHERE user_id = '${EJECUTIVO_A}' AND scope_id = '${CREADOR_E}'`);
    }
  });

  test('deal_creator_locked solo responde por un negocio que la sesión ve: por uno oculto no dice nada (ronda 4, hallazgo 2)', async () => {
    // DEAL_SOFIA_ENLACE tiene una cotización enviada de Sofía. Para la dueña, pasarlo a Laura lo partiría.
    const pregunta = (quien: typeof miembro, creador: string) =>
      quien((tx) => tx.query<{ v: boolean }>('SELECT deal_creator_locked($1, $2) AS v', [DEAL_SOFIA_ENLACE, creador])).then((r) => r.rows[0]?.v);
    assert.equal(await pregunta(duena, CREATOR_LAURA), true, 'la dueña lo ve: bloqueado para Laura');
    assert.equal(await pregunta(duena, CREATOR_SOFIA), false, 'y libre para Sofía');
    // El miembro acotado a Laura no ve ese negocio: ninguna pregunta le dice de quién es su acuerdo, ni que existe.
    for (const creador of [CREATOR_LAURA, CREATOR_SOFIA]) {
      assert.equal(await pregunta(miembro, creador), false, creador);
    }
    const inexistente = await miembro((tx) => tx.query<{ v: boolean }>(
      'SELECT deal_creator_locked($1, $2) AS v', ['0000000a-0000-4000-8000-00000000dead', CREATOR_LAURA],
    ));
    assert.equal(inexistente.rows[0]?.v, false, 'igual que por uno que no existe');
  });
});

describe('a quién no toca: el worker y los enlaces públicos', { timeout: DESCRIBE_DB_TIMEOUT_MS }, () => {
  test('las cuatro políticas son RESTRICTIVE, FOR ALL y solo para mc_app', async () => {
    const politicas = await t.raw<{ tablename: string; permissive: string; roles: string; cmd: string }>(
      `SELECT tablename::text, permissive::text, roles::text, cmd::text FROM pg_policies
        WHERE policyname LIKE '%\\_creator\\_scope' ORDER BY tablename`,
    );
    assert.deepEqual(politicas, Object.keys(TABLAS_CON_ALCANCE_POR_CREADOR).sort().map((tablename) => ({
      tablename, permissive: 'RESTRICTIVE', roles: '{mc_app}', cmd: 'ALL',
    })));
  });

  test('el worker (mc_worker, BYPASSRLS) sigue viendo las filas de Sofía', async () => {
    const n = await t.db.asWorker((tx) => tx.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM social_connection WHERE creator_id = $1) + (SELECT count(*) FROM post WHERE creator_id = $1)
            + (SELECT count(*) FROM campaign WHERE creator_id = $1) + (SELECT count(*) FROM deal WHERE creator_id = $1) AS n`,
      [CREATOR_SOFIA],
    ).then((r) => Number(r.rows[0]?.n)));
    assert.ok(n >= 4, `el worker ve las de Sofía (${n})`);
  });

  test('la marca acepta por el enlace público la cotización de un negocio de Sofía, y el negocio pasa a Ganado', async () => {
    const r = await t.db.withPublicShare((tx) =>
      tx.query<{ r: { status: string } }>('SELECT public_quote_accept($1, $2, $3) AS r', [SLUG_SOFIA_ENLACE, 'Ana Gómez', 'ana@marcasofia.co']));
    assert.equal(r.rows[0]?.r.status, 'ok');
    const etapa = await duena((tx) => tx.query<{ stage_id: string }>('SELECT stage_id FROM deal WHERE id = $1', [DEAL_SOFIA_ENLACE]));
    assert.equal(etapa.rows[0]?.stage_id, 'ganado');
    assert.equal((await miembro((tx) => tx.query('SELECT 1 FROM deal WHERE id = $1', [DEAL_SOFIA_ENLACE]))).rows.length, 0);
  });
});

describe('lo que la política deja sin respuesta: el @ y el índice único', { timeout: DESCRIBE_DB_TIMEOUT_MS }, () => {
  const fuera = (ws: string | null, userId: string | undefined, handle: string | null) => {
    const sql = 'SELECT public_account_out_of_scope($1, $2) AS v';
    if (ws === null) return t.db.withCatalogs((tx) => tx.query<{ v: boolean }>(sql, ['tiktok', handle])).then((r) => r.rows[0]?.v);
    return como(ws, userId, (tx) => tx.query<{ v: boolean }>(sql, ['tiktok', handle])).then((r) => r.rows[0]?.v);
  };

  test('public_account_out_of_scope: sí solo para el @ de otra creadora y a quien está acotado', async () => {
    assert.equal(await fuera(WORKSPACE_LAURA, USER_MIEMBRO, 'sofia.viaja'), true);
    assert.equal(await fuera(WORKSPACE_LAURA, USER_MIEMBRO, 'SOFIA.VIAJA'), true, 'el handle se compara sin mayúsculas, como en Conexiones');
    assert.equal(await fuera(WORKSPACE_LAURA, USER_LAURA, 'sofia.viaja'), false, 'la dueña la ve: no está fuera');
    assert.equal(await fuera(WORKSPACE_LAURA, USER_MIEMBRO, 'no.existe.acc7'), false);
    assert.equal(await fuera(WORKSPACE_LAURA, USER_MIEMBRO, null), false);
    assert.equal(await fuera(WS_AGENCIA, EJECUTIVO_A, 'sofia.viaja'), false, 'desde otro espacio, nada: no enseña cuentas de nadie más');
    assert.equal(await fuera(null, undefined, 'sofia.viaja'), false, 'sin espacio fijado, falso');
  });

  /** Una segunda campaña viva de la cotización, por writeOrScopeError, con la sonda de createCampaignFromQuote. */
  const otraCampanaDe = (quoteId: string) => (tx: WorkspaceTx) => writeOrScopeError(
    tx, 'campana_de_cotizacion', 'campaign_quote_id_active_key',
    () => tx.query(
      `INSERT INTO campaign (workspace_id, company_id, creator_id, quote_id, name, status)
       VALUES (current_workspace_id(), $1, $2, $3, 'Segunda viva', 'planned')`,
      [COMPANY_CAFE_ALMA, CREATOR_LAURA, quoteId],
    ),
    async () => (await tx.query(`SELECT 1 FROM campaign WHERE quote_id = $1 AND status <> 'cancelled'`, [quoteId])).rows.length > 0,
  );
  const es23505 = (e: unknown) => findPgError(e, '23505', 'campaign_quote_id_active_key') !== null;

  test('writeOrScopeError: el choque con una fila que la persona acotada no ve es ScopeError; para la dueña es el error de siempre', async () => {
    await t.admin(`UPDATE campaign SET quote_id = '${QUOTE_SOFIA_ENLACE}' WHERE id = '${CAMPAIGN_SOFIA}'`);
    try {
      await assert.rejects(miembro(async (tx) => {
        await assert.rejects(otraCampanaDe(QUOTE_SOFIA_ENLACE)(tx), ScopeError);
        // La transacción sigue usable después del SAVEPOINT.
        assert.equal((await tx.query('SELECT 1 AS uno')).rows.length, 1);
        throw new Error('fin');
      }), /fin/);
      await assert.rejects(duena(otraCampanaDe(QUOTE_SOFIA_ENLACE)), es23505);
    } finally {
      await t.admin(`UPDATE campaign SET quote_id = NULL WHERE id = '${CAMPAIGN_SOFIA}'`);
    }
  });

  test('writeOrScopeError: si la fila con la que choca la persona acotada es SUYA (la ve), es el 23505 de siempre, no ScopeError', async () => {
    // Una campaña viva de Laura con la cotización: el miembro la ve. Un doble envío o dos pestañas
    // chocan con ella, y eso no es «fuera de tu alcance».
    const CAMPANA_LAURA_VIVA = '0000000a-0000-4000-8000-0000ca0a0f01';
    await t.admin(`
      INSERT INTO campaign (id, workspace_id, company_id, creator_id, quote_id, name, status)
      VALUES ('${CAMPANA_LAURA_VIVA}', '${WORKSPACE_LAURA}', '${COMPANY_CAFE_ALMA}', '${CREATOR_LAURA}', '${QUOTE_SOFIA_ENLACE}', 'La de Laura', 'planned')`);
    try {
      await assert.rejects(miembro(async (tx) => {
        await assert.rejects(otraCampanaDe(QUOTE_SOFIA_ENLACE)(tx), (e: unknown) => !(e instanceof ScopeError) && es23505(e));
        assert.equal((await tx.query('SELECT 1 AS uno')).rows.length, 1, 'y la transacción sigue usable');
        throw new Error('fin');
      }), /fin/);
    } finally {
      await t.admin(`DELETE FROM campaign WHERE id = '${CAMPANA_LAURA_VIVA}'`);
    }
  });

  test('withSavepoint: si la vuelta al SAVEPOINT falla, llega el error original (con la vuelta en su cause) y onError no corre', async () => {
    const original = new Error('el de la escritura');
    const vuelta = new Error('la conexión se cayó');
    const sql: string[] = [];
    const tx: SqlExecutor = {
      query: (async (text: string) => {
        sql.push(text);
        if (text.startsWith('ROLLBACK TO')) throw vuelta;
        return { rows: [], rowCount: 0 };
      }) as SqlExecutor['query'],
    };
    let llamado = false;
    await assert.rejects(
      withSavepoint(tx, 'cambio_de_rol', async () => { throw original; }, () => { llamado = true; return null; }),
      (e: unknown) => e === original && (e as { cause?: unknown }).cause === vuelta,
    );
    assert.equal(llamado, false);
    assert.deepEqual(sql, ['SAVEPOINT cambio_de_rol', 'ROLLBACK TO SAVEPOINT cambio_de_rol']);
  });

  test('writeOrScopeError: un SAVEPOINT que no es un identificador simple no llega al SQL', async () => {
    let escribio = false;
    await assert.rejects(
      duena((tx) => writeOrScopeError(tx, 'x; DROP TABLE deal; --' as ScopeSavepoint, 'campaign_quote_id_active_key', async () => {
        escribio = true;
      }, async () => false)),
      TypeError,
    );
    assert.equal(escribio, false);
    assert.equal((await duena((tx) => tx.query('SELECT 1 FROM deal LIMIT 1'))).rows.length, 1, 'deal sigue ahí');
  });

  test('scopeErrorOf: el 42501 de la política por creador es ScopeError; otro 42501, no', async () => {
    const deLaPolitica = await miembro((tx) => tx.query(
      `INSERT INTO deal (workspace_id, company_id, creator_id, name, stage_id) VALUES (current_workspace_id(), $1, $2, 'Colado', 'nuevo')`,
      [COMPANY_CAFE_ALMA, CREATOR_SOFIA],
    )).then(() => null, (err: unknown) => err);
    assert.ok(scopeErrorOf(deLaPolitica) instanceof ScopeError);
    const otro = await miembro((tx) => tx.query('DELETE FROM membership_scope')).then(() => null, (err: unknown) => err);
    assert.ok(findPgError(otro, '42501') !== null, 'permission denied también es 42501');
    assert.equal(scopeErrorOf(otro), null);
    assert.equal(scopeErrorOf(new Error('cualquier otra cosa')), null);
    const propio = new ScopeError();
    assert.equal(scopeErrorOf(propio), propio);
  });

  test('scopeErrorOf: el nombre de la política se reconoce con las comillas de cualquier idioma del servidor', () => {
    const rechazo = (message: string) => Object.assign(new Error('envoltorio'), { cause: { code: '42501', message } });
    // lc_messages = en (Supabase), es y otros catálogos.
    for (const message of [
      'new row violates row-level security policy "deal_creator_scope" for table "deal"',
      'la nueva fila viola la política de seguridad de registros «deal_creator_scope» para la tabla «deal»',
      'new row violates row-level security policy “campaign_creator_scope” for table “campaign”',
    ]) {
      assert.ok(scopeErrorOf(rechazo(message)) instanceof ScopeError, message);
    }
    assert.equal(scopeErrorOf(rechazo('la nueva fila viola la política de seguridad de registros «deal_workspace» para la tabla «deal»')), null);
  });
});

describe('la guardia del esquema exige la política en las cuatro tablas', { timeout: DESCRIBE_DB_TIMEOUT_MS }, () => {
  const migrador = () => migratorRole(t);

  test('con 0082 aplicada no falta ninguna', async () => {
    const estado = await estadoDelEsquema(t.db);
    assert.deepEqual(estado.alcancePorCreador, []);
    assert.deepEqual(estado.funcionesDefiner, [], 'public_account_out_of_scope está declarada');
    assert.deepEqual(estado.funcionesQueFaltan, []);
  });

  test('sin la política de deal, la guardia nombra la tabla y la consulta cruda vuelve a enseñar lo de Sofía', async () => {
    await t.admin(`SET ROLE ${migrador()}; DROP POLICY deal_creator_scope ON deal; RESET ROLE`);
    try {
      const estado = await estadoDelEsquema(t.db);
      assert.deepEqual(estado.alcancePorCreador, ['deal (sin la política restrictiva por creador)']);
      assert.match(explicarEsquema(estado) ?? '', /faltan políticas de alcance por creador: .*: deal \(sin la política restrictiva por creador\)/);
      // La prueba de arriba muerde: sin la política, el miembro ve el negocio de Sofía.
      const filas = await miembro((tx) => crudas(tx, 'deal'));
      assert.ok(filas.some((f) => f.id === DEAL_SOFIA));
    } finally {
      await t.admin(`SET ROLE ${migrador()}; ${await readFile(MIGRACION, 'utf8')}; RESET ROLE`);
    }
    assert.deepEqual((await estadoDelEsquema(t.db)).alcancePorCreador, [], 'volver a correr 0082 la deja como estaba');
  });

  test('una tabla nueva con creator_id que no está en ninguna de las dos listas sale en la guardia', async () => {
    await t.admin(`SET ROLE ${migrador()};
      CREATE TABLE acc7_nueva (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, creator_id uuid);
      RESET ROLE`);
    try {
      const { alcancePorCreador } = await estadoDelEsquema(t.db);
      assert.deepEqual(alcancePorCreador, [
        'acc7_nueva (tiene creator_id y no está ni en TABLAS_CON_ALCANCE_POR_CREADOR ni en TABLAS_CON_CREADOR_SIN_POLITICA)',
      ]);
    } finally {
      await t.admin(`SET ROLE ${migrador()}; DROP TABLE acc7_nueva; RESET ROLE`);
    }
    assert.deepEqual((await estadoDelEsquema(t.db)).alcancePorCreador, []);
  });

  test('si alguien reescribe una función de la red (session_sees_all_creators(), el disparador, las SECURITY DEFINER…) para que no acote, la guardia lo dice', async () => {
    assert.deepEqual(Object.keys(CUERPOS_DEL_ALCANCE).sort(), [
      'creators_for_session(uuid)', 'deal_creator_locked(uuid,uuid)', 'membership_full_role_unscoped()', 'open_deal_out_of_scope(uuid)',
      'public_account_out_of_scope(text,text)', 'role_is_full_access(uuid)', 'scope_allows(text,uuid)', 'scope_allows(text,uuid[])',
      'session_sees_all_creators()', 'sole_creator_for_session(uuid)',
    ]);
    const sondas = [
      {
        firma: 'session_sees_all_creators()',
        sql: `CREATE OR REPLACE FUNCTION session_sees_all_creators() RETURNS boolean LANGUAGE sql STABLE
              SET search_path = public, extensions, pg_temp AS $$ SELECT true $$`,
      },
      {
        firma: 'scope_allows(text,uuid)',
        sql: 'CREATE OR REPLACE FUNCTION scope_allows(kind text, target uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$',
      },
      {
        firma: 'membership_full_role_unscoped()',
        sql: `CREATE OR REPLACE FUNCTION membership_full_role_unscoped() RETURNS trigger LANGUAGE plpgsql
              SET search_path = public, extensions, pg_temp AS $$ BEGIN RETURN NEW; END $$`,
      },
      {
        // Conexiones volvería a duplicar bajo otra creadora la cuenta por @ que ya existe (ACC-6 §6).
        firma: 'public_account_out_of_scope(text,text)',
        sql: `CREATE OR REPLACE FUNCTION public_account_out_of_scope(p_platform text, p_handle text) RETURNS boolean LANGUAGE sql
              STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$ SELECT false $$`,
      },
      {
        firma: 'open_deal_out_of_scope(uuid)',
        sql: `CREATE OR REPLACE FUNCTION open_deal_out_of_scope(p_company uuid) RETURNS boolean LANGUAGE sql
              STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$ SELECT false $$`,
      },
      {
        firma: 'deal_creator_locked(uuid,uuid)',
        sql: `CREATE OR REPLACE FUNCTION deal_creator_locked(p_deal uuid, p_creator uuid) RETURNS boolean LANGUAGE sql
              STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$ SELECT false $$`,
      },
      {
        firma: 'role_is_full_access(uuid)',
        sql: `CREATE OR REPLACE FUNCTION role_is_full_access(p_role uuid) RETURNS boolean LANGUAGE sql
              STABLE SET search_path = public, extensions, pg_temp AS $$ SELECT false $$`,
      },
    ];
    try {
      for (const { firma, sql } of sondas) {
        await t.admin(`SET ROLE ${migrador()}; ${sql}; RESET ROLE`);
        const { alcancePorCreador } = await estadoDelEsquema(t.db);
        assert.equal(alcancePorCreador.length, 1, firma);
        assert.match(alcancePorCreador[0] ?? '', new RegExp(`^${firma.replace(/[()[\]]/g, '\\$&')} \\(su cuerpo no es el de 00(82|40)`), firma);
        if (firma === 'session_sees_all_creators()') {
          // Y la sonda muerde: con la función en `true`, el miembro vuelve a ver lo de Sofía.
          assert.ok((await miembro((tx) => crudas(tx, 'deal'))).some((f) => f.id === DEAL_SOFIA));
        }
        if (firma === 'public_account_out_of_scope(text,text)') {
          // Muerde: el @ de Sofía deja de ser «de otra creadora» para el miembro, y Conexiones la duplicaría.
          const v = await miembro((tx) => tx.query<{ v: boolean }>('SELECT public_account_out_of_scope($1, $2) AS v', ['tiktok', 'sofia.viaja']));
          assert.equal(v.rows[0]?.v, false, 'reescrita, ya no avisa: por eso la guardia fija su cuerpo');
        }
        await t.admin(`SET ROLE ${migrador()}; ${await readFile(firma.startsWith('scope_allows') ? MIGRACION_0040 : MIGRACION, 'utf8')}; RESET ROLE`);
      }
    } finally {
      await t.admin(`SET ROLE ${migrador()}; ${await readFile(MIGRACION_0040, 'utf8')}; ${await readFile(MIGRACION, 'utf8')}; RESET ROLE`);
    }
    assert.deepEqual((await estadoDelEsquema(t.db)).alcancePorCreador, []);
  });

  test('una política con el nombre pero sin la forma (permisiva, otra condición, WITH CHECK, TO PUBLIC u otro rol) tampoco cuenta', async () => {
    const variantes = [
      'CREATE POLICY post_creator_scope ON post AS PERMISSIVE FOR ALL TO mc_app USING ((SELECT session_sees_all_creators()) OR scope_allows(\'creator\', creator_id))',
      'CREATE POLICY post_creator_scope ON post AS RESTRICTIVE FOR ALL TO mc_app USING (true)',
      'CREATE POLICY post_creator_scope ON post AS RESTRICTIVE FOR SELECT TO mc_app USING ((SELECT session_sees_all_creators()) OR scope_allows(\'creator\', creator_id))',
      'CREATE POLICY post_creator_scope ON post AS RESTRICTIVE FOR ALL TO mc_app USING ((SELECT session_sees_all_creators()) OR scope_allows(\'creator\', creator_id)) WITH CHECK (true)',
      `CREATE POLICY post_creator_scope ON post AS RESTRICTIVE FOR ALL TO ${migrador()} USING ((SELECT session_sees_all_creators()) OR scope_allows('creator', creator_id))`,
      // Con la forma exacta pero TO PUBLIC: acota a mc_app (la consulta cruda sale bien) y rompe el enlace público (0030).
      `CREATE POLICY post_creator_scope ON post AS RESTRICTIVE FOR ALL TO PUBLIC USING ((SELECT session_sees_all_creators()) OR scope_allows('creator', creator_id))`,
      // Y TO mc_app más otro rol: tampoco es «solo la web».
      `CREATE POLICY post_creator_scope ON post AS RESTRICTIVE FOR ALL TO mc_app, ${migrador()} USING ((SELECT session_sees_all_creators()) OR scope_allows('creator', creator_id))`,
    ];
    try {
      for (const variante of variantes) {
        await t.admin(`SET ROLE ${migrador()}; DROP POLICY IF EXISTS post_creator_scope ON post; ${variante}; RESET ROLE`);
        const { alcancePorCreador } = await estadoDelEsquema(t.db);
        assert.equal(alcancePorCreador.length, 1, variante);
        assert.match(alcancePorCreador[0] ?? '', /^post \(/, variante);
        if (/ TO PUBLIC | TO mc_app, /.test(variante)) {
          assert.match(alcancePorCreador[0] ?? '', /debe ser TO mc_app, y solo mc_app: TO PUBLIC rompe los enlaces públicos \(0030\)/, variante);
        }
      }
    } finally {
      await t.admin(`SET ROLE ${migrador()}; ${await readFile(MIGRACION, 'utf8')}; RESET ROLE`);
    }
    assert.deepEqual((await estadoDelEsquema(t.db)).alcancePorCreador, []);
  });
});

describe('0082 en una base con datos: los negocios de antes y la guardia de §2 (ronda 2, hallazgos 5, 10 y 11)', { timeout: DESCRIBE_DB_TIMEOUT_MS }, () => {
  const WS_LEGADO = '0000000e-0000-4000-8000-000000000001';
  const DUENA_LEGADO = '0000000e-0000-4000-8000-000000000002';
  const MANAGER_LEGADO = '0000000e-0000-4000-8000-000000000003';
  const CREADORA_LEGADO = '0000000e-0000-4000-8000-000000000004';
  const MARCA_LEGADO = '0000000e-0000-4000-8000-0000000000e1';
  const DEAL_LEGADO = '0000000e-0000-4000-8000-00000000dea1';
  const CAMPANA_LEGADO = '0000000e-0000-4000-8000-000000ca0001';
  const DEAL_AGENCIA_LEGADO = '0000000e-0000-4000-8000-00000000dea2';
  const manager = <T>(fn: (tx: WorkspaceTx) => Promise<T>) => como(WS_LEGADO, MANAGER_LEGADO, fn);
  /** 0082 como la aplica el integrador: con el rol que migra, dueño de las tablas y con su RLS forzada. */
  const aplicar0082 = async () => t.admin(`SET ROLE ${migratorRole(t)}; ${await readFile(MIGRACION, 'utf8')}; RESET ROLE`);

  before(async () => {
    await t.admin(`
      INSERT INTO workspace (id, slug, name, kind) VALUES ('${WS_LEGADO}', 'acc7-legado', 'Espacio de antes', 'creator') ON CONFLICT DO NOTHING;
      INSERT INTO app_user (id, email) VALUES
        ('${DUENA_LEGADO}', 'duena.legado@ejemplo.com'), ('${MANAGER_LEGADO}', 'manager.legado@ejemplo.com')
      ON CONFLICT DO NOTHING;
      INSERT INTO membership (workspace_id, user_id, role_id) VALUES
        ('${WS_LEGADO}', '${DUENA_LEGADO}', system_role_id('creator', 'owner')),
        ('${WS_LEGADO}', '${MANAGER_LEGADO}', system_role_id('creator', 'manager'))
      ON CONFLICT DO NOTHING;
      INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${CREADORA_LEGADO}', '${WS_LEGADO}', 'La de antes') ON CONFLICT DO NOTHING;
      INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id)
        VALUES ('${WS_LEGADO}', '${MANAGER_LEGADO}', 'creator', '${CREADORA_LEGADO}') ON CONFLICT DO NOTHING;
      INSERT INTO company (id, name, owner_workspace_id) VALUES ('${MARCA_LEGADO}', 'Marca de antes', '${WS_LEGADO}') ON CONFLICT DO NOTHING;
      INSERT INTO company_link (workspace_id, company_id, relationship) VALUES ('${WS_LEGADO}', '${MARCA_LEGADO}', 'client') ON CONFLICT DO NOTHING;
      INSERT INTO deal (id, workspace_id, company_id, creator_id, name, stage_id)
        VALUES ('${DEAL_LEGADO}', '${WS_LEGADO}', '${MARCA_LEGADO}', NULL, 'Negocio de antes de ACC-7', 'nuevo') ON CONFLICT DO NOTHING;
      ALTER TABLE deal DISABLE TRIGGER deal_updated;
      UPDATE deal SET updated_at = '2026-09-01T10:00:00Z' WHERE id = '${DEAL_LEGADO}';
      ALTER TABLE deal ENABLE TRIGGER deal_updated;
      INSERT INTO campaign (id, workspace_id, company_id, creator_id, name, status)
        VALUES ('${CAMPANA_LEGADO}', '${WS_LEGADO}', '${MARCA_LEGADO}', NULL, 'Campaña de antes', 'planned') ON CONFLICT DO NOTHING;
      INSERT INTO deal (id, workspace_id, company_id, creator_id, name, stage_id)
        VALUES ('${DEAL_AGENCIA_LEGADO}', '${WS_AGENCIA}', '${MARCA_AGENCIA}', NULL, 'De la agencia, de antes', 'nuevo') ON CONFLICT DO NOTHING;
    `);
  });

  test('en un espacio de una sola creadora, el negocio y la campaña de antes pasan a ser suyos y su mánager acotado los ve', async () => {
    const vistos = () => manager(async (tx) => ({
      negocio: (await tx.query('SELECT 1 FROM deal WHERE id = $1', [DEAL_LEGADO])).rows.length,
      campana: (await tx.query('SELECT 1 FROM campaign WHERE id = $1', [CAMPANA_LEGADO])).rows.length,
    }));
    assert.deepEqual(await vistos(), { negocio: 0, campana: 0 }, 'antes del relleno, un NULL no cae en su alcance');
    await aplicar0082();
    assert.deepEqual(await vistos(), { negocio: 1, campana: 1 });
    const fila = await t.db.asWorker((tx) => tx.query<{ creator_id: string; updated_at: string }>(
      `SELECT creator_id, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS updated_at FROM deal WHERE id = $1`,
      [DEAL_LEGADO],
    )).then((r) => r.rows[0]);
    assert.deepEqual(fila, { creator_id: CREADORA_LEGADO, updated_at: '2026-09-01T10:00:00' }, 'a nombre de su creadora y sin tocar updated_at');
    // Con varios creadores no se adivina: el de la agencia sigue sin creador.
    const deLaAgencia = await t.db.asWorker((tx) => tx.query<{ creator_id: string | null }>(
      'SELECT creator_id FROM deal WHERE id = $1', [DEAL_AGENCIA_LEGADO],
    )).then((r) => r.rows);
    assert.deepEqual(deLaAgencia, [{ creator_id: null }]);
    // Lo nuevo del espacio, en el worker, nace a nombre de la misma creadora.
    assert.deepEqual(await t.db.asWorker((tx) => soleCreatorFor(tx, WS_LEGADO)), { creatorId: CREADORA_LEGADO, seesAll: true });
    const sinFuerza = await t.raw<{ relname: string }>(
      `SELECT relname::text FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND NOT relforcerowsecurity
          AND relname IN ('deal', 'campaign', 'creator_profile', 'membership_scope', 'membership', 'role')`,
    );
    assert.deepEqual(sinFuerza, [], 'las tablas vuelven a tener FORCE');
    const apagados = await t.raw<{ tgname: string }>(
      `SELECT tgname::text FROM pg_trigger WHERE tgname IN ('deal_updated', 'campaign_updated') AND tgenabled = 'D'`,
    );
    assert.deepEqual(apagados, [], 'y los disparadores de updated_at, encendidos');
  });

  test('si ya hubiera alcance de una Dueña, la migración se para aunque quien migra no vea esa fila con su RLS', async () => {
    await t.admin(`
      ALTER TABLE membership_scope DISABLE TRIGGER membership_scope_full_role_unscoped;
      INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id)
        VALUES ('${WS_LEGADO}', '${DUENA_LEGADO}', 'creator', '${CREADORA_LEGADO}');
      ALTER TABLE membership_scope ENABLE TRIGGER membership_scope_full_role_unscoped;
    `);
    try {
      // Quien migra, con su RLS forzada y sin espacio fijado, no ve esa
      // fila (lo demuestra «una fila de alcance cuya membresía la
      // transacción no ve»): por eso §2 le quita FORCE para preguntar.
      await assert.rejects(aplicar0082(), (err: unknown) =>
        /hay filas de membership_scope de personas con rol Dueño o Administrador/.test(mensajeDe(err)));
    } finally {
      await t.admin(`RESET ROLE; DELETE FROM membership_scope WHERE user_id = '${DUENA_LEGADO}'`);
    }
    await aplicar0082();
    assert.deepEqual((await estadoDelEsquema(t.db)).alcancePorCreador, []);
  });
});

/** El texto de un error y de toda su cadena `cause`. */
function mensajeDe(err: unknown): string {
  const partes: string[] = [];
  for (let e: unknown = err; typeof e === 'object' && e !== null; e = (e as { cause?: unknown }).cause) {
    partes.push(String((e as { message?: unknown }).message ?? ''));
  }
  return partes.join(' | ');
}
