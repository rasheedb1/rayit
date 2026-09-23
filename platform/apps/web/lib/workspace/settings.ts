import "server-only";
import { cache } from "react";
import { getWorkspaceSettings, type WorkspaceSettings } from "@mc/db/queries/cimientos";
import { withWorkspace } from "@/lib/db";

/**
 * La moneda, la zona horaria y el locale del workspace actual.
 *
 * Es la costura que le faltaba al producto para salir de Colombia: el
 * esquema guarda esas tres columnas desde la migración 0001, pero
 * ninguna pantalla leía la fila `workspace`, así que `lib/format.ts`
 * fijaba "es-CO" y Finanzas pasaba "COP" a mano. Colombia son los
 * valores por defecto de un workspace, no constantes del código.
 *
 * `cache` de React lo memoriza por petición: aunque varias partes de la
 * misma pantalla lo pidan, la consulta se hace una vez.
 *
 *   const ws = await getCurrentWorkspace();
 *   const f = formatterFor(ws);
 *   f.money(kpis.outstanding);
 */
export const getCurrentWorkspace = cache(
  async (): Promise<WorkspaceSettings> => withWorkspace((tx) => getWorkspaceSettings(tx)),
);

export type { WorkspaceSettings };
