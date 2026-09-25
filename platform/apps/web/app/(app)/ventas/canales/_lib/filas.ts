/**
 * Una fila por canal en /ventas/canales, como la pantalla de
 * integraciones de Vercel o de Linear: qué cuenta, en qué estado y qué
 * botón. Pura, para probarla sin base ni React.
 *
 * Qué cuenta encabeza un canal: la viva (conectada, por reconectar o con
 * error) si la hay; si no, el intento MÁS RECIENTE (pendiente, cancelado,
 * fallido o desconectado), para decir en qué quedó el último clic y no
 * uno viejo: @mc/db deja como mucho una pendiente por creador y canal, y
 * aquí manda la fecha. Las DEMÁS cuentas vivas del canal (dos buzones en
 * el mismo espacio, dos LinkedIn) van en `others`, una sub-fila cada una
 * con su estado, sus límites y su «Desconectar», como Vercel con varias
 * integraciones del mismo tipo.
 *
 * «Conectar otra cuenta» (`addAnother`) solo cuando el canal ya tiene una
 * cuenta CONECTADA: con la única cuenta caída, lo que importa es
 * «Reconectar», y un segundo botón competía con él.
 *
 * Sin las llaves del proveedor en la plataforma («no disponible»), la fila
 * lo dice SIEMPRE, también cuando hay una cuenta viva: una conectada sale
 * «En pausa», y una caída conserva su «Reconectar», deshabilitado y con la
 * explicación al lado. Nunca una fila en rojo sin botón y sin motivo.
 *
 * El motivo de la fila sale de un CÓDIGO (last_error, que la base guarda
 * sin frases): REASON_BY_CODE lo traduce con las frases de messages.ts, y
 * un código que no conoce sale siempre como detail.unknownReason, nunca
 * como el texto de la base. Los motivos de UN intento (el servicio no
 * respondió, la persona canceló, la contraseña no era) solo se enseñan si
 * son de las últimas 24 horas (EXPIRING_CODES): días después ya no dicen
 * nada útil y solo ponían ruido en una fila «Sin conectar». Cancelar no es
 * un error: su motivo va en neutro (`reasonTone`), no en el recuadro rojo.
 */
import {
  CHANNEL_ERROR_CODES, isLiveChannelStatus, parseUnipileStatusCode, type ChannelAccountRow,
} from "@mc/db/queries/canales";
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

export type ReasonTone = "error" | "neutral";

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
  /** Cómo se pinta el motivo: «error» en el recuadro rojo; «neutral» en texto (la persona canceló: no es un error). */
  reasonTone: ReasonTone;
  /** Las demás cuentas vivas del canal, cada una con su vista (y `others` vacío). */
  others: ChannelRowView[];
  /** El canal ya tiene una cuenta conectada y se puede conectar otra (solo en la fila principal, con el canal disponible). */
  addAnother: boolean;
  /** La persona ya volvió de la página del proveedor (?conectado=) y la fila sigue esperando la confirmación. */
  returned: boolean;
}

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
const H = MESSAGES.health;

/**
 * Los códigos de last_error (CHANNEL_ERROR_CODES de @mc/db), en frase, con
 * el nombre del servicio cuando la frase lo lleva. 'unipile_status:<X>'
 * se traduce aparte (lo que Unipile dijo de la sesión).
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
  [CHANNEL_ERROR_CODES.duplicate]: () => MESSAGES.detail.reasons.duplicado,
  [CHANNEL_ERROR_CODES.gmailRevoked]: () => H.gmailRevoked,
  [CHANNEL_ERROR_CODES.gmailNoSecret]: () => H.gmailNoSecret,
  [CHANNEL_ERROR_CODES.unipileGone]: (service) => H.unipileGone(service),
  [CHANNEL_ERROR_CODES.transient]: () => MESSAGES.detail.reasons.transient,
};

/**
 * Los motivos de un intento que la persona ya dejó atrás (canceló en
 * Google, la contraseña no era): se enseñan solo si son de las últimas 24
 * horas (lastErrorRecent). El keepalive borra el intento a los 7 días, y
 * hasta entonces la fila no tiene que repetirlo.
 */
const EXPIRING_CODES: ReadonlySet<string> = new Set([CHANNEL_ERROR_CODES.cancelled, CHANNEL_ERROR_CODES.authFailed]);

/**
 * Los fallos pasajeros del servicio (no respondió al empezar la conexión,
 * no se pudo comprobar la cuenta): solo durante una hora
 * (lastErrorFresh). No son culpa de la persona y lo único que le piden es
 * reintentar; un fallo de un minuto no deja la fila en rojo todo el día.
 */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([CHANNEL_ERROR_CODES.providerError, CHANNEL_ERROR_CODES.transient]);

/** Los motivos que no son un error: la persona lo decidió. Van en texto neutro, no en el recuadro rojo. */
const NEUTRAL_CODES: ReadonlySet<string> = new Set([CHANNEL_ERROR_CODES.cancelled]);

/**
 * El motivo de una cuenta en frase, o null si no hay nada que decir.
 * `recent`: last_error es de las últimas 24 horas; `fresh`, de la última
 * hora (la consulta lo dice, la pantalla no resta fechas). Un código que
 * la pantalla no conoce nunca se enseña crudo; tampoco con un estado
 * caído, donde la frase genérica cambia (`state`).
 */
export function reasonText(
  lastError: string | null, channel: Channel, recent = true, fresh = true, state: RowState = "error",
): string | null {
  if (!lastError) return null;
  if (EXPIRING_CODES.has(lastError) && !recent) return null;
  if (TRANSIENT_CODES.has(lastError) && !fresh) return null;
  const service = MESSAGES.channels[channel].provider;
  const status = parseUnipileStatusCode(lastError);
  if (status !== null) return H.unipileStatus(status, service);
  const byCode = Object.hasOwn(REASON_BY_CODE, lastError) ? REASON_BY_CODE[lastError] : undefined;
  if (byCode) return byCode(service);
  // Marcada para reconectar (o un intento que no terminó), la cuenta no «se arregla sola»: la frase genérica pide reconectar.
  return state === "needs_reconnect" || state === "disconnected" ? MESSAGES.detail.unknownReasonReconnect : MESSAGES.detail.unknownReason;
}

/** El tono del motivo de un código (ver NEUTRAL_CODES). */
export function reasonTone(lastError: string | null): ReasonTone {
  return lastError !== null && NEUTRAL_CODES.has(lastError) ? "neutral" : "error";
}

type Base = Pick<ChannelRowView, "channel" | "missing" | "unavailable">;
const rest = { others: [] as ChannelRowView[], addAnother: false, returned: false, reasonTone: "error" as ReasonTone };

/** La vista de UNA cuenta viva: conectada (con «Volver a intentar» si le faltan los avisos) o caída (con «Reconectar»). */
function liveRow(base: Base, account: ChannelAccountRow): ChannelRowView {
  const state = account.status === "connected" ? "connected" : (account.status as "needs_reconnect" | "error");
  const reason = reasonText(account.lastError, base.channel, account.lastErrorRecent, account.lastErrorFresh, state);
  const tone = reasonTone(account.lastError);
  if (account.status === "connected") {
    const action: RowAction = account.lastError === CHANNEL_ERROR_CODES.webhooksMissing ? "rewebhook" : null;
    return { ...base, ...rest, account, state: "connected", action, reason, reasonTone: tone };
  }
  return { ...base, ...rest, account, state: account.status as "needs_reconnect" | "error", action: "reconnect", reason, reasonTone: tone };
}

/**
 * Las filas de la pantalla. `returnedFrom`: el canal de ?conectado= (la
 * persona volvió de la página del proveedor), para que su fila pendiente
 * no le pida terminar algo que ya terminó.
 */
export function channelRows(accounts: readonly ChannelAccountRow[], setup: ChannelSetup, opts: { returnedFrom?: Channel | null } = {}): ChannelRowView[] {
  return CHANNELS.map((channel): ChannelRowView => {
    const mine = accounts.filter((a) => a.channel === channel);
    const live = mine.filter((a) => isLiveChannelStatus(a.status));
    const { configured, missing } = setup[channel];
    const base: Base = { channel, missing, unavailable: !configured };
    if (live.length > 0) {
      const [first, ...others] = live;
      const anyConnected = live.some((a) => a.status === "connected");
      return { ...liveRow(base, first!), others: others.map((a) => liveRow(base, a)), addAnother: configured && anyConnected };
    }
    // El intento más reciente (listChannelAccounts ordena por updated_at, de nuevo a viejo), no «cualquier pendiente».
    const account = mine[0] ?? null;
    if (!configured) return { ...base, ...rest, account, state: "not_configured", action: "connect", reason: null };
    if (account?.status === "pending") {
      const state = account.stale ? "expired" : "pending";
      return { ...base, ...rest, account, state, action: "retry", reason: null, returned: state === "pending" && opts.returnedFrom === channel };
    }
    // El motivo es de un INTENTO que no terminó (la fila nunca tuvo cuenta: providerAccountId NULL). Una cuenta que la
    // persona desconectó a propósito no arrastra el motivo de su última caída, aunque la base aún lo guarde.
    const attempt = account !== null && account.providerAccountId === null;
    const code = attempt ? account.lastError : null;
    const reason = reasonText(code, channel, account?.lastErrorRecent ?? true, account?.lastErrorFresh ?? true, "disconnected");
    return { ...base, ...rest, account, state: "disconnected", action: "connect", reason, reasonTone: reasonTone(code) };
  });
}
