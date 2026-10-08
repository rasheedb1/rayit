import "server-only";
import { cache } from "react";
import { isPermiso, permisosDeRol, type Permiso } from "@mc/core";
import { getSessionPermissions } from "@mc/db/queries/accesos";
import { isAuthConfigured } from "@/lib/auth/config";
import { getSesion } from "@/lib/auth/session";
import { withWorkspace } from "@/lib/db";
import { withWorkspaceId } from "@/lib/db/cliente";
import { getCurrentContext } from "@/lib/workspace/current";
import { usuarioDeDemo } from "@/lib/workspace/demo";

/**
 * Los permisos de quien abrió ESTA petición, en el workspace actual.
 *
 * Es la única costura entre la sesión y los permisos (ACC-1 la dejó
 * resolviendo a todos como Dueño; ACC-5 la hace real) y se resuelve una
 * vez por petición (`cache` de React): el marco, el layout del módulo y
 * las Server Actions preguntan y la base contesta una sola vez. Tres
 * ramas, en este orden:
 *
 *   1. Sin llaves de Supabase (modo demo: `pnpm verificar`, el dev sin
 *      `make db.unlock`): no hay sesión posible. Sin `DEMO_USER_ID`, el
 *      Dueño de creador —como hasta ACC-5—; con ella, los permisos REALES
 *      de ese app_user en el workspace de demo, que es como se verifica
 *      en dev que el marco esconde y cierra (README, §Reglas del marco).
 *      Con llaves, la variable no existe para este archivo, igual que
 *      DEMO_WORKSPACE_ID para lib/workspace/current.ts.
 *   2. Con llaves y sin sesión: NADA, sin abrir la base y sin redirigir.
 *      Aquí llega el marco de las rutas públicas del grupo (app), como
 *      /kit; una ruta protegida no llega sin sesión (el middleware y
 *      getCurrentContext la mandan antes a /login).
 *   3. Con sesión: `getSessionPermissions` (membership.role_id →
 *      role_permission) dentro de withWorkspace, que fija el workspace y
 *      la identidad. Sin membresía, nada.
 *
 * FALLA CERRADO: si la base o Supabase no contestan, esto lanza y
 * requirePermission lanza con ello; nunca se concede «por si acaso».
 * El Shell es el único que lo recoge (pinta el menú sin módulos) porque
 * un marco no puede tumbar todas las rutas por una consulta; la
 * pantalla ya cae en su error.tsx.
 */
export const permisosDeLaSesion = cache(async (): Promise<ReadonlySet<Permiso>> => {
  if (!isAuthConfigured()) return permisosDeDemo();
  const sesion = await getSesion();
  if (!sesion) return SIN_PERMISOS;
  return aConjunto(await withWorkspace((tx) => getSessionPermissions(tx)));
});

/** Nadie: el conjunto vacío, compartido y congelado. */
const SIN_PERMISOS: ReadonlySet<Permiso> = Object.freeze(new Set<Permiso>());

/**
 * Las llaves de la base, como conjunto del catálogo. Una llave que el
 * catálogo de @mc/core no conoce (una fila sembrada por una migración
 * más nueva que este despliegue) se descarta: no hay código que la
 * pregunte, y descartarla nunca da más acceso.
 */
export function aConjunto(llaves: readonly string[]): ReadonlySet<Permiso> {
  const permisos = llaves.filter(isPermiso);
  return permisos.length === 0 ? SIN_PERMISOS : Object.freeze(new Set(permisos));
}

/**
 * A quién se simula en modo demo, o null para el Dueño: lib/workspace/demo.ts,
 * la misma persona que getCurrentContext pone en las transacciones de las
 * pantallas. Se reexporta aquí, donde la buscan la invitación y las pruebas.
 */
export { usuarioDeDemo };

async function permisosDeDemo(): Promise<ReadonlySet<Permiso>> {
  const userId = usuarioDeDemo();
  if (!userId) return permisosDeRol("creator", "owner");
  // Con la persona simulada, por la puerta con nombre de lib/db/cliente,
  // como hace el selector de espacio. Es la misma identidad que
  // getCurrentContext pone en las pantallas (lib/workspace/demo.ts); se
  // fija aquí a mano para que los permisos no dependan de cómo se resolvió
  // el contexto.
  const { workspaceId } = await getCurrentContext();
  return aConjunto(await withWorkspaceId(workspaceId, (tx) => getSessionPermissions(tx), { userId }));
}
