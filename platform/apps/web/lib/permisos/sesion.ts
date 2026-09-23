import "server-only";
import { cache } from "react";
import { isUuid } from "@mc/db";
import { getSessionMembership } from "@mc/db/queries/accesos";
import { isAuthConfigured, type Env } from "@/lib/auth/config";
import { getSesion } from "@/lib/auth/session";
import { withWorkspace } from "@/lib/db";
import { withWorkspaceId } from "@/lib/db/cliente";
import { getCurrentContext } from "@/lib/workspace/current";
import { PERMISOS_DE_DUENO, permisosDeMembresia, SIN_PERMISOS } from "./roles-provisionales";

/**
 * Los permisos de quien abrió ESTA petición, en el workspace actual.
 *
 * Es la única costura entre la sesión y los permisos, y se resuelve
 * una vez por petición (`cache` de React): el marco, la página, el
 * layout del módulo y las Server Actions preguntan y la base contesta
 * una sola vez. Tres ramas, en este orden:
 *
 *   1. Sin llaves de Supabase (modo demo: `pnpm verificar`, el dev sin
 *      `make db.unlock`): no hay sesión posible. Sin `DEMO_USER_ID`, el
 *      Dueño —todo, como hasta ACC-5—; con ella, la membresía REAL de
 *      ese app_user en el workspace de demo, que es como se verifica en
 *      dev que el marco esconde y cierra (ver README, §Reglas del marco).
 *      Con llaves, la variable no existe para este archivo, igual que
 *      DEMO_WORKSPACE_ID para lib/workspace/current.ts.
 *   2. Con llaves y sin sesión: NADA, sin abrir la base y sin redirigir.
 *      Aquí llega el marco de las rutas públicas del grupo (app), como
 *      /kit; una ruta protegida no llega sin sesión (el middleware y
 *      getCurrentContext la mandan a /login antes).
 *   3. Con sesión: `getSessionMembership` dentro de withWorkspace, que
 *      fija el workspace y la identidad; el rol se convierte en su
 *      conjunto. Sin membresía —no debería pasar: el workspace actual
 *      sale de mis membresías— nada.
 *
 * FALLA CERRADO: si la base o Supabase no contestan, esto lanza y
 * requirePermission lanza con ello; nunca se concede «por si acaso».
 * El Shell es el único que lo recoge (pinta el menú sin módulos) porque
 * un marco no puede tumbar todas las rutas por una consulta; la
 * pantalla ya cae en su error.tsx.
 *
 * COSTURAS. Hasta ACC-1 el conjunto sale de la matriz provisional
 * (roles-provisionales.ts); hasta ACC-3 el rol es `membership.role`.
 * Cuando lleguen, cambian esos dos archivos y no este.
 */
export const permisosDeLaSesion = cache(async (): Promise<ReadonlySet<string>> => {
  if (!isAuthConfigured()) return permisosDeDemo();
  const sesion = await getSesion();
  if (!sesion) return SIN_PERMISOS;
  const m = await withWorkspace((tx) => getSessionMembership(tx));
  return m ? permisosDeMembresia(m.workspaceKind, m.role) : SIN_PERMISOS;
});

/**
 * A quién se simula en modo demo, o null para el Dueño. Aparte y con el
 * entorno inyectable para poder probarlo; con Supabase Auth configurado
 * no se mira nunca.
 */
export function usuarioDeDemo(env: Env = process.env): string | null {
  if (isAuthConfigured(env)) return null;
  const id = env.DEMO_USER_ID?.trim();
  if (!id) return null;
  if (!isUuid(id)) {
    throw new Error(`DEMO_USER_ID no es un UUID: "${id}". Debe ser el id de una fila de app_user (la del seed: 00000002-0000-4000-8000-000000000002).`);
  }
  return id;
}

async function permisosDeDemo(): Promise<ReadonlySet<string>> {
  const userId = usuarioDeDemo();
  if (!userId) return PERMISOS_DE_DUENO;
  // El contexto de demo no lleva identidad (app.user_id queda NULL en las
  // transacciones de las pantallas); aquí se abre una con la persona
  // simulada solo para leer su membresía, por la puerta con nombre de
  // lib/db/cliente, como hace el selector de espacio.
  const { workspaceId } = await getCurrentContext();
  const m = await withWorkspaceId(workspaceId, (tx) => getSessionMembership(tx), { userId });
  return m ? permisosDeMembresia(m.workspaceKind, m.role) : SIN_PERMISOS;
}
