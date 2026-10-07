import "server-only";
import type { Identity } from "@mc/db";
import { isAuthConfigured } from "@/lib/auth/config";
import { usuarioDeDemo } from "@/lib/permisos/sesion";
import { getIdentidadDeSesion } from "@/lib/workspace/current";

/**
 * Quién abre el enlace de una invitación: la persona de la sesión, con
 * su id y su correo verificado.
 *
 * NO pasa por getCurrentContext a propósito: ese exige un espacio, y
 * quien viene invitado puede no tener ninguno todavía (al entrar por
 * primera vez, lib/auth/sincronizar.ts no le crea uno propio si lo
 * esperan en otro). getIdentidadDeSesion resuelve lo mismo —sesión de
 * Supabase, correo verificado, fila de app_user— sin elegir espacio.
 * Sin sesión, null: la página ofrece entrar (el middleware ya habrá
 * mandado a /login con `next=` para volver).
 *
 * En una copia SIN llaves (modo demo) no hay sesión posible; la persona
 * simulada es DEMO_USER_ID, como en lib/permisos/sesion.ts, y sin ella
 * no hay nadie que acepte: la página lee el enlace sin sesión y dice que
 * en la demo no se acepta. Con llaves, DEMO_USER_ID no existe para este
 * archivo.
 */
export async function quienAcepta(): Promise<(Identity & { userId: string }) | null> {
  if (isAuthConfigured()) {
    const yo = await getIdentidadDeSesion();
    return yo ? { ...yo.identity } : null;
  }
  const demo = usuarioDeDemo();
  return demo ? { userId: demo } : null;
}
