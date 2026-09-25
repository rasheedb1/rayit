import "server-only";
/**
 * La prueba de que un aviso de proveedor es nuestro y de qué espacio es
 * (VEN-9). Es lo único que abre una transacción en un workspace que no
 * sale de la sesión (withProviderCallback, lib/db): el webhook de Unipile
 * llega sin sesión ni cookie y su espacio lo dice la FIRMA.
 *
 * No se puede fabricar fuera de aquí:
 *
 *   · en tipos, ProviderCallbackProof lleva una marca con un `unique
 *     symbol` que este módulo no exporta: un literal { workspaceId,
 *     verifiedBy } no compila (lo fija una prueba con @ts-expect-error);
 *   · en ejecución, solo cuentan los objetos que emitieron las dos
 *     verificaciones de abajo (un WeakSet): un objeto forzado con `as`
 *     lanza en proofWorkspace.
 *
 * Y las dos verificaciones solo emiten tras comprobar la firma HMAC con
 * una llave derivada de TOKEN_ENCRYPTION_KEY, con TODAS las versiones del
 * llavero (la actual primero): rotar la llave maestra no deja 401 los
 * avisos de las cuentas que ya estaban conectadas.
 */
import {
  channelSigningKeys, keyringFromEnv, MasterKeyError, verifyChannelRoute, verifyChannelState, type ChannelRoute,
  type ChannelSigningKeys, type ChannelState,
} from "@mc/connectors";

declare const proofBrand: unique symbol;

export interface ProviderCallbackProof {
  readonly workspaceId: string;
  readonly verifiedBy: "channel_state" | "channel_route";
  readonly [proofBrand]: true;
}

type Env = Readonly<Record<string, string | undefined>>;

const issued = new WeakSet<object>();

function issue(workspaceId: string, verifiedBy: ProviderCallbackProof["verifiedBy"]): ProviderCallbackProof {
  const proof = Object.freeze({ workspaceId, verifiedBy }) as unknown as ProviderCallbackProof;
  issued.add(proof);
  return proof;
}

/** Las llaves de firma de los canales, de cada versión de TOKEN_ENCRYPTION_KEY. null si falta o no es válida. */
export function channelSigningKeysFromEnv(env: Env): ChannelSigningKeys | null {
  try {
    return channelSigningKeys(keyringFromEnv(env));
  } catch (err) {
    if (err instanceof MasterKeyError) return null;
    throw err;
  }
}

/** El estado firmado de una conexión (el `name` de la hosted auth de Unipile). null si no es nuestro, caducó o no tiene forma. */
export function verifyChannelStateProof(
  token: string | null | undefined,
  now: Date,
  ttlMs: number,
  env: Env = process.env,
): { proof: ProviderCallbackProof; state: ChannelState; issuedAt: Date } | null {
  const keys = channelSigningKeysFromEnv(env);
  if (!keys) return null;
  const v = verifyChannelState(token, keys.state, now, ttlMs);
  if (!v.ok) return null;
  return { proof: issue(v.payload.workspaceId, "channel_state"), state: v.payload, issuedAt: v.issuedAt };
}

/** La ruta firmada de un aviso de Unipile (cabecera x-on-cue-route). null si no es nuestra. */
export function verifyChannelRouteProof(
  header: string | null | undefined,
  now: Date,
  env: Env = process.env,
): { proof: ProviderCallbackProof; route: ChannelRoute } | null {
  const keys = channelSigningKeysFromEnv(env);
  if (!keys) return null;
  const route = verifyChannelRoute(header, keys.route, now);
  if (!route) return null;
  return { proof: issue(route.workspaceId, "channel_route"), route };
}

/** El workspace de una prueba emitida aquí. Un objeto que no salió de una verificación lanza. */
export function proofWorkspace(proof: ProviderCallbackProof): string {
  if (typeof proof !== "object" || proof === null || !issued.has(proof)) {
    throw new TypeError("withProviderCallback: la prueba no salió de una verificación de firma.");
  }
  return proof.workspaceId;
}
