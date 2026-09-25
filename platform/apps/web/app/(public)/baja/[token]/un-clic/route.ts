import { looksLikeOptoutToken } from "@mc/core/outreach/deliverability";
import { darDeBajaDesdeEnlace } from "@/lib/db/baja";

/**
 * POST /baja/<token>/un-clic · el «Darse de baja» de un clic de Gmail,
 * Yahoo y Apple Mail (RFC 8058). El correo lleva
 *
 *   List-Unsubscribe: <https://…/baja/<token>/un-clic>
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *
 * y el proveedor hace aquí un POST sin cookies con ese cuerpo. Es la
 * misma baja que el botón de la página (el mismo sha256, el mismo rechazo
 * de quien envió, la misma public_optout). No depende de ningún secreto:
 * un error de configuración no la apaga. Solo POST: un GET no da de baja
 * a nadie (Next responde 405), y el cuerpo tiene que ser el de la RFC.
 */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const cuerpo = await request.text().catch(() => "");
  if (!new URLSearchParams(cuerpo).has("List-Unsubscribe")) {
    return new Response("Falta List-Unsubscribe=One-Click (RFC 8058).", { status: 400 });
  }
  if (!looksLikeOptoutToken(token)) return new Response(null, { status: 404 });
  try {
    const r = await darDeBajaDesdeEnlace(token);
    if (r.status === "ok") return new Response(null, { status: 200 });
    if (r.status === "sender") return new Response(null, { status: 403 });
    return new Response(null, { status: 404 });
  } catch (err) {
    console.error("[baja un clic] no se pudo completar", err);
    return new Response(null, { status: 500 });
  }
}
