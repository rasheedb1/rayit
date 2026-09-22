/**
 * La migración manda: el esquema Drizzle se compara, columna por
 * columna, con lo que db/migrations dejó en Postgres embebido. Nombre,
 * tipo, nulabilidad y default de cada tabla; nombre y tipo de cada
 * vista; y que ninguna columna de la base falte en el esquema.
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

/** Tablas con workspace_id NOT NULL que a propósito no llevan RLS: se leen antes de fijar un workspace. */
const SIN_RLS_A_PROPOSITO = new Set(['membership']);

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
});

after(async () => {
  await t.close();
});

const exportado: unknown[] = Object.values(schema);
const tables = exportado.filter((v): v is PgTable => is(v, PgTable));
const views = exportado.filter((v): v is PgView => is(v, PgView));

describe('el esquema Drizzle coincide con db/migrations', () => {
  test('exporta todas las tablas y vistas del MVP', () => {
    const nombres = new Set(tables.map((x) => getTableName(x)));
    const faltan = TABLAS_MVP.filter((n) => !nombres.has(n));
    assert.deepEqual(faltan, [], `tablas del MVP sin declarar: ${faltan.join(', ')}`);
    const vistas = new Set(views.map((v) => getViewName(v)));
    const faltanVistas = VISTAS_MVP.filter((n) => !vistas.has(n));
    assert.deepEqual(faltanVistas, [], `vistas del MVP sin declarar: ${faltanVistas.join(', ')}`);
  });

  for (const table of tables) {
    const name = getTableName(table);
    test(`tabla ${name}`, () => {
      assert.equal(relations.get(name)?.kind, 'table', `${name} no existe como tabla en la base`);
      const enBase = columns.get(name);
      assert.ok(enBase, `${name} sin columnas en information_schema`);
      const declaradas = new Set<string>();
      for (const col of Object.values(getTableColumns(table))) {
        declaradas.add(col.name);
        const c = enBase.get(col.name);
        assert.ok(c, `${name}.${col.name} no existe en la base`);
        assert.equal(drizzleType(col), dbType(c), `${name}.${col.name}: tipo`);
        assert.equal(col.notNull, c.is_nullable === 'NO', `${name}.${col.name}: NOT NULL`);
        assert.equal(col.hasDefault, c.column_default !== null, `${name}.${col.name}: DEFAULT`);
      }
      const sinDeclarar = [...enBase.keys()].filter((c) => !declaradas.has(c));
      assert.deepEqual(sinDeclarar, [], `${name}: columnas de la base que faltan en el esquema`);
    });
  }

  for (const view of views) {
    const name = getViewName(view);
    test(`vista ${name}`, () => {
      assert.equal(relations.get(name)?.kind, 'view', `${name} no existe como vista en la base`);
      const enBase = columns.get(name);
      assert.ok(enBase, `${name} sin columnas en information_schema`);
      const declaradas = new Set<string>();
      for (const field of Object.values(getViewSelectedFields(view))) {
        assert.ok(is(field, PgColumn), `${name}: campo que no es columna`);
        declaradas.add(field.name);
        const c = enBase.get(field.name);
        assert.ok(c, `${name}.${field.name} no existe en la base`);
        assert.equal(drizzleType(field), dbType(c), `${name}.${field.name}: tipo`);
      }
      const sinDeclarar = [...enBase.keys()].filter((c) => !declaradas.has(c));
      assert.deepEqual(sinDeclarar, [], `${name}: columnas de la base que faltan en el esquema`);
    });
  }

  test('toda tabla con workspace_id obligatorio tiene RLS activo', () => {
    for (const table of tables) {
      const name = getTableName(table);
      const ws = getTableColumns(table)['workspaceId'];
      if (!ws || !ws.notNull || SIN_RLS_A_PROPOSITO.has(name)) continue;
      assert.equal(relations.get(name)?.rls, true, `${name} tiene workspace_id NOT NULL pero no RLS`);
    }
  });
});
