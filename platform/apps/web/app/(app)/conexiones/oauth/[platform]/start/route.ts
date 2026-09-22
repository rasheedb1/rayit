import { getOAuthHandlers } from "../../../_lib/oauth-server";

type Ctx = { params: Promise<{ platform: string }> };

/** El diálogo de consentimiento envía aquí el formulario (POST): queda evidencia y se abre la plataforma. */
export async function POST(req: Request, ctx: Ctx) {
  const { platform } = await ctx.params;
  return getOAuthHandlers().start(req, platform);
}

/** Un enlace directo no trae consentimiento: 405 con la explicación. */
export async function GET(req: Request, ctx: Ctx) {
  const { platform } = await ctx.params;
  return getOAuthHandlers().start(req, platform);
}
