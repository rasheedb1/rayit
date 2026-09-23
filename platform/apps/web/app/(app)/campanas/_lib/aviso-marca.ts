/**
 * «Actualizar ahora» vuelve a la ficha con el resultado en la URL. Viaja
 * como CÓDIGOS (?marca=guardada&aviso=transitorio.instagram) y la página
 * los traduce con messages.ts: un enlace no puede meter un texto propio en
 * la pantalla (un token desconocido se descarta), y el nombre de una
 * variable del servidor nunca llega a quien mira.
 */
import { isPlatformId, PLATFORM_LABEL } from "@/components/ui/platform-pill";
import { AVISO_CODES, ERROR_CODES, type ActualizarMarcaResult, type AvisoCode, type ErrorCode } from "./marca-service";
import { MESSAGES } from "./messages";

const t = MESSAGES.seguidores;

export type ResultadoMarca = "guardada" | "ya_hoy";

/** Lo que va detrás del «?» al volver a la ficha. */
export function queryDeMarca(out: ActualizarMarcaResult | { ok: false; code: "generico"; avisos: [] }): string {
  const avisos = out.avisos.map((a) => `${a.code}.${a.platformId}`);
  const params = new URLSearchParams();
  if (out.ok) params.set("marca", out.resultado);
  const tokens = out.ok ? avisos : [out.code, ...avisos];
  if (tokens.length > 0) params.set("aviso", tokens.join(","));
  return params.toString();
}

const esError = (v: string): v is ErrorCode | "generico" => v === "generico" || (ERROR_CODES as readonly string[]).includes(v);
const esAviso = (v: string): v is AvisoCode => (AVISO_CODES as readonly string[]).includes(v);

/** Lo que la página enseña a partir de los parámetros. Lo que no se reconoce, no se enseña. */
export function leerAvisoMarca(marca: string | undefined, aviso: string | undefined): { resultado: ResultadoMarca | null; mensajes: string[] } {
  const resultado = marca === "guardada" || marca === "ya_hoy" ? marca : null;
  const mensajes: string[] = [];
  for (const token of (aviso ?? "").split(",").slice(0, 8)) {
    if (esError(token)) {
      mensajes.push(t.errores[token]);
      continue;
    }
    const [code, platformId] = token.split(".");
    if (code && platformId && esAviso(code) && isPlatformId(platformId)) mensajes.push(t.avisos[code](PLATFORM_LABEL[platformId]));
  }
  return { resultado, mensajes };
}
