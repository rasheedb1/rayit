import { unipileFailure, unipileStart } from "../_lib/conexion";
import { channelDeps } from "../_lib/server";

// Crea la fila pendiente y pide el enlace a Unipile en cada petición.
export const dynamic = "force-dynamic";

/** «Conectar» o «Reconectar» LinkedIn o Instagram: 303 al enlace de hosted auth de Unipile. */
export async function POST(req: Request) {
  return unipileStart(req, channelDeps());
}

/** La vuelta de Unipile cuando su página de conexión termina sin cuenta: la pendiente dice por qué y 303 a la pantalla. */
export async function GET(req: Request) {
  return unipileFailure(req, channelDeps());
}
