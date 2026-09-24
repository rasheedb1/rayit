/**
 * POST /api/webhooks/unipile, como función Request → Response (VEN-9).
 *
 * Dos clases de aviso, y ninguna se cree por lo que dice su cuerpo (el
 * detalle, en @mc/connectors outreach/unipile-webhook.ts):
 *
 *   · los de UNA cuenta (mensajes y salud), que dimos de alta al
 *     conectarla con dos cabeceras nuestras: el secreto compartido
 *     (tiempo constante) y la ruta firmada. Se autentican por las
 *     cabeceras ANTES de leer el cuerpo: sin las dos, 401 y ni un byte
 *     leído. Con ellas, el cuerpo se lee con un techo de bytes contado
 *     sobre el flujo (no sobre caracteres) y se actúa en el espacio de la
 *     ruta, solo si la cuenta de la ruta es la del cuerpo: un mensaje de
 *     la otra persona entra a outbound_message y detiene su enrolamiento;
 *     una cuenta caída pasa a needs_reconnect con su aviso en la campana.
 *   · el de cuenta creada o reconectada de la hosted auth (notify_url):
 *     Unipile no deja poner cabeceras ahí, así que lo único que lo
 *     autentica es el `name`, nuestro estado firmado. Va en el cuerpo, y
 *     el cuerpo se lee con un techo mucho menor (el aviso son tres
 *     campos). La cuenta se lee en Unipile con nuestra llave y tiene que
 *     ser del canal pedido; se conecta por outreach_channel_connect (la
 *     pendiente del nonce, una sola vez) y se dan de alta sus dos avisos,
 *     cuyos ids quedan en la fila para borrarlos al desconectar (0040).
 *
 * Un Content-Length por encima del techo responde 413 sin leer nada. Un
 * aviso autenticado que no corresponde a nada responde 200: Unipile
 * reintenta lo que no es 2xx, y reintentar no lo arreglaría.
 */
import {
  InMemoryOutreachCallLog, isOutreachApiError, parseUnipileWebhook, PostgresOutreachCallLog, sharedSecretMatches, signChannelRoute,
  UNIPILE_PROVIDER_BY_CHANNEL, UNIPILE_ROUTE_HEADER, UNIPILE_SECRET_HEADER, UNIPILE_STATE_TTL_MS, UNIPILE_WEBHOOK_SECRET_ENV,
  type ChannelState, type UnipileApi, type UnipileWebhookEvent,
} from "@mc/connectors";
import {
  CHANNEL_ERROR_CODES, channelWebhookCount, completeChannelConnection, failPendingChannelAccount, findUnipileAccountForWebhook,
  markChannelAccountDown, noteChannelAccountIssue, recordInboundMessage, setChannelWebhooks,
} from "@mc/db/queries/canales";
import { verifyChannelRouteProof, verifyChannelStateProof, type ProviderCallbackProof } from "@/lib/db/aviso-de-proveedor";
import { MESSAGES } from "../messages";
import { channelKeys, plain, type ChannelDeps } from "./deps";

/** Un aviso de mensajes o de salud cabe de sobra en esto. */
export const MAX_WEBHOOK_BYTES = 256 * 1024;
/** El aviso de cuenta creada llega sin autenticar: tres campos, y nada más se lee. */
export const MAX_NOTIFY_BYTES = 16 * 1024;
/** Los estados de una fuente que dicen que la sesión se cayó. */
const DOWN = new Set(["CREDENTIALS", "ERROR", "STOPPED", "DELETED", "DISCONNECTED"]);

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
const channelName = (channel: string) => MESSAGES.channels[channel === "instagram_dm" ? "instagram_dm" : "linkedin"].name;

export async function unipileWebhook(req: Request, deps: ChannelDeps): Promise<Response> {
  if (req.method !== "POST") return plain(405, MESSAGES.routes.webhookPostOnly, { Allow: "POST" });
  if (!channelKeys(deps.env)) return plain(503, MESSAGES.routes.notConfigured);
  const now = deps.now?.() ?? new Date();
  const secretHeader = req.headers.get(UNIPILE_SECRET_HEADER);
  if (secretHeader === null) return accountNotify(req, deps, now);

  // Los avisos de una cuenta: primero las cabeceras, después el cuerpo.
  const secret = deps.env[UNIPILE_WEBHOOK_SECRET_ENV]?.trim();
  if (!sharedSecretMatches(secretHeader, secret)) return plain(401, MESSAGES.routes.unauthorized);
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
    const name = channelName(account.channel);
    if (event.kind === "message") {
      if (event.fromSelf) return MESSAGES.routes.ignored.echo;
      const r = await recordInboundMessage(tx, {
        account, threadRef: event.chatId, providerMessageId: event.messageId, body: event.text,
        fromAddress: event.senderName ?? event.senderProviderId, occurredAt: event.occurredAt ?? now,
        optOutReasonEs: MESSAGES.optOutReason(name),
      });
      return r.inserted ? null : MESSAGES.routes.ignored.duplicate;
    }
    if (!DOWN.has(event.status)) return MESSAGES.routes.ignored.healthy;
    // El código crudo de Unipile va al registro del servidor; a la persona, la frase.
    console.info("[canales] Unipile avisó una sesión caída", { status: event.status, channelAccountId: account.id });
    const what = MESSAGES.unipileStatus(event.status, name);
    await markChannelAccountDown(tx, account.id, what, {
      titleEs: MESSAGES.downNotice.title(name, account.displayName), bodyEs: MESSAGES.downNotice.body(what),
    });
    return null;
  });
  return json(200, result ? { ok: true, ignored: result } : { ok: true });
}

/** El aviso de cuenta creada o reconectada: sin cabeceras nuestras, lo autentica el estado firmado del cuerpo. */
async function accountNotify(req: Request, deps: ChannelDeps, now: Date): Promise<Response> {
  const body = await readLimitedJson(req, MAX_NOTIFY_BYTES);
  if (!body.ok) return bodyError(body.status);
  const event = parseUnipileWebhook(body.value);
  if (event.kind !== "account_connected") return plain(401, MESSAGES.routes.unauthorized);
  const verified = verifyChannelStateProof(event.state, now, UNIPILE_STATE_TTL_MS, deps.env);
  if (!verified || verified.state.channel === "email") return plain(401, MESSAGES.routes.unauthorized);
  if (!deps.unipile) return plain(503, MESSAGES.routes.notConfigured);
  return accountConnected(req, event, verified, deps, now);
}

async function accountConnected(
  req: Request,
  event: Extract<UnipileWebhookEvent, { kind: "account_connected" }>,
  verified: { proof: ProviderCallbackProof; state: ChannelState },
  deps: ChannelDeps,
  now: Date,
): Promise<Response> {
  const { proof, state } = verified;
  const channel = state.channel as "linkedin" | "instagram_dm";
  const log = new InMemoryOutreachCallLog();
  const unipile: UnipileApi = deps.unipile!(log);

  let account;
  try {
    account = await unipile.getAccount(event.accountId);
  } catch (err) {
    await deps.withProviderCallback(proof, (tx) => log.flushTo(new PostgresOutreachCallLog(tx), null));
    // Una cuenta que Unipile no conoce no se conecta; un fallo suyo se reintenta (Unipile repite lo que no es 2xx).
    if (isOutreachApiError(err) && err.kind === "transient") return plain(503, MESSAGES.routes.providerDown);
    return json(200, { ok: true, ignored: MESSAGES.routes.ignored.unknownInUnipile });
  }

  const outcome = await deps.withProviderCallback(proof, async (tx) => {
    if (account.provider !== UNIPILE_PROVIDER_BY_CHANNEL[channel]) {
      await failPendingChannelAccount(tx, { channel, nonce: state.nonce, code: CHANNEL_ERROR_CODES.wrongProvider });
      await log.flushTo(new PostgresOutreachCallLog(tx), null);
      return { status: "wrong_provider" as const };
    }
    const r = await completeChannelConnection(tx, {
      channel, nonce: state.nonce, providerAccountId: account.id, displayName: account.name ?? account.username, secretRef: null, scopes: null,
    });
    if (r.status === "taken") await failPendingChannelAccount(tx, { channel, nonce: state.nonce, code: CHANNEL_ERROR_CODES.taken });
    await log.flushTo(new PostgresOutreachCallLog(tx), r.status === "connected" ? r.accountId : null);
    // Reconectar una cuenta que ya tiene sus avisos no los duplica; una que se quedó sin ellos los vuelve a pedir.
    const webhooks = r.status === "connected" ? await channelWebhookCount(tx, r.accountId) : 0;
    return { ...r, webhooks };
  });
  if (outcome.status !== "connected") return json(200, { ok: true, ignored: outcome.status });
  if (outcome.webhooks > 0) return json(200, { ok: true });

  // Sus dos avisos, fuera de la transacción (son llamadas a Unipile), con la ruta firmada con la llave actual.
  const keys = channelKeys(deps.env)!;
  const route = signChannelRoute({ workspaceId: state.workspaceId, channelAccountId: outcome.accountId }, keys.sign.route, now);
  const secret = deps.env[UNIPILE_WEBHOOK_SECRET_ENV]?.trim() ?? "";
  const requestUrl = `${await deps.origin(req)}/api/webhooks/unipile`;
  const headers = { [UNIPILE_SECRET_HEADER]: secret, [UNIPILE_ROUTE_HEADER]: route };
  const created: string[] = [];
  let failed = !secret;
  if (secret) {
    for (const source of ["messaging", "account_status"] as const) {
      try {
        const { webhookId } = await unipile.createWebhook({ source, accountId: account.id, requestUrl, headers }, { channelAccountId: outcome.accountId });
        created.push(webhookId);
      } catch (err) {
        if (!isOutreachApiError(err)) throw err;
        failed = true;
      }
    }
  }
  await deps.withProviderCallback(proof, async (tx) => {
    await log.flushTo(new PostgresOutreachCallLog(tx), outcome.accountId);
    if (created.length > 0) await setChannelWebhooks(tx, outcome.accountId, created);
    if (failed) await noteChannelAccountIssue(tx, outcome.accountId, MESSAGES.webhookSetupFailed);
  });
  return json(200, { ok: true });
}
