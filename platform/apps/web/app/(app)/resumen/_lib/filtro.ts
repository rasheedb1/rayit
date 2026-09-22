import { PERIODOS, REDES, type Periodo, type RedId } from "@mc/db/queries/resumen";

/**
 * El filtro de Resumen vive en la URL, no en el estado del cliente:
 * `/resumen?periodo=90&red=tiktok` se puede pegar en un chat y abre lo
 * mismo para quien lo reciba. Aquí se valida lo que llega —cualquiera
 * puede escribir `?periodo=chorizo`— y se construye la URL de vuelta.
 */
export type Filtro = { dias: Periodo; red: RedId | null };

export const PERIODO_POR_DEFECTO: Periodo = 30;

export { PERIODOS, REDES };
export type { Periodo, RedId };

export function parsePeriodo(valor: string | undefined): Periodo {
  const n = Number(valor);
  return (PERIODOS as readonly number[]).includes(n) ? (n as Periodo) : PERIODO_POR_DEFECTO;
}

export function parseRed(valor: string | undefined): RedId | null {
  return valor && (REDES as readonly string[]).includes(valor) ? (valor as RedId) : null;
}

export function parseFiltro(params: { periodo?: string; red?: string }): Filtro {
  return { dias: parsePeriodo(params.periodo), red: parseRed(params.red) };
}

/** La ruta canónica de un filtro: sin parámetros cuando son los de por defecto. */
export function hrefDe(filtro: Filtro): string {
  const q = new URLSearchParams();
  if (filtro.dias !== PERIODO_POR_DEFECTO) q.set("periodo", String(filtro.dias));
  if (filtro.red) q.set("red", filtro.red);
  const s = q.toString();
  return s ? `/resumen?${s}` : "/resumen";
}
