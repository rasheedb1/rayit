import "server-only";
import { authConfig } from "@/lib/auth/config";
import { PUEDEN_EDITAR_PERFIL } from "@/lib/auth/reglas";
import { getCurrentContext } from "@/lib/workspace/current";

/**
 * Si quien mira puede recalcular el perfil comercial y editar su
 * narrativa: 'owner', 'admin' o 'member' del workspace actual
 * (PUEDEN_EDITAR_PERFIL). La página lo usa para no ofrecer «Recalcular»
 * ni «Editar», y las dos acciones lo vuelven a mirar antes de tocar la
 * base o de llamar al modelo. Mismo patrón que politica/permiso.ts.
 *
 * Sin identidad, solo si no hay Supabase Auth (una copia de desarrollo
 * donde no existe ningún usuario). Con Supabase Auth, getCurrentContext
 * siempre trae la identidad, y sin ella se falla cerrado.
 */
export async function puedeEditarElPerfil(): Promise<boolean> {
  const ctx = await getCurrentContext();
  if (!ctx.identity) return authConfig() === null;
  const rol = ctx.workspaces.find((w) => w.id === ctx.workspaceId)?.role;
  return rol !== undefined && PUEDEN_EDITAR_PERFIL.has(rol);
}
