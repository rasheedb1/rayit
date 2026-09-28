/**
 * El alta de una membresía en los fixtures de las pruebas, con y sin los
 * roles de 0034_access_control (main).
 *
 * main borró membership.role (pasa a role_id → role). Las pruebas del
 * motor y de Ventas tienen que correr igual sobre la serie de esta rama
 * (con role) y sobre la integrada (main más esta serie detrás, con role_id):
 * si no, `pnpm verificar` después de mezclar main no dice nada. El SQL que
 * devuelve elige la forma al correr, como membership_is_team (0060).
 *
 *   owner  → 'owner' / owner
 *   member → 'member' / editor (creador) o manager (agencia), el relleno de 0034_access_control
 *   admin  → 'admin' / manager (creador) o admin (agencia)
 *   viewer → 'viewer' / viewer
 *   client → 'client' / viewer, el relleno de 0034_access_control
 */
export type MembershipKind = 'owner' | 'admin' | 'member' | 'viewer' | 'client';

const NEW_KEY: Record<MembershipKind, string> = {
  owner: "'owner'",
  member: "CASE w.kind WHEN 'agency' THEN 'manager' ELSE 'editor' END",
  admin: "CASE w.kind WHEN 'agency' THEN 'admin' ELSE 'manager' END",
  viewer: "'viewer'",
  client: "'viewer'",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Un bloque DO que da de alta las membresías (ON CONFLICT DO NOTHING). Para t.admin / db.raw.exec. */
export function membershipSql(rows: ReadonlyArray<{ workspaceId: string; userId: string; kind: MembershipKind }>): string {
  const nuevas: string[] = [];
  const viejas: string[] = [];
  for (const r of rows) {
    if (!UUID.test(r.workspaceId) || !UUID.test(r.userId)) throw new Error(`membershipSql: id no válido (${r.workspaceId}, ${r.userId})`);
    nuevas.push(
      `INSERT INTO membership (workspace_id, user_id, role_id)
         SELECT w.id, ''${r.userId}''::uuid, system_role_id(w.kind, ${NEW_KEY[r.kind].replaceAll("'", "''")})
           FROM workspace w WHERE w.id = ''${r.workspaceId}''::uuid
       ON CONFLICT DO NOTHING`,
    );
    viejas.push(
      `INSERT INTO membership (workspace_id, user_id, role)
         VALUES (''${r.workspaceId}''::uuid, ''${r.userId}''::uuid, ''${r.kind}'') ON CONFLICT DO NOTHING`,
    );
  }
  return `DO $membresia$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'membership' AND column_name = 'role_id') THEN
    ${nuevas.map((q) => `EXECUTE '${q}';`).join('\n    ')}
  ELSE
    ${viejas.map((q) => `EXECUTE '${q}';`).join('\n    ')}
  END IF;
END $membresia$;`;
}
