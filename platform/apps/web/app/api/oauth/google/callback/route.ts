import { googleCallback } from "@/app/(app)/ventas/canales/_lib/conexion";
import { channelDeps } from "@/app/(app)/ventas/canales/_lib/server";

// Lee cookies y query: nunca se prerenderiza.
export const dynamic = "force-dynamic";

/** Google vuelve aquí con code y state (o con error si la persona canceló). */
export async function GET(req: Request) {
  return googleCallback(req, channelDeps());
}
