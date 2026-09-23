import { getOAuthHandlers } from "../../../_lib/oauth-server";

type Ctx = { params: Promise<{ platform: string }> };

// Lee cookies y query: nunca se prerenderiza.
export const dynamic = "force-dynamic";

/** La plataforma vuelve aquí con code y state (o con error si el creador canceló). */
export async function GET(req: Request, ctx: Ctx) {
  // TODO(ACC-2): audit('conexiones.cuenta.autorizar', { after: { platformId, scopes } })
  //   — nunca el code ni los tokens en before/after (CON-3 §0.2).
  const { platform } = await ctx.params;
  return getOAuthHandlers().callback(req, platform);
}
