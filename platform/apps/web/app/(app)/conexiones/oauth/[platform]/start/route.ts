import { puede } from "@/lib/permisos";
import { getOAuthHandlers } from "../../../_lib/oauth-server";

type Ctx = { params: Promise<{ platform: string }> };

/**
 * El diálogo de consentimiento envía aquí el formulario (POST): queda
 * evidencia y se abre la plataforma. Es el mismo inicio para «Conectar»
 * y para «Reautorizar» (CON-4): el callback vuelve a la misma fila por
 * su clave natural.
 */
export async function POST(req: Request, ctx: Ctx) {
  // Es el punto de entrada del flujo que escribe tokens: el mismo
  // permiso que «Agregar cuenta», y antes de mirar el formulario. Un
  // route handler no tiene frontera de error, así que no se lanza (sería
  // un 500): se vuelve a Cuentas con el mismo aviso que da el handler
  // cuando la transacción dice que no (oauth-handlers.ts, sin_permiso).
  if (!(await puede("conexiones.cuenta.conectar"))) {
    return new Response(null, { status: 303, headers: { Location: "/conexiones?error=sin_permiso" } });
  }
  const { platform } = await ctx.params;
  return getOAuthHandlers().start(req, platform);
}

/** Un enlace directo no trae consentimiento: 405 con la explicación. */
export async function GET(req: Request, ctx: Ctx) {
  const { platform } = await ctx.params;
  return getOAuthHandlers().start(req, platform);
}
