/**
 * Lo que necesitan las rutas de canales, inyectable para probarlas sin
 * Next, sin red y sin llaves: los proveedores son fábricas (una por
 * petición, con su propia bitácora que después se escribe en la
 * transacción) y las transacciones son las de lib/db.
 */
import {
  channelRouteKey, channelStateKey, currentMasterKey, keyringFromEnv, MasterKeyError, TokenCipher,
  type GoogleOAuthApi, type OutreachCallLogSink, type UnipileApi,
} from "@mc/connectors";
import type { WorkspaceTx } from "@mc/db";
import type { ProviderCallbackProof } from "@/lib/db";

export type Env = Readonly<Record<string, string | undefined>>;

export interface ChannelDeps {
  env: Env;
  /** La transacción del espacio de la sesión (lib/db withWorkspace). */
  withWorkspace: <T>(fn: (tx: WorkspaceTx) => Promise<T>) => Promise<T>;
  /** El espacio de la sesión, para firmarlo en el estado y compararlo al volver. */
  currentWorkspaceId: () => Promise<string>;
  /** La transacción de un aviso ya verificado (lib/db withProviderCallback). */
  withProviderCallback: <T>(proof: ProviderCallbackProof, fn: (tx: WorkspaceTx) => Promise<T>) => Promise<T>;
  /** null = faltan GOOGLE_CLIENT_ID/SECRET. Recibe la bitácora de la petición. */
  google: ((log: OutreachCallLogSink, origin: string) => GoogleOAuthApi) | null;
  /** null = faltan UNIPILE_DSN/ACCESS_TOKEN. */
  unipile: ((log: OutreachCallLogSink) => UnipileApi) | null;
  /** El origen público de la app (APP_URL o las cabeceras): de ahí salen las URL de vuelta. */
  origin: (req: Request) => Promise<string>;
  now?: () => Date;
  random?: (bytes: number) => Uint8Array;
}

export interface ChannelKeys {
  cipher: TokenCipher;
  state: Uint8Array;
  route: Uint8Array;
}

/** Las tres llaves salen de TOKEN_ENCRYPTION_KEY, derivadas con etiquetas distintas. null si falta o no es válida. */
export function channelKeys(env: Env): ChannelKeys | null {
  try {
    const keyring = keyringFromEnv(env);
    const master = currentMasterKey(keyring);
    return { cipher: new TokenCipher(keyring), state: channelStateKey(master), route: channelRouteKey(master) };
  } catch (err) {
    if (err instanceof MasterKeyError) return null;
    throw err;
  }
}

export function redirectTo(req: Request, path: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { Location: new URL(path, req.url).toString(), ...headers } });
}

export function plain(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}

export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get("cookie");
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}
