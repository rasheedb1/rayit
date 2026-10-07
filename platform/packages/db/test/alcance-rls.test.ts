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
import { estadoDelEsquema, explicarEsquema, TABLAS_CON_ALCANCE_POR_CREADOR } from '../src/esquema.ts';
import type { WorkspaceTx } from '../src/client.ts';
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

// La agencia: dos creadores, una dueña sin alcance, una administradora
// a la que alguien dejó una fila de alcance, y un ejecutivo acotado a A.
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
      ('${WS_AGENCIA}', '${ADMIN_AGENCIA}', 'creator', '${CREADOR_A}'),
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

/** El código de Postgres del error, buscado en la cadena `cause`. */
function codigoDe(err: unknown): string | null {
  for (let e: unknown = err; typeof e === 'object' && e !== null; e = (e as { cause?: unknown }).cause) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return null;
}
const rechazoDeRls = (err: unknown) => codigoDe(err) === '42501';

describe('una consulta cruda, sin scopeFilter(), sobre las cuatro tablas', { timeout: DESCRIBE_DB_TIMEOUT_MS }, () => {
  test('las cuatro son exactamente las de la guardia', () => {
    assert.deepEqual(Object.keys(DE_SOFIA).sort(), Object.keys(TABLAS_CON_ALCANCE_POR_CREADOR).sort());
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
