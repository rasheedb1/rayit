// @vitest-environment node
/**
 * CON-3 · PRUEBA CLAVE (R4). Los handlers de OAuth como funciones, con un
 * Request y un fetch de fixtures, contra Postgres embebido con las
 * migraciones reales y el seed 0003: tras un callback completo, la fila
 * queda con sus scopes y NINGUNA columna de texto, jsonb, arreglo o bytea
 * de NINGUNA tabla (recorriendo pg_catalog) contiene el access token, el
 * refresh token, el code ni el client secret.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dumpTextColumns, EncryptedSecretStore, findSecretInDump, FixtureFetch, keyringFromEnv, loadFixtures, TokenCipher, withoutNetwork, type NetworkGuard,
} from "@mc/connectors";
import { listConnections, listConsents, type WorkspaceTx } from "@mc/db";
import { createEmbeddedDb, type EmbeddedDb } from "@mc/db/provisional/embedded";
import { createOAuthHandlers, OAUTH_COOKIE, type OAuthHandlers } from "./oauth-handlers";
import { CONSENT_POLICY_VERSION } from "./consent";
import { SEED_WORKSPACE_ID } from "@/lib/db/workspace";

const NOW = new Date("2026-09-22T10:00:00Z");
const ORIGIN = "http://localhost:3000";
const ENV = {
  NODE_ENV: "test",
  APP_URL: ORIGIN,
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  TIKTOK_LOGIN_CLIENT_KEY: "tt-client-key",
  TIKTOK_LOGIN_CLIENT_SECRET: "TT-CLIENT-SECRET-SECRETO",
  META_APP_ID: "meta-app-id",
  META_APP_SECRET: "META-APP-SECRET-SECRETO",
};
const CODE_TT = "CODE-TIKTOK-SECRETO-1234567890";
const CODE_IG = "CODE-INSTAGRAM-SECRETO-0987654321";
/** Lo que los fixtures devuelven y que no puede aparecer en ninguna tabla ni salir en una URL nuestra. */
const SECRETS = [
  ENV.TIKTOK_LOGIN_CLIENT_SECRET, ENV.META_APP_SECRET, CODE_TT, CODE_IG,
  "act.demo-access-tiktok-0001-SECRETO", "rft.demo-refresh-tiktok-0001-SECRETO",
  "IGQVJ-short-demo-0001-SECRETO", "IGAA-long-demo-0001-SECRETO",
];

let db: EmbeddedDb;
let guard: NetworkGuard;
let fetch: FixtureFetch;
let handlers: OAuthHandlers;
let clock = NOW;

const withWorkspace = <T,>(fn: (tx: WorkspaceTx) => Promise<T>) => db.withWorkspace(SEED_WORKSPACE_ID, fn);

beforeAll(async () => {
  guard = withoutNetwork();
  db = await createEmbeddedDb({ seeds: true });
  fetch = new FixtureFetch([
    ...(await loadFixtures("tiktok", [["oauth.token", "code.ok"], ["user.info", "ok"]])),
    ...(await loadFixtures("instagram", [["oauth.access_token", "ok"], ["oauth.long_lived", "ok"], ["me", "ok"]])),
  ]);
  handlers = createOAuthHandlers({ env: ENV, withWorkspace, fetch: fetch.fetch, now: () => clock });
}, 60_000);

afterAll(async () => {
  await db.close();
  guard.restore();
});

function startRequest(provider: string, body: Record<string, string>): Request {
  return new Request(`${ORIGIN}/conexiones/oauth/${provider}/start`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
}

function cookieOf(res: Response): string {
  const set = res.headers.get("set-cookie") ?? "";
  const m = new RegExp(`${OAUTH_COOKIE}=([^;]*)`).exec(set);
  expect(m, "Set-Cookie con la cookie del flujo").toBeTruthy();
  return m![1]!;
}

async function start(provider: string) {
  const res = await handlers.start(startRequest(provider, { acepto: "on", policy_version: CONSENT_POLICY_VERSION }), provider);
  expect(res.status).toBe(303);
  const location = new URL(res.headers.get("location")!);
  const state = location.searchParams.get("state")!;
  return { res, location, state, cookie: cookieOf(res) };
}

function callbackRequest(provider: string, query: Record<string, string>, cookie?: string): Request {
  const u = new URL(`${ORIGIN}/conexiones/oauth/${provider}/callback`);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return new Request(u, { headers: { ...(cookie ? { cookie: `${OAUTH_COOKIE}=${cookie}` } : {}), "x-forwarded-for": "203.0.113.7, 10.0.0.1", "user-agent": "vitest" } });
}

async function countConnections(): Promise<number> {
  const r = await db.queryAsSuperuser<{ n: number }>("SELECT count(*)::int AS n FROM social_connection");
  return Number(r.rows[0]!.n);
}

describe("start", () => {
  it("sin consentimiento vuelve a /conexiones?error=consentimiento; por GET responde 405", async () => {
    const res = await handlers.start(startRequest("tiktok", { policy_version: CONSENT_POLICY_VERSION }), "tiktok");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/conexiones?error=consentimiento`);
    const get = await handlers.start(new Request(`${ORIGIN}/conexiones/oauth/tiktok/start`), "tiktok");
    expect(get.status).toBe(405);
    expect(await get.text()).toMatch(/Conectar/);
  });

  it("con consentimiento: 303 a TikTok con state, y cookie httpOnly, SameSite=Lax, 10 minutos, sin nada secreto", async () => {
    const { res, location, state, cookie } = await start("tiktok");
    expect(location.origin + location.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(location.searchParams.get("client_key")).toBe("tt-client-key");
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/conexiones/oauth/tiktok/callback`);
    expect(state).toHaveLength(43);
    const set = res.headers.get("set-cookie")!;
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/);
    expect(set).toMatch(/Max-Age=600/);
    expect(set).toMatch(/Path=\/conexiones\/oauth/);
    expect(set).not.toMatch(/Secure/); // fuera de producción
    expect(cookie).not.toContain(ENV.TIKTOK_LOGIN_CLIENT_SECRET);
    expect(cookie).not.toContain(ENV.TOKEN_ENCRYPTION_KEY);
  });

  it("una red sin app configurada responde 503 nombrando las variables", async () => {
    const res = await handlers.start(startRequest("tiktok-business", { acepto: "on", policy_version: CONSENT_POLICY_VERSION }), "tiktok-business");
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/TIKTOK_BUSINESS_APP_ID/);
  });
});

describe("callback: lo que NO toca la base", () => {
  it("el creador canceló → /conexiones?error=cancelada y la cookie se borra", async () => {
    const before = await countConnections();
    const { cookie } = await start("instagram");
    const res = await handlers.callback(callbackRequest("instagram", { error: "access_denied", error_reason: "user_denied", error_description: "The user denied your request." }, cookie), "instagram");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/conexiones?error=cancelada`);
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect(await countConnections()).toBe(before);
  });

  it("sin cookie, con state distinto, con cookie manipulada o vencida → 400 en español, sin llamadas ni filas", async () => {
    const before = await countConnections();
    const calls = fetch.calls.length;
    const { cookie, state } = await start("tiktok");
    const noCookie = await handlers.callback(callbackRequest("tiktok", { code: CODE_TT, state }), "tiktok");
    expect(noCookie.status).toBe(400);
    expect(await noCookie.text()).toMatch(/Vuelve a \/conexiones/);
    const badState = await handlers.callback(callbackRequest("tiktok", { code: CODE_TT, state: "otro-estado" }, cookie), "tiktok");
    expect(badState.status).toBe(400);
    const otherProvider = await handlers.callback(callbackRequest("instagram", { code: CODE_TT, state }, cookie), "instagram");
    expect(otherProvider.status).toBe(400);
    const tampered = await handlers.callback(callbackRequest("tiktok", { code: CODE_TT, state }, cookie.slice(0, -3) + "AAA"), "tiktok");
    expect(tampered.status).toBe(400);
    clock = new Date(NOW.getTime() + 10 * 60_000 + 1);
    const expired = await handlers.callback(callbackRequest("tiktok", { code: CODE_TT, state }, cookie), "tiktok");
    expect(expired.status).toBe(400);
    expect(await expired.text()).toMatch(/venció/);
    clock = NOW;
    expect(fetch.calls.length).toBe(calls);
    expect(await countConnections()).toBe(before);
  });
});

describe("callback completo (la prueba del «terminado cuando»)", () => {
  let tiktokId: string;

  it("TikTok: code → tokens → identidad → fila activa con scopes, consentimiento, api_call_log; redirige a ?conectada=<id>", async () => {
    const { cookie, state } = await start("tiktok");
    const res = await handlers.callback(callbackRequest("tiktok", { code: CODE_TT, state, scopes: "user.info.basic,user.info.profile,user.info.stats,video.list" }, cookie), "tiktok");
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/conexiones");
    tiktokId = location.searchParams.get("conectada")!;
    expect(tiktokId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    for (const s of SECRETS) expect(location.toString()).not.toContain(s);

    const rows = await withWorkspace((tx) => listConnections(tx));
    const row = rows.find((r) => r.id === tiktokId)!;
    expect(row).toBeTruthy();
    expect(row.platformId).toBe("tiktok");
    expect(row.externalAccountId).toBe("open_id_demo_laura");
    expect(row.handle).toBe("laura.cocinafacil");
    expect(row.status).toBe("active");
    expect(row.scopes).toEqual(["user.info.basic", "user.info.profile", "user.info.stats", "video.list"]);
    expect(row.accessExpiresAt).toBe("2026-09-23T10:00:00.000Z");
    expect(row.secretRef).toMatch(/^enc:tiktok:[0-9a-f-]{36}$/);
    expect(row.connectedAt).toBe(NOW.toISOString());

    // El seed traía esa misma cuenta (open_id_demo_laura) con ref vault://…: se reconectó, no se duplicó.
    expect(rows.filter((r) => r.platformId === "tiktok").length).toBe(1);

    const consents = await withWorkspace((tx) => listConsents(tx, tiktokId));
    const active = consents.filter((c) => c.revokedAt === null);
    expect(active.map((c) => c.purpose)).toEqual(["analytics"]);
    expect(active[0]!.policyVersion).toBe(CONSENT_POLICY_VERSION);
    const evidence = await db.queryAsSuperuser<{ evidence: Record<string, unknown> }>("SELECT evidence FROM data_consent WHERE id = $1", [active[0]!.id]);
    expect(evidence.rows[0]!.evidence).toMatchObject({ ip: "203.0.113.7", userAgent: "vitest", policyVersion: CONSENT_POLICY_VERSION, scopesGranted: row.scopes, at: NOW.toISOString() });
    expect(String(evidence.rows[0]!.evidence["textShown"])).toMatch(/TikTok/);

    const log = await db.queryAsSuperuser<{ endpoint: string; ok: boolean; connection_id: string | null }>("SELECT endpoint, ok, connection_id FROM api_call_log ORDER BY id");
    expect(log.rows.map((r) => r.endpoint)).toEqual(["oauth.token", "tiktok.user.info"]);
    expect(log.rows.every((r) => r.ok && r.connection_id === tiktokId)).toBe(true);

    // El almacén descifra con la clave del entorno dentro del workspace…
    const cipher = new TokenCipher(keyringFromEnv(ENV));
    const tokens = await withWorkspace((tx) => new EncryptedSecretStore({ db: tx, cipher }).get(row.secretRef));
    expect(tokens?.accessToken).toBe("act.demo-access-tiktok-0001-SECRETO");
    expect(tokens?.refreshToken).toBe("rft.demo-refresh-tiktok-0001-SECRETO");
    // …y otro workspace no ve la fila.
    const ajeno = await db.withWorkspace("00000009-0000-4000-8000-000000000001", async (tx) => new EncryptedSecretStore({ db: tx, cipher }).get(row.secretRef)).catch((e: Error) => e);
    expect(ajeno === null || ajeno instanceof Error).toBe(true);
  });

  it("Instagram: el id viene de `me` (el del token no cabe en un número); dos finalidades por el scope de insights", async () => {
    const { cookie, state } = await start("instagram");
    const res = await handlers.callback(callbackRequest("instagram", { code: CODE_IG, state }, cookie), "instagram");
    expect(res.status).toBe(303);
    const id = new URL(res.headers.get("location")!).searchParams.get("conectada")!;
    const row = (await withWorkspace((tx) => listConnections(tx))).find((r) => r.id === id)!;
    expect(row.platformId).toBe("instagram");
    expect(row.externalAccountId).toBe("17841400000000123");
    expect(row.scopes).toEqual(["instagram_business_basic", "instagram_business_manage_insights"]);
    expect(row.secretRef).toMatch(/^enc:instagram:/);
    expect(new Date(row.accessExpiresAt!).getTime() - NOW.getTime()).toBe(5_183_944_000);
    const active = (await withWorkspace((tx) => listConsents(tx, id))).filter((c) => c.revokedAt === null).map((c) => c.purpose).sort();
    expect(active).toEqual(["analytics", "audience_demographics"]);
  });

  it("reconectar TikTok reutiliza la misma fila y la misma ref: una sola fila en connection_secret", async () => {
    const { cookie, state } = await start("tiktok");
    const res = await handlers.callback(callbackRequest("tiktok", { code: CODE_TT, state }, cookie), "tiktok");
    expect(new URL(res.headers.get("location")!).searchParams.get("conectada")).toBe(tiktokId);
    const refs = await db.queryAsSuperuser<{ secret_ref: string }>("SELECT secret_ref FROM connection_secret WHERE secret_ref LIKE 'enc:tiktok:%'");
    expect(refs.rows.length).toBe(1);
  });

  it("una fila con ref de otro proveedor (Login Kit) no presta su ref: la Accounts API tendría la suya", async () => {
    const refs = await db.queryAsSuperuser<{ secret_ref: string }>("SELECT secret_ref FROM social_connection WHERE id = $1", [tiktokId]);
    expect(refs.rows[0]!.secret_ref.startsWith("enc:tiktok:")).toBe(true);
    expect(refs.rows[0]!.secret_ref.startsWith("enc:tiktok-business:")).toBe(false);
  });

  it("R4: ninguna columna de texto, jsonb, arreglo o bytea de ninguna tabla contiene un token, el code ni el client secret", async () => {
    const dump = await dumpTextColumns({ query: (text, params) => db.queryAsSuperuser(text, params) });
    expect(dump.length).toBeGreaterThan(100);
    expect(dump.some((d) => d.table === "connection_secret" && d.column === "ciphertext")).toBe(true);
    expect(dump.some((d) => d.table === "data_consent" && d.column === "evidence")).toBe(true);
    expect(findSecretInDump(dump, SECRETS)).toBeNull();
    // Y el fetch de pruebas tampoco grabó nada en claro.
    const recorded = JSON.stringify(fetch.calls);
    for (const s of SECRETS) expect(recorded).not.toContain(s);
    expect(guard.attempts).toBe(0);
  });
});
