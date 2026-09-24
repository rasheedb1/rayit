/**
 * Conectar un canal, como funciones Request → Response (VEN-9). Las
 * rutas solo delegan aquí:
 *
 *   POST /api/oauth/google            fila 'pending' con un nonce nuevo,
 *                                     estado firmado {workspace, creador,
 *                                     canal, nonce}, cookie con el nonce
 *                                     (ata la vuelta a ESTE navegador) y
 *                                     303 a Google.
 *   GET  /api/oauth/google/callback   estado válido + misma cookie + mismo
 *                                     espacio de la sesión → canje del
 *                                     code → alcances → correo de userinfo
 *                                     → UNA transacción: token cifrado en
 *                                     el vault (misma ref si reconecta) y
 *                                     outreach_channel_connect → 303 a
 *                                     /ventas/canales?conectado=email.
 *   POST /ventas/canales/conectar     LinkedIn o Instagram: fila 'pending',
 *                                     estado firmado como `name` del
 *                                     enlace de hosted auth de Unipile y
 *                                     303 a ese enlace. La cuenta se
 *                                     conecta cuando llega el aviso
 *                                     (aviso.ts). Reconectar manda el id
 *                                     de NUESTRA fila; el account_id de
 *                                     Unipile se lee en el servidor.
 *
 * Sin las llaves de un proveedor no se empieza nada: vuelve a la
 * pantalla con ?error=no_configurado (texto de producto) y lo que falta
 * va al registro del servidor, nunca al navegador.
 *
 * Ni el code ni los tokens tocan logs, URLs nuestras ni la cookie.
 */
import {
  EncryptedSecretStore, GMAIL_REQUIRED_SCOPES, GOOGLE_STATE_TTL_MS, InMemoryOutreachCallLog, isOutreachApiError, newNonce, newSecretRef,
  PostgresOutreachCallLog, shortScope, signChannelState, UNIPILE_STATE_TTL_MS, verifyChannelState, type OAuthTokens,
} from "@mc/connectors";
import { getDefaultCreatorId, NoCreatorProfile, type WorkspaceTx } from "@mc/db";
import {
  CHANNEL_ERROR_CODES, completeChannelConnection, createPendingChannelAccount, existingGmailSecretRef, failPendingChannelAccount,
  getReconnectableUnipileAccount,
} from "@mc/db/queries/canales";
import { MESSAGES } from "../messages";
import type { ChannelErrorCode } from "./banner";
import { missingFor, type Channel } from "./config";
import { channelKeys, plain, readCookie, redirectTo, type ChannelDeps } from "./deps";

export const GOOGLE_COOKIE = "oc_canal";
export const GOOGLE_COOKIE_PATH = "/api/oauth/google";
export const CANALES = "/ventas/canales";

export type { ChannelErrorCode };

const back = (req: Request, code: ChannelErrorCode, headers: Record<string, string> = {}) => redirectTo(req, `${CANALES}?error=${code}`, headers);

/** Lanzar esto dentro de la transacción la deshace entera (el token y la fila), y el callback responde con `code`. */
class RollbackConnection extends Error {
  constructor(readonly code: ChannelErrorCode) {
    super(code);
  }
}

function cookie(value: string, maxAgeS: number, secure: boolean): string {
  const parts = [`${GOOGLE_COOKIE}=${value}`, `Path=${GOOGLE_COOKIE_PATH}`, "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeS}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Sin llaves: lo que falta va al registro del servidor y la persona vuelve a la pantalla con un texto de producto. */
function notConfigured(req: Request, channel: Channel, missing: readonly string[]): Response {
  console.warn(MESSAGES.routes.serverMissing(MESSAGES.channels[channel].provider, missing.join(", ") || "TOKEN_ENCRYPTION_KEY"));
  return back(req, "no_configurado");
}

/**
 * La fila 'pending' y el estado firmado, en el espacio de la sesión. Con
 * `reconnectRowId`, en la MISMA transacción se lee el account_id de
 * Unipile de esa fila (de este espacio, del canal y caída): si no hay,
 * no se crea nada y vuelve 'vencida'.
 */
async function begin(
  deps: ChannelDeps,
  channel: Channel,
  stateKey: Uint8Array,
  reconnectRowId?: string,
): Promise<{ state: string; nonce: string; reconnectAccountId: string | undefined } | { error: ChannelErrorCode }> {
  const now = deps.now?.() ?? new Date();
  const nonce = newNonce(deps.random);
  const workspaceId = await deps.currentWorkspaceId();
  try {
    const started = await deps.withWorkspace(async (tx) => {
      let reconnectAccountId: string | undefined;
      if (reconnectRowId !== undefined) {
        if (channel === "email") return null;
        reconnectAccountId = (await getReconnectableUnipileAccount(tx, reconnectRowId, channel)) ?? undefined;
        if (!reconnectAccountId) return null;
      }
      const id = await getDefaultCreatorId(tx);
      await createPendingChannelAccount(tx, { channel, creatorId: id, nonce });
      return { creatorId: id, reconnectAccountId };
    });
    if (!started) return { error: "vencida" };
    return { state: signChannelState({ workspaceId, creatorId: started.creatorId, channel, nonce }, stateKey, now), nonce, reconnectAccountId: started.reconnectAccountId };
  } catch (err) {
    if (err instanceof NoCreatorProfile) return { error: "sin_creador" };
    throw err;
  }
}

export async function googleStart(req: Request, deps: ChannelDeps): Promise<Response> {
  if (req.method !== "POST") return plain(405, MESSAGES.routes.postOnly, { Allow: "POST" });
  const missing = missingFor("email", deps.env);
  const keys = channelKeys(deps.env);
  if (missing.length > 0 || !keys || !deps.google) return notConfigured(req, "email", missing);
  const started = await begin(deps, "email", keys.sign.state);
  if ("error" in started) return back(req, started.error);
  const google = deps.google(new InMemoryOutreachCallLog(), await deps.origin(req));
  const secure = deps.env["NODE_ENV"] === "production";
  return new Response(null, {
    status: 303,
    headers: { Location: google.authorizationUrl(started.state), "Set-Cookie": cookie(started.nonce, GOOGLE_STATE_TTL_MS / 1000, secure) },
  });
}

export async function googleCallback(req: Request, deps: ChannelDeps): Promise<Response> {
  const secure = deps.env["NODE_ENV"] === "production";
  const headers = { "Set-Cookie": cookie("", 0, secure) };
  const params = new URL(req.url).searchParams;
  const keys = channelKeys(deps.env);
  const now = deps.now?.() ?? new Date();
  if (params.get("error")) {
    const code: ChannelErrorCode = params.get("error") === "access_denied" ? "cancelada" : "proveedor";
    // La pendiente de ESTE navegador y de este espacio deja de estar «Conectando»: dice por qué no se conectó.
    const v = keys ? verifyChannelState(params.get("state"), keys.verify.state, now, GOOGLE_STATE_TTL_MS) : null;
    if (v?.ok && v.payload.channel === "email" && readCookie(req, GOOGLE_COOKIE) === v.payload.nonce
      && (await deps.currentWorkspaceId()) === v.payload.workspaceId) {
      await deps.withWorkspace((tx) => failPendingChannelAccount(tx, {
        channel: "email", nonce: v.payload.nonce, code: code === "cancelada" ? CHANNEL_ERROR_CODES.cancelled : MESSAGES.banners.errors.proveedor,
      }));
    }
    return back(req, code, headers);
  }

  if (!keys || !deps.google) return back(req, "no_configurado", headers);
  const verified = verifyChannelState(params.get("state"), keys.verify.state, now, GOOGLE_STATE_TTL_MS);
  if (!verified.ok || verified.payload.channel !== "email") return plain(400, MESSAGES.routes.badState, headers);
  const state = verified.payload;
  if (readCookie(req, GOOGLE_COOKIE) !== state.nonce) return plain(400, MESSAGES.routes.badState, headers);
  if ((await deps.currentWorkspaceId()) !== state.workspaceId) return plain(409, MESSAGES.routes.otherWorkspace, headers);
  const code = params.get("code");
  if (!code) return plain(400, MESSAGES.routes.badState, headers);

  // Fase HTTP, fuera de la transacción. La bitácora se escribe después, con la cuenta.
  const log = new InMemoryOutreachCallLog();
  const google = deps.google(log, await deps.origin(req));
  let tokens: OAuthTokens;
  let scopes: string[];
  let email: string;
  try {
    const exchanged = await google.exchangeCode(code);
    tokens = exchanged.tokens;
    scopes = exchanged.scopesGranted.map(shortScope);
    const who = await google.userEmail(tokens);
    if (!who.verified) throw new RollbackConnection("intercambio");
    email = who.email.trim().toLowerCase();
  } catch (err) {
    const out: ChannelErrorCode = err instanceof RollbackConnection ? err.code : isOutreachApiError(err) && err.kind === "transient" ? "proveedor" : "intercambio";
    await flushAndFail(deps, log, state.nonce, MESSAGES.banners.errors[out]);
    return back(req, out, headers);
  }
  if (!GMAIL_REQUIRED_SCOPES.map(shortScope).every((s) => scopes.includes(s))) {
    await flushAndFail(deps, log, state.nonce, CHANNEL_ERROR_CODES.missingScopes);
    return back(req, "permisos", headers);
  }

  try {
    await deps.withWorkspace(async (tx) => {
      const ref = (await existingGmailSecretRef(tx, email)) ?? newSecretRef("gmail");
      await new EncryptedSecretStore({ db: tx, cipher: keys.cipher }).set(ref, tokens);
      const r = await completeChannelConnection(tx, { channel: "email", nonce: state.nonce, providerAccountId: email, displayName: email, secretRef: ref, scopes });
      if (r.status === "taken") throw new RollbackConnection("ocupada");
      if (r.status === "unknown_state") throw new RollbackConnection("vencida");
      await log.flushTo(new PostgresOutreachCallLog(tx), r.accountId);
    });
  } catch (err) {
    if (!(err instanceof RollbackConnection)) throw err;
    // 'vencida': la pendiente ya no existe o ya se usó; no hay nada que marcar.
    await flushAndFail(deps, log, state.nonce, err.code === "ocupada" ? CHANNEL_ERROR_CODES.taken : null);
    return back(req, err.code, headers);
  }
  return redirectTo(req, `${CANALES}?conectado=email`, headers);
}

/** Lo que se llamó queda en la bitácora aunque la conexión no se complete; con `code`, la pendiente dice por qué (un código de CHANNEL_ERROR_CODES o una frase). */
async function flushAndFail(deps: ChannelDeps, log: InMemoryOutreachCallLog, nonce: string, code: string | null): Promise<void> {
  await deps.withWorkspace(async (tx: WorkspaceTx) => {
    await log.flushTo(new PostgresOutreachCallLog(tx), null);
    if (code) await failPendingChannelAccount(tx, { channel: "email", nonce, code });
  }).catch((err: unknown) => console.error("[canales] no se pudo registrar el intento fallido", err));
}

/**
 * LinkedIn o Instagram: al enlace de hosted auth de Unipile. `reconectar`
 * es el id de NUESTRA fila (outreach_channel_account) de una cuenta caída;
 * el account_id de Unipile sale de la base con RLS, nunca del formulario.
 */
export async function unipileStart(req: Request, deps: ChannelDeps): Promise<Response> {
  if (req.method !== "POST") return plain(405, MESSAGES.routes.postOnly, { Allow: "POST" });
  const form = await req.formData();
  const channel = form.get("canal");
  if (channel !== "linkedin" && channel !== "instagram_dm") return back(req, "no_configurado");
  const missing = missingFor(channel, deps.env);
  const keys = channelKeys(deps.env);
  if (missing.length > 0 || !keys || !deps.unipile) return notConfigured(req, channel, missing);
  const raw = form.get("reconectar");
  const reconnectRowId = typeof raw === "string" && raw !== "" ? raw : undefined;

  const started = await begin(deps, channel, keys.sign.state, reconnectRowId);
  if ("error" in started) return back(req, started.error);
  const origin = await deps.origin(req);
  const now = deps.now?.() ?? new Date();
  const log = new InMemoryOutreachCallLog();
  try {
    const { url } = await deps.unipile(log).createHostedAuthLink({
      channel, state: started.state, reconnectAccountId: started.reconnectAccountId,
      notifyUrl: `${origin}/api/webhooks/unipile`,
      successRedirectUrl: `${origin}${CANALES}?conectado=${channel}`,
      failureRedirectUrl: `${origin}${CANALES}?error=proveedor`,
      expiresOn: new Date(now.getTime() + UNIPILE_STATE_TTL_MS),
    });
    await deps.withWorkspace((tx) => log.flushTo(new PostgresOutreachCallLog(tx), null));
    return redirectTo(req, url);
  } catch (err) {
    if (!isOutreachApiError(err)) throw err;
    await deps.withWorkspace(async (tx) => {
      await log.flushTo(new PostgresOutreachCallLog(tx), null);
      await failPendingChannelAccount(tx, { channel, nonce: started.nonce, code: err.messageEs });
    });
    return back(req, "proveedor");
  }
}
