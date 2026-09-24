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
 *                                     el vault (misma ref si reconecta una
 *                                     cuenta viva; una nueva si la fila
 *                                     estaba desconectada) y
 *                                     outreach_channel_connect → 303 a
 *                                     /ventas/canales?conectado=email.
 *                                     Un estado vencido, de otro navegador
 *                                     o de otro espacio vuelve a la
 *                                     pantalla con su aviso, no a un texto
 *                                     plano.
 *   POST /ventas/canales/conectar     LinkedIn o Instagram: fila 'pending',
 *                                     estado firmado como `name` del
 *                                     enlace de hosted auth de Unipile y
 *                                     303 a ese enlace. La cuenta se
 *                                     conecta cuando llega el aviso
 *                                     (aviso.ts). Reconectar manda el id
 *                                     de NUESTRA fila; el account_id de
 *                                     Unipile se lee en el servidor.
 *   GET  /ventas/canales/conectar     la vuelta de Unipile cuando su página
 *        ?fallo=<nonce>&canal=…       termina sin cuenta (contraseña mala,
 *                                     el código de verificación sin
 *                                     resolver, la persona la cerró): la
 *                                     pendiente de ese nonce dice por qué y
 *                                     la persona vuelve a la pantalla con
 *                                     ?error=unipile_fallo&canal=….
 *
 * Toda vuelta con error lleva ?canal=: el aviso de arriba nombra el
 * servicio y no repite lo que ya dice la fila de ese canal (banner.ts).
 * En last_error solo van códigos (CHANNEL_ERROR_CODES) o frases de
 * @mc/core, nunca el texto de un proveedor: ese queda en api_call_log.
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

const back = (req: Request, code: ChannelErrorCode, headers: Record<string, string> = {}, channel?: Channel) =>
  redirectTo(req, `${CANALES}?error=${code}${channel ? `&canal=${channel}` : ""}`, headers);

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
  return back(req, "no_configurado", {}, channel);
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
  if ("error" in started) return back(req, started.error, {}, "email");
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
  const backEmail = (code: ChannelErrorCode) => back(req, code, headers, "email");
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
        channel: "email", nonce: v.payload.nonce, code: code === "cancelada" ? CHANNEL_ERROR_CODES.cancelled : CHANNEL_ERROR_CODES.providerError,
      }));
    }
    return backEmail(code);
  }

  if (!keys || !deps.google) return backEmail("no_configurado");
  // Volver atrás tras autorizar, abrir el enlace en otro navegador o tardar más de diez minutos: la pantalla de
  // canales con su aviso, dentro de la aplicación, nunca una página en blanco. Nada se toca.
  const verified = verifyChannelState(params.get("state"), keys.verify.state, now, GOOGLE_STATE_TTL_MS);
  if (!verified.ok || verified.payload.channel !== "email") return backEmail("vencida");
  const state = verified.payload;
  if (readCookie(req, GOOGLE_COOKIE) !== state.nonce) return backEmail("vencida");
  if ((await deps.currentWorkspaceId()) !== state.workspaceId) return backEmail("otro_espacio");
  const code = params.get("code");
  if (!code) return backEmail("vencida");

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
    await flushAndFail(deps, log, state.nonce, out === "proveedor" ? CHANNEL_ERROR_CODES.providerError : CHANNEL_ERROR_CODES.exchangeFailed);
    return backEmail(out);
  }
  if (!GMAIL_REQUIRED_SCOPES.map(shortScope).every((s) => scopes.includes(s))) {
    await flushAndFail(deps, log, state.nonce, CHANNEL_ERROR_CODES.missingScopes);
    return backEmail("permisos");
  }

  try {
    await deps.withWorkspace(async (tx) => {
      const ref = (await existingGmailSecretRef(tx, email)) ?? newSecretRef("gmail");
      await new EncryptedSecretStore({ db: tx, cipher: keys.cipher }).set(ref, tokens);
      const r = await completeChannelConnection(tx, { channel: "email", nonce: state.nonce, providerAccountId: email, displayName: email, secretRef: ref, scopes });
      if (r.status === "taken") throw new RollbackConnection("ocupada");
      if (r.status === "unknown_state") throw new RollbackConnection("vencida");
      // El worker está soltando ese mismo Gmail (revoca en Google): el token nuevo moriría con el viejo. Se deshace todo.
      if (r.status === "releasing") throw new RollbackConnection("soltando");
      await log.flushTo(new PostgresOutreachCallLog(tx), r.accountId);
    });
  } catch (err) {
    if (!(err instanceof RollbackConnection)) throw err;
    // 'vencida': la pendiente ya no existe o ya se usó; no hay nada que marcar.
    const reason = err.code === "ocupada" ? CHANNEL_ERROR_CODES.taken : err.code === "soltando" ? CHANNEL_ERROR_CODES.releasing : null;
    await flushAndFail(deps, log, state.nonce, reason);
    return backEmail(err.code);
  }
  return redirectTo(req, `${CANALES}?conectado=email`, headers);
}

/** Lo que se llamó queda en la bitácora aunque la conexión no se complete; con `code` (CHANNEL_ERROR_CODES), la pendiente dice por qué. */
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
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    // Un cuerpo que no es de formulario (JSON, vacío, cortado): el botón de la pantalla nunca lo manda. 400, no un 500.
    return plain(400, MESSAGES.routes.badForm);
  }
  const channel = form.get("canal");
  if (channel !== "linkedin" && channel !== "instagram_dm") return back(req, "no_configurado");
  const missing = missingFor(channel, deps.env);
  const keys = channelKeys(deps.env);
  if (missing.length > 0 || !keys || !deps.unipile) return notConfigured(req, channel, missing);
  const raw = form.get("reconectar");
  const reconnectRowId = typeof raw === "string" && raw !== "" ? raw : undefined;

  const started = await begin(deps, channel, keys.sign.state, reconnectRowId);
  if ("error" in started) return back(req, started.error, {}, channel);
  const origin = await deps.origin(req);
  const now = deps.now?.() ?? new Date();
  const log = new InMemoryOutreachCallLog();
  try {
    const { url } = await deps.unipile(log).createHostedAuthLink({
      channel, state: started.state, reconnectAccountId: started.reconnectAccountId,
      notifyUrl: `${origin}/api/webhooks/unipile`,
      successRedirectUrl: `${origin}${CANALES}?conectado=${channel}`,
      // Su página terminó sin cuenta: la vuelta pasa por unipileFailure, que marca ESTA pendiente (por su nonce).
      failureRedirectUrl: `${origin}${CANALES}/conectar?fallo=${started.nonce}&canal=${channel}`,
      expiresOn: new Date(now.getTime() + UNIPILE_STATE_TTL_MS),
    });
    await deps.withWorkspace((tx) => log.flushTo(new PostgresOutreachCallLog(tx), null));
    return redirectTo(req, url);
  } catch (err) {
    if (!isOutreachApiError(err)) throw err;
    // El texto del proveedor (err.messageEs, en inglés) queda en api_call_log; a la fila, el código.
    await deps.withWorkspace(async (tx) => {
      await log.flushTo(new PostgresOutreachCallLog(tx), null);
      await failPendingChannelAccount(tx, { channel, nonce: started.nonce, code: CHANNEL_ERROR_CODES.providerError });
    });
    return back(req, "proveedor", {}, channel);
  }
}

/**
 * La vuelta de Unipile cuando su página de conexión termina sin cuenta
 * (failure_redirect_url). La pendiente de ese nonce, en el espacio de la
 * sesión (RLS) y del canal, pasa a 'disconnected' con auth_failed: la
 * fila deja de decir «Conectando» y dice qué revisar. El nonce solo sirve
 * para marcar como fallida SU pendiente: no conecta nada (eso pide el
 * estado firmado del aviso de Unipile).
 */
export async function unipileFailure(req: Request, deps: ChannelDeps): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const channel = params.get("canal");
  if (channel !== "linkedin" && channel !== "instagram_dm") return back(req, "unipile_fallo");
  const nonce = params.get("fallo");
  if (nonce) {
    await deps.withWorkspace((tx) => failPendingChannelAccount(tx, { channel, nonce, code: CHANNEL_ERROR_CODES.authFailed }));
  }
  return back(req, "unipile_fallo", {}, channel);
}
