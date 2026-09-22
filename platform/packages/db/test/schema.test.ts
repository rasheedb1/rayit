/**
 * La migración manda: el esquema Drizzle se compara, columna por
 * columna, con lo que db/migrations dejó en Postgres embebido. Nombre,
 * tipo, nulabilidad y default de cada tabla; nombre y tipo de cada
 * vista; y que ninguna columna de la base falte en el esquema.
 *
 * Y el aislamiento: qué tablas son de tenant (directamente, por
 * workspace_id, o por ser hijas de una que lo tiene) y que todas tengan
 * RLS activo. La lista es explícita a propósito: una tabla nueva sin
 * aislamiento no pasa en verde por no tener workspace_id.
 *
 * Si esta prueba falla tras una migración nueva, se cura src/schema/
 * (pnpm --filter @mc/db introspect ayuda). Nunca al revés.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getTableColumns, getTableName, getViewName, getViewSelectedFields, is } from 'drizzle-orm';
import { PgColumn, PgTable, PgView } from 'drizzle-orm/pg-core';
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
 * Tablas de tenant del MVP: toda fila pertenece a un workspace y RLS la
 * aísla (0010, 0011, 0017). Con workspace_id NOT NULL.
 */
const TENANT_MVP = [
  'creator_profile', 'social_connection', 'data_consent', 'post', 'post_metric_snapshot',
  'account_metric_snapshot', 'audience_breakdown', 'creator_baseline', 'post_score', 'company_link',
  'signal', 'deal', 'activity', 'outbound_brief', 'outbound_policy', 'outbound_sequence', 'outbound_touch',
  'rate_card', 'media_kit', 'quote', 'campaign', 'campaign_result', 'invoice', 'payment', 'expense',
  'platform_payout', 'tax_reserve', 'notification', 'job_run',
];

/**
 * Hijas de una tabla de tenant, sin workspace_id propio: heredan la RLS
 * del padre por EXISTS (0018). La FK al padre es NOT NULL.
 */
const HIJAS_DE_TENANT: Array<[child: string, parent: string]> = [
  ['quote_item', 'quote'],
  ['rate_card_item', 'rate_card'],
  ['deal_stage_history', 'deal'],
  ['campaign_post', 'campaign'],
  ['idea_evidence', 'idea'],
  ['posting_window', 'creator_profile'],
  ['script_block', 'script'],
  ['script_variant', 'script'],
  ['preflight_result', 'video_analysis'],
  ['preflight_verdict', 'video_analysis'],
  ['video_audio_profile', 'video_analysis'],
  ['video_feature', 'video_analysis'],
  ['video_onscreen_text', 'video_analysis'],
  ['video_prediction', 'video_analysis'],
  ['video_recommendation', 'video_analysis'],
  ['video_second', 'video_analysis'],
  ['video_shot', 'video_analysis'],
  ['video_transcript', 'video_analysis'],
  ['video_transcript_word', 'video_analysis'],
];

/**
 * Catálogos globales con filas por workspace opcionales (workspace_id
 * NULL = de todos). Se leen antes de fijar un workspace, y por eso no
 * llevan RLS. Está decidido, y aquí queda escrito.
 */
const CATALOGOS_CON_WORKSPACE_OPCIONAL = ['pipeline_stage', 'feature_flag'];

/**
 * Hijas con la FK al padre OPCIONAL: tienen filas sin padre por diseño
 * (una cuota global de plataforma, un snapshot de marca previo a la
 * campaña) y la política se decide por módulo, no aquí. Cada corrida
 * las deja a la vista como pendientes.
 */
const HIJAS_CON_FK_OPCIONAL: Array<[child: string, parent: string, owner: string]> = [
  ['brand_account_snapshot', 'campaign', 'CAM'],
  ['trait_lift', 'creator_profile', 'MET'],
  ['external_post', 'video_analysis', 'MED'],
  ['api_call_log', 'social_connection', 'CON'],
  ['api_quota_usage', 'social_connection', 'CON'],
];

/** Con workspace_id NOT NULL y sin RLS hasta la migración de CIM-3 (ver el test.todo de abajo). */
const PENDIENTE_CIM_3 = ['membership'];

/**
 * Tablas globales sin workspace_id que guardan datos personales y hoy
 * cualquier workspace enumera (ver el test.todo de VEN-1). Hasta que
 * lleven RLS se leen SIEMPRE dentro de withWorkspace, a través de
 * company_link; nunca como catálogo.
 */
const PENDIENTE_VEN_1_PII = ['contact', 'app_user'];

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
}
interface FkRow extends Record<string, unknown> {
  child: string;
  fk: string;
  parent: string;
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
/** Tablas sin RLS con una FK NOT NULL hacia una tabla con RLS: hijas que se quedaron sin aislar. */
let childrenWithoutRls: FkRow[] = [];

before(async () => {
  t = await openTestDb({ seeds: false });
  const cols = await t.db.withoutWorkspace((tx) =>
    tx.query<ColumnRow>(`
      SELECT table_name, column_name, data_type, udt_name, character_maximum_length,
             numeric_precision, numeric_scale, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = 'public'`),
  );
  for (const c of cols.rows) {
    if (!columns.has(c.table_name)) columns.set(c.table_name, new Map());
    columns.get(c.table_name)!.set(c.column_name, c);
  }
  const rels = await t.db.withoutWorkspace((tx) =>
    tx.query<RelRow>(`
      SELECT c.relname AS name,
             CASE c.relkind WHEN 'v' THEN 'view' ELSE 'table' END AS kind,
             c.relrowsecurity AS rls
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v')`),
  );
  for (const r of rels.rows) relations.set(r.name, r);
  const fks = await t.db.withoutWorkspace((tx) =>
    tx.query<FkRow>(`
      SELECT c.relname AS child, a.attname AS fk, p.relname AS parent
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_class p ON p.oid = k.confrelid
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.conkey[1]
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND k.contype = 'f'
        AND NOT c.relrowsecurity AND p.relrowsecurity AND a.attnotnull
      ORDER BY 1, 2`),
  );
  childrenWithoutRls = fks.rows;
});

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

describe('aislamiento por workspace en la base', () => {
  test('las tablas de tenant del MVP tienen RLS activo', () => {
    for (const name of TENANT_MVP) {
      const ws = columns.get(name)?.get('workspace_id');
      assert.ok(ws, `${name} no existe o no tiene workspace_id`);
      // job_run admite workspace_id NULL (jobs globales): RLS oculta esas
      // filas a mc_app y solo el worker (BYPASSRLS) las ve. Es lo buscado.
      assert.equal(relations.get(name)?.rls, true, `${name} es de tenant pero no tiene RLS`);
    }
  });

  test('las hijas de una tabla de tenant heredan su RLS (0018)', () => {
    for (const [child, parent] of HIJAS_DE_TENANT) {
      assert.equal(relations.get(parent)?.rls, true, `${parent} (padre de ${child}) no tiene RLS`);
      assert.equal(relations.get(child)?.rls, true, `${child} es hija de ${parent} pero no tiene RLS`);
      assert.equal(columns.get(child)?.has('workspace_id'), false, `${child} tiene workspace_id: va en TENANT_MVP, no aquí`);
    }
  });

  test('toda tabla con workspace_id obligatorio tiene RLS, salvo lo pendiente de CIM-3', () => {
    for (const [name, cols] of columns) {
      if (relations.get(name)?.kind !== 'table') continue;
      const ws = cols.get('workspace_id');
      if (!ws || ws.is_nullable !== 'NO' || PENDIENTE_CIM_3.includes(name)) continue;
      assert.equal(relations.get(name)?.rls, true, `${name} tiene workspace_id NOT NULL pero no RLS`);
    }
  });

  test('ninguna tabla sin RLS apunta con una FK obligatoria a una tabla con RLS', () => {
    // Es la regla que 0018 cerró y que evita el hueco de quote_item de
    // la ronda 1: una hija nueva sin política aparece aquí con su padre.
    const gaps = childrenWithoutRls.map((r) => `${r.child}.${r.fk} → ${r.parent}`);
    assert.deepEqual(gaps, [], `hijas de una tabla de tenant sin RLS: ${gaps.join(', ')}`);
  });

  test('los catálogos con workspace_id opcional siguen sin RLS, a propósito', () => {
    for (const name of CATALOGOS_CON_WORKSPACE_OPCIONAL) {
      const ws = columns.get(name)?.get('workspace_id');
      assert.equal(ws?.is_nullable, 'YES', `${name}.workspace_id debería admitir NULL (catálogo global)`);
      assert.equal(relations.get(name)?.rls, false, `${name} es un catálogo: si ahora lleva RLS, sácalo de esta lista`);
    }
  });

  test('membership existe con workspace_id NOT NULL y hoy se lee sin RLS', () => {
    for (const name of PENDIENTE_CIM_3) {
      assert.equal(columns.get(name)?.get('workspace_id')?.is_nullable, 'NO');
      assert.equal(relations.get(name)?.rls, false, `${name} ya tiene RLS: cierra el test.todo de CIM-3`);
    }
  });

  // Pendientes visibles en cada corrida (salen como "todo" en el resumen).
  test(
    'CIM-3: RLS en membership — ENABLE + FORCE con USING (user_id = current_user_id() OR workspace_id = current_workspace_id()) ' +
      'y current_user_id() leyendo app.user_id fijado por la sesión. Hoy cualquier consulta como mc_app enumera user_id y rol de todos los workspaces.',
    { todo: true },
    () => {},
  );

  test('contact y app_user existen sin workspace_id y hoy se leen sin RLS (PII global)', () => {
    for (const name of PENDIENTE_VEN_1_PII) {
      assert.equal(columns.get(name)?.has('workspace_id'), false, `${name} ya tiene workspace_id: va en TENANT_MVP`);
      assert.equal(relations.get(name)?.rls, false, `${name} ya tiene RLS: cierra el test.todo de VEN-1`);
    }
  });

  test(
    'VEN-1: RLS en contact y app_user (PII globales) — contact: ENABLE + FORCE con USING (source IN (' +
      "'public_website', 'public_profile', 'press') OR EXISTS (SELECT 1 FROM company_link l WHERE l.company_id = " +
      'contact.company_id AND l.workspace_id = current_workspace_id())), y una prueba en rls.test.ts con un contacto ' +
      'user_provided de A que B no ve. app_user: por membership, con CIM-3. Hoy cualquier consulta como mc_app enumera ' +
      'correo, teléfono y LinkedIn de todos los workspaces.',
    { todo: true },
    () => {},
  );

  test(
    'hijas con FK opcional a una tabla de tenant, política pendiente por módulo: ' +
      HIJAS_CON_FK_OPCIONAL.map(([h, p, d]) => `${h} → ${p} (${d})`).join(', '),
    { todo: true },
    () => {},
  );
});
