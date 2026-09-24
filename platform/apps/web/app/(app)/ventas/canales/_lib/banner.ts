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
 * Un ?error= conocido es siempre el mensaje de error. Pura: se prueba sin
 * React.
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

export function channelBanner(params: { conectado?: string; error?: string }, rows: readonly ChannelRowView[]): ChannelBanner {
  const errors: Record<string, string> = MESSAGES.banners.errors;
  if (params.error && Object.hasOwn(errors, params.error)) return { message: errors[params.error as ChannelErrorCode]!, notice: null, refresh: false };
  if (!isChannel(params.conectado)) return NONE;
  const channel = params.conectado;
  const row = rows.find((r) => r.channel === channel);
  const name = MESSAGES.channels[channel].provider;
  if (row?.state === "connected") return { message: null, notice: MESSAGES.banners.connected(name), refresh: false };
  if (row?.state === "pending") return { message: null, notice: MESSAGES.banners.finishing(name), refresh: true };
  return NONE;
}
