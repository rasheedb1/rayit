import { unipileWebhook } from "@/app/(app)/ventas/canales/_lib/aviso";
import { channelDeps } from "@/app/(app)/ventas/canales/_lib/server";

// Lo llama Unipile, sin sesión (lib/auth/rutas.ts: /api/webhooks es público). Nada se prerenderiza.
export const dynamic = "force-dynamic";

/** Los avisos de Unipile: cuenta creada (estado firmado) o mensajes y salud (secreto compartido + ruta firmada). */
export async function POST(req: Request) {
  return unipileWebhook(req, channelDeps());
}
