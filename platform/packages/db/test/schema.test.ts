/**
 * La migración manda: el esquema Drizzle se compara, columna por
 * columna, con lo que db/migrations dejó en Postgres embebido. Nombre,
 * tipo, nulabilidad y default de cada tabla; nombre y tipo de cada
 * vista; y que ninguna columna de la base falte en el esquema.
 *
 * Y el aislamiento, con la guardia INVERTIDA (src/esquema.ts): no se
 * comprueba una lista de tablas que alguien escribió a mano, se le
 * pregunta a la base cuáles hay y se exige aislamiento en TODAS, salvo
 * las que EXCEPCIONES_SIN_AISLAMIENTO declara con su motivo. Una tabla
 * nueva sin política y sin excepción declarada rompe esta prueba: es la
 * única forma de que no vuelva a pasar lo de la fase 1, donde cada
 * ronda tapaba los casos que le nombraban y la siguiente encontraba los
 * que la lista no mencionaba (workspace incluida, que se podía BORRAR).
 *
 * Si esta prueba falla tras una migración nueva, se cura src/schema/
 * (pnpm --filter @mc/db introspect ayuda). Nunca al revés.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getTableColumns, getTableName, getViewName, getViewSelectedFields, is } from 'drizzle-orm';
import { PgColumn, PgTable, PgView } from 'drizzle-orm/pg-core';
import {
  APP_ROLE, estadoDelEsquema, EXCEPCIONES_SIN_AISLAMIENTO, explicarEsquema, PRIVILEGIOS, PRIVILEGIOS_DE_LA_APP,
  type EstadoDelEsquema,
} from '../src/esquema.ts';
import * as schema from '../src/schema/index.ts';
import { openTestDb, type TestDb } from './pglite.ts';

/** Las tablas y vistas que el backlog (CIM-2) exige en el esquema del MVP. */
const TABLAS_MVP = [
  'workspace', 'app_user', 'membership', 'creator_profile', 'niche', 'niche_cpm_benchmark', 'platform',
  'social_connection', 'data_consent', 'post', 'post_metric_snapshot', 'account_metric_snapshot',
  'audience_breakdown', 'creator_baseline', 'post_score', 'company', 'contact', 'company_link', 'signal',
  'signal_source', 'pipeline_stage', 'deal', 'deal_stage_history', 'activity', 'outbound_brief',
  'outbound_policy', 'outbound_sequence', 'outbound_touch', 'rate_card', 'rate_card_item', 'media_kit',
  'quote', 'quote_item', 'campaign', 'campaign_post', 'campaign_result', 'invoice', 'payment', 'expense',
  'platform_payout', 'tax_reserve', 'notification', 'job_definition', 'job_run', 'feature_flag',
];
const VISTAS_MVP = [
  'post_metrics_latest', 'post_metrics_at_cut', 'post_metrics_daily_delta', 'creator_post_board',
  'connection_health', 'deal_pipeline', 'receivables', 'outbound_touch_recent',
];

/**
 * Aquí NO hay lista de tablas que deban estar aisladas, y eso es lo que
 * cambió: la única lista que queda es la de EXCEPCIONES, en
 * src/esquema.ts, y la usa también assertSchemaUpToDate en tiempo de
 * ejecución contra Supabase. Lo demás lo trae la base.
 */

interface ColumnRow extends Record<string, unknown> {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
}
interface RelRow extends Record<string, unknown> {
  name: string;
  kind: 'table' | 'view';
  rls: boolean;
  /** Sin FORCE, el dueño de la tabla (mc_migrator: migraciones y seeds) se salta la política. */
  forzada: boolean;
  politicas: number;
  /** Vistas: sin security_invoker leen sus tablas base como su DUEÑO. */
  invocador: boolean;
}
interface FkRow extends Record<string, unknown> {
  child: string;
  fk: string;
  parent: string;
  obligatoria: boolean;
}
interface GrantRow extends Record<string, unknown> {
  relname: string;
  privilegio: string;
}

const ARRAY_UDT: Record<string, string> = { _text: 'text[]', _uuid: 'uuid[]', _int4: 'integer[]' };

/** Normaliza information_schema al vocabulario de column.getSQLType(). */
function dbType(c: ColumnRow): string {
  if (c.data_type === 'ARRAY') return ARRAY_UDT[c.udt_name] ?? `${c.udt_name}[]`;
  if (c.data_type === 'USER-DEFINED') return c.udt_name;
  if (c.data_type === 'character') return `char(${c.character_maximum_length})`;
  if (c.data_type === 'numeric') {
    return c.numeric_precision === null ? 'numeric' : `numeric(${c.numeric_precision}, ${c.numeric_scale})`;
  }
  return c.data_type;
}

function drizzleType(col: PgColumn): string {
  const t = col.getSQLType();
  return t === 'bigserial' ? 'bigint' : t;
}

let t: TestDb;
const columns = new Map<string, Map<string, ColumnRow>>();
const relations = new Map<string, RelRow>();
/** Tablas sin RLS con una FK hacia una tabla con RLS: hijas que se quedaron sin aislar. */
let childrenWithoutRls: FkRow[] = [];
/** Lo que mc_app puede hacer, tabla por tabla, leído de pg_class.relacl. */
const privilegiosDeLaApp = new Map<string, Set<string>>();
/**
 * Lo que dice la guardia de src/esquema.ts sobre esta base. Las pruebas
 * de aislamiento NO tienen su propio criterio de «aislada»: la ronda 2
 * tenía aquí una copia de la regex de la guardia, y las dos daban por
 * buena una tabla con una política abierta junto a una cerrada. Ahora
 * solo hay un criterio, el de src/politicas.ts.
 */
let estado: EstadoDelEsquema;

before(async () => {
  t = await openTestDb({ seeds: false });
  const cols = await t.db.withCatalogs((tx) =>
    tx.query<ColumnRow>(`
      SELECT table_name, column_name, data_type, udt_name, character_maximum_length,
             numeric_precision, numeric_scale, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = 'public'`),
  );
  for (const c of cols.rows) {
    if (!columns.has(c.table_name)) columns.set(c.table_name, new Map());
    columns.get(c.table_name)!.set(c.column_name, c);
  }
  const rels = await t.db.withCatalogs((tx) =>
    tx.query<RelRow>(`
      SELECT c.relname AS name,
             CASE c.relkind WHEN 'v' THEN 'view' ELSE 'table' END AS kind,
             c.relrowsecurity AS rls,
             c.relforcerowsecurity AS forzada,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS politicas,
             coalesce(c.reloptions @> ARRAY['security_invoker=on'], false) AS invocador
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v')`),
  );
  for (const r of rels.rows) relations.set(r.name, r);
  const fks = await t.db.withCatalogs((tx) =>
    tx.query<FkRow>(`
      SELECT c.relname AS child, a.attname AS fk, p.relname AS parent, a.attnotnull AS obligatoria
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_class p ON p.oid = k.confrelid
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.conkey[1]
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND k.contype = 'f'
        AND NOT c.relrowsecurity AND p.relrowsecurity
      ORDER BY 1, 2`),
  );
  // Sin el filtro por a.attnotnull que tenía antes: una FK OPCIONAL
  // hacia una tabla aislada deja el mismo agujero (api_call_log y
  // api_quota_usage colgaban de social_connection así, y desde B se
  // leían los endpoints y los errores de A). La rama «fk IS NULL» es
  // parte de la política, no una excusa para no tenerla.
  childrenWithoutRls = fks.rows;
  const grants = await t.db.withCatalogs((tx) =>
    tx.query<GrantRow>(
      `SELECT c.relname AS relname, a.privilege_type AS privilegio
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(c.relacl) a
         JOIN pg_roles r ON r.oid = a.grantee
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v') AND r.rolname = $1`,
      [APP_ROLE],
    ),
  );
  for (const g of grants.rows) {
    let s = privilegiosDeLaApp.get(g.relname);
    if (!s) {
      s = new Set();
      privilegiosDeLaApp.set(g.relname, s);
    }
    s.add(g.privilegio);
  }
  estado = await estadoDelEsquema(t.db);
}, { timeout: 600_000 });

after(async () => {
  await t.close();
});

const exported: unknown[] = Object.values(schema);
const tables = exported.filter((v): v is PgTable => is(v, PgTable));
const views = exported.filter((v): v is PgView => is(v, PgView));

describe('el esquema Drizzle coincide con db/migrations', () => {
  test('exporta todas las tablas y vistas del MVP', () => {
    const names = new Set(tables.map((x) => getTableName(x)));
    const missing = TABLAS_MVP.filter((n) => !names.has(n));
    assert.deepEqual(missing, [], `tablas del MVP sin declarar: ${missing.join(', ')}`);
    const viewNames = new Set(views.map((v) => getViewName(v)));
    const missingViews = VISTAS_MVP.filter((n) => !viewNames.has(n));
    assert.deepEqual(missingViews, [], `vistas del MVP sin declarar: ${missingViews.join(', ')}`);
  });

  for (const table of tables) {
    const name = getTableName(table);
    test(`tabla ${name}`, () => {
      assert.equal(relations.get(name)?.kind, 'table', `${name} no existe como tabla en la base`);
      const inDb = columns.get(name);
      assert.ok(inDb, `${name} sin columnas en information_schema`);
      const declared = new Set<string>();
      for (const col of Object.values(getTableColumns(table))) {
        declared.add(col.name);
        const c = inDb.get(col.name);
        assert.ok(c, `${name}.${col.name} no existe en la base`);
        assert.equal(drizzleType(col), dbType(c), `${name}.${col.name}: tipo`);
        assert.equal(col.notNull, c.is_nullable === 'NO', `${name}.${col.name}: NOT NULL`);
        assert.equal(col.hasDefault, c.column_default !== null, `${name}.${col.name}: DEFAULT`);
      }
      const undeclared = [...inDb.keys()].filter((c) => !declared.has(c));
      assert.deepEqual(undeclared, [], `${name}: columnas de la base que faltan en el esquema`);
    });
  }

  for (const view of views) {
    const name = getViewName(view);
    test(`vista ${name}`, () => {
      assert.equal(relations.get(name)?.kind, 'view', `${name} no existe como vista en la base`);
      const inDb = columns.get(name);
      assert.ok(inDb, `${name} sin columnas en information_schema`);
      const declared = new Set<string>();
      for (const field of Object.values(getViewSelectedFields(view))) {
        assert.ok(is(field, PgColumn), `${name}: campo que no es columna`);
        declared.add(field.name);
        const c = inDb.get(field.name);
        assert.ok(c, `${name}.${field.name} no existe en la base`);
        assert.equal(drizzleType(field), dbType(c), `${name}.${field.name}: tipo`);
      }
      const undeclared = [...inDb.keys()].filter((c) => !declared.has(c));
      assert.deepEqual(undeclared, [], `${name}: columnas de la base que faltan en el esquema`);
    });
  }
});


/**
 * LA GUARDIA INVERTIDA.
 *
 * Ninguna de estas pruebas enumera las tablas que deberían estar
 * aisladas: las trae de la base. Lo único escrito a mano es la lista de
 * EXCEPCIONES, en src/esquema.ts, y cada entrada lleva su motivo. Una
 * tabla nueva sin política y sin excepción rompe la primera prueba; una
 * excepción que ya no corresponde rompe la segunda; un GRANT de más
 * rompe la tercera.
 */
describe('aislamiento por workspace en la base', () => {
  /**
   * Aislada = ENABLE + FORCE + al menos una política + que CADA política
   * permisiva aísle por sí sola, en cada comando que mc_app tiene. Es el
   * criterio de src/esquema.ts, sin copia: la ronda 2 tenía aquí su
   * propia regex («alguna política menciona el inquilino») y aceptaba
   * `USING (1 = 1)` junto a una buena.
   */
  const aislada = (name: string) => estado.aisladas.includes(name);
  const tablas = () => [...relations.values()].filter((r) => r.kind === 'table').map((r) => r.name).sort();

  test('TODA tabla de public está aislada, o declarada como excepción con su motivo', () => {
    // Esta es la prueba que la fase 1 no tenía. La anterior preguntaba
    // «¿estas 53 tablas tienen RLS?» y por eso no vio `workspace` —la
    // raíz del inquilino, cuya clave se llama `id` y no workspace_id—,
    // ni los catálogos, ni api_call_log. Aquí la lista la pone la base.
    const sinAislar = tablas().filter((n) => !aislada(n) && !(n in EXCEPCIONES_SIN_AISLAMIENTO));
    assert.deepEqual(
      sinAislar,
      [],
      `tablas sin RLS, sin FORCE o sin política, y sin excepción declarada: ${sinAislar.join(', ')}. ` +
        'O les pones política en una migración nueva, o declaras por qué son globales en EXCEPCIONES_SIN_AISLAMIENTO.',
    );
  });

  test('la lista de excepciones no se pudre: cada una existe y sigue sin política', () => {
    const existen = new Set(tablas());
    const sobran = Object.keys(EXCEPCIONES_SIN_AISLAMIENTO).filter((n) => !existen.has(n) || aislada(n));
    assert.deepEqual(sobran, [], `excepciones que ya no corresponden: ${sobran.join(', ')}`);
    for (const [tabla, motivo] of Object.entries(EXCEPCIONES_SIN_AISLAMIENTO)) {
      assert.ok(motivo.length > 20, `la excepción de ${tabla} no explica nada: "${motivo}"`);
    }
  });

  test('workspace, la raíz del inquilino, está aislada y no se puede BORRAR desde la app', () => {
    // El hallazgo bloqueante de la fase 1: mc_app tenía los cuatro
    // privilegios sobre workspace y no había política, así que cualquier
    // transacción de la aplicación leía, renombraba y borraba los
    // workspaces ajenos, y el DELETE cascadeaba a todos sus datos.
    assert.ok(aislada('workspace'), 'workspace sin RLS: se leen, renombran y borran los inquilinos ajenos');
    assert.equal(columns.get('workspace')?.has('workspace_id'), false, 'su clave de inquilino es id, no workspace_id');
    assert.equal(privilegiosDeLaApp.get('workspace')?.has('DELETE'), false, 'mc_app puede borrar inquilinos');
  });

  test(`${APP_ROLE} no tiene ni un privilegio de más sobre lo que el paquete declara de solo lectura`, () => {
    // RLS no protege una tabla sin política: la protege el GRANT. Los
    // revisores midieron 99 relaciones × 4 privilegios contra la
    // Supabase real y salieron los cuatro en todas, catálogos incluidos.
    const deMas: string[] = [];
    for (const [tabla, { permite }] of Object.entries(PRIVILEGIOS_DE_LA_APP)) {
      const tiene = privilegiosDeLaApp.get(tabla);
      if (!tiene) continue;
      const sobran = PRIVILEGIOS.filter((p) => tiene.has(p) && !permite.includes(p));
      if (sobran.length) deMas.push(`${tabla}: ${sobran.join(', ')}`);
    }
    assert.deepEqual(deMas, [], `privilegios que la migración 0024 revocó y alguien devolvió: ${deMas.join(' · ')}`);
  });

  test('ninguna tabla sin RLS apunta con una clave ajena a una tabla con RLS, ni siquiera opcional', () => {
    // 0018 cerró las hijas con la FK NOT NULL y dejó las opcionales «a
    // decisión del módulo»: así se quedaron abiertas api_call_log,
    // api_quota_usage, brand_account_snapshot, trait_lift y
    // external_post. Que la columna admita NULL es una rama de la
    // política, no una excusa para no tenerla.
    const gaps = childrenWithoutRls
      .filter((r) => !(r.child in EXCEPCIONES_SIN_AISLAMIENTO))
      .map((r) => `${r.child}.${r.fk}${r.obligatoria ? '' : '?'} → ${r.parent}`);
    assert.deepEqual(gaps, [], `hijas de una tabla de tenant sin RLS: ${gaps.join(', ')}`);
  });

  test('toda tabla con workspace_id, obligatorio u opcional, está aislada', () => {
    // La regla vieja solo miraba workspace_id NOT NULL, y por ahí se
    // colaron pipeline_stage y feature_flag (workspace_id NULL = fila
    // global) hasta 0020.
    for (const [name, cols] of columns) {
      if (relations.get(name)?.kind !== 'table') continue;
      if (!cols.has('workspace_id')) continue;
      assert.ok(aislada(name), `${name} tiene workspace_id y no está aislada`);
    }
  });

  test('las tres piezas del aislamiento, no solo la primera: ENABLE, FORCE y política', () => {
    const sinForce = tablas().filter((n) => relations.get(n)?.rls && !relations.get(n)?.forzada);
    assert.deepEqual(sinForce, [], `con RLS pero sin FORCE (mc_migrator se la salta): ${sinForce.join(', ')}`);
    const sinPolitica = tablas().filter((n) => relations.get(n)?.rls && relations.get(n)?.politicas === 0);
    assert.deepEqual(sinPolitica, [], `con RLS y sin ninguna política (niega en vez de aislar): ${sinPolitica.join(', ')}`);
  });

  test('contact y app_user llevan RLS aunque no tengan workspace_id (PII)', () => {
    for (const name of ['contact', 'app_user']) {
      assert.equal(columns.get(name)?.has('workspace_id'), false, `${name} ya tiene workspace_id`);
      assert.ok(aislada(name), `${name} guarda datos personales y tiene que llevar RLS (0019/0020)`);
    }
  });

  test('contact y company se aíslan por owner_workspace_id, y el dueño lo pone la base', () => {
    // company se describía como «catálogo global sin PII» y por eso se
    // quedó sin RLS: pero el CRM la escribe, y desde B se renombraba y
    // se BORRABA una empresa que dio de alta A (y borrarla arrastra sus
    // contactos por ON DELETE CASCADE). Desde 0024 lleva el mismo dueño
    // explícito que contact desde 0020.
    for (const name of ['contact', 'company']) {
      const owner = columns.get(name)?.get('owner_workspace_id');
      assert.ok(owner, `${name}.owner_workspace_id no existe`);
      assert.equal(owner.data_type, 'uuid');
      assert.equal(owner.column_default, 'current_workspace_id()', 'el dueño lo pone la base, no la pantalla');
    }
  });

  test('current_user_id() existe y devuelve NULL hasta que CIM-3 fije app.user_id', async () => {
    const { rows } = await t.db.withCatalogs((tx) =>
      tx.query<{ uid: string | null }>('SELECT current_user_id()::text AS uid'),
    );
    assert.equal(rows[0]?.uid, null);
  });

  test('ninguna política permisiva del esquema está abierta sin declararlo', () => {
    // La primera versión de company_read era `true`, y la ronda 2 solo
    // buscaba ese literal. Una política permisiva abierta anula a las
    // demás de su tabla (se combinan con OR), así que la guardia evalúa
    // cada una: `1 = 1`, `current_workspace_id() IS NOT NULL` o un
    // EXISTS sin correlación tampoco pasan.
    assert.deepEqual(
      estado.politicasAbiertas.map((p) => `${p.clave} [${p.comandos.join(', ')}] por «${p.trozo}»`),
      [],
    );
  });

  test('toda vista corre con security_invoker: si no, rodea los GRANT de mc_app', () => {
    // En Postgres una vista es SECURITY DEFINER por omisión y lee sus
    // tablas base con los privilegios de su DUEÑO (mc_migrator, que
    // puede todo). Reproducido: una vista sobre `niche` deja hacer
    // UPDATE a mc_app, que 0024 §7.1 acaba de dejar sin escritura.
    const sinInvocador = [...relations.values()]
      .filter((r) => r.kind === 'view' && !r.invocador)
      .map((r) => r.name);
    assert.deepEqual(
      sinInvocador,
      [],
      `vistas que leen con los privilegios de mc_migrator: ${sinInvocador.join(', ')}. ` +
        'Ponles ALTER VIEW … SET (security_invoker = on) en una migración (0024 §8 lo hace en bucle sobre pg_class).',
    );
    const vistas = [...relations.values()].filter((r) => r.kind === 'view');
    assert.ok(vistas.length >= 10, `solo ${vistas.length} vistas: la prueba no está mirando nada`);
  });

  test('cada excepción sin RLS dice además qué puede hacer mc_app con ella', () => {
    // Sin RLS lo único que protege una tabla es el GRANT, así que una
    // excepción declarada sin su entrada de privilegios nace sin
    // ninguno de los dos candados —y con los cuatro privilegios, que
    // ALTER DEFAULT PRIVILEGES le da al nacer—. Las dos mitades de la
    // guardia la darían por buena.
    const huerfanas = Object.keys(EXCEPCIONES_SIN_AISLAMIENTO).filter((t) => !(t in PRIVILEGIOS_DE_LA_APP));
    assert.deepEqual(huerfanas, [], `excepciones sin entrada en PRIVILEGIOS_DE_LA_APP: ${huerfanas.join(', ')}`);
  });

  test('y la misma guardia, en tiempo de ejecución, no reporta nada contra esta base', async () => {
    // Es literalmente lo que corre assertSchemaUpToDate al construir el
    // cliente contra Supabase: si esto pasa aquí y allá falla, es que
    // allá falta una migración.
    const ahora = await estadoDelEsquema(t.db);
    assert.deepEqual(ahora.sinAislar, [], JSON.stringify(ahora.sinAislar));
    assert.deepEqual(ahora.excepcionesObsoletas, []);
    assert.deepEqual(ahora.privilegiosDeMas, [], JSON.stringify(ahora.privilegiosDeMas));
    assert.deepEqual(ahora.referenciasSinComprobar, []);
    assert.deepEqual(ahora.rolesDeMas, [], JSON.stringify(ahora.rolesDeMas));
    assert.equal(explicarEsquema(ahora), null, String(explicarEsquema(ahora)));
  });
});
