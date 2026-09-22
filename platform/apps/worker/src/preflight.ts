/**
 * Comprobación previa del worker contra un Postgres real, y el "humo"
 * que la acompaña.
 *
 * El runner (src/index.ts, CON-2) necesita dos cosas que NINGUNA
 * migración puede dar, porque son operaciones de administración
 * (docs/propuestas/CON-2.md §3.1):
 *
 *   1. que el rol de conexión sea miembro de mc_worker
 *        ./scripts/supabase-admin.sh sql "GRANT mc_worker TO mc_migrator"
 *   2. que exista el esquema de pg-boss
 *        ./scripts/supabase-admin.sh sql "CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION mc_migrator"
 *        pnpm --filter @mc/worker install-schema
 *
 * Sin la primera muere en SET ROLE; sin la segunda, al abrir pg-boss.
 * `dev` (src/dev.ts) pregunta aquí antes de arrancar y, si falta algo,
 * lo dice con el comando exacto en vez de caerse en bucle. `make
 * arranque` hace la misma pregunta desde bash.
 *
 * Lo que sí funciona siempre con las credenciales del vault es leer
 * job_definition (catálogo sin RLS): eso es el humo, y sirve para
 * comprobar @mc/db, TLS y credenciales antes de cualquier otra cosa.
 */
import { hostOf, jobDefinition, type Db } from '@mc/db';

export interface PreflightResult {
  currentUser: string;
  /** El rol de conexión es miembro de `role` (puede hacer SET ROLE). */
  memberOfRole: boolean;
  /** Existe el esquema de pg-boss. */
  bossSchemaExists: boolean;
}

interface PreflightRow extends Record<string, unknown> {
  current_user: string;
  member: boolean;
  boss: boolean;
}

export async function runPreflight(db: Db, opts: { role: string | null; bossSchema: string }): Promise<PreflightResult> {
  const { rows } = await db.withoutWorkspace((tx) =>
    tx.query<PreflightRow>(
      `SELECT current_user::text AS current_user,
              CASE WHEN $1::text IS NULL THEN true ELSE pg_has_role(current_user, $1::name, 'MEMBER') END AS member,
              EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $2::name) AS boss`,
      [opts.role, opts.bossSchema],
    ),
  );
  const row = rows[0];
  return {
    currentUser: row?.current_user ?? '',
    memberOfRole: row?.member === true,
    bossSchemaExists: row?.boss === true,
  };
}

/** Qué falta y cómo se arregla, en líneas listas para imprimir. Vacío si no falta nada. */
export function explainMissing(p: PreflightResult, opts: { role: string | null; bossSchema: string }): string[] {
  const lines: string[] = [];
  if (opts.role && !p.memberOfRole) {
    lines.push(
      `${p.currentUser} no es miembro de ${opts.role}: el runner moriría en SET ROLE.`,
      `  ./scripts/supabase-admin.sh sql "GRANT ${opts.role} TO ${p.currentUser}"`,
    );
  }
  if (!p.bossSchemaExists) {
    lines.push(
      `no existe el esquema ${opts.bossSchema}: pg-boss no puede abrir su cola.`,
      `  ./scripts/supabase-admin.sh sql "CREATE SCHEMA IF NOT EXISTS ${opts.bossSchema} AUTHORIZATION ${p.currentUser}"`,
      '  pnpm --filter @mc/worker install-schema',
    );
  }
  if (lines.length) lines.push('Detalle: docs/propuestas/CON-2.md §3.1 y §3.3. Necesita el token de administración (Rasheed).');
  return lines;
}

/**
 * Un error de conexión, en una línea del producto con el comando que lo
 * arregla; null si no es de conexión (que se propague con su stack).
 *
 *   28P01                       Postgres rechazó usuario o contraseña.
 *   ENOTFOUND/ECONNREFUSED/…    No se llega al host.
 */
export function explainConnectionError(err: unknown, url: string): string | null {
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e?.code === 'string' ? e.code : '';
  const host = hostOf(url);
  if (code === '28P01') {
    return `Supabase rechazó las credenciales de ${userOf(url)}@${host}: corre make db.unlock (o make db.status).`;
  }
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN' || code === 'ECONNRESET') {
    return `no se llega a ${host} (${code}): revisa la red o make db.info.`;
  }
  return null;
}

function userOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).username) || '?';
  } catch {
    return '?';
  }
}

/** El humo: lista job_definition (catálogo sin RLS, por withoutWorkspace) en el formato de la consola. */
export async function formatJobDefinitions(db: Db, url: string): Promise<string> {
  const defs = await db.withoutWorkspace((tx) =>
    tx.db.select().from(jobDefinition).orderBy(jobDefinition.queue, jobDefinition.id),
  );
  const lines = defs.map(
    (d) => `  ${d.enabled ? '·' : '✗'} ${d.id.padEnd(26)} ${d.queue.padEnd(12)} ${(d.defaultCron ?? '—').padEnd(14)} ${d.labelEs}`,
  );
  return `\n  ${defs.length} definiciones de jobs en ${hostOf(url)}\n\n${lines.join('\n')}\n\n`;
}
