import { looksLikeOptoutToken } from "@mc/core/outreach/deliverability";
import { readLimitedBytes } from "@/lib/cuerpo-limitado";
import { darDeBajaDesdeEnlace } from "@/lib/db/baja";
import { MESSAGES } from "../../messages";

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
  const pide = await pideLaBajaDeUnClic(request);
  if (pide === "grande") return new Response(MESSAGES.unClic.demasiadoGrande, { status: 413 });
  if (pide === "no") return new Response(MESSAGES.unClic.faltaCuerpo, { status: 400 });
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

/**
 * Tope del cuerpo: el de la RFC tiene 26 bytes, y un multipart con él
 * cabe en unos cientos. Es una ruta pública sin sesión, así que el tope
 * se cuenta sobre el flujo (readLimitedBytes) ANTES de leer nada entero:
 * `request.formData()` o `request.text()` se tragarían el cuerpo completo.
 */
const CUERPO_MAX = 8 * 1024;

/**
 * Si el cuerpo dice List-Unsubscribe=One-Click, en cualquiera de las dos
 * formas de formulario. Con un Content-Type que no es de formulario (o
 * sin él), se busca el par en el texto: la RFC no deja otra lectura.
 * «grande» si el cuerpo pasa de CUERPO_MAX (413); sin cuerpo, «no».
 */
async function pideLaBajaDeUnClic(request: Request): Promise<"si" | "no" | "grande"> {
  const cuerpo = await readLimitedBytes(request, CUERPO_MAX);
  if (!cuerpo.ok) return cuerpo.status === 413 ? "grande" : "no";
  const tipo = request.headers.get("content-type") ?? "";
  const minusculas = tipo.toLowerCase();
  if (minusculas.startsWith("multipart/form-data") || minusculas.startsWith("application/x-www-form-urlencoded")) {
    // Los bytes ya leídos (y ya acotados) se vuelven a parsear como el formulario que dicen ser.
    const fd = await new Response(cuerpo.bytes, { headers: { "content-type": tipo } }).formData().catch(() => null);
    return fd?.get("List-Unsubscribe") === "One-Click" ? "si" : "no";
  }
  const texto = new TextDecoder().decode(cuerpo.bytes);
  if (new URLSearchParams(texto.trim()).get("List-Unsubscribe") === "One-Click") return "si";
  return /(^|[\s&;"])List-Unsubscribe=One-Click(\s|$|&|;)/.test(texto) ? "si" : "no";
}
