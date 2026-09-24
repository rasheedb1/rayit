import "server-only";
import { POLICY_MANAGER_ROLES } from "@mc/db/queries/entregabilidad";
import { getCurrentContext } from "@/lib/workspace/current";

/**
 * Si quien mira puede cambiar la política de envío y encender o apagar
 * el envío automático: 'owner' o 'admin' del workspace actual (0038 §7).
 * La página lo usa para no ofrecer lo que la base rechazaría, y las
 * acciones lo vuelven a mirar antes de escribir; la última palabra es de
 * la base (políticas RESTRICTIVE de outbound_policy).
 *
 * Sin identidad (una copia de desarrollo sin Supabase Auth, donde no
 * existe ningún usuario) no hay roles que mirar, y la base tampoco los
 * mira. Con Supabase Auth, getCurrentContext siempre trae la identidad.
 */
export async function puedeCambiarLaPolitica(): Promise<boolean> {
  const ctx = await getCurrentContext();
  if (!ctx.identity) return true;
  const rol = ctx.workspaces.find((w) => w.id === ctx.workspaceId)?.role;
  return rol !== undefined && (POLICY_MANAGER_ROLES as readonly string[]).includes(rol);
}
