// @vitest-environment node
/**
 * VEN-9 · las rutas de canales como funciones, sin red, contra Postgres
 * embebido con las migraciones reales y el seed (el espacio de Laura):
 *
 *   · Gmail: POST de inicio → 303 a Google con el estado firmado y la
 *     cookie del nonce → callback con FakeGmail → cuenta conectada con su
 *     token cifrado (ninguna tabla lo tiene en claro); un estado que no es
 *     de este navegador no pasa; sin gmail.modify no se conecta.
 *   · Sin llaves, las rutas vuelven a la pantalla con un texto de
 *     producto, lo que falta va al registro del servidor y no tocan la base.
 *   · El webhook de Unipile rechaza con 401 lo que no trae firma válida —
 *     sin secreto, con otro secreto, sin ruta o con un estado inventado —
 *     ANTES de leer el cuerpo, y con 413 lo que pasa del techo de bytes;
 *     con firma: conecta la cuenta del estado, da de alta sus avisos (y
 *     guarda sus ids), encola la respuesta en outbound_message y marca la
 *     cuenta caída con una frase, no con el código de Unipile.
 *   · Reconectar manda el id de nuestra fila: uno ajeno no pide enlace.
 *
 * Las pruebas que levantan el flujo completo sobre pglite llevan su propio
 * tiempo de espera (HEAVY_MS): con varios agentes en la máquina, los 5 s
 * por defecto de vitest no alcanzan.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  channelStateKey, dumpTextColumns, EncryptedSecretStore, FakeGmail, FakeUnipile, findSecretInDump, signChannelRoute,
  signChannelState, TokenCipher, UNIPILE_ROUTE_HEADER, UNIPILE_SECRET_HEADER, withoutNetwork, type NetworkGuard,
} from "@mc/connectors";
import type { WorkspaceTx } from "@mc/db";
import { createEmbeddedDb, type EmbeddedDb } from "@mc/db/embedded";
import { listChannelAccounts } from "@mc/db/queries/canales";
import { proofWorkspace, type ProviderCallbackProof } from "@/lib/db/aviso-de-proveedor";
import { SEED_WORKSPACE_ID } from "@/lib/workspace/current";
import { MESSAGES } from "../messages";
import { MAX_NOTIFY_BYTES, MAX_WEBHOOK_BYTES, unipileWebhook } from "./aviso";
import { GOOGLE_COOKIE, googleCallback, googleStart, unipileStart } from "./conexion";
import { channelKeys, type ChannelDeps } from "./deps";

const NOW = new Date("2026-09-24T10:00:00Z");
/** El flujo completo sobre pglite: bajo carga pasa de los 5 s por defecto. */
const HEAVY_MS = 30_000;
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
// Como lib/db: solo abre el espacio de una prueba emitida por una verificación de firma.
const withProviderCallback = <T,>(proof: ProviderCallbackProof, fn: (tx: WorkspaceTx) => Promise<T>) => db.withWorkspace(proofWorkspace(proof), fn);

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
  }, HEAVY_MS);

  it("un estado que no empezó en este navegador, uno alterado o de otro espacio no pasan", async () => {
    const { state } = await startGoogle();
    expect((await googleCallback(callback({ code: "x", state }, "otro-nonce"), deps())).status).toBe(400);
    expect((await googleCallback(callback({ code: "x", state: `${state}x` }, "n"), deps())).status).toBe(400);
    const again = await startGoogle();
    const otro = deps({ currentWorkspaceId: async () => "00000009-0000-4000-8000-00000000c0a1" });
    expect((await googleCallback(callback({ code: "x", state: again.state }, again.nonce), otro)).status).toBe(409);
  }, HEAVY_MS);

  it("sin gmail.modify no se conecta, y la pendiente dice por qué", async () => {
    const sinModify = new FakeGmail({ now: () => NOW, email: "otra@gmail.test", scopesGranted: ["https://www.googleapis.com/auth/gmail.send"] });
    const { state, nonce } = await startGoogle();
    const res = await googleCallback(callback({ code: "c", state }, nonce), deps({ google: () => sinModify }));
    expect(res.headers.get("location")).toBe(`${ORIGIN}/ventas/canales?error=permisos`);
    expect((await accounts()).some((a) => a.lastError === "missing_scopes" && a.status === "disconnected")).toBe(true);
  }, HEAVY_MS);

  it("cancelar en Google vuelve con el aviso; sin estado no toca la base, con el estado de este navegador la pendiente dice «cancelaste»", async () => {
    const res = await googleCallback(callback({ error: "access_denied" }), deps());
    expect(res.headers.get("location")).toBe(`${ORIGIN}/ventas/canales?error=cancelada`);
    const { state, nonce } = await startGoogle();
    const pendientes = async () => (await accounts()).filter((a) => a.channel === "email" && a.status === "pending").length;
    const antes = await pendientes();
    // Con el estado pero con la cookie de otro navegador: no se toca.
    await googleCallback(callback({ error: "access_denied", state }, "otro"), deps());
    expect(await pendientes()).toBe(antes);
    const ok = await googleCallback(callback({ error: "access_denied", state }, nonce), deps());
    expect(ok.headers.get("location")).toBe(`${ORIGIN}/ventas/canales?error=cancelada`);
    expect(await pendientes()).toBe(antes - 1);
    expect((await accounts()).some((a) => a.status === "disconnected" && a.lastError === "cancelled")).toBe(true);
  }, HEAVY_MS);
});

describe("sin llaves", () => {
  it("el inicio vuelve a la pantalla con un texto de producto, lo que falta va al registro y no crea ninguna fila", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const antes = await count(`SELECT count(*)::int AS n FROM outreach_channel_account`);
      const env = { NODE_ENV: "test", TOKEN_ENCRYPTION_KEY: ENV.TOKEN_ENCRYPTION_KEY };
      const res = await googleStart(post("/api/oauth/google"), deps({ env, google: null }));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${ORIGIN}/ventas/canales?error=no_configurado`);
      const li = await unipileStart(post("/ventas/canales/conectar", { canal: "linkedin" }), deps({ env, unipile: null }));
      expect(li.headers.get("location")).toBe(`${ORIGIN}/ventas/canales?error=no_configurado`);
      // El navegador no ve ni una variable; el servidor sí las registra.
      expect(MESSAGES.banners.errors.no_configurado).not.toMatch(/[A-Z]{3,}_[A-Z]+/);
      const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toMatch(/GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET/);
      expect(logged).toMatch(/UNIPILE_DSN, UNIPILE_ACCESS_TOKEN, UNIPILE_WEBHOOK_SECRET/);
      expect(await count(`SELECT count(*)::int AS n FROM outreach_channel_account`)).toBe(antes);
    } finally {
      warn.mockRestore();
    }
  }, HEAVY_MS);
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
  const route = (channelAccountId: string) => signChannelRoute({ workspaceId: SEED_WORKSPACE_ID, channelAccountId }, channelKeys(ENV)!.sign.route, NOW);

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
    // Un mensaje sin cabeceras no es un aviso de cuenta: 401 aunque el cuerpo esté bien formado.
    expect((await unipileWebhook(webhook(body), deps())).status).toBe(401);
    expect(await count(`SELECT count(*)::int AS n FROM outbound_message`)).toBe(antes);
  }, HEAVY_MS);

  it("primero se autentica, después se lee: con un secreto malo, 401 aunque el cuerpo no sea JSON; y un cuerpo enorme, 413", async () => {
    const LINKEDIN_LAURA = "00000005-0000-4000-8000-0000000ac002";
    const bad = new Request(`${ORIGIN}/api/webhooks/unipile`, { method: "POST", headers: { [UNIPILE_SECRET_HEADER]: "otro", [UNIPILE_ROUTE_HEADER]: route(LINKEDIN_LAURA) }, body: "{no es json" });
    expect((await unipileWebhook(bad, deps())).status).toBe(401);
    // Content-Length por encima del techo: 413 sin leer nada.
    const declared = new Request(`${ORIGIN}/api/webhooks/unipile`, {
      method: "POST", headers: { "content-length": String(MAX_WEBHOOK_BYTES + 1), [UNIPILE_SECRET_HEADER]: SECRET, [UNIPILE_ROUTE_HEADER]: route(LINKEDIN_LAURA) }, body: "{}",
    });
    expect((await unipileWebhook(declared, deps())).status).toBe(413);
    // Sin cabeceras (el aviso de cuenta creada), el techo es mucho menor y se cuenta en bytes, no en caracteres.
    const big = new Request(`${ORIGIN}/api/webhooks/unipile`, { method: "POST", body: JSON.stringify({ name: "ñ".repeat(MAX_NOTIFY_BYTES / 2 + 10) }) });
    expect((await unipileWebhook(big, deps())).status).toBe(413);
  }, HEAVY_MS);

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
    // Los ids de los dos avisos quedan en la fila: sales.channels_release los borra al desconectar.
    const ids = await db.queryAsSuperuser<{ provider_webhook_ids: string[] }>(`SELECT provider_webhook_ids FROM outreach_channel_account WHERE id = $1`, [li.id]);
    expect([...ids.rows[0]!.provider_webhook_ids].sort()).toEqual(unipile.webhooks.map((w) => w.id).sort());

    // El mismo aviso otra vez: el nonce ya se usó.
    const again = await unipileWebhook(webhook({ status: "CREATION_SUCCESS", account_id: "acc_li_web", name: link.state }), deps());
    expect(await again.json()).toEqual({ ok: true, ignored: "unknown_state" });
    expect(unipile.webhooks.length, "no se dieron de alta avisos otra vez").toBe(2);

    // Una respuesta, con las cabeceras que Unipile manda porque las pusimos al crear el aviso.
    const msg = await unipileWebhook(webhook(MESSAGE("acc_li_web", "msg_web_1"), headers), deps());
    expect(await msg.json()).toEqual({ ok: true });
    const repetido = await unipileWebhook(webhook(MESSAGE("acc_li_web", "msg_web_1"), headers), deps());
    expect(await repetido.json()).toEqual({ ok: true, ignored: MESSAGES.routes.ignored.duplicate });
    const rows = await db.queryAsSuperuser<{ direction: string; intent: string | null; body: string }>(
      `SELECT direction, intent, body FROM outbound_message WHERE provider_message_id = 'msg_web_1'`,
    );
    expect(rows.rows).toEqual([{ direction: "inbound", intent: null, body: "¡Hola! Nos interesa, ¿tienes media kit?" }]);

    // La ruta de ESTA cuenta no sirve para otra cuenta del cuerpo.
    const ajena = await unipileWebhook(webhook(MESSAGE("acc_li_0001", "msg_web_2"), headers), deps());
    expect(await ajena.json()).toEqual({ ok: true, ignored: MESSAGES.routes.ignored.unknownAccount });

    const caida = await unipileWebhook(webhook({ AccountStatus: { account_id: "acc_li_web", account_type: "LINKEDIN", message: "CREDENTIALS" } }, headers), deps());
    expect(caida.status).toBe(200);
    const caidaRow = (await accounts()).find((a) => a.id === li.id);
    expect(caidaRow?.status).toBe("needs_reconnect");
    // La persona lee una frase; el código de Unipile no sale de la ruta.
    expect(caidaRow?.lastError).toBe(MESSAGES.unipileStatus("CREDENTIALS", "LinkedIn"));
    const aviso = await db.queryAsSuperuser<{ title_es: string; body_es: string }>(`SELECT title_es, body_es FROM notification WHERE entity_id = $1`, [li.id]);
    expect(aviso.rows).toHaveLength(1);
    expect(JSON.stringify(aviso.rows)).not.toMatch(/CREDENTIALS/);

    // Reconectar por el id de la fila: el account_id de Unipile sale de la base, no del formulario.
    const re = await unipileStart(post("/ventas/canales/conectar", { canal: "linkedin", reconectar: li.id }), deps());
    expect(re.status).toBe(303);
    expect(unipile.hostedLinks.at(-1)!.reconnectAccountId).toBe("acc_li_web");
  }, HEAVY_MS);

  it("reconectar con un id ajeno, inventado o de otro canal no pide enlace a Unipile ni crea nada", async () => {
    const antes = unipile.hostedLinks.length;
    const filas = await count(`SELECT count(*)::int AS n FROM outreach_channel_account`);
    const OTRO_ESPACIO = "00000009-0000-4000-8000-0000000ac0f9";
    await db.queryAsSuperuser(`INSERT INTO workspace (id, slug, name) VALUES ('00000009-0000-4000-8000-00000000c0b1', 'otro-reconectar', 'Otro') ON CONFLICT DO NOTHING`);
    await db.queryAsSuperuser(`INSERT INTO outreach_channel_account (id, workspace_id, channel, provider, provider_account_id, status)
      VALUES ('${OTRO_ESPACIO}', '00000009-0000-4000-8000-00000000c0b1', 'linkedin', 'unipile', 'acc_de_otro', 'needs_reconnect') ON CONFLICT DO NOTHING`);
    for (const reconectar of [OTRO_ESPACIO, "00000009-0000-4000-8000-000000000000", "acc_de_otro", "00000005-0000-4000-8000-0000000ac001"]) {
      const res = await unipileStart(post("/ventas/canales/conectar", { canal: "linkedin", reconectar }), deps());
      expect(res.headers.get("location"), reconectar).toBe(`${ORIGIN}/ventas/canales?error=vencida`);
    }
    expect(unipile.hostedLinks.length).toBe(antes);
    expect(await count(`SELECT count(*)::int AS n FROM outreach_channel_account`)).toBe(filas + 1);
  }, HEAVY_MS);

  it("una cuenta de Instagram donde se pidió LinkedIn no se conecta", async () => {
    await unipileStart(post("/ventas/canales/conectar", { canal: "linkedin" }), deps());
    const link = unipile.hostedLinks.at(-1)!;
    unipile.addAccount({ id: "acc_ig_web", provider: "INSTAGRAM" });
    const res = await unipileWebhook(webhook({ status: "CREATION_SUCCESS", account_id: "acc_ig_web", name: link.state }), deps());
    expect(await res.json()).toEqual({ ok: true, ignored: "wrong_provider" });
    expect((await accounts()).some((a) => a.lastError === "wrong_provider")).toBe(true);
  }, HEAVY_MS);
});

it("channelKeys deriva de TOKEN_ENCRYPTION_KEY y sin ella es null", () => {
  expect(channelKeys(ENV)?.cipher).toBeInstanceOf(TokenCipher);
  expect(channelKeys({ ...ENV, TOKEN_ENCRYPTION_KEY_V2: randomBytes(32).toString("base64") })?.verify.route).toHaveLength(2);
  expect(channelKeys({})).toBeNull();
});
