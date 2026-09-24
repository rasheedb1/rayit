/**
 * POST /api/webhooks/unipile, como función Request → Response (VEN-9).
 *
 * Primero se autentica, después se lee. Dos caminos (el detalle, en
 * @mc/connectors outreach/unipile-webhook.ts):
 *
 *   · cuenta creada o reconectada (hosted auth): el `name` tiene que ser
 *     un estado firmado vigente de LinkedIn o Instagram. La cuenta no se
 *     cree por el cuerpo: se lee en Unipile con nuestra llave y tiene que
 *     ser del canal pedido. Se conecta en el espacio del estado por
 *     outreach_channel_connect (la pendiente del nonce, una sola vez) y,
 *     si es una fila nueva, se dan de alta sus dos avisos (mensajes y
 *     salud) con la ruta firmada y el secreto compartido.
 *   · cualquier otro aviso: secreto compartido en tiempo constante Y ruta
 *     firmada. Sin las dos, 401 y la base no se toca. Con ellas, en el
 *     espacio de la ruta y solo si la cuenta de la ruta es la del cuerpo:
 *     un mensaje de la otra persona entra a outbound_message (intent
 *     NULL: la cola del clasificador de VEN-14) y una cuenta caída pasa a
 *     needs_reconnect con su aviso en la campana.
 *
 * Un aviso autenticado que no corresponde a nada responde 200: Unipile
 * reintenta lo que no es 2xx, y reintentar no lo arreglaría.
 */
import {
  InMemoryOutreachCallLog, isOutreachApiError, parseUnipileWebhook, PostgresOutreachCallLog, sharedSecretMatches, signChannelRoute,
  UNIPILE_PROVIDER_BY_CHANNEL, UNIPILE_ROUTE_HEADER, UNIPILE_SECRET_HEADER, UNIPILE_STATE_TTL_MS, UNIPILE_WEBHOOK_SECRET_ENV,
  verifyChannelRoute, verifyChannelState, type UnipileApi, type UnipileWebhookEvent,
} from "@mc/connectors";
import {
  CHANNEL_ERROR_CODES, completeChannelConnection, failPendingChannelAccount, findUnipileAccountForWebhook, markChannelAccountDown,
  noteChannelAccountIssue, recordInboundMessage,
} from "@mc/db/queries/canales";
import { MESSAGES } from "../messages";
import { channelKeys, plain, type ChannelDeps } from "./deps";

/** Un aviso de Unipile cabe de sobra en esto; lo que pase se rechaza sin leerlo entero. */
export const MAX_WEBHOOK_BYTES = 256 * 1024;
/** Los estados de una fuente que dicen que la sesión se cayó. */
const DOWN = new Set(["CREDENTIALS", "ERROR", "STOPPED", "DELETED", "DISCONNECTED"]);

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

async function readBody(req: Request): Promise<unknown | undefined> {
  const text = await req.text();
  if (text.length > MAX_WEBHOOK_BYTES) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function unipileWebhook(req: Request, deps: ChannelDeps): Promise<Response> {
  if (req.method !== "POST") return plain(405, "POST", { Allow: "POST" });
  const keys = channelKeys(deps.env);
  if (!keys) return plain(503, MESSAGES.routes.notConfigured("TOKEN_ENCRYPTION_KEY"));
  const raw = await readBody(req);
  if (raw === undefined) return plain(400, "JSON inválido.");
  const event = parseUnipileWebhook(raw);
  const now = deps.now?.() ?? new Date();

  if (event.kind === "account_connected") {
    const verified = verifyChannelState(event.state, keys.state, now, UNIPILE_STATE_TTL_MS);
    if (!verified.ok || verified.payload.channel === "email") return plain(401, MESSAGES.routes.unauthorized);
    if (!deps.unipile) return plain(503, MESSAGES.routes.notConfigured("UNIPILE_DSN, UNIPILE_ACCESS_TOKEN"));
    return accountConnected(req, event, verified.payload, deps, now);
  }

  const secret = deps.env[UNIPILE_WEBHOOK_SECRET_ENV]?.trim();
  if (!sharedSecretMatches(req.headers.get(UNIPILE_SECRET_HEADER), secret)) return plain(401, MESSAGES.routes.unauthorized);
  const route = verifyChannelRoute(req.headers.get(UNIPILE_ROUTE_HEADER), keys.route, now);
  if (!route) return plain(401, MESSAGES.routes.unauthorized);
  if (event.kind === "ignored") return json(200, { ok: true, ignored: event.reason });

  const proof = { workspaceId: route.workspaceId, verifiedBy: "channel_route" as const };
  const result = await deps.withProviderCallback(proof, async (tx) => {
    const account = await findUnipileAccountForWebhook(tx, route.channelAccountId, event.accountId);
    if (!account) return "cuenta desconocida o desconectada";
    if (event.kind === "message") {
      if (event.fromSelf) return "eco de un envío propio";
      const inserted = await recordInboundMessage(tx, {
        account, threadRef: event.chatId, providerMessageId: event.messageId, body: event.text,
        fromAddress: event.senderName ?? event.senderProviderId, occurredAt: event.occurredAt ?? now,
      });
      return inserted ? null : "mensaje repetido";
    }
    if (!DOWN.has(event.status)) return `estado ${event.status}`;
    const channel = MESSAGES.channels[account.channel === "instagram_dm" ? "instagram_dm" : "linkedin"].name;
    await markChannelAccountDown(tx, account.id, MESSAGES.downNotice.body(event.status), {
      titleEs: MESSAGES.downNotice.title(channel, account.displayName), bodyEs: MESSAGES.downNotice.body(event.status),
    });
    return null;
  });
  return json(200, result ? { ok: true, ignored: result } : { ok: true });
}

type VerifiedState = Extract<ReturnType<typeof verifyChannelState>, { ok: true }>["payload"];

async function accountConnected(
  req: Request,
  event: Extract<UnipileWebhookEvent, { kind: "account_connected" }>,
  state: VerifiedState,
  deps: ChannelDeps,
  now: Date,
): Promise<Response> {
  const channel = state.channel as "linkedin" | "instagram_dm";
  const proof = { workspaceId: state.workspaceId, verifiedBy: "channel_state" as const };
  const log = new InMemoryOutreachCallLog();
  const unipile: UnipileApi = deps.unipile!(log);

  let account;
  try {
    account = await unipile.getAccount(event.accountId);
  } catch (err) {
    await deps.withProviderCallback(proof, (tx) => log.flushTo(new PostgresOutreachCallLog(tx), null));
    // Una cuenta que Unipile no conoce no se conecta; un fallo suyo se reintenta (Unipile repite lo que no es 2xx).
    if (isOutreachApiError(err) && err.kind === "transient") return plain(503, "Unipile no respondió.");
    return json(200, { ok: true, ignored: "cuenta desconocida en Unipile" });
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
    return r;
  });
  if (outcome.status !== "connected") return json(200, { ok: true, ignored: outcome.status });
  if (outcome.reconnected) return json(200, { ok: true });

  // Una fila nueva: sus dos avisos, fuera de la transacción (es otra llamada a Unipile).
  const route = signChannelRoute({ workspaceId: state.workspaceId, channelAccountId: outcome.accountId }, channelKeys(deps.env)!.route, now);
  const secret = deps.env[UNIPILE_WEBHOOK_SECRET_ENV]?.trim() ?? "";
  const requestUrl = `${await deps.origin(req)}/api/webhooks/unipile`;
  const headers = { [UNIPILE_SECRET_HEADER]: secret, [UNIPILE_ROUTE_HEADER]: route };
  let failed = !secret;
  if (secret) {
    for (const source of ["messaging", "account_status"] as const) {
      try {
        await unipile.createWebhook({ source, accountId: account.id, requestUrl, headers }, { channelAccountId: outcome.accountId });
      } catch (err) {
        if (!isOutreachApiError(err)) throw err;
        failed = true;
      }
    }
  }
  await deps.withProviderCallback(proof, async (tx) => {
    await log.flushTo(new PostgresOutreachCallLog(tx), outcome.accountId);
    if (failed) {
      await noteChannelAccountIssue(tx, outcome.accountId, MESSAGES.webhookSetupFailed);
    }
  });
  return json(200, { ok: true });
}
