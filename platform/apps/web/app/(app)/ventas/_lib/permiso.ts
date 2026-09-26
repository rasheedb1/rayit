import "server-only";
import { authConfig } from "@/lib/auth/config";
import { PUEDEN_OPERAR_VENTAS } from "@/lib/auth/reglas";
import { getCurrentContext } from "@/lib/workspace/current";

/**
 * Si quien mira puede operar las bandejas de Ventas (VEN-14): 'owner',
 * 'admin' o 'member' del workspace actual (PUEDEN_OPERAR_VENTAS). Las
 * páginas lo usan para no ofrecer los botones ni los atajos, y cada
 * acción de /ventas/aprobaciones y /ventas/bandeja lo vuelve a mirar en
 * el servidor ANTES de tocar la base o de llamar al modelo. Mismo patrón
 * que perfil/permiso.ts y politica/permiso.ts.
 *
 * Sin identidad, solo si no hay Supabase Auth (una copia de desarrollo
 * donde no existe ningún usuario). Con Supabase Auth, getCurrentContext
 * siempre trae la identidad, y sin ella se falla cerrado.
 */
export async function puedeOperarVentas(): Promise<boolean> {
  const ctx = await getCurrentContext();
  if (!ctx.identity) return authConfig() === null;
  const rol = ctx.workspaces.find((w) => w.id === ctx.workspaceId)?.role;
  return rol !== undefined && PUEDEN_OPERAR_VENTAS.has(rol);
}
