/**
 * POST /api/webhooks/unipile, como función Request → Response (VEN-9).
 *
 * Dos clases de aviso, y ninguna se cree por lo que dice su cuerpo (el
 * detalle, en @mc/connectors outreach/unipile-webhook.ts):
 *
 *   · los de UNA cuenta (mensajes y salud), que dimos de alta al
 *     conectarla con dos cabeceras nuestras: el secreto compartido
 *     (tiempo constante, contra el actual y, durante una rotación, el
 *     anterior: UNIPILE_WEBHOOK_SECRET_PREVIOUS) y la ruta firmada. Se
 *     autentican por las cabeceras ANTES de leer el cuerpo: sin las dos,
 *     401 y ni un byte leído. Con ellas, el cuerpo se lee con un techo de
 *     bytes contado sobre el flujo y se actúa en el espacio de la ruta,
 *     solo si la cuenta de la ruta es la del cuerpo: un mensaje de la otra
 *     persona en el hilo de un toque NUESTRO de esa cuenta entra a
 *     outbound_message y detiene su enrolamiento (cualquier otro DM se
 *     ignora sin guardar su cuerpo); una cuenta caída pasa a
 *     needs_reconnect, y una que vuelve (OK, RECONNECTED: la persona
 *     resolvió el reto) a connected, las dos con su aviso en la campana.
 *   · el de cuenta creada o reconectada de la hosted auth (notify_url):
 *     Unipile no deja poner cabeceras ahí, así que lo autentica el `name`,
 *     nuestro estado firmado. La cuenta se lee en Unipile con nuestra
 *     llave y, antes de ligarla a nada, tiene que ser la de ESTE intento:
 *     al reconectar, el account_id que se firmó en el estado; al crear,
 *     una cuenta cuyo `name` es un estado nuestro con el MISMO nonce (la
 *     de otro enlace no se liga, aunque quien avisa tenga un estado válido
 *     propio y su account_id) y nacida después de firmarlo. Después,
 *     del canal pedido, y se conecta por outreach_channel_connect (0042:
 *     un perfil es una fila). Si no se conecta (canal equivocado, perfil
 *     duplicado u ocupado, fila soltándose, pendiente ya usada), la cuenta
 *     recién creada en Unipile se BORRA, salvo que alguien la use: Unipile
 *     cobra cada cuenta cada mes. Si el borrado falla, la conciliación del
 *     keepalive la borra al día siguiente.
 *
 * Las llamadas a Unipile de este camino llevan el presupuesto interactivo
 * (INTERACTIVE_BUDGET): Unipile reintenta un aviso que no es 2xx, y una
 * función de Vercel no puede quedarse dos minutos esperando.
 *
 * En last_error solo quedan códigos; el nombre visible de la cuenta sale
 * de connection_params.im, nunca del `name` (que es el estado firmado).
 */
import {
  acceptedWebhookSecrets, InMemoryOutreachCallLog, INTERACTIVE_BUDGET, isOutreachApiError, isUnipileDownStatus, isUnipileOkStatus, matchSharedSecret,
  parseUnipileWebhook, PostgresOutreachCallLog, registerAccountWebhooks, UNIPILE_ACCOUNT_WEBHOOK_SOURCES, UNIPILE_PROVIDER_BY_CHANNEL,
  UNIPILE_ROUTE_HEADER, UNIPILE_SECRET_HEADER, UNIPILE_STATE_TTL_MS, UNIPILE_WEBHOOK_SECRET_ENV, verifyChannelState,
  type ChannelState, type UnipileAccount, type UnipileApi, type UnipileWebhookEvent,
} from "@mc/connectors";
import { channelHealthName } from "@mc/core";
import { inboundBody } from "@mc/core/outreach/messages";
import {
  CHANNEL_ERROR_CODES, channelWebhookCount, clearChannelAccountIssue, completeChannelConnection, failPendingChannelAccount,
  findUnipileAccountForWebhook, getConnectedUnipileAccount, markChannelAccountDown, markChannelAccountOk, noteChannelAccountIssue,
  recordInboundMessage, setChannelWebhooks, unipileAccountInUseHere, unipileStatusCode,
} from "@mc/db/queries/canales";
import type { WorkspaceTx } from "@mc/db";
import { verifyChannelRouteProof, verifyChannelStateProof, type ProviderCallbackProof } from "@/lib/db/aviso-de-proveedor";
import { MESSAGES } from "../messages";
import { channelKeys, plain, type ChannelDeps } from "./deps";

/** Un aviso de mensajes o de salud cabe de sobra en esto. */
export const MAX_WEBHOOK_BYTES = 256 * 1024;
/** El aviso de cuenta creada llega sin autenticar: tres campos, y nada más se lee. */
export const MAX_NOTIFY_BYTES = 16 * 1024;
/**
 * Cuánto antes de firmar el estado puede decir Unipile que nació una
 * cuenta de «crear»: la diferencia de relojes entre Unipile y nosotros.
 */
export const CREATED_CLOCK_SKEW_MS = 2 * 60 * 1000;

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

export type LimitedBody = { ok: true; value: unknown } | { ok: false; status: 400 | 413 };

/**
 * El cuerpo como JSON, con un techo de BYTES: primero por Content-Length
 * (sin leer nada) y después contando lo que llega por el flujo, que corta
 * en cuanto se pasa aunque la cabecera mintiera o no estuviera.
 */
export async function readLimitedJson(req: Request, maxBytes: number): Promise<LimitedBody> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) return { ok: false, status: 413 };
  if (!req.body) return { ok: false, status: 400 };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, status: 413 };
    }
    chunks.push(value);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    return { ok: false, status: 400 };
  }
}

const bodyError = (status: 400 | 413) => plain(status, status === 413 ? MESSAGES.routes.tooLarge : MESSAGES.routes.badJson);

export async function unipileWebhook(req: Request, deps: ChannelDeps): Promise<Response> {
  if (req.method !== "POST") return plain(405, MESSAGES.routes.webhookPostOnly, { Allow: "POST" });
  if (!channelKeys(deps.env)) return plain(503, MESSAGES.routes.notConfigured);
  const now = deps.now?.() ?? new Date();
  const secretHeader = req.headers.get(UNIPILE_SECRET_HEADER);
  if (secretHeader === null) return accountNotify(req, deps, now);

  // Los avisos de una cuenta: primero las cabeceras, después el cuerpo. El secreto, contra el actual y el anterior.
  if (matchSharedSecret(secretHeader, acceptedWebhookSecrets(deps.env)) < 0) return plain(401, MESSAGES.routes.unauthorized);
  const routed = verifyChannelRouteProof(req.headers.get(UNIPILE_ROUTE_HEADER), now, deps.env);
  if (!routed) return plain(401, MESSAGES.routes.unauthorized);
  const body = await readLimitedJson(req, MAX_WEBHOOK_BYTES);
  if (!body.ok) return bodyError(body.status);
  const event = parseUnipileWebhook(body.value);
  if (event.kind === "ignored") return json(200, { ok: true, ignored: event.reason });
  if (event.kind === "account_connected") return json(200, { ok: true, ignored: MESSAGES.routes.ignored.notAccountEvent });

  const { proof, route } = routed;
  const result = await deps.withProviderCallback(proof, async (tx) => {
    const account = await findUnipileAccountForWebhook(tx, route.channelAccountId, event.accountId);
    if (!account) return MESSAGES.routes.ignored.unknownAccount;
    const name = channelHealthName(account.channel);
    if (event.kind === "message") {
      // Sin quién escribe no se sabe si es el eco de un envío propio: se descarta antes que detener una cadencia.
      if (!event.senderProviderId) return MESSAGES.routes.ignored.noSender;
      // El eco de un envío propio: por account_info del aviso o, si no viene, porque escribe la persona de esta cuenta (0042).
      if (event.fromSelf || isOwnAccount(event.senderProviderId, account.providerIdentity)) return MESSAGES.routes.ignored.echo;
      // Con quién escribe: una respuesta en un chat nuevo (la invitación aceptada) casa con el toque enviado a esa persona.
      const r = await recordInboundMessage(tx, {
        account, threadRef: event.chatId, providerMessageId: event.messageId, body: inboundBody(event.text, event.hasAttachments),
        fromAddress: event.senderName ?? event.senderProviderId, occurredAt: event.occurredAt ?? now,
        senderProviderId: event.senderProviderId,
      });
      // Un DM de un amigo o de un fan: ni el hilo ni quien escribe son de un toque de esta cuenta. No queda nada suyo.
      if (!r.matched) return MESSAGES.routes.ignored.foreignChat;
      return r.inserted ? null : MESSAGES.routes.ignored.duplicate;
    }
    if (isUnipileOkStatus(event.status)) {
      // La sesión volvió (la persona resolvió el reto): la fila deja de estar en rojo sin esperar al keepalive.
      const back = await markChannelAccountOk(tx, account.id, {
        titleEs: MESSAGES.health.back.title(name, account.displayName), bodyEs: MESSAGES.health.back.body,
      });
      return back ? null : MESSAGES.routes.ignored.healthy;
    }
    if (!isUnipileDownStatus(event.status)) return MESSAGES.routes.ignored.healthy;
    // En last_error, el código; a la campana, la frase (la misma que escribe el keepalive).
    console.info("[canales] Unipile avisó una sesión caída", { status: event.status, channelAccountId: account.id });
    const what = MESSAGES.health.unipileStatus(event.status, name);
    await markChannelAccountDown(tx, account.id, unipileStatusCode(event.status), {
      titleEs: MESSAGES.health.down.title(name, account.displayName), bodyEs: MESSAGES.health.down.body(what),
    });
    return null;
  });
  return json(200, result ? { ok: true, ignored: result } : { ok: true });
}

/**
 * ¿Escribe la propia cuenta? El id que Unipile pone en
 * `sender.attendee_provider_id` es el mismo que `connection_params.im.id`
 * de la cuenta (provider_identity, 0042). Sin identidad guardada (una
 * cuenta conectada antes de 0042) no se puede afirmar: decide el
 * `account_info` del aviso.
 */
export function isOwnAccount(senderProviderId: string, providerIdentity: string | null): boolean {
  return providerIdentity !== null && senderProviderId.trim() !== "" && senderProviderId.trim() === providerIdentity.trim();
}

/** El aviso de cuenta creada o reconectada: sin cabeceras nuestras, lo autentica el estado firmado del cuerpo. */
async function accountNotify(req: Request, deps: ChannelDeps, now: Date): Promise<Response> {
  const body = await readLimitedJson(req, MAX_NOTIFY_BYTES);
  if (!body.ok) return bodyError(body.status);
  const event = parseUnipileWebhook(body.value);
  if (event.kind !== "account_connected") return plain(401, MESSAGES.routes.unauthorized);
  const verified = verifyChannelStateProof(event.state, now, UNIPILE_STATE_TTL_MS, deps.env);
  if (!verified || verified.state.channel === "email") {
    // Solo el largo: si Unipile recortara el `name`, aquí se vería (un estado entero ronda los 180 caracteres).
    console.warn("[canales] aviso de cuenta creada con un estado que no abre", { length: event.state.length });
    return plain(401, MESSAGES.routes.unauthorized);
  }
  if (!deps.unipile) return plain(503, MESSAGES.routes.notConfigured);
  return accountConnected(req, event, verified, deps, now);
}

/**
 * ¿Es la cuenta de ESTE intento? Al reconectar, la que se firmó en el
 * estado. Al crear, dos pruebas, y las dos hacen falta:
 *
 *   · la criptográfica: el `name` de la cuenta es el que mandamos al
 *     pedir el enlace (Unipile lo guarda tal cual), es decir, un estado
 *     firmado por nosotros con el MISMO nonce y el mismo espacio que el
 *     del aviso. Una cuenta nacida de otro enlace (de otro cliente del
 *     tenant, o de otro intento de la misma persona) no la trae, aunque
 *     quien avisa tenga un estado válido propio y su account_id. Sin
 *     caducidad: el estado del aviso ya la pasó y el `name` es su gemelo;
 *   · la de fecha: una nacida después de firmar el estado (con un margen
 *     por la diferencia de relojes). Sin fecha de alta no se liga: la
 *     documentación de Account la trae siempre.
 */
export function isAccountOfThisAttempt(
  account: Pick<UnipileAccount, "id" | "createdAt" | "hostedAuthName">,
  state: ChannelState,
  issuedAt: Date,
  stateKeys: Uint8Array | readonly Uint8Array[],
  now: Date,
): boolean {
  if (state.reconnectAccountId !== undefined) return account.id === state.reconnectAccountId;
  const named = verifyChannelState(account.hostedAuthName, stateKeys, now, Number.MAX_SAFE_INTEGER);
  if (!named.ok || named.payload.nonce !== state.nonce || named.payload.workspaceId !== state.workspaceId) return false;
  if (!account.createdAt) return false;
  return account.createdAt.getTime() >= issuedAt.getTime() - CREATED_CLOCK_SKEW_MS;
}

async function accountConnected(
  req: Request,
  event: Extract<UnipileWebhookEvent, { kind: "account_connected" }>,
  verified: { proof: ProviderCallbackProof; state: ChannelState; issuedAt: Date },
  deps: ChannelDeps,
  now: Date,
): Promise<Response> {
  const { proof, state, issuedAt } = verified;
  const channel = state.channel as "linkedin" | "instagram_dm";
  const log = new InMemoryOutreachCallLog();
  const unipile: UnipileApi = deps.unipile!(log);
  const flush = () => deps.withProviderCallback(proof, (tx) => log.flushTo(new PostgresOutreachCallLog(tx), null));

  let account: UnipileAccount;
  try {
    account = await unipile.getAccount(event.accountId, INTERACTIVE_BUDGET);
  } catch (err) {
    await flush();
    // Una cuenta que Unipile no conoce no se conecta; un fallo suyo se reintenta (Unipile repite lo que no es 2xx).
    if (isOutreachApiError(err) && err.kind === "transient") return plain(503, MESSAGES.routes.providerDown);
    return json(200, { ok: true, ignored: MESSAGES.routes.ignored.unknownInUnipile });
  }
  // Un estado válido no sirve para ligar OTRA cuenta del tenant: ni una que ya existía ni otra que la reconectada.
  if (!isAccountOfThisAttempt(account, state, issuedAt, channelKeys(deps.env)!.verify.state, now)) {
    await flush();
    console.warn("[canales] aviso de cuenta creada con una cuenta que no es de ese intento", { channel, reconnect: state.reconnectAccountId !== undefined });
    return json(200, { ok: true, ignored: MESSAGES.routes.ignored.notThisAttempt });
  }

  const outcome = await deps.withProviderCallback(proof, async (tx) => {
    const fail = (code: string) => failPendingChannelAccount(tx, { channel, nonce: state.nonce, code });
    let out: { status: string; accountId?: string; webhooks?: number; release: boolean; replaced?: { providerAccountId: string; webhookIds: string[] } | null };
    if (account.provider !== UNIPILE_PROVIDER_BY_CHANNEL[channel]) {
      await fail(CHANNEL_ERROR_CODES.wrongProvider);
      out = { status: "wrong_provider", release: !(await unipileAccountInUseHere(tx, account.id)) };
    } else {
      const r = await completeChannelConnection(tx, {
        channel, nonce: state.nonce, providerAccountId: account.id, displayName: account.displayName ?? account.username,
        secretRef: null, scopes: null, providerIdentity: account.providerIdentity,
      });
      switch (r.status) {
        case "connected":
          // Reconectar una cuenta que ya tiene sus dos avisos no los duplica; una a la que le falta alguno los vuelve a pedir.
          out = { status: "connected", accountId: r.accountId, webhooks: await channelWebhookCount(tx, r.accountId), release: false, replaced: r.replaced };
          break;
        case "duplicate":
          await fail(CHANNEL_ERROR_CODES.duplicate);
          out = { status: "duplicate", release: true };
          break;
        case "taken":
          await fail(CHANNEL_ERROR_CODES.taken);
          out = { status: "taken", release: !r.inUse };
          break;
        case "releasing":
          // El worker está borrando esa misma cuenta en Unipile: la pendiente dice «espera un minuto y vuelve a intentarlo».
          await fail(CHANNEL_ERROR_CODES.releasing);
          out = { status: "releasing", release: !r.inUse };
          break;
        default:
          // La pendiente ya se usó (un aviso repetido: la cuenta está viva) o la reemplazó otro «Conectar» (nadie la usa).
          out = { status: "unknown_state", release: !r.inUse };
      }
    }
    await log.flushTo(new PostgresOutreachCallLog(tx), out.status === "connected" ? out.accountId! : null);
    return out;
  });

  // Fuera de la transacción: lo que se creó en Unipile y no quedó ligado a nada, y la cuenta vieja de un perfil que adoptó otra.
  if (outcome.release) await releaseInUnipile(deps, proof, unipile, log, account.id, []);
  if (outcome.replaced) await releaseInUnipile(deps, proof, unipile, log, outcome.replaced.providerAccountId, outcome.replaced.webhookIds);
  if (outcome.status !== "connected") return json(200, { ok: true, ignored: outcome.status });
  if ((outcome.webhooks ?? 0) >= UNIPILE_ACCOUNT_WEBHOOK_SOURCES.length) return json(200, { ok: true });

  // Sus dos avisos, fuera de la transacción (son llamadas a Unipile), con la ruta firmada con la llave actual.
  const route = { workspaceId: state.workspaceId, channelAccountId: outcome.accountId! };
  await setUpWebhooks(await deps.origin(req), deps, proof, unipile, log, route, account.id, now);
  return json(200, { ok: true });
}

/**
 * Borra en Unipile una cuenta que no quedó ligada (y sus avisos, si los
 * tenía), con la bitácora. Es a mejor esfuerzo: si Unipile falla, la
 * cuenta no tiene fila viva y la conciliación del keepalive
 * (reconcileOrphans) la borra al día siguiente. Nunca rompe el aviso.
 */
async function releaseInUnipile(
  deps: ChannelDeps,
  proof: ProviderCallbackProof,
  unipile: UnipileApi,
  log: InMemoryOutreachCallLog,
  providerAccountId: string,
  webhookIds: readonly string[],
): Promise<void> {
  try {
    for (const id of webhookIds) await unipile.deleteWebhook(id, INTERACTIVE_BUDGET);
    await unipile.deleteAccount(providerAccountId, INTERACTIVE_BUDGET);
  } catch (err) {
    if (!isOutreachApiError(err)) throw err;
    console.warn("[canales] no se pudo borrar en Unipile una cuenta sin ligar; la concilia el keepalive", { code: err.code });
  }
  await deps.withProviderCallback(proof, (tx) => log.flushTo(new PostgresOutreachCallLog(tx), null));
}

/**
 * Da de alta los dos avisos de una cuenta y deja escrito el resultado: los
 * ids en la fila con la huella del secreto (outreach_channel_set_webhooks)
 * y, si faltó alguno, el código webhooks_missing; si salieron, el código
 * fuera. Lo usan el alta de la cuenta y «Volver a intentar».
 */
async function setUpWebhooks(
  origin: string,
  deps: ChannelDeps,
  proof: ProviderCallbackProof | null,
  unipile: UnipileApi,
  log: InMemoryOutreachCallLog,
  route: { workspaceId: string; channelAccountId: string },
  providerAccountId: string,
  now: Date,
): Promise<boolean> {
  const keys = channelKeys(deps.env)!;
  const { created, failed, secretFingerprint } = await registerAccountWebhooks({
    unipile, providerAccountId, route, routeKey: keys.sign.route, secret: deps.env[UNIPILE_WEBHOOK_SECRET_ENV],
    requestUrl: `${origin}/api/webhooks/unipile`, now, budget: INTERACTIVE_BUDGET,
  });
  const write = async (tx: WorkspaceTx) => {
    await log.flushTo(new PostgresOutreachCallLog(tx), route.channelAccountId);
    if (created.length > 0 && secretFingerprint) await setChannelWebhooks(tx, route.channelAccountId, created, secretFingerprint);
    if (failed) await noteChannelAccountIssue(tx, route.channelAccountId, CHANNEL_ERROR_CODES.webhooksMissing);
    else await clearChannelAccountIssue(tx, route.channelAccountId, CHANNEL_ERROR_CODES.webhooksMissing);
  };
  await (proof ? deps.withProviderCallback(proof, write) : deps.withWorkspace(write));
  return !failed;
}

export type RetryWebhooksResult = "restored" | "failed" | "not_found" | "not_configured" | "forbidden";

/**
 * «Volver a intentar» de una cuenta conectada que se quedó sin avisos: los
 * da de alta otra vez, sin pasar por la hosted auth. Solo quien puede
 * gestionar los canales (PUEDEN_GESTIONAR_CANALES). La cuenta es de la
 * sesión (withWorkspace, RLS) y conectada; su account_id sale de la base.
 * Una que ya tiene los dos solo pierde el código; a una que le falta
 * alguno se le piden los dos (un aviso repetido no hace daño: un mensaje
 * se guarda una vez por su id y una caída avisa una vez). `origin`: el
 * origen público de la app, del que sale la URL del aviso.
 */
export async function retryAccountWebhooks(accountId: string, origin: string, deps: ChannelDeps): Promise<RetryWebhooksResult> {
  if (!(await deps.canManage())) return "forbidden";
  if (!deps.unipile || !channelKeys(deps.env) || !deps.env[UNIPILE_WEBHOOK_SECRET_ENV]?.trim()) return "not_configured";
  const workspaceId = await deps.currentWorkspaceId();
  const account = await deps.withWorkspace((tx) => getConnectedUnipileAccount(tx, accountId));
  if (!account) return "not_found";
  if (account.webhooks >= UNIPILE_ACCOUNT_WEBHOOK_SOURCES.length) {
    await deps.withWorkspace((tx) => clearChannelAccountIssue(tx, account.id, CHANNEL_ERROR_CODES.webhooksMissing));
    return "restored";
  }
  const log = new InMemoryOutreachCallLog();
  const ok = await setUpWebhooks(
    origin, deps, null, deps.unipile(log), log, { workspaceId, channelAccountId: account.id }, account.providerAccountId, deps.now?.() ?? new Date(),
  );
  return ok ? "restored" : "failed";
}
