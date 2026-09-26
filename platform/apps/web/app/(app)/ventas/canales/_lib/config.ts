/**
 * Qué canales se pueden conectar en este entorno y qué falta para los
 * demás. Solo nombres de variables: ningún valor sale de aquí.
 *
 *   correo     GOOGLE_OUTREACH_CLIENT_ID y GOOGLE_OUTREACH_CLIENT_SECRET (la redirección
 *              sale de GOOGLE_OUTREACH_REDIRECT_URI o del origen de la app)
 *   LinkedIn   UNIPILE_DSN, UNIPILE_ACCESS_TOKEN y UNIPILE_WEBHOOK_SECRET
 *   Instagram  (lo mismo: los dos van por Unipile)
 *   todos      TOKEN_ENCRYPTION_KEY: firma el estado de la conexión y
 *              cifra el token de Google
 */
import {
  CONNECTABLE_CHANNELS, GOOGLE_ENV, isConnectableChannel, MASTER_KEY_ENV, UNIPILE_ENV, UNIPILE_WEBHOOK_SECRET_ENV, type ConnectableChannel,
} from "@mc/connectors";
import type { ConnectableChannel as DbConnectableChannel } from "@mc/db/queries/canales";

/**
 * Los canales de la pantalla, en su orden: la lista de @mc/connectors (la
 * misma que valida el estado firmado), no una copia. @mc/db deriva el
 * suyo del vocabulario de 0007 (no depende de @mc/connectors); la
 * comprobación de abajo no compila si los dos se separan.
 */
export const CHANNELS = CONNECTABLE_CHANNELS;
export type Channel = ConnectableChannel;
export const isChannel: (v: unknown) => v is Channel = isConnectableChannel;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const channelsAgree: Same<Channel, DbConnectableChannel> = true;
void channelsAgree;

type Env = Readonly<Record<string, string | undefined>>;

const REQUIRED: Record<Channel, readonly string[]> = {
  email: [...GOOGLE_ENV, MASTER_KEY_ENV],
  linkedin: [...UNIPILE_ENV, UNIPILE_WEBHOOK_SECRET_ENV, MASTER_KEY_ENV],
  instagram_dm: [...UNIPILE_ENV, UNIPILE_WEBHOOK_SECRET_ENV, MASTER_KEY_ENV],
};

/** Las variables que faltan para conectar ese canal; vacío = se puede. */
export function missingFor(channel: Channel, env: Env): string[] {
  return REQUIRED[channel].filter((k) => !env[k]?.trim());
}

export type ChannelSetup = Record<Channel, { configured: boolean; missing: string[] }>;

export function channelSetup(env: Env): ChannelSetup {
  const out = {} as ChannelSetup;
  for (const c of CHANNELS) {
    const missing = missingFor(c, env);
    out[c] = { configured: missing.length === 0, missing };
  }
  return out;
}

/**
 * ¿Se enseña el bloque plegado «Detalles para quien administra la
 * plataforma» (los nombres de las variables que faltan)? Solo fuera de
 * producción y solo a quien gestiona los canales. Una demo pública en
 * producción (con la base embebida) tampoco lo enseña: un visitante no
 * tiene por qué leer nombres internos como TOKEN_ENCRYPTION_KEY. En
 * producción, lo que falta va al registro del servidor.
 */
export function showAdminDetails(i: { canManage: boolean; nodeEnv: string | undefined }): boolean {
  return i.canManage && i.nodeEnv !== "production";
}
