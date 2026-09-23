/**
 * Imprime la semilla SQL de permisos y roles de fábrica (ACC-1 → ACC-3).
 *
 *   pnpm --filter @mc/core permisos:sql > /tmp/permisos.sql
 *
 * Una sola fuente de verdad: lo que hay en src/permisos.ts. ACC-3 pega
 * la salida en su migración (o en db/seed/0001_catalog.sql) en vez de
 * escribir los INSERT a mano, y test/permisos-sql.test.ts compara la
 * salida con test/snapshots/permisos.sql para que cambiar la matriz sin
 * regenerar el snapshot rompa la prueba.
 *
 * Esquema destino (propuesta ACC, fase 4):
 *   permission (key PK, module, label_es, sensitivity)
 *   role (id uuid DEFAULT gen_random_uuid(), workspace_id NULL para los de
 *         sistema, key, workspace_kind, label_es, description_es, is_system)
 *         con el índice único parcial role_system_uk (key, workspace_kind)
 *         WHERE workspace_id IS NULL
 *   role_permission (role_id, permission_key) PK
 *
 * Todo con ON CONFLICT DO NOTHING: re-ejecutable. No quita un permiso que
 * un rol de sistema pierda después; si ACC-3 quiere que la semilla mande,
 * añade el DELETE que documenta docs/propuestas/ACC-1.md §5.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PERMISOS, ROLES_SISTEMA } from '../src/permisos.ts';

/** Un literal de texto SQL: comillas simples dobladas. */
function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** La semilla completa, determinista (el orden es el del catálogo y el de la matriz). */
export function generarSemillaSql(): string {
  const out: string[] = [];
  out.push('-- Semilla de permisos y roles de fábrica. GENERADA por');
  out.push('-- packages/core/scripts/permisos-sql.ts desde packages/core/src/permisos.ts (ACC-1).');
  out.push('-- No se edita a mano: se cambia el catálogo y se vuelve a generar');
  out.push('-- con `pnpm --filter @mc/core permisos:sql`. Re-ejecutable.');
  out.push('');

  out.push(`-- ${PERMISOS.length} permisos.`);
  out.push('INSERT INTO permission (key, module, label_es, sensitivity) VALUES');
  out.push(PERMISOS.map((p) => `  (${lit(p.key)}, ${lit(p.module)}, ${lit(p.labelEs)}, ${lit(p.sensitivity)})`).join(',\n'));
  out.push('ON CONFLICT (key) DO NOTHING;');
  out.push('');

  out.push(`-- ${ROLES_SISTEMA.length} roles de sistema (workspace_id IS NULL).`);
  out.push('INSERT INTO role (workspace_id, key, workspace_kind, label_es, description_es, is_system) VALUES');
  out.push(
    ROLES_SISTEMA.map(
      (r) => `  (NULL, ${lit(r.key)}, ${lit(r.workspaceKind)}, ${lit(r.labelEs)}, ${lit(r.descriptionEs)}, true)`,
    ).join(',\n'),
  );
  out.push('ON CONFLICT (key, workspace_kind) WHERE workspace_id IS NULL DO NOTHING;');
  out.push('');

  const filas = ROLES_SISTEMA.flatMap((r) => r.permisos.map((p) => `  (${lit(r.key)}, ${lit(r.workspaceKind)}, ${lit(p)})`));
  out.push(`-- ${filas.length} filas de la matriz. El role_id se resuelve por (key, workspace_kind) porque es gen_random_uuid().`);
  out.push('INSERT INTO role_permission (role_id, permission_key)');
  out.push('SELECT r.id, m.permission_key');
  out.push('FROM (VALUES');
  out.push(filas.join(',\n'));
  out.push(') AS m (role_key, workspace_kind, permission_key)');
  out.push('JOIN role r ON r.key = m.role_key AND r.workspace_kind = m.workspace_kind AND r.workspace_id IS NULL');
  out.push('ON CONFLICT DO NOTHING;');
  out.push('');
  return out.join('\n');
}

/** Cuántas filas deja cada INSERT: lo que la prueba comprueba y lo que ACC-3 puede contar después de migrar. */
export function contarFilas(): { permission: number; role: number; rolePermission: number } {
  return {
    permission: PERMISOS.length,
    role: ROLES_SISTEMA.length,
    rolePermission: ROLES_SISTEMA.reduce((n, r) => n + r.permisos.length, 0),
  };
}

/**
 * Solo imprime cuando se ejecuta como script; la prueba lo importa sin
 * efectos. Las dos rutas pasan por realpath: import.meta.url ya viene
 * resuelta y argv[1] no, y en un checkout con enlaces simbólicos (/tmp
 * en macOS) no coincidirían y el script callaría.
 */
const esElPrincipal = process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (esElPrincipal) {
  process.stdout.write(generarSemillaSql());
}
