import "server-only";
/**
 * Las dependencias de verdad de las rutas de canales: las transacciones
 * de lib/db, el espacio de la sesión, el origen de lib/auth/origen y los
 * clientes reales de Google y de Unipile cuando sus llaves están. Sin
 * ellas, la fábrica es null y la ruta responde «no configurado»: nunca
 * se inventa una credencial ni se cae a un doble en producción.
 */
import { GOOGLE_ENV, GoogleOAuth, loadGoogleOAuthConfig, loadUnipileConfig, UnipileClient } from "@mc/connectors";
import { origenDesde } from "@/lib/auth/origen";
import { PUEDEN_GESTIONAR_CANALES } from "@/lib/auth/reglas";
import { withProviderCallback, withWorkspace } from "@/lib/db";
import { getCurrentContext, getCurrentWorkspaceId } from "@/lib/workspace/current";
import type { ChannelDeps } from "./deps";

/**
 * ¿El rol de quien pide, en el espacio de la sesión, puede gestionar los
 * canales? Sin sesión solo se llega en una copia SIN Supabase Auth (el
 * atajo de desarrollo de lib/workspace/current.ts): ahí no hay roles que
 * mirar y la persona es la dueña de su copia.
 */
export async function puedeGestionarCanales(): Promise<boolean> {
  const ctx = await getCurrentContext();
  if (!ctx.sesion) return true;
  const role = ctx.workspaces.find((w) => w.id === ctx.workspaceId)?.role;
  return role !== undefined && PUEDEN_GESTIONAR_CANALES.has(role);
}

export function channelDeps(env: Readonly<Record<string, string | undefined>> = process.env): ChannelDeps {
  const unipile = loadUnipileConfig(env);
  const hasGoogle = GOOGLE_ENV.every((k) => env[k]?.trim());
  return {
    env,
    withWorkspace,
    withProviderCallback,
    currentWorkspaceId: getCurrentWorkspaceId,
    canManage: puedeGestionarCanales,
    origin: async (req) => origenDesde(env, req.headers),
    google: hasGoogle
      ? (callLog, origin) => {
        const cfg = loadGoogleOAuthConfig(env, origin);
        if (!("config" in cfg)) throw new Error(`Google OAuth sin configurar: ${cfg.missing.join(", ")}`);
        return new GoogleOAuth(cfg.config, { callLog });
      }
      : null,
    unipile: "config" in unipile ? (callLog) => new UnipileClient({ config: unipile.config, callLog }) : null,
  };
}
