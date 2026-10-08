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
 * Sin Supabase Auth (una copia de desarrollo donde no existe ningún
 * usuario), sí: es la misma bandera que lib/db fija en la base
 * (app.auth_disabled). También cuando esa copia simula a una persona con
 * DEMO_USER_ID (lib/workspace/demo.ts): su contexto no trae la lista de
 * sus espacios con su rol, y lo que puede lo dicen el marco (lib/permisos)
 * y, por fila, la base. Con Supabase Auth, getCurrentContext siempre
 * trae la identidad, y sin ella se falla cerrado.
 */
export async function tieneRol(roles: ReadonlySet<MembershipRole>): Promise<boolean> {
  const ctx = await getCurrentContext();
  if (authConfig() === null) return true;
  if (!ctx.identity) return false;
  const rol = ctx.workspaces.find((w) => w.id === ctx.workspaceId)?.role;
  return rol !== undefined && roles.has(rol);
}
