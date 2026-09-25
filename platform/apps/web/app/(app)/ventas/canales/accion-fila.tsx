import type { ButtonVariant } from "@/components/ui/button";
import type { Channel } from "./_lib/config";
import { CANALES } from "./_lib/conexion";
import type { ChannelRowView } from "./_lib/filas";
import { ConectarBoton } from "./conectar-boton";
import { MESSAGES } from "./messages";
import { ReintentarAvisos } from "./reintentar-avisos";

/**
 * El botón que abre la conexión de un canal: el correo va a Google,
 * LinkedIn e Instagram a Unipile. Reconectar manda el id de NUESTRA fila
 * (el servidor lee el buzón o la cuenta: Google propone ese buzón con
 * login_hint); «Conectar otra cuenta» del correo manda otra=1 para que
 * Google pregunte qué cuenta en vez de autorizar sola la sesión abierta.
 */
export function connectTarget(channel: Channel, opts: { reconnectId?: string; another?: boolean } = {}): { action: string; fields: Record<string, string> } {
  const extra: Record<string, string> = opts.reconnectId ? { reconectar: opts.reconnectId } : {};
  if (channel === "email") return { action: "/api/oauth/google", fields: { ...extra, ...(opts.another ? { otra: "1" } : {}) } };
  return { action: `${CANALES}/conectar`, fields: { canal: channel, ...extra } };
}

/**
 * El aspecto del botón de la fila. «Reconectar» va en primario (es lo
 * urgente de la pantalla) solo si se puede pulsar: deshabilitado, un
 * primario gris macizo parecía activo y más llamativo que el «Conectar»
 * deshabilitado de al lado, e invitaba a pulsar algo que no responde.
 */
export function rowActionVariant(row: Pick<ChannelRowView, "action">, disabled: boolean): ButtonVariant {
  return !disabled && row.action === "reconnect" ? "primary" : "secondary";
}

/**
 * El botón de la fila. Conectar, reconectar y volver a empezar son un
 * formulario (POST): el correo va a Google, LinkedIn e Instagram a
 * Unipile, con estado de carga (ConectarBoton). Reconectar manda el id de
 * NUESTRA fila; el account_id del proveedor lo lee el servidor. Los
 * avisos de una cuenta conectada se reintentan con una acción de
 * servidor, sin salir de la página. Sin llaves o sin el rol, el botón
 * sigue ahí pero deshabilitado, con el motivo en su nombre accesible.
 */
export function AccionFila({ row, canManage }: { row: ChannelRowView; canManage: boolean }) {
  if (!row.action) return null;
  const label = row.action === "connect" ? MESSAGES.actions.connect : row.action === "reconnect" ? MESSAGES.actions.reconnect : MESSAGES.actions.retry;
  // Deshabilitado con el motivo en su nombre accesible: sin llaves en la plataforma, o sin el rol para gestionar canales.
  const why = row.unavailable ? MESSAGES.detail.unavailable(MESSAGES.channels[row.channel].provider) : !canManage ? MESSAGES.detail.readOnly : null;
  const a11y = why ? MESSAGES.actions.unavailableLabel(label, why) : undefined;
  const disabled = why !== null;
  if (row.action === "rewebhook" && row.account) {
    return <ReintentarAvisos accountId={row.account.id} disabled={disabled} ariaLabel={a11y} />;
  }
  const { action, fields } = connectTarget(row.channel, { reconnectId: row.action === "reconnect" ? row.account?.id : undefined });
  return <ConectarBoton action={action} fields={fields} label={label} variant={rowActionVariant(row, disabled)} disabled={disabled} ariaLabel={a11y} />;
}
