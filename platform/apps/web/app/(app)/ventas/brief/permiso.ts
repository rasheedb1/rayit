import "server-only";
import { authConfig } from "@/lib/auth/config";
import { PUEDEN_EDITAR_BRIEF } from "@/lib/auth/reglas";
import { getCurrentContext } from "@/lib/workspace/current";

/**
 * Si quien mira puede cambiar el brief de outbound: 'owner' o 'admin'
 * del workspace actual (PUEDEN_EDITAR_BRIEF). La página lo usa para
 * enseñar el brief sin ofrecer «Guardar», y la acción lo vuelve a mirar
 * antes de escribir; la última palabra es de la base (0070 §5, las
 * políticas RESTRICTIVE de outbound_brief). Mismo patrón que
 * politica/permiso.ts.
 *
 * Sin identidad, solo si no hay Supabase Auth (una copia de desarrollo
 * donde no existe ningún usuario). Con Supabase Auth, getCurrentContext
 * siempre trae la identidad, y sin ella se falla cerrado.
 */
export async function puedeEditarElBrief(): Promise<boolean> {
  const ctx = await getCurrentContext();
  if (!ctx.identity) return authConfig() === null;
  const rol = ctx.workspaces.find((w) => w.id === ctx.workspaceId)?.role;
  return rol !== undefined && PUEDEN_EDITAR_BRIEF.has(rol);
}
