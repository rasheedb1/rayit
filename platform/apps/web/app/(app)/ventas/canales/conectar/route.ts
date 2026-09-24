import { unipileStart } from "../_lib/conexion";
import { channelDeps } from "../_lib/server";

// Crea la fila pendiente y pide el enlace a Unipile en cada petición.
export const dynamic = "force-dynamic";

/** «Conectar» o «Reconectar» LinkedIn o Instagram: 303 al enlace de hosted auth de Unipile. */
export async function POST(req: Request) {
  return unipileStart(req, channelDeps());
}
