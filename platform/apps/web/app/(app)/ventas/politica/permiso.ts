import "server-only";
import { POLICY_MANAGER_ROLES } from "@mc/db/queries/entregabilidad";
import { authConfig } from "@/lib/auth/config";
import { getCurrentContext } from "@/lib/workspace/current";

/**
 * Si quien mira puede cambiar la política de envío y encender o apagar
 * el envío automático: 'owner' o 'admin' del workspace actual (entregabilidad §7).
 * La página lo usa para no ofrecer lo que la base rechazaría, y las
 * acciones lo vuelven a mirar antes de escribir; la última palabra es de
 * la base (políticas RESTRICTIVE de outbound_policy).
 *
 * Sin identidad, solo si no hay Supabase Auth (una copia de desarrollo
 * donde no existe ningún usuario): es la misma bandera que lib/db fija
 * en la base (app.auth_disabled), y sin ella la base también dice que no
 * (entregabilidad §7, falla cerrada). Con Supabase Auth, getCurrentContext siempre
 * trae la identidad.
 */
export async function puedeCambiarLaPolitica(): Promise<boolean> {
  const ctx = await getCurrentContext();
  if (!ctx.identity) return authConfig() === null;
  const rol = ctx.workspaces.find((w) => w.id === ctx.workspaceId)?.role;
  return rol !== undefined && (POLICY_MANAGER_ROLES as readonly string[]).includes(rol);
}
