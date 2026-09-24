/**
 * Qué canales se pueden conectar en este entorno y qué falta para los
 * demás. Solo nombres de variables: ningún valor sale de aquí.
 *
 *   correo     GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET (la redirección
 *              sale de GOOGLE_REDIRECT_URI o del origen de la app)
 *   LinkedIn   UNIPILE_DSN, UNIPILE_ACCESS_TOKEN y UNIPILE_WEBHOOK_SECRET
 *   Instagram  (lo mismo: los dos van por Unipile)
 *   todos      TOKEN_ENCRYPTION_KEY: firma el estado de la conexión y
 *              cifra el token de Google
 */
import { GOOGLE_ENV, MASTER_KEY_ENV, UNIPILE_ENV, UNIPILE_WEBHOOK_SECRET_ENV } from "@mc/connectors";

export const CHANNELS = ["email", "linkedin", "instagram_dm"] as const;
export type Channel = (typeof CHANNELS)[number];

export function isChannel(v: unknown): v is Channel {
  return typeof v === "string" && (CHANNELS as readonly string[]).includes(v);
}

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
