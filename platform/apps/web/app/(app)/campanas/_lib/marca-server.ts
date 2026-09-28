import "server-only";
import { createMarcaService, type MarcaService } from "./marca-service";
import { withWorkspace } from "./db";

declare global {
  var __mcMarca: MarcaService | undefined;
}

/** Un servicio por proceso, con las variables del servidor (INSTAGRAM_HOUSE_TOKEN, GOOGLE_API_KEY). */
export function getMarcaService(): MarcaService {
  if (!globalThis.__mcMarca) globalThis.__mcMarca = createMarcaService({ env: process.env, withWorkspace });
  return globalThis.__mcMarca;
}
