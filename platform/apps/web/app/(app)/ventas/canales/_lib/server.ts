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
import { withProviderCallback, withWorkspace } from "@/lib/db";
import { getCurrentWorkspaceId } from "@/lib/workspace/current";
import type { ChannelDeps } from "./deps";

export function channelDeps(env: Readonly<Record<string, string | undefined>> = process.env): ChannelDeps {
  const unipile = loadUnipileConfig(env);
  const hasGoogle = GOOGLE_ENV.every((k) => env[k]?.trim());
  return {
    env,
    withWorkspace,
    withProviderCallback,
    currentWorkspaceId: getCurrentWorkspaceId,
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
