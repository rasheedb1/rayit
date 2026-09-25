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
 *
 * El cuerpo llega como multipart/form-data (lo que la RFC §3.1 dice que
 * el proveedor SHOULD mandar) o como application/x-www-form-urlencoded
 * (lo que MAY mandar, y lo que manda Gmail): se aceptan los dos. Un
 * proveedor que siguiera la RFC al pie de la letra y recibiera un 400 no
 * daría de baja a nadie, y el creador incumpliría el requisito de baja de
 * un clic de Gmail y Yahoo sin enterarse.
 */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  if (!(await pideLaBajaDeUnClic(request))) {
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

/** Tope del cuerpo que se mira: el de la RFC tiene 26 bytes. */
const CUERPO_MAX = 8 * 1024;

/**
 * Si el cuerpo dice List-Unsubscribe=One-Click, en cualquiera de las dos
 * formas de formulario. Con un Content-Type que no es de formulario (o
 * sin él), se busca el par en el texto: la RFC no deja otra lectura.
 */
async function pideLaBajaDeUnClic(request: Request): Promise<boolean> {
  const tipo = (request.headers.get("content-type") ?? "").toLowerCase();
  if (tipo.startsWith("multipart/form-data") || tipo.startsWith("application/x-www-form-urlencoded")) {
    const fd = await request.formData().catch(() => null);
    return fd?.get("List-Unsubscribe") === "One-Click";
  }
  const texto = (await request.text().catch(() => "")).slice(0, CUERPO_MAX);
  if (new URLSearchParams(texto.trim()).get("List-Unsubscribe") === "One-Click") return true;
  return /(^|[\s&;"])List-Unsubscribe=One-Click(\s|$|&|;)/.test(texto);
}
