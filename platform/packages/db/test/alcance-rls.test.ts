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
import type { WorkspaceTx } from '../src/client.ts';
import { findPgError } from '../src/pg-error.ts';
import { listCampaigns } from '../src/queries/campanas.ts';
import { acceptSignal, createDeal, createSignal, listDealCreatorOptions, listPipeline, VentasError } from '../src/queries/ventas.ts';
import { CREATOR_SCOPE_TABLES, ScopeError, scopeErrorOf, writeOrScopeError, type ScopeSavepoint } from '../src/scope.ts';
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
    assert.deepEqual(opciones, { creators: [{ id: CREADOR_A, name: 'Creador A' }], required: false }, 'solo el suyo, y no se pregunta');
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
    assert.deepEqual(opciones, { creators: [{ id: CREADORA_UNA, name: 'Una' }], required: false });
    const id = await como(WS_UNA, DUENA_UNA, (tx) => createDeal(tx, { companyId: MARCA_UNA, name: 'Primer negocio' }));
    assert.equal(await creadorDe(id), CREADORA_UNA);
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

  test('writeOrScopeError: el choque con una fila que la persona acotada no ve es ScopeError; para la dueña es el error de siempre', async () => {
    const otraCampanaDe = (quoteId: string) => (tx: WorkspaceTx) => writeOrScopeError(tx, 'campana_de_cotizacion', 'campaign_quote_id_active_key', () => tx.query(
      `INSERT INTO campaign (workspace_id, company_id, creator_id, quote_id, name, status)
       VALUES (current_workspace_id(), $1, $2, $3, 'Segunda viva', 'planned')`,
      [COMPANY_CAFE_ALMA, CREATOR_LAURA, quoteId],
    ));
    await t.admin(`UPDATE campaign SET quote_id = '${QUOTE_SOFIA_ENLACE}' WHERE id = '${CAMPAIGN_SOFIA}'`);
    try {
      await assert.rejects(miembro(async (tx) => {
        await assert.rejects(otraCampanaDe(QUOTE_SOFIA_ENLACE)(tx), ScopeError);
        // La transacción sigue usable después del SAVEPOINT.
        assert.equal((await tx.query('SELECT 1 AS uno')).rows.length, 1);
        throw new Error('fin');
      }), /fin/);
      await assert.rejects(duena(otraCampanaDe(QUOTE_SOFIA_ENLACE)), (e: unknown) => findPgError(e, '23505', 'campaign_quote_id_active_key') !== null);
    } finally {
      await t.admin(`UPDATE campaign SET quote_id = NULL WHERE id = '${CAMPAIGN_SOFIA}'`);
    }
  });

  test('writeOrScopeError: un SAVEPOINT que no es un identificador simple no llega al SQL', async () => {
    let escribio = false;
    await assert.rejects(
      duena((tx) => writeOrScopeError(tx, 'x; DROP TABLE deal; --' as ScopeSavepoint, 'campaign_quote_id_active_key', async () => {
        escribio = true;
      })),
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

  test('si alguien reescribe session_sees_all_creators() o el disparador para que no acoten, la guardia lo dice', async () => {
    assert.deepEqual(Object.keys(CUERPOS_DEL_ALCANCE).sort(), [
      'membership_full_role_unscoped()', 'scope_allows(text,uuid)', 'scope_allows(text,uuid[])', 'session_sees_all_creators()',
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
        await t.admin(`SET ROLE ${migrador()}; ${await readFile(firma.startsWith('scope_allows') ? MIGRACION_0040 : MIGRACION, 'utf8')}; RESET ROLE`);
      }
    } finally {
      await t.admin(`SET ROLE ${migrador()}; ${await readFile(MIGRACION_0040, 'utf8')}; ${await readFile(MIGRACION, 'utf8')}; RESET ROLE`);
    }
    assert.deepEqual((await estadoDelEsquema(t.db)).alcancePorCreador, []);
  });

  test('una política con el nombre pero sin la forma (permisiva, con otra condición o con WITH CHECK) tampoco cuenta', async () => {
    const variantes = [
      'CREATE POLICY post_creator_scope ON post AS PERMISSIVE FOR ALL TO mc_app USING ((SELECT session_sees_all_creators()) OR scope_allows(\'creator\', creator_id))',
      'CREATE POLICY post_creator_scope ON post AS RESTRICTIVE FOR ALL TO mc_app USING (true)',
      'CREATE POLICY post_creator_scope ON post AS RESTRICTIVE FOR SELECT TO mc_app USING ((SELECT session_sees_all_creators()) OR scope_allows(\'creator\', creator_id))',
      'CREATE POLICY post_creator_scope ON post AS RESTRICTIVE FOR ALL TO mc_app USING ((SELECT session_sees_all_creators()) OR scope_allows(\'creator\', creator_id)) WITH CHECK (true)',
      `CREATE POLICY post_creator_scope ON post AS RESTRICTIVE FOR ALL TO ${migrador()} USING ((SELECT session_sees_all_creators()) OR scope_allows('creator', creator_id))`,
    ];
    try {
      for (const variante of variantes) {
        await t.admin(`SET ROLE ${migrador()}; DROP POLICY IF EXISTS post_creator_scope ON post; ${variante}; RESET ROLE`);
        const { alcancePorCreador } = await estadoDelEsquema(t.db);
        assert.equal(alcancePorCreador.length, 1, variante);
        assert.match(alcancePorCreador[0] ?? '', /^post \(/, variante);
      }
    } finally {
      await t.admin(`SET ROLE ${migrador()}; ${await readFile(MIGRACION, 'utf8')}; RESET ROLE`);
    }
    assert.deepEqual((await estadoDelEsquema(t.db)).alcancePorCreador, []);
  });
});
