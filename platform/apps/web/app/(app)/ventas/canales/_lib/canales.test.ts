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
  channelStateKey, dumpTextColumns, EncryptedSecretStore, findSecretInDump, INTERACTIVE_BUDGET, normalizeUnipileAccount,
  OutreachApiError, signChannelRoute, signChannelState, TokenCipher, UNIPILE_ROUTE_HEADER, UNIPILE_SECRET_HEADER, withoutNetwork, type NetworkGuard,
} from "@mc/connectors";
import { FakeGmail, FakeUnipile } from "@mc/connectors/testing";
import type { WorkspaceTx } from "@mc/db";
import { createEmbeddedDb, type EmbeddedDb } from "@mc/db/embedded";
import { getChannelPolicyCaps, listChannelAccounts } from "@mc/db/queries/canales";
import { OrigenNoConfiguradoError } from "@/lib/auth/origen";
import { proofWorkspace, type ProviderCallbackProof } from "@/lib/db/aviso-de-proveedor";
import { SEED_WORKSPACE_ID } from "@/lib/workspace/current";
import { formatterFor } from "@/lib/format";
import { MESSAGES } from "../messages";
import { disconnect, saveCaps } from "./acciones";
import { MAX_NOTIFY_BYTES, MAX_WEBHOOK_BYTES, retryAccountWebhooks, unipileWebhook } from "./aviso";
import { channelSetup } from "./config";
import { channelBanner } from "./banner";
import { channelRows, reasonText } from "./filas";
import { GOOGLE_COOKIE, googleCallback, googleStart, UNIPILE_COOKIE, unipileFailure, unipileStart } from "./conexion";
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
  GOOGLE_OUTREACH_CLIENT_ID: "google-client",
  GOOGLE_OUTREACH_CLIENT_SECRET: "GOOGLE-CLIENT-SECRET-SECRETO",
  UNIPILE_DSN: "api1.unipile.test:13111",
  UNIPILE_ACCESS_TOKEN: "UNIPILE-LLAVE-SECRETA",
  UNIPILE_WEBHOOK_SECRET: SECRET,
};

let db: EmbeddedDb;
let guard: NetworkGuard;
const gmail = new FakeGmail({ now: () => NOW, email: "Laura.Alianzas@Gmail.test" });
// Las cuentas nacen a la hora de la prueba: una cuenta de «crear» no puede ser más vieja que su estado firmado.
const unipile = new FakeUnipile({ now: () => NOW });

const withWorkspace = <T,>(fn: (tx: WorkspaceTx) => Promise<T>) => db.withWorkspace(SEED_WORKSPACE_ID, fn);
// Como lib/db: solo abre el espacio de una prueba emitida por una verificación de firma.
const withProviderCallback = <T,>(proof: ProviderCallbackProof, fn: (tx: WorkspaceTx) => Promise<T>) => db.withWorkspace(proofWorkspace(proof), fn);

function deps(over: Partial<ChannelDeps> = {}): ChannelDeps {
  return {
    env: ENV, withWorkspace, withProviderCallback, currentWorkspaceId: async () => SEED_WORKSPACE_ID, canManage: async () => true,
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

describe("la demo sembrada (seed 0005)", () => {
  it("todo last_error sembrado es un código que la pantalla traduce, y la cuenta caída dice qué pasó", async () => {
    const rows = await db.queryAsSuperuser<{ channel: "email" | "linkedin" | "instagram_dm"; status: string; last_error: string | null; display_name: string | null }>(
      `SELECT channel, status, last_error, display_name FROM outreach_channel_account WHERE last_error IS NOT NULL`,
    );
    expect(rows.rows.length, "la demo tiene al menos una cuenta caída con su motivo").toBeGreaterThan(0);
    for (const r of rows.rows) {
      const state = r.status === "needs_reconnect" ? "needs_reconnect" : "error";
      const frase = reasonText(r.last_error, r.channel, true, true, state);
      expect([MESSAGES.detail.unknownReason, MESSAGES.detail.unknownReasonReconnect], `last_error «${r.last_error}» es un código conocido`).not.toContain(frase);
    }
    const li = rows.rows.find((r) => r.channel === "linkedin")!;
    expect(reasonText(li.last_error, "linkedin")).toBe(MESSAGES.health.unipileStatus("CREDENTIALS", "LinkedIn"));
    // El nombre es el de la persona, como el que trae connection_params.im: sin el canal repetido dentro de la fila.
    expect(li.display_name).not.toMatch(/LinkedIn/);
  });
});

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

  it("un estado que no empezó en este navegador, uno alterado, sin code o de otro espacio no pasan, y vuelven a la pantalla con su aviso", async () => {
    const back = (code: string) => `${ORIGIN}/ventas/canales?error=${code}&canal=email`;
    const { state, nonce } = await startGoogle();
    const canje = vi.spyOn(gmail, "exchangeCode");
    const otroNavegador = await googleCallback(callback({ code: "x", state }, "otro-nonce"), deps());
    expect([otroNavegador.status, otroNavegador.headers.get("location")]).toEqual([303, back("vencida")]);
    expect((await googleCallback(callback({ code: "x", state: `${state}x` }, "n"), deps())).headers.get("location")).toBe(back("vencida"));
    expect((await googleCallback(callback({ state }, nonce), deps())).headers.get("location")).toBe(back("vencida"));
    const again = await startGoogle();
    const otro = deps({ currentWorkspaceId: async () => "00000009-0000-4000-8000-00000000c0a1" });
    expect((await googleCallback(callback({ code: "x", state: again.state }, again.nonce), otro)).headers.get("location")).toBe(back("otro_espacio"));
    expect(canje, "ninguno llegó a canjear el code").not.toHaveBeenCalled();
    canje.mockRestore();
    expect(MESSAGES.banners.errors.otro_espacio).toBeTruthy();
  }, HEAVY_MS);

  it("sin gmail.modify no se conecta, y la pendiente dice por qué", async () => {
    const sinModify = new FakeGmail({ now: () => NOW, email: "otra@gmail.test", scopesGranted: ["https://www.googleapis.com/auth/gmail.send"] });
    const { state, nonce } = await startGoogle();
    const res = await googleCallback(callback({ code: "c", state }, nonce), deps({ google: () => sinModify }));
    expect(res.headers.get("location")).toBe(`${ORIGIN}/ventas/canales?error=permisos&canal=email`);
    expect((await accounts()).some((a) => a.lastError === "missing_scopes" && a.status === "disconnected")).toBe(true);
  }, HEAVY_MS);

  it("cancelar en Google vuelve con el aviso; sin estado no toca la base, con el estado de este navegador la pendiente dice «cancelaste»", async () => {
    const res = await googleCallback(callback({ error: "access_denied" }), deps());
    expect(res.headers.get("location")).toBe(`${ORIGIN}/ventas/canales?error=cancelada&canal=email`);
    const { state, nonce } = await startGoogle();
    const pendientes = async () => (await accounts()).filter((a) => a.channel === "email" && a.status === "pending").length;
    const antes = await pendientes();
    // Con el estado pero con la cookie de otro navegador: no se toca.
    await googleCallback(callback({ error: "access_denied", state }, "otro"), deps());
    expect(await pendientes()).toBe(antes);
    const ok = await googleCallback(callback({ error: "access_denied", state }, nonce), deps());
    expect(ok.headers.get("location")).toBe(`${ORIGIN}/ventas/canales?error=cancelada&canal=email`);
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
      expect(res.headers.get("location")).toBe(`${ORIGIN}/ventas/canales?error=no_configurado&canal=email`);
      const li = await unipileStart(post("/ventas/canales/conectar", { canal: "linkedin" }), deps({ env, unipile: null }));
      expect(li.headers.get("location")).toBe(`${ORIGIN}/ventas/canales?error=no_configurado&canal=linkedin`);
      // El navegador no ve ni una variable; el servidor sí las registra.
      expect(MESSAGES.banners.errors.no_configurado("LinkedIn")).not.toMatch(/[A-Z]{3,}_[A-Z]+/);
      const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toMatch(/GOOGLE_OUTREACH_CLIENT_ID, GOOGLE_OUTREACH_CLIENT_SECRET/);
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

/** Una copia del aviso sin una de sus llaves (sin desestructurar a una variable que nadie usa). */
function omit<T extends object, K extends keyof T>(o: T, key: K): Omit<T, K> {
  const copia = { ...o };
  delete copia[key];
  return copia;
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

    // Como la devuelve Unipile tras NUESTRA hosted auth: el `name` de la cuenta es el estado firmado que le mandamos.
    unipile.addAccount(normalizeUnipileAccount({
      object: "Account", type: "LINKEDIN", id: "acc_li_web", name: link.state, created_at: NOW.toISOString(),
      connection_params: { im: { id: "ACoAAB_laura_web", publicIdentifier: "laura-gomez", username: "Laura Gómez" } },
      sources: [{ id: "acc_li_web_MESSAGING", status: "OK" }],
    }));
    const notify = await unipileWebhook(webhook({ status: "CREATION_SUCCESS", account_id: "acc_li_web", name: link.state }), deps());
    expect(notify.status).toBe(200);
    const li = (await accounts()).find((a) => a.providerAccountId === "acc_li_web")!;
    expect(li).toMatchObject({ status: "connected", displayName: "Laura Gómez", channel: "linkedin" });
    // El nombre visible nunca es el estado: ni en la fila, ni en ninguna columna de texto de la base.
    expect(li.displayName!.startsWith(link.state.slice(0, 12))).toBe(false);
    const volcado = await dumpTextColumns({ query: (text, params) => db.queryAsSuperuser(text, params) });
    expect(findSecretInDump(volcado, [link.state]), "el estado firmado no queda en la base").toBeNull();
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
    expect(unipile.deletedAccounts, "un aviso repetido no borra la cuenta que ya está viva").not.toContain("acc_li_web");

    // Un DM de un amigo en un chat donde no hay ningún toque nuestro: se ignora y su cuerpo no queda en la base.
    const amigo = await unipileWebhook(webhook({ ...MESSAGE("acc_li_web", "msg_amigo_1"), chat_id: "chat_de_un_amigo", message: "¿Cenamos el viernes?" }, headers), deps());
    expect(await amigo.json()).toEqual({ ok: true, ignored: MESSAGES.routes.ignored.foreignChat });
    expect(await count(`SELECT count(*)::int AS n FROM outbound_message WHERE body LIKE '%Cenamos%'`)).toBe(0);

    // El toque que el despachador (VEN-10) mandó desde ESTA cuenta abre el hilo chat_web_0001.
    await db.queryAsSuperuser(
      `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, scheduled_for, claimed_at, sent_at, attempt_count,
                                   provider_message_id, thread_ref, channel_account_id)
       VALUES ($1, '00000002-0000-4000-8000-0000000000e7', '00000002-0000-4000-8000-0000000c0011', 'linkedin', 'Hola Marta', 'sent',
               now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour', 1, 'msg_nuestro_1', 'chat_web_0001', $2)`,
      [SEED_WORKSPACE_ID, li.id],
    );
    // El eco de nuestro propio DM en ese hilo, SIN account_info: lo reconoce porque escribe la persona de la cuenta
    // (provider_identity = connection_params.im.id). No entra como respuesta ni detiene el enrolamiento.
    const ENROLLMENT = "00000005-0000-4000-8000-0000000e0001";
    await db.queryAsSuperuser(`UPDATE outbound_touch SET enrollment_id = $1 WHERE thread_ref = 'chat_web_0001'`, [ENROLLMENT]);
    const sinAccountInfo = omit(MESSAGE("acc_li_web", "msg_eco_1"), "account_info");
    const eco = await unipileWebhook(webhook({
      ...sinAccountInfo, message: "Hola Marta", sender: { attendee_provider_id: "ACoAAB_laura_web", attendee_name: "Laura Gómez" },
    }, headers), deps());
    expect(await eco.json()).toEqual({ ok: true, ignored: MESSAGES.routes.ignored.echo });
    // Sin remitente no se sabe si es un eco: se descarta antes que arriesgar la cadencia.
    const sinSender = omit(sinAccountInfo, "sender");
    const anonimo = await unipileWebhook(webhook({ ...sinSender, message_id: "msg_sin_remitente_1" }, headers), deps());
    expect(await anonimo.json()).toEqual({ ok: true, ignored: MESSAGES.routes.ignored.noSender });
    expect(await count(`SELECT count(*)::int AS n FROM outbound_message WHERE provider_message_id IN ('msg_eco_1', 'msg_sin_remitente_1')`)).toBe(0);
    const enr = await db.queryAsSuperuser<{ status: string }>(`SELECT status FROM outbound_enrollment WHERE id = $1`, [ENROLLMENT]);
    expect(enr.rows[0]?.status, "el eco no detiene la cadencia").toBe("active");
    await db.queryAsSuperuser(`UPDATE outbound_touch SET enrollment_id = NULL WHERE thread_ref = 'chat_web_0001'`);

    // Una respuesta, con las cabeceras que Unipile manda porque las pusimos al crear el aviso.
    const msg = await unipileWebhook(webhook(MESSAGE("acc_li_web", "msg_web_1"), headers), deps());
    expect(await msg.json()).toEqual({ ok: true });
    const repetido = await unipileWebhook(webhook(MESSAGE("acc_li_web", "msg_web_1"), headers), deps());
    expect(await repetido.json()).toEqual({ ok: true, ignored: MESSAGES.routes.ignored.duplicate });
    const rows = await db.queryAsSuperuser<{ direction: string; intent: string | null; body: string }>(
      `SELECT direction, intent, body FROM outbound_message WHERE provider_message_id = 'msg_web_1'`,
    );
    expect(rows.rows).toEqual([{ direction: "inbound", intent: null, body: "¡Hola! Nos interesa, ¿tienes media kit?" }]);

    // La invitación con nota no abre chat: el despachador deja en recipient_address a quién la mandó (su provider_id).
    await db.queryAsSuperuser(
      `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, body, status, scheduled_for, claimed_at, sent_at, attempt_count,
                                   provider_message_id, recipient_address, channel_account_id)
       VALUES ($1, '00000002-0000-4000-8000-0000000000e6', '00000002-0000-4000-8000-0000000c0009', 'linkedin', 'Hola Laura', 'sent',
               now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', 1, 'inv_web_1', 'ACoAAB_laura_q_web', $2)`,
      [SEED_WORKSPACE_ID, li.id],
    );
    // Laura acepta y escribe en un chat nuevo: el aviso lleva quién escribe y casa con la invitación, con baja incluida.
    const aceptada = await unipileWebhook(webhook({
      ...MESSAGE("acc_li_web", "msg_web_inv_1"), chat_id: "chat_web_nuevo", message: "Gracias, pero no me escribas más.",
      sender: { attendee_provider_id: "ACoAAB_laura_q_web", attendee_name: "Laura Quintero" },
    }, headers), deps());
    expect(await aceptada.json()).toEqual({ ok: true });
    const baja = await db.queryAsSuperuser<{ opted_out: boolean; opted_out_code: string | null }>(
      `SELECT opted_out, opted_out_code FROM contact WHERE id = '00000002-0000-4000-8000-0000000c0009'`,
    );
    expect(baja.rows[0]).toEqual({ opted_out: true, opted_out_code: "reply_optout:linkedin" });

    // La ruta de ESTA cuenta no sirve para otra cuenta del cuerpo.
    const ajena = await unipileWebhook(webhook(MESSAGE("acc_li_0001", "msg_web_2"), headers), deps());
    expect(await ajena.json()).toEqual({ ok: true, ignored: MESSAGES.routes.ignored.unknownAccount });

    const caida = await unipileWebhook(webhook({ AccountStatus: { account_id: "acc_li_web", account_type: "LINKEDIN", message: "CREDENTIALS" } }, headers), deps());
    expect(caida.status).toBe(200);
    const caidaRow = (await accounts()).find((a) => a.id === li.id);
    expect(caidaRow?.status).toBe("needs_reconnect");
    // En la base, un código; la pantalla lo traduce. La campana lleva la frase, sin el código crudo.
    expect(caidaRow?.lastError).toBe("unipile_status:CREDENTIALS");
    expect(channelRows([caidaRow!], channelSetup(ENV))[1]!.reason).toBe(MESSAGES.health.unipileStatus("CREDENTIALS", "LinkedIn"));
    const aviso = await db.queryAsSuperuser<{ title_es: string; body_es: string }>(`SELECT title_es, body_es FROM notification WHERE entity_id = $1`, [li.id]);
    expect(aviso.rows).toHaveLength(1);
    expect(JSON.stringify(aviso.rows)).not.toMatch(/CREDENTIALS/);

    // Reconectar por el id de la fila: el account_id de Unipile sale de la base, no del formulario.
    const re = await unipileStart(post("/ventas/canales/conectar", { canal: "linkedin", reconectar: li.id }), deps());
    expect(re.status).toBe(303);
    const relink = unipile.hostedLinks.at(-1)!;
    expect(relink.reconnectAccountId).toBe("acc_li_web");
    // El estado de una reconexión solo liga ESA cuenta: con otra del tenant, aunque sea nueva, se ignora.
    unipile.addAccount({ id: "acc_li_otra_del_tenant", provider: "LINKEDIN", providerIdentity: "ACoAAB_otra" });
    const otra = await unipileWebhook(webhook({ status: "RECONNECTED", account_id: "acc_li_otra_del_tenant", name: relink.state }), deps());
    expect(await otra.json()).toEqual({ ok: true, ignored: MESSAGES.routes.ignored.notThisAttempt });
    expect((await accounts()).some((a) => a.providerAccountId === "acc_li_otra_del_tenant")).toBe(false);
    expect(unipile.deletedAccounts, "lo que no es de este intento no se toca").not.toContain("acc_li_otra_del_tenant");
    // Con la suya, sí: la fila vuelve a connected.
    const ok = await unipileWebhook(webhook({ status: "RECONNECTED", account_id: "acc_li_web", name: relink.state }), deps());
    expect(ok.status).toBe(200);
    expect((await accounts()).find((a) => a.id === li.id)?.status).toBe("connected");
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
      expect(res.headers.get("location"), reconectar).toBe(`${ORIGIN}/ventas/canales?error=vencida&canal=linkedin`);
    }
    expect(unipile.hostedLinks.length).toBe(antes);
    expect(await count(`SELECT count(*)::int AS n FROM outreach_channel_account`)).toBe(filas + 1);
  }, HEAVY_MS);

  it("si el alta de los avisos falla, la cuenta queda conectada con webhooks_missing y «Volver a intentar» los da de alta", async () => {
    await unipileStart(post("/ventas/canales/conectar", { canal: "instagram_dm" }), deps());
    const link = unipile.hostedLinks.at(-1)!;
    unipile.completeHostedAuth({ id: "acc_ig_sorda", provider: "INSTAGRAM", displayName: "laura.sorda" });
    unipile.failNext("createWebhook", "transient", "errors/service_unavailable", 503);
    const res = await unipileWebhook(webhook({ status: "CREATION_SUCCESS", account_id: "acc_ig_sorda", name: link.state }), deps());
    expect(res.status).toBe(200);
    const ig = (await accounts()).find((a) => a.providerAccountId === "acc_ig_sorda")!;
    expect([ig.status, ig.lastError]).toEqual(["connected", "webhooks_missing"]);
    const [view] = channelRows([ig], channelSetup(ENV)).filter((r) => r.channel === "instagram_dm");
    expect([view!.action, view!.reason]).toEqual(["rewebhook", MESSAGES.detail.webhooksMissing]);

    // «Volver a intentar»: sin pasar por la hosted auth.
    const enlaces = unipile.hostedLinks.length;
    expect(await retryAccountWebhooks(ig.id, ORIGIN, deps())).toBe("restored");
    expect(unipile.hostedLinks.length).toBe(enlaces);
    const again = (await accounts()).find((a) => a.id === ig.id)!;
    expect(again.lastError).toBeNull();
    const ids = await db.queryAsSuperuser<{ n: number }>(`SELECT cardinality(provider_webhook_ids)::int AS n FROM outreach_channel_account WHERE id = $1`, [ig.id]);
    expect(ids.rows[0]!.n).toBeGreaterThanOrEqual(2);
    // Una cuenta de otro espacio o inventada: nada.
    expect(await retryAccountWebhooks("00000009-0000-4000-8000-0000000ac0f9", ORIGIN, deps())).toBe("not_found");
  }, HEAVY_MS);

  it("una cuenta de Instagram donde se pidió LinkedIn no se conecta, y se borra en Unipile (no se queda cobrando)", async () => {
    await unipileStart(post("/ventas/canales/conectar", { canal: "linkedin" }), deps());
    const link = unipile.hostedLinks.at(-1)!;
    unipile.completeHostedAuth({ id: "acc_ig_web", provider: "INSTAGRAM" });
    const res = await unipileWebhook(webhook({ status: "CREATION_SUCCESS", account_id: "acc_ig_web", name: link.state }), deps());
    expect(await res.json()).toEqual({ ok: true, ignored: "wrong_provider" });
    expect((await accounts()).some((a) => a.lastError === "wrong_provider")).toBe(true);
    expect(unipile.deletedAccounts).toContain("acc_ig_web");
    // Con la bitácora: el borrado quedó en api_call_log (el doble no escribe, pero la llamada se registró en su lista).
    expect(unipile.calls.some((c) => c.method === "deleteAccount" && (c.args as { accountId: string }).accountId === "acc_ig_web")).toBe(true);
  }, HEAVY_MS);
});

describe("conectar LinkedIn o Instagram: lo que sale mal", () => {
  const texts = () => new Set<string>(Object.values(MESSAGES.banners.errors).flatMap((e) => (typeof e === "function" ? [e("Instagram"), e("LinkedIn")] : [e])));

  it("si Unipile no da el enlace, la fila dice una frase nuestra con el nombre del servicio, nunca el texto del proveedor", async () => {
    const spy = vi.spyOn(unipile, "createHostedAuthLink").mockRejectedValueOnce(new OutreachApiError({
      provider: "unipile", endpoint: "POST /hosted/accounts/link", httpStatus: 401, code: "errors/invalid_credentials", kind: "permanent",
      messageEs: "The provided API key is invalid",
    }));
    try {
      const res = await unipileStart(post("/ventas/canales/conectar", { canal: "instagram_dm" }), deps());
      expect(res.headers.get("location")).toBe(`${ORIGIN}/ventas/canales?error=proveedor&canal=instagram_dm`);
    } finally {
      spy.mockRestore();
    }
    // (Un Instagram vivo de una prueba anterior encabezaría la fila: se mira el intento más reciente, que no está vivo.)
    const intento = (await accounts()).filter((a) => a.channel === "instagram_dm" && !["connected", "needs_reconnect", "error"].includes(a.status))[0]!;
    expect([intento.status, intento.lastError]).toEqual(["disconnected", "provider_error"]);
    const rows = channelRows([intento], channelSetup(ENV));
    const ig = rows.find((r) => r.channel === "instagram_dm")!;
    expect(ig.state).toBe("disconnected");
    expect(ig.reason).toBe(MESSAGES.banners.errors.proveedor("Instagram"));
    expect(texts().has(ig.reason!), "el motivo está en MESSAGES").toBe(true);
    expect(JSON.stringify(await accounts())).not.toMatch(/API key|invalid/i);
    // Arriba no se repite lo que ya dice la fila.
    expect(channelBanner({ error: "proveedor", canal: "instagram_dm" }, rows).message).toBeNull();
  }, HEAVY_MS);

  it("un POST de inicio desde otra página (Origin ajeno o Sec-Fetch-Site de otro sitio) responde 403 sin tocar la base ni pedir enlace", async () => {
    const filas = await count(`SELECT count(*)::int AS n FROM outreach_channel_account`);
    const enlaces = unipile.hostedLinks.length;
    const from = (path: string, canal: string, headers: Record<string, string>) => new Request(`${ORIGIN}${path}`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ canal }).toString(),
    });
    const ajenos: Record<string, string>[] = [{ origin: "https://pagina-ajena.test" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site", origin: ORIGIN }, { origin: "null" }];
    for (const headers of ajenos) {
      const li = await unipileStart(from("/ventas/canales/conectar", "linkedin", headers), deps());
      expect([li.status, await li.text()], JSON.stringify(headers)).toEqual([403, MESSAGES.routes.crossOrigin]);
      const gm = await googleStart(from("/api/oauth/google", "email", headers), deps());
      expect([gm.status, await gm.text()], JSON.stringify(headers)).toEqual([403, MESSAGES.routes.crossOrigin]);
    }
    expect(unipile.hostedLinks.length).toBe(enlaces);
    expect(await count(`SELECT count(*)::int AS n FROM outreach_channel_account`)).toBe(filas);
    // Desde la propia pantalla (lo que manda el navegador con el botón), sí.
    const propio = await unipileStart(from("/ventas/canales/conectar", "linkedin", { origin: ORIGIN, "sec-fetch-site": "same-origin" }), deps());
    expect(propio.status).toBe(303);
    const google = await googleStart(from("/api/oauth/google", "email", { origin: ORIGIN, "sec-fetch-site": "same-origin" }), deps());
    expect(google.status).toBe(303);
  }, HEAVY_MS);

  it("producción sin APP_URL: «Conectar» vuelve a la pantalla con «no disponible» (no un 500) y no crea la pendiente", async () => {
    const filas = await count(`SELECT count(*)::int AS n FROM outreach_channel_account`);
    const enlaces = unipile.hostedLinks.length;
    const sinOrigen = deps({ origin: async () => { throw new OrigenNoConfiguradoError(); } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const from = (path: string, canal: string, headers: Record<string, string>) => new Request(`${ORIGIN}${path}`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ canal }).toString(),
      });
      const li = await unipileStart(from("/ventas/canales/conectar", "linkedin", { origin: ORIGIN, "sec-fetch-site": "same-origin" }), sinOrigen);
      expect([li.status, li.headers.get("location")]).toEqual([303, `${ORIGIN}/ventas/canales?error=no_configurado&canal=linkedin`]);
      const gm = await googleStart(from("/api/oauth/google", "email", { origin: ORIGIN }), sinOrigen);
      expect([gm.status, gm.headers.get("location")]).toEqual([303, `${ORIGIN}/ventas/canales?error=no_configurado&canal=email`]);
      // Un Origin ajeno sigue siendo 403, no un 500.
      const ajeno = await unipileStart(from("/ventas/canales/conectar", "linkedin", { origin: "https://pagina-ajena.test" }), sinOrigen);
      expect(ajeno.status).toBe(403);
      expect(warn).toHaveBeenCalledWith(MESSAGES.routes.originMissing);
    } finally {
      warn.mockRestore();
    }
    expect(unipile.hostedLinks.length).toBe(enlaces);
    expect(await count(`SELECT count(*)::int AS n FROM outreach_channel_account`)).toBe(filas);
  }, HEAVY_MS);

  it("un canal apagado en la política del espacio no pide enlace ni crea la pendiente, aunque el POST llegue a mano", async () => {
    await db.queryAsSuperuser(`UPDATE outbound_policy SET allowed_channels = '{email,linkedin}' WHERE workspace_id = $1`, [SEED_WORKSPACE_ID]);
    try {
      const filas = await count(`SELECT count(*)::int AS n FROM outreach_channel_account`);
      const enlaces = unipile.hostedLinks.length;
      const res = await unipileStart(post("/ventas/canales/conectar", { canal: "instagram_dm" }), deps());
      expect(res.headers.get("location")).toBe(`${ORIGIN}/ventas/canales?error=apagado&canal=instagram_dm`);
      expect(unipile.hostedLinks.length).toBe(enlaces);
      expect(await count(`SELECT count(*)::int AS n FROM outreach_channel_account`)).toBe(filas);
      // La fila lo dice sin ofrecer el botón.
      const policy = await withWorkspace((tx) => getChannelPolicyCaps(tx));
      expect(channelRows(await accounts(), channelSetup(ENV), { allowed: policy.allowedChannels }).find((r) => r.channel === "instagram_dm")?.off).toBe(true);
    } finally {
      await db.queryAsSuperuser(`UPDATE outbound_policy SET allowed_channels = '{email,linkedin,instagram_dm}' WHERE workspace_id = $1`, [SEED_WORKSPACE_ID]);
    }
  }, HEAVY_MS);

  it("un cuerpo que no es de formulario, o un canal inventado, responde 400 sin tocar la base (ni «no disponible», que sería falso)", async () => {
    const antes = await count(`SELECT count(*)::int AS n FROM outreach_channel_account`);
    const json = new Request(`${ORIGIN}/ventas/canales/conectar`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ canal: "linkedin" }) });
    const res = await unipileStart(json, deps());
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(MESSAGES.routes.badForm);
    const inventado = await unipileStart(post("/ventas/canales/conectar", { canal: "fax" }), deps());
    expect([inventado.status, await inventado.text()]).toEqual([400, MESSAGES.routes.badForm]);
    expect(await count(`SELECT count(*)::int AS n FROM outreach_channel_account`)).toBe(antes);
  }, HEAVY_MS);

  it("si la página de Unipile termina sin cuenta, la pendiente de ESE intento deja de decir «Conectando» y dice qué revisar", async () => {
    const start = await unipileStart(post("/ventas/canales/conectar", { canal: "linkedin" }), deps());
    expect(start.status).toBe(303);
    const link = unipile.hostedLinks.at(-1)!;
    // La vuelta de fallo lleva el nonce del intento y el canal, a nuestra ruta; no a «?error=proveedor».
    const failure = new URL(link.failureRedirectUrl);
    expect(`${failure.origin}${failure.pathname}`).toBe(`${ORIGIN}/ventas/canales/conectar`);
    expect(failure.searchParams.get("canal")).toBe("linkedin");
    const filas = async () => channelRows(await accounts(), channelSetup(ENV));
    const linkedin = async () => (await filas()).find((r) => r.channel === "linkedin")!;
    // (Una LinkedIn viva de una prueba anterior encabezaría la fila: se mira la pendiente de este intento.)
    const deEsteIntento = async () => (await accounts()).filter((a) => a.channel === "linkedin" && !["connected", "needs_reconnect", "error"].includes(a.status))[0]!;
    expect((await deEsteIntento()).status).toBe("pending");

    // Sin la cookie de ESTE navegador (un enlace con el nonce abierto en otro sitio), no se toca nada.
    const ajeno = await unipileFailure(new Request(failure), deps());
    expect(ajeno.headers.get("location")).toBe(`${ORIGIN}/ventas/canales?error=unipile_fallo&canal=linkedin`);
    expect((await deEsteIntento()).status, "un GET sin la cookie no cambia estado").toBe("pending");
    const cookie = new RegExp(`${UNIPILE_COOKIE}=([^;]*)`).exec(start.headers.get("set-cookie") ?? "")![1]!;
    expect(cookie).toBe(failure.searchParams.get("fallo"));
    const res = await unipileFailure(new Request(failure, { headers: { cookie: `${UNIPILE_COOKIE}=${cookie}` } }), deps());
    expect(res.headers.get("location")).toBe(`${ORIGIN}/ventas/canales?error=unipile_fallo&canal=linkedin`);
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    const fallida = await deEsteIntento();
    expect([fallida.status, fallida.lastError]).toEqual(["disconnected", "auth_failed"]);
    const sinVivas = channelRows([fallida], channelSetup(ENV)).find((r) => r.channel === "linkedin")!;
    expect(sinVivas.state).toBe("disconnected");
    expect(sinVivas.reason).toBe(MESSAGES.banners.errors.unipile_fallo("LinkedIn"));
    expect(channelBanner({ error: "unipile_fallo", canal: "linkedin" }, [sinVivas]).message, "la fila ya lo dice").toBeNull();
    expect((await linkedin()).state, "la fila nunca sigue «Conectando»").not.toBe("pending");
    // Otra vez la misma vuelta, o una con un nonce inventado o sin canal: no toca nada y vuelve con el aviso.
    const inventada = await unipileFailure(new Request(`${ORIGIN}/ventas/canales/conectar?fallo=${"z".repeat(64)}&canal=linkedin`), deps());
    expect(inventada.headers.get("location")).toBe(`${ORIGIN}/ventas/canales?error=unipile_fallo&canal=linkedin`);
    const sinCanal = await unipileFailure(new Request(`${ORIGIN}/ventas/canales/conectar?fallo=x`), deps());
    expect(sinCanal.headers.get("location")).toBe(`${ORIGIN}/ventas/canales?error=unipile_fallo`);
  }, HEAVY_MS);
});

it("channelKeys deriva de TOKEN_ENCRYPTION_KEY y sin ella es null", () => {
  expect(channelKeys(ENV)?.cipher).toBeInstanceOf(TokenCipher);
  expect(channelKeys({ ...ENV, TOKEN_ENCRYPTION_KEY_V2: randomBytes(32).toString("base64") })?.verify.route).toHaveLength(2);
  expect(channelKeys({})).toBeNull();
});

// ---------------------------------------------------------------------
// Ronda 5: un perfil es una cuenta, lo que no se liga se suelta, roles,
// rotación del secreto y la sesión que vuelve sola
// ---------------------------------------------------------------------

/** Conecta LinkedIn o Instagram de punta a punta y devuelve el estado del enlace. */
async function hostedAuth(channel: "linkedin" | "instagram_dm", d = deps()) {
  const res = await unipileStart(post("/ventas/canales/conectar", { canal: channel }), d);
  expect(res.status).toBe(303);
  return unipile.hostedLinks.at(-1)!;
}

const notify = (accountId: string, state: string, d = deps()) =>
  unipileWebhook(webhook({ status: "CREATION_SUCCESS", account_id: accountId, name: state }), d);

describe("un perfil es una cuenta (0042)", () => {
  it("el mismo perfil conectado otra vez en el espacio: la cuenta nueva se borra en Unipile y la fila dice por qué", async () => {
    const primero = await hostedAuth("instagram_dm");
    unipile.completeHostedAuth({ id: "acc_ig_perfil_1", provider: "INSTAGRAM", displayName: "laura.perfil", providerIdentity: "ig_perfil_laura" });
    expect(await (await notify("acc_ig_perfil_1", primero.state)).json()).toEqual({ ok: true });
    const segundo = await hostedAuth("instagram_dm");
    unipile.completeHostedAuth({ id: "acc_ig_perfil_2", provider: "INSTAGRAM", displayName: "laura.perfil", providerIdentity: "ig_perfil_laura" });
    expect(await (await notify("acc_ig_perfil_2", segundo.state)).json()).toEqual({ ok: true, ignored: "duplicate" });
    expect(unipile.deletedAccounts).toContain("acc_ig_perfil_2");
    expect(unipile.deletedAccounts).not.toContain("acc_ig_perfil_1");
    const filas = (await accounts()).filter((a) => a.channel === "instagram_dm");
    expect(filas.filter((a) => a.providerAccountId === "acc_ig_perfil_2")).toEqual([]);
    expect(filas.some((a) => a.status === "disconnected" && a.lastError === "duplicate")).toBe(true);
  }, HEAVY_MS);

  it("el mismo perfil vivo en OTRO espacio: taken, la frase de «ocupada» y la cuenta nueva borrada", async () => {
    const OTRO = "00000009-0000-4000-8000-00000000c0d1";
    await db.queryAsSuperuser(`INSERT INTO workspace (id, slug, name) VALUES ('${OTRO}', 'otro-perfil', 'Otro') ON CONFLICT DO NOTHING`);
    await db.queryAsSuperuser(`INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, provider_identity, status)
      VALUES ('${OTRO}', 'linkedin', 'unipile', 'acc_li_de_otro_espacio', 'ACoAAB_perfil_compartido', 'connected')`);
    const link = await hostedAuth("linkedin");
    unipile.completeHostedAuth({ id: "acc_li_perfil_nuevo", provider: "LINKEDIN", providerIdentity: "ACoAAB_perfil_compartido" });
    expect(await (await notify("acc_li_perfil_nuevo", link.state)).json()).toEqual({ ok: true, ignored: "taken" });
    expect(unipile.deletedAccounts).toContain("acc_li_perfil_nuevo");
    const intento = (await accounts()).find((a) => a.channel === "linkedin" && a.lastError === "taken")!;
    expect(channelRows([intento], channelSetup(ENV))[1]!.reason).toBe(MESSAGES.banners.errors.ocupada);
  }, HEAVY_MS);

  it("una cuenta que ya existía en el tenant no se liga a quien tenga un estado válido propio", async () => {
    const link = await hostedAuth("linkedin");
    unipile.addAccount({ id: "acc_li_vieja_del_tenant", provider: "LINKEDIN", createdAt: new Date(NOW.getTime() - 3 * 24 * 3600_000) });
    expect(await (await notify("acc_li_vieja_del_tenant", link.state)).json()).toEqual({ ok: true, ignored: MESSAGES.routes.ignored.notThisAttempt });
    expect((await accounts()).some((a) => a.providerAccountId === "acc_li_vieja_del_tenant")).toBe(false);
    expect(unipile.deletedAccounts, "no es nuestra: ni se liga ni se borra").not.toContain("acc_li_vieja_del_tenant");
  }, HEAVY_MS);

  it("una cuenta nacida después del estado pero de OTRO intento (name de otro nonce) no se liga", async () => {
    const link = await hostedAuth("linkedin");
    // Otro enlace del mismo tenant (otro cliente, u otro intento): su `name` es un estado nuestro, válido, con OTRO nonce.
    const otroIntento = signChannelState(
      { workspaceId: SEED_WORKSPACE_ID, creatorId: SEED_WORKSPACE_ID, channel: "linkedin", nonce: randomBytes(32).toString("hex") }, channelKeys(ENV)!.sign.state, NOW,
    );
    unipile.addAccount({ id: "acc_li_de_otro_intento", provider: "LINKEDIN", providerIdentity: "ACoAAB_otro_intento", hostedAuthName: otroIntento });
    // Y una sin `name` (creada fuera de la hosted auth, por ejemplo con credenciales).
    unipile.addAccount({ id: "acc_li_sin_name", provider: "LINKEDIN", providerIdentity: "ACoAAB_sin_name" });
    for (const id of ["acc_li_de_otro_intento", "acc_li_sin_name"]) {
      expect(await (await notify(id, link.state)).json(), id).toEqual({ ok: true, ignored: MESSAGES.routes.ignored.notThisAttempt });
      expect((await accounts()).some((a) => a.providerAccountId === id)).toBe(false);
      expect(unipile.deletedAccounts, "no es de este intento: ni se liga ni se borra").not.toContain(id);
    }
    // La pendiente sigue esperando a la suya: la de ESTE enlace sí se liga.
    unipile.completeHostedAuth({ id: "acc_li_de_este_intento", provider: "LINKEDIN", providerIdentity: "ACoAAB_este_intento" }, link);
    expect(await (await notify("acc_li_de_este_intento", link.state)).json()).toEqual({ ok: true });
    expect((await accounts()).find((a) => a.providerAccountId === "acc_li_de_este_intento")?.status).toBe("connected");
  }, HEAVY_MS);

  it("un doble «Conectar»: la cuenta del primer enlace llega con el nonce ya reemplazado, nadie la usa y se borra", async () => {
    const primero = await hostedAuth("instagram_dm");
    await hostedAuth("instagram_dm");
    unipile.completeHostedAuth({ id: "acc_ig_doble_clic", provider: "INSTAGRAM", providerIdentity: "ig_doble" }, primero);
    expect(await (await notify("acc_ig_doble_clic", primero.state)).json()).toEqual({ ok: true, ignored: "unknown_state" });
    expect(unipile.deletedAccounts).toContain("acc_ig_doble_clic");
  }, HEAVY_MS);

  it("Unipile pide y borra con el presupuesto interactivo (ocho segundos, un reintento)", async () => {
    const spy = vi.spyOn(unipile, "createHostedAuthLink");
    await hostedAuth("linkedin");
    expect(spy.mock.calls.at(-1)![1]).toMatchObject(INTERACTIVE_BUDGET);
    spy.mockRestore();
  }, HEAVY_MS);
});

describe("la sesión vuelve sola y el secreto se rota", () => {
  it("un aviso OK de una cuenta caída la devuelve a connected, con su aviso de éxito en la campana", async () => {
    const link = await hostedAuth("linkedin");
    unipile.completeHostedAuth({ id: "acc_li_vuelve", provider: "LINKEDIN", displayName: "Laura Vuelve", providerIdentity: "ACoAAB_vuelve" });
    await notify("acc_li_vuelve", link.state);
    const li = (await accounts()).find((a) => a.providerAccountId === "acc_li_vuelve")!;
    const headers = unipile.webhooks.find((w) => w.accountId === "acc_li_vuelve")!.headers;
    const status = (message: string) => webhook({ AccountStatus: { account_id: "acc_li_vuelve", account_type: "LINKEDIN", message } }, headers);
    await unipileWebhook(status("CREDENTIALS"), deps());
    expect((await accounts()).find((a) => a.id === li.id)?.status).toBe("needs_reconnect");
    expect(await (await unipileWebhook(status("OK"), deps())).json()).toEqual({ ok: true });
    const vuelta = (await accounts()).find((a) => a.id === li.id)!;
    expect([vuelta.status, vuelta.lastError]).toEqual(["connected", null]);
    const avisos = await db.queryAsSuperuser<{ severity: string; title_es: string }>(`SELECT severity, title_es FROM notification WHERE entity_id = $1 ORDER BY created_at`, [li.id]);
    expect(avisos.rows.map((r) => r.severity)).toEqual(["critical", "success"]);
    expect(avisos.rows[1]!.title_es).toBe(MESSAGES.health.back.title("LinkedIn", "Laura Vuelve"));
    // Otra vez OK: ya estaba bien, no avisa.
    expect(await (await unipileWebhook(status("OK"), deps())).json()).toEqual({ ok: true, ignored: MESSAGES.routes.ignored.healthy });
  }, HEAVY_MS);

  it("durante una rotación se aceptan el secreto actual y el anterior; sin la rotación, el viejo es 401", async () => {
    const link = await hostedAuth("linkedin");
    unipile.completeHostedAuth({ id: "acc_li_rotacion", provider: "LINKEDIN", providerIdentity: "ACoAAB_rotacion" });
    await notify("acc_li_rotacion", link.state);
    const route = unipile.webhooks.find((w) => w.accountId === "acc_li_rotacion")!.headers[UNIPILE_ROUTE_HEADER]!;
    const body = { AccountStatus: { account_id: "acc_li_rotacion", account_type: "LINKEDIN", message: "OK" } };
    const rotando = { ...ENV, UNIPILE_WEBHOOK_SECRET: "SECRETO-NUEVO-DE-PRUEBA-456", UNIPILE_WEBHOOK_SECRET_PREVIOUS: SECRET };
    expect((await unipileWebhook(webhook(body, { [UNIPILE_SECRET_HEADER]: SECRET, [UNIPILE_ROUTE_HEADER]: route }), deps({ env: rotando }))).status).toBe(200);
    expect((await unipileWebhook(webhook(body, { [UNIPILE_SECRET_HEADER]: "SECRETO-NUEVO-DE-PRUEBA-456", [UNIPILE_ROUTE_HEADER]: route }), deps({ env: rotando }))).status).toBe(200);
    const terminada = { ...ENV, UNIPILE_WEBHOOK_SECRET: "SECRETO-NUEVO-DE-PRUEBA-456" };
    expect((await unipileWebhook(webhook(body, { [UNIPILE_SECRET_HEADER]: SECRET, [UNIPILE_ROUTE_HEADER]: route }), deps({ env: terminada }))).status).toBe(401);
    // Los avisos que da de alta la web llevan la huella del secreto actual: el keepalive sabe cuáles renovar.
    const fp = await db.queryAsSuperuser<{ fp: string }>(`SELECT provider_webhook_secret_fp AS fp FROM outreach_channel_account WHERE provider_account_id = 'acc_li_rotacion'`);
    expect(fp.rows[0]!.fp).toMatch(/^[0-9a-f]{16}$/);
  }, HEAVY_MS);
});

describe("Gmail: la concesión que no se guarda se revoca, salvo que otro espacio la use", () => {
  it("ocupada en otro espacio: NO se revoca (tumbaría la concesión de ese espacio)", async () => {
    const OTRO = "00000009-0000-4000-8000-00000000c0e1";
    await db.queryAsSuperuser(`INSERT INTO workspace (id, slug, name) VALUES ('${OTRO}', 'otro-gmail', 'Otro') ON CONFLICT DO NOTHING`);
    await db.queryAsSuperuser(`INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, status)
      VALUES ('${OTRO}', 'email', 'gmail_oauth', 'ocupado@gmail.test', 'connected')`);
    const ocupado = new FakeGmail({ now: () => NOW, email: "ocupado@gmail.test" });
    const { state, nonce } = await startGoogle();
    const res = await googleCallback(callback({ code: "c", state }, nonce), deps({ google: () => ocupado }));
    expect(res.headers.get("location")).toBe(`${ORIGIN}/ventas/canales?error=ocupada&canal=email`);
    expect(ocupado.revokeCalls).toEqual([]);
  }, HEAVY_MS);

  it("la pendiente ya reemplazada (doble clic) con un buzón que nadie usa: la concesión nueva se revoca", async () => {
    const huerfano = new FakeGmail({ now: () => NOW, email: "huerfano@gmail.test" });
    const primero = await startGoogle();
    await startGoogle();
    const res = await googleCallback(callback({ code: "c", state: primero.state }, primero.nonce), deps({ google: () => huerfano }));
    expect(res.headers.get("location")).toBe(`${ORIGIN}/ventas/canales?error=vencida&canal=email`);
    expect(huerfano.revokeCalls).toHaveLength(1);
  }, HEAVY_MS);

  it("reconectar propone el buzón caído (login_hint); «Conectar otra cuenta» pide elegir (select_account)", async () => {
    const [gmailRow] = (await accounts()).filter((a) => a.channel === "email" && a.status === "connected");
    const re = await googleStart(post("/api/oauth/google", { reconectar: gmailRow!.id }), deps());
    expect(new URL(re.headers.get("location")!).searchParams.get("login_hint")).toBe(gmailRow!.providerAccountId);
    const otra = await googleStart(post("/api/oauth/google", { otra: "1" }), deps());
    const u = new URL(otra.headers.get("location")!);
    expect([u.searchParams.get("prompt"), u.searchParams.get("login_hint")]).toEqual(["select_account consent", null]);
    // Una fila ajena o inventada no da pista ninguna.
    const ajena = await googleStart(post("/api/oauth/google", { reconectar: "00000009-0000-4000-8000-000000000000" }), deps());
    expect(new URL(ajena.headers.get("location")!).searchParams.get("login_hint")).toBeNull();
  }, HEAVY_MS);
});

describe("solo quien administra el espacio gestiona los canales", () => {
  const viewer = () => deps({ canManage: async () => false });
  const actionDeps = (canManage: boolean) => ({
    canManage: async () => canManage, withWorkspace, format: async () => formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
  });

  it("un 'viewer' no empieza ninguna conexión: 403 y ninguna fila", async () => {
    const antes = await count(`SELECT count(*)::int AS n FROM outreach_channel_account`);
    const g = await googleStart(post("/api/oauth/google"), viewer());
    const u = await unipileStart(post("/ventas/canales/conectar", { canal: "linkedin" }), viewer());
    expect([g.status, u.status]).toEqual([403, 403]);
    expect(await g.text()).toBe(MESSAGES.routes.forbidden);
    expect(await count(`SELECT count(*)::int AS n FROM outreach_channel_account`)).toBe(antes);
  }, HEAVY_MS);

  it("un 'viewer' no cambia topes, no desconecta y no reactiva avisos; quien administra, sí", async () => {
    const [li] = (await accounts()).filter((a) => a.channel === "linkedin" && a.status === "connected");
    const form = (fields: Record<string, string>) => {
      const f = new FormData();
      for (const [k, v] of Object.entries(fields)) f.set(k, v);
      return f;
    };
    expect(await saveCaps(actionDeps(false), form({ accountId: li!.id, dailyCap: "3", weeklyCap: "" }))).toEqual({ message: MESSAGES.detail.readOnly });
    expect(await disconnect(actionDeps(false), form({ accountId: li!.id }))).toEqual({ message: MESSAGES.detail.readOnly });
    expect(await retryAccountWebhooks(li!.id, ORIGIN, viewer())).toBe("forbidden");
    const sigue = (await accounts()).find((a) => a.id === li!.id)!;
    expect([sigue.status, sigue.dailyCap]).toEqual(["connected", null]);
    // Con el rol, sí.
    expect(await saveCaps(actionDeps(true), form({ accountId: li!.id, dailyCap: "3", weeklyCap: "" }))).toMatchObject({ notice: MESSAGES.caps.saved });
    expect((await accounts()).find((a) => a.id === li!.id)!.dailyCap).toBe(3);
  }, HEAVY_MS);
});
