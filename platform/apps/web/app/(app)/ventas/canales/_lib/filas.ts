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
 * sin frases): REASON_BY_CODE lo traduce con las frases de messages.ts.
 * Un motivo pasajero (el servicio no respondió) solo se enseña si es de
 * las últimas 24 horas: días después ya no dice nada útil.
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

/** Los motivos pasajeros: días después ya no dicen nada, y no se enseñan. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([CHANNEL_ERROR_CODES.providerError, CHANNEL_ERROR_CODES.transient]);

/**
 * Las frases que la ronda 4 escribía en last_error (el keepalive y el
 * webhook). Una cuenta viva se renueva a diario y pasa a guardar el código;
 * mientras tanto se enseñan tal cual, porque son nuestras. Se borra en la
 * ronda siguiente.
 */
const LEGACY_PHRASES: ReadonlySet<string> = new Set(
  ["Gmail", "LinkedIn", "Instagram"].flatMap((n) => [
    ...["CREDENTIALS", "STOPPED", "DELETED", "DISCONNECTED", null].map((s) => H.unipileStatus(s, n)),
    H.unipileGone(n),
  ]).concat([H.gmailRevoked, H.gmailNoSecret, H.transient]),
);

/**
 * El motivo de una cuenta en frase, o null si no hay nada que decir.
 * `recent`: last_error es de las últimas 24 horas (la consulta lo dice).
 * Un código que la pantalla no conoce nunca se enseña crudo.
 */
export function reasonText(lastError: string | null, channel: Channel, recent = true): string | null {
  if (!lastError) return null;
  if (TRANSIENT_CODES.has(lastError) && !recent) return null;
  const service = MESSAGES.channels[channel].provider;
  const status = parseUnipileStatusCode(lastError);
  if (status !== null) return H.unipileStatus(status, service);
  const byCode = Object.hasOwn(REASON_BY_CODE, lastError) ? REASON_BY_CODE[lastError] : undefined;
  if (byCode) return byCode(service);
  return LEGACY_PHRASES.has(lastError) ? lastError : MESSAGES.detail.unknownReason;
}

type Base = Pick<ChannelRowView, "channel" | "missing" | "unavailable">;
const rest = { others: [] as ChannelRowView[], addAnother: false, returned: false };

/** La vista de UNA cuenta viva: conectada (con «Volver a intentar» si le faltan los avisos) o caída (con «Reconectar»). */
function liveRow(base: Base, account: ChannelAccountRow): ChannelRowView {
  const reason = reasonText(account.lastError, base.channel, account.lastErrorRecent);
  if (account.status === "connected") {
    const action: RowAction = account.lastError === CHANNEL_ERROR_CODES.webhooksMissing ? "rewebhook" : null;
    return { ...base, ...rest, account, state: "connected", action, reason };
  }
  return { ...base, ...rest, account, state: account.status as "needs_reconnect" | "error", action: "reconnect", reason };
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
    const reason = reasonText(account?.lastError ?? null, channel, account?.lastErrorRecent ?? true);
    return { ...base, ...rest, account, state: "disconnected", action: "connect", reason };
  });
}
