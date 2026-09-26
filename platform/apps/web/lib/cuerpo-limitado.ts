/**
 * Leer el cuerpo de una petición con un techo de BYTES que proteja de
 * verdad (VEN-9, VEN-15). Para las rutas que reciben de fuera sin sesión:
 * el webhook de Unipile y la baja de un clic (RFC 8058).
 *
 * `request.text()`, `request.json()` y `request.formData()` leen el
 * cuerpo ENTERO antes de devolver nada: un techo aplicado después no
 * protege de quien manda megas. Aquí se mira primero el Content-Length
 * (sin leer nada) y después se cuenta lo que llega por el flujo, que se
 * corta en cuanto se pasa aunque la cabecera mintiera o no estuviera.
 */

export type LimitedBytes = { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; status: 400 | 413 };
export type LimitedBody = { ok: true; value: unknown } | { ok: false; status: 400 | 413 };

/** El cuerpo en bytes, o 413 si pasa de `maxBytes` y 400 si no hay cuerpo. */
export async function readLimitedBytes(req: Request, maxBytes: number): Promise<LimitedBytes> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) return { ok: false, status: 413 };
  if (!req.body) return { ok: false, status: 400 };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, status: 413 };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/** El cuerpo como JSON, con el mismo techo: 400 si no es JSON. */
export async function readLimitedJson(req: Request, maxBytes: number): Promise<LimitedBody> {
  const body = await readLimitedBytes(req, maxBytes);
  if (!body.ok) return body;
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(body.bytes)) as unknown };
  } catch {
    return { ok: false, status: 400 };
  }
}
