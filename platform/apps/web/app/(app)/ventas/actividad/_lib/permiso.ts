import "server-only";
import type { MembershipRole } from "@mc/db/queries/identidad";
import { authConfig } from "@/lib/auth/config";
import { getCurrentContext } from "@/lib/workspace/current";

/**
 * Los roles que pueden operar la cola del outreach: reintentar lo
 * fallido y cancelar en masa (hasta BULK_MAX mensajes de una vez). Es la
 * acción más destructiva de Ventas: cancela mensajes a marcas o los
 * vuelve a mandar. Quien trabaja las cadencias ('owner', 'admin',
 * 'member') la opera; un 'viewer' o un 'client' (en una agencia, la
 * marca misma) ven la cola, no la tocan. La RLS de outbound_touch es
 * solo por workspace, así que la guarda es esta.
 */
export const PUEDEN_OPERAR_LA_COLA: ReadonlySet<MembershipRole> = new Set<MembershipRole>(["owner", "admin", "member"]);

/**
 * Si quien mira puede operar la cola (PUEDEN_OPERAR_LA_COLA) en el
 * workspace actual. La página lo usa para no ofrecer las casillas ni los
 * botones de reintentar, y las tres acciones lo vuelven a mirar antes de
 * abrir la transacción. Mismo patrón que politica/permiso.ts y
 * perfil/permiso.ts.
 *
 * Sin identidad, solo si no hay Supabase Auth (una copia de desarrollo
 * donde no existe ningún usuario). Con Supabase Auth, getCurrentContext
 * siempre trae la identidad, y sin ella se falla cerrado.
 */
export async function puedeOperarLaCola(): Promise<boolean> {
  const ctx = await getCurrentContext();
  if (!ctx.identity) return authConfig() === null;
  const rol = ctx.workspaces.find((w) => w.id === ctx.workspaceId)?.role;
  return rol !== undefined && PUEDEN_OPERAR_LA_COLA.has(rol);
}
