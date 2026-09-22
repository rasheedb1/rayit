/**
 * Volcado de TODAS las columnas de texto, jsonb, arreglos y bytea de un
 * esquema, recorriendo pg_catalog. Es la prueba del «terminado cuando» de
 * CON-3: tras un callback completo, ni el access token, ni el refresh
 * token, ni el code aparecen en ninguna tabla. Se usa desde las pruebas
 * de la web y del worker; en producción no tiene sentido.
 */
import type { SqlExecutor } from '../log/postgres.ts';

export interface TextColumnDump {
  table: string;
  column: string;
  /** Todas las filas de esa columna, casteadas a texto y unidas por saltos de línea. */
  text: string;
}

interface ColumnRow extends Record<string, unknown> {
  table: string;
  column: string;
}

export async function dumpTextColumns(db: SqlExecutor, schema: string = 'public'): Promise<TextColumnDump[]> {
  const cols = (await db.query(
    `SELECT c.relname AS "table", a.attname AS "column"
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
        AND (t.typname IN ('text', 'varchar', 'bpchar', 'citext', 'json', 'jsonb', 'bytea') OR t.typname LIKE '\\_%')
      ORDER BY 1, 2`,
    [schema],
  )) as { rows?: ColumnRow[] };
  const out: TextColumnDump[] = [];
  for (const { table, column } of cols.rows ?? []) {
    const res = (await db.query(`SELECT coalesce(string_agg(${quote(column)}::text, E'\\n'), '') AS text FROM ${quote(schema)}.${quote(table)}`)) as { rows?: Array<{ text: string }> };
    out.push({ table, column, text: res.rows?.[0]?.text ?? '' });
  }
  return out;
}

/** Devuelve la primera aparición de un secreto (en claro o en hex, por los bytea) o null si ninguno aparece. */
export function findSecretInDump(dump: readonly TextColumnDump[], secrets: readonly string[]): { table: string; column: string; secret: string } | null {
  for (const d of dump) {
    for (const s of secrets) {
      if (!s) continue;
      const hex = Buffer.from(s, 'utf8').toString('hex');
      if (d.text.includes(s) || d.text.includes(hex)) return { table: d.table, column: d.column, secret: s.slice(0, 10) + '…' };
    }
  }
  return null;
}

function quote(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}
