import { isUuid } from "@mc/db";
import { isAuthConfigured, type Env } from "@/lib/auth/config";

/**
 * A quién se simula en una copia SIN llaves de Supabase Auth (modo demo),
 * o null para nadie. Es `DEMO_USER_ID`, el id de una fila de app_user.
 *
 * Con Auth configurado no se mira nunca, igual que DEMO_WORKSPACE_ID
 * (lib/workspace/current.ts): con llaves hay sesión, y la identidad sale
 * solo de ella.
 *
 * Se usa en dos sitios, y tienen que decir lo mismo:
 *   · los permisos del marco (lib/permisos/sesion.ts): qué módulos ve;
 *   · la identidad de las transacciones de las pantallas
 *     (getCurrentContext): app.user_id, y con él lo que la base deja ver
 *     por fila. Sin esto, los permisos eran los de esa persona y las
 *     filas las de nadie (quien ve a todo), y el alcance por creador de
 *     ACC-7 no se podía ver en la demo: con
 *     `DEMO_WORKSPACE_ID=000000a7-…-000000000001` y
 *     `DEMO_USER_ID=000000a7-…-000000000004`, la agencia del seed 0013 se
 *     ve como Diego, acotado a Camilo.
 *
 * Aparte de los dos, sin `server-only` ni dependencias de la petición,
 * para poder probarlo con el entorno inyectado.
 */
export function usuarioDeDemo(env: Env = process.env): string | null {
  if (isAuthConfigured(env)) return null;
  const id = env.DEMO_USER_ID?.trim();
  if (!id) return null;
  if (!isUuid(id)) {
    throw new Error(
      `DEMO_USER_ID no es un UUID: "${id}". Debe ser el id de una fila de app_user (la del seed: 00000002-0000-4000-8000-000000000002).`,
    );
  }
  return id;
}
