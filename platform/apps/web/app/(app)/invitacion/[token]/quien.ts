import "server-only";
import type { Identity } from "@mc/db";
import { isAuthConfigured } from "@/lib/auth/config";
import { usuarioDeDemo } from "@/lib/permisos/sesion";
import { getCurrentContext } from "@/lib/workspace/current";

/**
 * Quién abre el enlace de una invitación: la persona de la sesión, con
 * su id y su correo verificado (lib/workspace/current.ts). Sin sesión y
 * con Supabase Auth configurado no se llega aquí: getCurrentContext
 * manda a /login (y el middleware antes, con `next=` para volver).
 *
 * En una copia SIN llaves (modo demo) no hay sesión posible; la persona
 * simulada es DEMO_USER_ID, como en lib/permisos/sesion.ts, y sin ella
 * no hay nadie que acepte. Con llaves, DEMO_USER_ID no existe para este
 * archivo.
 */
export async function quienAcepta(): Promise<Identity & { userId: string } | null> {
  const { identity } = await getCurrentContext();
  if (identity?.userId) return { ...identity, userId: identity.userId };
  if (isAuthConfigured()) return null;
  const demo = usuarioDeDemo();
  return demo ? { userId: demo } : null;
}
