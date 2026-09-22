import "server-only";
import { flags } from "@/content/flags";
import { createOAuthHandlers, type OAuthHandlers } from "./oauth-handlers";
import { withWorkspace } from "./db";

/** Con la bandera oauth_connect apagada (CON-10), las rutas de CON-3 no existen para el público. */
const OFF: OAuthHandlers = {
  async start() { return new Response("No encontrado.", { status: 404 }); },
  async callback() { return new Response("No encontrado.", { status: 404 }); },
};

/** Un solo juego de handlers por proceso: la clave y la configuración de las apps se resuelven una vez. */
declare global {
  var __mcOAuthHandlers: OAuthHandlers | undefined;
}

export function getOAuthHandlers(): OAuthHandlers {
  if (!flags.oauth_connect) return OFF;
  if (!globalThis.__mcOAuthHandlers) globalThis.__mcOAuthHandlers = createOAuthHandlers({ env: process.env, withWorkspace });
  return globalThis.__mcOAuthHandlers;
}
