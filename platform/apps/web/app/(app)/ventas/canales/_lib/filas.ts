/**
 * Una fila por canal en /ventas/canales, como la pantalla de
 * integraciones de Vercel o de Linear: qué cuenta, en qué estado y qué
 * botón. Pura, para probarla sin base ni React.
 *
 * Qué cuenta se enseña de un canal: la viva (conectada, por reconectar o
 * con error) si la hay; si no, la última pendiente; si no, la última que
 * se desconectó o no terminó, para poder decir por qué.
 *
 * Sin las llaves del proveedor en la plataforma («no disponible»), la fila
 * lo dice SIEMPRE, también cuando hay una cuenta viva: una conectada sale
 * «En pausa» (no puede enviar ni refrescarse), y una caída conserva su
 * «Reconectar», deshabilitado y con la explicación al lado. Nunca una
 * fila en rojo sin botón y sin motivo.
 */
import type { ChannelAccountRow } from "@mc/db/queries/canales";
import type { PillKind } from "@/components/ui/pill";
import { MESSAGES } from "../messages";
import { CHANNELS, type Channel, type ChannelSetup } from "./config";

export type RowState = "not_configured" | "disconnected" | "pending" | "expired" | "connected" | "needs_reconnect" | "error";

export interface ChannelRowView {
  channel: Channel;
  state: RowState;
  account: ChannelAccountRow | null;
  /** Las variables que faltan en el servidor (vacío si el canal se puede conectar). Solo para el registro y el modo desarrollo. */
  missing: string[];
  /** El canal no está disponible en la plataforma (faltan llaves): el botón va deshabilitado y la fila lo explica. */
  unavailable: boolean;
  /** Qué botón toca: conectar, reconectar, volver a intentar o ninguno (ya conectado). */
  action: "connect" | "reconnect" | "retry" | null;
  /** El motivo, en español, de la última falla, si hay que decirlo. */
  reason: string | null;
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

/** Los códigos que escribe el código en last_error, en frase; lo demás ya es una frase nuestra. */
const REASON_BY_CODE: Record<string, string> = {
  taken: MESSAGES.banners.errors.ocupada,
  missing_scopes: MESSAGES.banners.errors.permisos,
  wrong_provider: MESSAGES.banners.errors.canal_equivocado,
  cancelled: MESSAGES.banners.errors.cancelada,
};

export function reasonText(lastError: string | null): string | null {
  if (!lastError) return null;
  return REASON_BY_CODE[lastError] ?? lastError;
}

function pick(accounts: readonly ChannelAccountRow[], channel: Channel): ChannelAccountRow | null {
  const mine = accounts.filter((a) => a.channel === channel);
  return mine.find((a) => LIVE.has(a.status)) ?? mine.find((a) => a.status === "pending" && !a.stale) ?? mine[0] ?? null;
}

export function channelRows(accounts: readonly ChannelAccountRow[], setup: ChannelSetup): ChannelRowView[] {
  return CHANNELS.map((channel): ChannelRowView => {
    const account = pick(accounts, channel);
    const { configured, missing } = setup[channel];
    const base = { channel, account, missing, unavailable: !configured };
    if (account && account.status === "connected") return { ...base, state: "connected", action: null, reason: reasonText(account.lastError) };
    if (account && (account.status === "needs_reconnect" || account.status === "error")) {
      return { ...base, state: account.status, action: "reconnect", reason: reasonText(account.lastError) };
    }
    if (!configured) return { ...base, state: "not_configured", action: "connect", reason: null };
    if (account?.status === "pending") {
      return { ...base, state: account.stale ? "expired" : "pending", action: "retry", reason: null };
    }
    return { ...base, state: "disconnected", action: "connect", reason: reasonText(account?.lastError ?? null) };
  });
}
