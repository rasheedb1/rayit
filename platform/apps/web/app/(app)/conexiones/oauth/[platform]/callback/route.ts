import { getOAuthHandlers } from "../../../_lib/oauth-server";

type Ctx = { params: Promise<{ platform: string }> };

// Lee cookies y query: nunca se prerenderiza.
export const dynamic = "force-dynamic";

/** La plataforma vuelve aquí con code y state (o con error si el creador canceló). */
export async function GET(req: Request, ctx: Ctx) {
  const { platform } = await ctx.params;
  return getOAuthHandlers().callback(req, platform);
}
