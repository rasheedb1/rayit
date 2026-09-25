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
 *                                    sola un minuto (refresh: true); si
 *                                    el aviso no llega en ese minuto, la
 *                                    frase cambia a `slowNotice` («LinkedIn
 *                                    tarda en confirmar…»): nunca «estamos
 *                                    terminando» para siempre;
 *   · cualquier otra cosa         → nada: la fila ya dice lo que pasa.
 *
 * Un ?error= conocido es el mensaje de error, con el nombre del servicio
 * de ?canal= cuando la frase lo lleva. Pero si la fila de ese canal ya
 * dice ese mismo motivo (la ruta lo dejó en last_error), el aviso de
 * arriba no lo repite: la misma falla, dos veces y con dos redacciones, era ruido.
 *
 * No todo ?error= es un error (NOTICE_TONE): «no disponible» va en ámbar
 * (`warning`: no depende de la persona) y «Cancelaste la autorización» o
 * «ese perfil ya estaba conectado» en neutro (`info`: la persona lo
 * decidió, o no pasó nada malo). Lo demás, en rojo (`message`).
 * Pura: se prueba sin React.
 */
import { MESSAGES } from "../messages";
import { isChannel } from "./config";
import type { ChannelRowView } from "./filas";

export type ChannelErrorCode = keyof typeof MESSAGES.banners.errors;

export interface ChannelBanner {
  /** Un error, en rojo. */
  message: string | null;
  /** Salió bien, en verde. */
  notice: string | null;
  /** No depende de la persona (el canal no está disponible), en ámbar. */
  warning: string | null;
  /** Lo decidió la persona o no pasó nada malo (canceló), en neutro. */
  info: string | null;
  /** La conexión todavía no terminó: refrescar la pantalla hasta que la fila cambie. */
  refresh: boolean;
  /** Lo que dice el aviso cuando pasó el minuto de refrescos y la fila sigue sin confirmar. */
  slowNotice: string | null;
}

const NONE: ChannelBanner = { message: null, notice: null, warning: null, info: null, refresh: false, slowNotice: null };

/** El tono de los ?error= que no son un error; los que no están aquí van en rojo. */
export const NOTICE_TONE: Partial<Record<ChannelErrorCode, "warning" | "info">> = {
  no_configurado: "warning",
  cancelada: "info",
  duplicado: "info",
  apagado: "warning",
};

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
    return { ...NONE, [NOTICE_TONE[params.error] ?? "message"]: message };
  }
  if (!isChannel(params.conectado)) return NONE;
  const channel = params.conectado;
  const row = rows.find((r) => r.channel === channel);
  const name = MESSAGES.channels[channel].provider;
  if (row?.state === "connected") return { ...NONE, notice: MESSAGES.banners.connected(name) };
  if (row?.state === "pending") return { ...NONE, notice: MESSAGES.banners.finishing(name), refresh: true, slowNotice: MESSAGES.banners.finishingSlow(name) };
  return NONE;
}
