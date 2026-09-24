/**
 * Una fila por canal en /ventas/canales, como la pantalla de
 * integraciones de Vercel o de Linear: qué cuenta, en qué estado y qué
 * botón. Pura, para probarla sin base ni React.
 *
 * Qué cuenta encabeza un canal: la viva (conectada, por reconectar o con
 * error) si la hay; si no, el intento MÁS RECIENTE (pendiente, cancelado,
 * fallido o desconectado), para decir en qué quedó el último clic y no
 * uno viejo: @mc/db deja como mucho una pendiente por creador y canal, y
 * aquí manda la fecha. Un canal con cuenta viva ofrece además «Conectar
 * otra cuenta» (`addAnother`). Las DEMÁS cuentas
 * vivas del canal (dos buzones en el mismo espacio, dos LinkedIn) van en
 * `others`, una sub-fila cada una con su estado, sus límites y su
 * «Desconectar», como Vercel con varias integraciones del mismo tipo:
 * ninguna cuenta viva queda sin verse, sin poder editarse ni soltarse.
 *
 * Sin las llaves del proveedor en la plataforma («no disponible»), la fila
 * lo dice SIEMPRE, también cuando hay una cuenta viva: una conectada sale
 * «En pausa» (no puede enviar ni refrescarse), y una caída conserva su
 * «Reconectar», deshabilitado y con la explicación al lado. Nunca una
 * fila en rojo sin botón y sin motivo.
 */
import { CHANNEL_ERROR_CODES, type ChannelAccountRow } from "@mc/db/queries/canales";
import type { PillKind } from "@/components/ui/pill";
import { MESSAGES } from "../messages";
import { CHANNELS, type Channel, type ChannelSetup } from "./config";

export type RowState = "not_configured" | "disconnected" | "pending" | "expired" | "connected" | "needs_reconnect" | "error";

/**
 * Qué botón toca:
 *   connect    conectar (Google o la hosted auth de Unipile)
 *   reconnect  reconectar una cuenta caída
 *   retry      volver a empezar una conexión que no terminó
 *   rewebhook  volver a dar de alta los avisos de una cuenta conectada que se quedó sin ellos
 *   null       ninguno (ya conectada)
 */
export type RowAction = "connect" | "reconnect" | "retry" | "rewebhook" | null;

export interface ChannelRowView {
  channel: Channel;
  state: RowState;
  account: ChannelAccountRow | null;
  /** Las variables que faltan en el servidor (vacío si el canal se puede conectar). Solo para el registro y el modo desarrollo. */
  missing: string[];
  /** El canal no está disponible en la plataforma (faltan llaves): el botón va deshabilitado y la fila lo explica. */
  unavailable: boolean;
  action: RowAction;
  /** El motivo, en español, de la última falla, si hay que decirlo. */
  reason: string | null;
  /** Las demás cuentas vivas del canal, cada una con su vista (y `others` vacío). */
  others: ChannelRowView[];
  /** El canal ya tiene una cuenta viva y se puede conectar otra (solo en la fila principal, con el canal disponible). */
  addAnother: boolean;
}

const LIVE = new Set(["connected", "needs_reconnect", "error"]);

export const STATE_PILL: Record<RowState, { kind: PillKind; label: string }> = {
  connected: { kind: "good", label: MESSAGES.status.connected },
  pending: { kind: "neutral", label: MESSAGES.status.pending },
  expired: { kind: "warn", label: MESSAGES.status.expired },
  needs_reconnect: { kind: "bad", label: MESSAGES.status.needsReconnect },
  error: { kind: "bad", label: MESSAGES.status.error },
  disconnected: { kind: "neutral", label: MESSAGES.status.disconnected },
  not_configured: { kind: "neutral", label: MESSAGES.status.notConfigured },
};

/** La pill de una fila: una cuenta conectada en un canal no disponible sale «En pausa», en ámbar. */
export function pillFor(row: ChannelRowView): { kind: PillKind; label: string } {
  if (row.state === "connected" && row.unavailable) return { kind: "warn", label: MESSAGES.status.paused };
  return STATE_PILL[row.state];
}

const E = MESSAGES.banners.errors;

/**
 * Los códigos que escribe el código en last_error (CHANNEL_ERROR_CODES),
 * en frase, con el nombre del servicio cuando la frase lo lleva. Lo que
 * no es un código es una frase nuestra (@mc/core, canales-textos.ts):
 * ni la web ni el worker escriben en last_error el texto de un proveedor.
 */
const REASON_BY_CODE: Record<string, (service: string) => string> = {
  [CHANNEL_ERROR_CODES.taken]: () => E.ocupada,
  [CHANNEL_ERROR_CODES.missingScopes]: () => E.permisos,
  [CHANNEL_ERROR_CODES.wrongProvider]: () => E.canal_equivocado,
  [CHANNEL_ERROR_CODES.cancelled]: () => E.cancelada,
  [CHANNEL_ERROR_CODES.releasing]: () => MESSAGES.detail.releasing,
  [CHANNEL_ERROR_CODES.webhooksMissing]: () => MESSAGES.detail.webhooksMissing,
  [CHANNEL_ERROR_CODES.providerError]: E.proveedor,
  [CHANNEL_ERROR_CODES.exchangeFailed]: () => E.intercambio,
  [CHANNEL_ERROR_CODES.authFailed]: E.unipile_fallo,
};

export function reasonText(lastError: string | null, channel: Channel): string | null {
  if (!lastError) return null;
  const byCode = Object.hasOwn(REASON_BY_CODE, lastError) ? REASON_BY_CODE[lastError] : undefined;
  return byCode ? byCode(MESSAGES.channels[channel].provider) : lastError;
}

type Base = Pick<ChannelRowView, "channel" | "missing" | "unavailable">;

/** La vista de UNA cuenta viva: conectada (con «Volver a intentar» si le faltan los avisos) o caída (con «Reconectar»). */
function liveRow(base: Base, account: ChannelAccountRow): ChannelRowView {
  const reason = reasonText(account.lastError, base.channel);
  if (account.status === "connected") {
    const action: RowAction = account.lastError === CHANNEL_ERROR_CODES.webhooksMissing ? "rewebhook" : null;
    return { ...base, account, state: "connected", action, reason, others: [], addAnother: false };
  }
  return { ...base, account, state: account.status as "needs_reconnect" | "error", action: "reconnect", reason, others: [], addAnother: false };
}

export function channelRows(accounts: readonly ChannelAccountRow[], setup: ChannelSetup): ChannelRowView[] {
  return CHANNELS.map((channel): ChannelRowView => {
    const mine = accounts.filter((a) => a.channel === channel);
    const live = mine.filter((a) => LIVE.has(a.status));
    const { configured, missing } = setup[channel];
    const base: Base = { channel, missing, unavailable: !configured };
    if (live.length > 0) {
      const [first, ...rest] = live;
      return { ...liveRow(base, first!), others: rest.map((a) => liveRow(base, a)), addAnother: configured };
    }
    // El intento más reciente (listChannelAccounts ordena por updated_at, de nuevo a viejo), no «cualquier pendiente».
    const account = mine[0] ?? null;
    const none = { others: [], addAnother: false };
    if (!configured) return { ...base, account, state: "not_configured", action: "connect", reason: null, ...none };
    if (account?.status === "pending") {
      return { ...base, account, state: account.stale ? "expired" : "pending", action: "retry", reason: null, ...none };
    }
    return { ...base, account, state: "disconnected", action: "connect", reason: reasonText(account?.lastError ?? null, channel), ...none };
  });
}
