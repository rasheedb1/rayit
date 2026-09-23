import { getOAuthHandlers } from "../../../_lib/oauth-server";

type Ctx = { params: Promise<{ platform: string }> };

// Lee cookies y query: nunca se prerenderiza.
export const dynamic = "force-dynamic";

/** La plataforma vuelve aquí con code y state (o con error si el creador canceló). */
export async function GET(req: Request, ctx: Ctx) {
  // La bitácora la escribe la consulta, en la misma transacción que la
  // conexión (ACC-2): upsertConnection deja connection.added, .reconnected
  // (lo que hace «Reautorizar») o .authorized, y upgradePublicAccountToOAuth
  // connection.authorized; nunca el code ni los tokens (CON-3 §0.2).
  const { platform } = await ctx.params;
  return getOAuthHandlers().callback(req, platform);
}
