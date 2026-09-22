import "server-only";
import { createOAuthHandlers, type OAuthHandlers } from "./oauth-handlers";
import { withWorkspace } from "./db";

/** Un solo juego de handlers por proceso: la clave y la configuración de las apps se resuelven una vez. */
declare global {
  var __mcOAuthHandlers: OAuthHandlers | undefined;
}

export function getOAuthHandlers(): OAuthHandlers {
  if (!globalThis.__mcOAuthHandlers) globalThis.__mcOAuthHandlers = createOAuthHandlers({ env: process.env, withWorkspace });
  return globalThis.__mcOAuthHandlers;
}
