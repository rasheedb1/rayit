import "server-only";
import type { MembershipRole } from "@mc/db/queries/identidad";
import { authConfig } from "@/lib/auth/config";
import { getCurrentContext } from "./current";

/**
 * Si quien mira tiene, en el workspace actual, uno de estos roles. Es la
 * regla que comparten los permisos de cada pantalla (Ventas: bandejas,
 * actividad, perfil, política, brief), para que el modo sin identidad se
 * decida en un solo sitio.
 *
 * Sin identidad, solo si no hay Supabase Auth (una copia de desarrollo
 * donde no existe ningún usuario): es la misma bandera que lib/db fija
 * en la base (app.auth_disabled). Con Supabase Auth, getCurrentContext
 * siempre trae la identidad, y sin ella se falla cerrado.
 */
export async function tieneRol(roles: ReadonlySet<MembershipRole>): Promise<boolean> {
  const ctx = await getCurrentContext();
  if (!ctx.identity) return authConfig() === null;
  const rol = ctx.workspaces.find((w) => w.id === ctx.workspaceId)?.role;
  return rol !== undefined && roles.has(rol);
}
