import { PERIODS, PLATFORMS, type Period, type PlatformId } from "@mc/db/queries/resumen-constantes";

/**
 * El filtro de Resumen vive en la URL, no en el estado del cliente:
 * `/resumen?periodo=90&red=tiktok` se puede pegar en un chat y abre lo
 * mismo para quien lo reciba. Aquí se valida lo que llega —cualquiera
 * puede escribir `?periodo=chorizo`— y se construye la URL de vuelta.
 *
 * Los parámetros de la URL van en español (`periodo`, `red`) porque son
 * lo que la persona ve y comparte; el objeto, con los nombres de @mc/db.
 */
export type Filtro = { days: Period; platform: PlatformId | null };

export const PERIODO_POR_DEFECTO: Period = 30;

export { PERIODS, PLATFORMS };
export type { Period, PlatformId };

export function parsePeriodo(valor: string | undefined): Period {
  const n = Number(valor);
  return (PERIODS as readonly number[]).includes(n) ? (n as Period) : PERIODO_POR_DEFECTO;
}

export function parseRed(valor: string | undefined): PlatformId | null {
  return valor && (PLATFORMS as readonly string[]).includes(valor) ? (valor as PlatformId) : null;
}

export function parseFiltro(params: { periodo?: string; red?: string }): Filtro {
  return { days: parsePeriodo(params.periodo), platform: parseRed(params.red) };
}

/** El periodo más largo que ofrece el filtro. */
export const MAX_PERIODO: Period = PERIODS[PERIODS.length - 1]!;

/**
 * Qué salida ofrecer cuando una tarjeta se queda sin datos.
 *
 * Es una decisión, no un texto, y por eso vive aquí y se prueba:
 * ofrecer «Ver 90 días» a quien YA está en 90 días enlaza a la página
 * en la que está, y aconsejarle «prueba con un periodo más largo» es
 * pedirle algo imposible. Cuando no queda ninguna salida, `null`: la
 * pantalla explica por qué no hay datos y no pinta ningún botón.
 */
export function salidaDelVacio(filtro: Filtro): "masLargo" | "quitarRed" | null {
  if (filtro.days < MAX_PERIODO) return "masLargo";
  if (filtro.platform !== null) return "quitarRed";
  return null;
}

/** La ruta canónica de un filtro: sin parámetros cuando son los de por defecto. */
export function hrefDe(filtro: Filtro): string {
  const q = new URLSearchParams();
  if (filtro.days !== PERIODO_POR_DEFECTO) q.set("periodo", String(filtro.days));
  if (filtro.platform) q.set("red", filtro.platform);
  const s = q.toString();
  return s ? `/resumen?${s}` : "/resumen";
}
