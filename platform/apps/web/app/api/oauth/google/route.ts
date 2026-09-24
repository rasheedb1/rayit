import { googleStart } from "@/app/(app)/ventas/canales/_lib/conexion";
import { channelDeps } from "@/app/(app)/ventas/canales/_lib/server";

// Crea la fila pendiente y firma el estado en cada petición: nunca se prerenderiza.
export const dynamic = "force-dynamic";

/** «Conectar» el correo en /ventas/canales envía aquí el formulario: estado firmado y 303 a Google. */
export async function POST(req: Request) {
  return googleStart(req, channelDeps());
}

/** Un enlace directo no inicia nada: 405 con la explicación. */
export async function GET(req: Request) {
  return googleStart(req, channelDeps());
}
