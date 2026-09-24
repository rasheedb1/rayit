// @vitest-environment node
/**
 * VEN-9 · las rutas de canales como funciones, sin red, contra Postgres
 * embebido con las migraciones reales y el seed (el espacio de Laura):
 *
 *   · Gmail: POST de inicio → 303 a Google con el estado firmado y la
 *     cookie del nonce → callback con FakeGmail → cuenta conectada con su
 *     token cifrado (ninguna tabla lo tiene en claro); un estado que no es
 *     de este navegador no pasa; sin gmail.modify no se conecta.
 *   · Sin llaves, las rutas dicen qué falta y no tocan la base.
 *   · El webhook de Unipile rechaza con 401 lo que no trae firma válida —
 *     sin secreto, con otro secreto, sin ruta o con un estado inventado —
 *     y con firma: conecta la cuenta del estado, da de alta sus avisos,
 *     encola la respuesta en outbound_message y marca la cuenta caída.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  channelStateKey, dumpTextColumns, EncryptedSecretStore, FakeGmail, FakeUnipile, findSecretInDump, signChannelRoute,
  signChannelState, TokenCipher, UNIPILE_ROUTE_HEADER, UNIPILE_SECRET_HEADER, withoutNetwork, type NetworkGuard,
} from "@mc/connectors";
import type { WorkspaceTx } from "@mc/db";
import { createEmbeddedDb, type EmbeddedDb } from "@mc/db/embedded";
import { listChannelAccounts } from "@mc/db/queries/canales";
import type { ProviderCallbackProof } from "@/lib/db";
import { SEED_WORKSPACE_ID } from "@/lib/workspace/current";
import { unipileWebhook } from "./aviso";
import { GOOGLE_COOKIE, googleCallback, googleStart, unipileStart } from "./conexion";
import { channelKeys, type ChannelDeps } from "./deps";

const NOW = new Date("2026-09-24T10:00:00Z");
const ORIGIN = "http://localhost:3100";
const SECRET = "SECRETO-COMPARTIDO-DE-PRUEBA-123";
const ENV = {
  NODE_ENV: "test",
  APP_URL: ORIGIN,
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "GOOGLE-CLIENT-SECRET-SECRETO",
  UNIPILE_DSN: "api1.unipile.test:13111",
  UNIPILE_ACCESS_TOKEN: "UNIPILE-LLAVE-SECRETA",
  UNIPILE_WEBHOOK_SECRET: SECRET,
};

let db: EmbeddedDb;
let guard: NetworkGuard;
const gmail = new FakeGmail({ now: () => NOW, email: "Laura.Alianzas@Gmail.test" });
const unipile = new FakeUnipile();

const withWorkspace = <T,>(fn: (tx: WorkspaceTx) => Promise<T>) => db.withWorkspace(SEED_WORKSPACE_ID, fn);
const withProviderCallback = <T,>(proof: ProviderCallbackProof, fn: (tx: WorkspaceTx) => Promise<T>) => db.withWorkspace(proof.workspaceId, fn);

function deps(over: Partial<ChannelDeps> = {}): ChannelDeps {
  return {
    env: ENV, withWorkspace, withProviderCallback, currentWorkspaceId: async () => SEED_WORKSPACE_ID,
    origin: async () => ORIGIN, google: () => gmail, unipile: () => unipile, now: () => NOW, ...over,
  };
}

const count = async (sql: string) => (await db.queryAsSuperuser<{ n: number }>(sql)).rows[0]!.n;
const accounts = () => withWorkspace((tx) => listChannelAccounts(tx));

beforeAll(async () => {
  guard = withoutNetwork();
  db = await createEmbeddedDb({ seeds: true });
}, 60_000);

afterAll(async () => {
  await db.close();
  guard.restore();
  expect(guard.attempts, "ninguna prueba de canales salió a la red").toBe(0);
});

function post(path: string, body: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
}

async function startGoogle() {
  const res = await googleStart(post("/api/oauth/google"), deps());
  expect(res.status).toBe(303);
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  const nonce = new RegExp(`${GOOGLE_COOKIE}=([^;]*)`).exec(res.headers.get("set-cookie") ?? "")![1]!;
  return { state, nonce };
}

function callback(query: Record<string, string>, cookie?: string): Request {
  const u = new URL(`${ORIGIN}/api/oauth/google/callback`);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return new Request(u, { headers: cookie ? { cookie: `${GOOGLE_COOKIE}=${cookie}` } : {} });
}

describe("Gmail", () => {
  it("de punta a punta: el correo queda conectado con su token cifrado y en ninguna tabla en claro", async () => {
    const { state, nonce } = await startGoogle();
    expect((await accounts()).some((a) => a.channel === "email" && a.status === "pending")).toBe(true);
    const res = await googleCallback(callback({ code: "CODE-GOOGLE-SECRETO", state }, nonce), deps());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/ventas/canales?conectado=email`);
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/);

    const gmailRow = (await accounts()).find((a) => a.providerAccountId === "laura.alianzas@gmail.test")!;
    expect(gmailRow.status).toBe("connected");
    expect(gmailRow.scopes).toEqual(["gmail.send", "gmail.modify", "userinfo.email"]);

    const ref = (await db.queryAsSuperuser<{ secret_ref: string }>(`SELECT secret_ref FROM outreach_channel_account WHERE id = $1`, [gmailRow.id])).rows[0]!.secret_ref;
    expect(ref).toMatch(/^enc:gmail:/);
    const keys = channelKeys(ENV)!;
    const tokens = await withWorkspace((tx) => new EncryptedSecretStore({ db: tx, cipher: keys.cipher }).get(ref));
    expect(tokens?.refreshToken).toMatch(/^fake-refresh/);
    const dump = await dumpTextColumns({ query: (text, params) => db.queryAsSuperuser(text, params) });
    expect(findSecretInDump(dump, [tokens!.accessToken, tokens!.refreshToken!, "CODE-GOOGLE-SECRETO"])).toBeNull();
  });

  it("un estado que no empezó en este navegador, uno alterado o de otro espacio no pasan", async () => {
    const { state } = await startGoogle();
    expect((await googleCallback(callback({ code: "x", state }, "otro-nonce"), deps())).status).toBe(400);
    expect((await googleCallback(callback({ code: "x", state: `${state}x` }, "n"), deps())).status).toBe(400);
    const again = await startGoogle();
    const otro = deps({ currentWorkspaceId: async () => "00000009-0000-4000-8000-00000000c0a1" });
    expect((await googleCallback(callback({ code: "x", state: again.state }, again.nonce), otro)).status).toBe(409);
  });

  it("sin gmail.modify no se conecta, y la pendiente dice por qué", async () => {
    const sinModify = new FakeGmail({ now: () => NOW, email: "otra@gmail.test", scopesGranted: ["https://www.googleapis.com/auth/gmail.send"] });
    const { state, nonce } = await startGoogle();
    const res = await googleCallback(callback({ code: "c", state }, nonce), deps({ google: () => sinModify }));
    expect(res.headers.get("location")).toBe(`${ORIGIN}/ventas/canales?error=permisos`);
    expect((await accounts()).some((a) => a.lastError === "missing_scopes" && a.status === "disconnected")).toBe(true);
  });

  it("cancelar en Google vuelve con el aviso, sin tocar la base", async () => {
    const res = await googleCallback(callback({ error: "access_denied" }), deps());
    expect(res.headers.get("location")).toBe(`${ORIGIN}/ventas/canales?error=cancelada`);
  });
});

describe("sin llaves", () => {
  it("el inicio dice qué variables faltan y no crea ninguna fila", async () => {
    const antes = await count(`SELECT count(*)::int AS n FROM outreach_channel_account`);
    const env = { NODE_ENV: "test", TOKEN_ENCRYPTION_KEY: ENV.TOKEN_ENCRYPTION_KEY };
    const res = await googleStart(post("/api/oauth/google"), deps({ env, google: null }));
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET/);
    const li = await unipileStart(post("/ventas/canales/conectar", { canal: "linkedin" }), deps({ env, unipile: null }));
    expect(li.status).toBe(503);
    expect(await li.text()).toMatch(/UNIPILE_DSN, UNIPILE_ACCESS_TOKEN, UNIPILE_WEBHOOK_SECRET/);
    expect(await count(`SELECT count(*)::int AS n FROM outreach_channel_account`)).toBe(antes);
  });
});

function webhook(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/webhooks/unipile`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

const MESSAGE = (accountId: string, messageId: string) => ({
  event: "message_received", account_id: accountId, account_info: { user_id: "ACoAAB_demo" }, chat_id: "chat_web_0001", message_id: messageId,
  message: "¡Hola! Nos interesa, ¿tienes media kit?", timestamp: "2026-09-24T09:59:00.000Z",
  sender: { attendee_provider_id: "ACoAAMarta_demo", attendee_name: "Marta Ríos" },
});

describe("el webhook de Unipile", () => {
  const route = (channelAccountId: string) => signChannelRoute({ workspaceId: SEED_WORKSPACE_ID, channelAccountId }, channelKeys(ENV)!.route, NOW);

  it("sin firma válida responde 401 y no escribe nada", async () => {
    const antes = await count(`SELECT count(*)::int AS n FROM outbound_message`);
    const LINKEDIN_LAURA = "00000005-0000-4000-8000-0000000ac002";
    const body = MESSAGE("acc_li_0001", "msg_forjado");
    expect((await unipileWebhook(webhook(body), deps())).status).toBe(401);
    expect((await unipileWebhook(webhook(body, { [UNIPILE_SECRET_HEADER]: "otro", [UNIPILE_ROUTE_HEADER]: route(LINKEDIN_LAURA) }), deps())).status).toBe(401);
    expect((await unipileWebhook(webhook(body, { [UNIPILE_SECRET_HEADER]: SECRET }), deps())).status).toBe(401);
    expect((await unipileWebhook(webhook(body, { [UNIPILE_SECRET_HEADER]: SECRET, [UNIPILE_ROUTE_HEADER]: "ruta-inventada" }), deps())).status).toBe(401);
    // Un aviso de cuenta creada con un estado que no firmamos nosotros.
    const otraLlave = channelStateKey(new Uint8Array(32).fill(1));
    const falso = signChannelState({ workspaceId: SEED_WORKSPACE_ID, creatorId: SEED_WORKSPACE_ID, channel: "linkedin", nonce: "n".repeat(43) }, otraLlave, NOW);
    expect((await unipileWebhook(webhook({ status: "CREATION_SUCCESS", account_id: "acc_x", name: falso }), deps())).status).toBe(401);
    expect(await count(`SELECT count(*)::int AS n FROM outbound_message`)).toBe(antes);
  });

  it("de punta a punta: conectar LinkedIn, sus avisos, una respuesta y la cuenta caída", async () => {
    const start = await unipileStart(post("/ventas/canales/conectar", { canal: "linkedin" }), deps());
    expect(start.status).toBe(303);
    expect(start.headers.get("location")).toMatch(/^https:\/\/account\.unipile\.test\//);
    const link = unipile.hostedLinks.at(-1)!;
    expect(link.notifyUrl).toBe(`${ORIGIN}/api/webhooks/unipile`);

    unipile.addAccount({ id: "acc_li_web", provider: "LINKEDIN", name: "Laura Gómez", username: "laura-gomez" });
    const notify = await unipileWebhook(webhook({ status: "CREATION_SUCCESS", account_id: "acc_li_web", name: link.state }), deps());
    expect(notify.status).toBe(200);
    const li = (await accounts()).find((a) => a.providerAccountId === "acc_li_web")!;
    expect(li).toMatchObject({ status: "connected", displayName: "Laura Gómez", channel: "linkedin" });
    expect(unipile.webhooks.map((w) => [w.source, w.accountId])).toEqual([["messaging", "acc_li_web"], ["account_status", "acc_li_web"]]);
    const headers = unipile.webhooks[0]!.headers;
    expect(headers[UNIPILE_SECRET_HEADER]).toBe(SECRET);

    // El mismo aviso otra vez: el nonce ya se usó.
    const again = await unipileWebhook(webhook({ status: "CREATION_SUCCESS", account_id: "acc_li_web", name: link.state }), deps());
    expect(await again.json()).toEqual({ ok: true, ignored: "unknown_state" });

    // Una respuesta, con las cabeceras que Unipile manda porque las pusimos al crear el aviso.
    const msg = await unipileWebhook(webhook(MESSAGE("acc_li_web", "msg_web_1"), headers), deps());
    expect(await msg.json()).toEqual({ ok: true });
    const repetido = await unipileWebhook(webhook(MESSAGE("acc_li_web", "msg_web_1"), headers), deps());
    expect(await repetido.json()).toEqual({ ok: true, ignored: "mensaje repetido" });
    const rows = await db.queryAsSuperuser<{ direction: string; intent: string | null; body: string }>(
      `SELECT direction, intent, body FROM outbound_message WHERE provider_message_id = 'msg_web_1'`,
    );
    expect(rows.rows).toEqual([{ direction: "inbound", intent: null, body: "¡Hola! Nos interesa, ¿tienes media kit?" }]);

    // La ruta de ESTA cuenta no sirve para otra cuenta del cuerpo.
    const ajena = await unipileWebhook(webhook(MESSAGE("acc_li_0001", "msg_web_2"), headers), deps());
    expect(await ajena.json()).toEqual({ ok: true, ignored: "cuenta desconocida o desconectada" });

    const caida = await unipileWebhook(webhook({ AccountStatus: { account_id: "acc_li_web", account_type: "LINKEDIN", message: "CREDENTIALS" } }, headers), deps());
    expect(caida.status).toBe(200);
    expect((await accounts()).find((a) => a.id === li.id)?.status).toBe("needs_reconnect");
    expect(await count(`SELECT count(*)::int AS n FROM notification WHERE entity_id = '${li.id}'`)).toBe(1);
  });

  it("una cuenta de Instagram donde se pidió LinkedIn no se conecta", async () => {
    await unipileStart(post("/ventas/canales/conectar", { canal: "linkedin" }), deps());
    const link = unipile.hostedLinks.at(-1)!;
    unipile.addAccount({ id: "acc_ig_web", provider: "INSTAGRAM" });
    const res = await unipileWebhook(webhook({ status: "CREATION_SUCCESS", account_id: "acc_ig_web", name: link.state }), deps());
    expect(await res.json()).toEqual({ ok: true, ignored: "wrong_provider" });
    expect((await accounts()).some((a) => a.lastError === "wrong_provider")).toBe(true);
  });
});

it("channelKeys deriva de TOKEN_ENCRYPTION_KEY y sin ella es null", () => {
  expect(channelKeys(ENV)?.cipher).toBeInstanceOf(TokenCipher);
  expect(channelKeys({})).toBeNull();
});
