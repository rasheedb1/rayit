/**
 * El aviso de arriba de /ventas/canales, calculado con el ESTADO REAL de
 * la fila y no solo con el parámetro de la URL (VEN-9).
 *
 * Unipile manda a la persona a success_redirect (?conectado=linkedin) a
 * veces antes de que llegue su aviso de cuenta creada: con solo el
 * parámetro, la pantalla decía «LinkedIn quedó conectado» encima de una
 * fila «Conectando» o «Necesita reconectar». Ahora:
 *
 *   · la fila está conectada      → «quedó conectado», en verde;
 *   · la fila sigue conectándose  → «Estamos terminando de conectar tu
 *                                    LinkedIn…» y la pantalla se refresca
 *                                    sola unos segundos (refresh: true);
 *   · cualquier otra cosa         → nada: la fila ya dice lo que pasa.
 *
 * Un ?error= conocido es el mensaje de error, con el nombre del servicio
 * de ?canal= cuando la frase lo lleva. Pero si la fila de ese canal ya
 * dice ese mismo motivo (la ruta lo dejó en last_error), el aviso de
 * arriba no lo repite: la misma falla, dos veces y con dos redacciones, era ruido.
 * Pura: se prueba sin React.
 */
import { MESSAGES } from "../messages";
import { isChannel } from "./config";
import type { ChannelRowView } from "./filas";

export type ChannelErrorCode = keyof typeof MESSAGES.banners.errors;

export interface ChannelBanner {
  message: string | null;
  notice: string | null;
  /** La conexión todavía no terminó: refrescar la pantalla hasta que la fila cambie. */
  refresh: boolean;
}

const NONE: ChannelBanner = { message: null, notice: null, refresh: false };

export function isChannelErrorCode(v: unknown): v is ChannelErrorCode {
  return typeof v === "string" && Object.hasOwn(MESSAGES.banners.errors, v);
}

/** El texto de un código de error, con el nombre del servicio si la frase lo lleva. */
export function errorText(code: ChannelErrorCode, service: string): string {
  const e: string | ((service: string) => string) = MESSAGES.banners.errors[code];
  return typeof e === "function" ? e(service) : e;
}

export function channelBanner(params: { conectado?: string; error?: string; canal?: string }, rows: readonly ChannelRowView[]): ChannelBanner {
  if (isChannelErrorCode(params.error)) {
    const channel = isChannel(params.canal) ? params.canal : null;
    const row = channel ? rows.find((r) => r.channel === channel) : undefined;
    const service = channel ? MESSAGES.channels[channel].provider : MESSAGES.banners.genericService;
    const message = errorText(params.error, service);
    // La fila ya lo dice con las mismas palabras: no se repite arriba.
    if (row?.reason === message) return NONE;
    return { message, notice: null, refresh: false };
  }
  if (!isChannel(params.conectado)) return NONE;
  const channel = params.conectado;
  const row = rows.find((r) => r.channel === channel);
  const name = MESSAGES.channels[channel].provider;
  if (row?.state === "connected") return { message: null, notice: MESSAGES.banners.connected(name), refresh: false };
  if (row?.state === "pending") return { message: null, notice: MESSAGES.banners.finishing(name), refresh: true };
  return NONE;
}
