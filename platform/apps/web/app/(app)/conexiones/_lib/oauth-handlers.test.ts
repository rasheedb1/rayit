// @vitest-environment node
/**
 * CON-3 · PRUEBA CLAVE (R4). Los handlers de OAuth como funciones, con un
 * Request y un fetch de fixtures, contra Postgres embebido con las
 * migraciones reales y el seed 0003: tras un callback completo, la fila
 * queda con sus scopes y NINGUNA columna de texto, jsonb, arreglo o bytea
 * de NINGUNA tabla (recorriendo pg_catalog) contiene el access token, el
 * refresh token, el code ni el client secret.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  dumpTextColumns, EncryptedSecretStore, findSecretInDump, FixtureFetch, keyringFromEnv, loadFixtures, TokenCipher, withoutNetwork, type NetworkGuard,
} from "@mc/connectors";
import { listConnections, listConsents, type WorkspaceTx } from "@mc/db";
import { createEmbeddedDb, type EmbeddedDb } from "@mc/db/embedded";
import { createOAuthHandlers, OAUTH_COOKIE, type OAuthHandlers } from "./oauth-handlers";
import { CONSENT_POLICY_VERSION } from "./consent";
import { SEED_WORKSPACE_ID } from "@/lib/workspace/current";

const NOW = new Date("2026-09-22T10:00:00Z");
const ORIGIN = "http://localhost:3000";
// El volcado de R4 recorre todas las tablas del embebido: con la máquina cargada pasa de los 5 s por defecto.
vi.setConfig({ testTimeout: 120_000 });
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

const CREATOR_LAURA = "00000002-0000-4000-8000-000000000003";
const USER_LAURA = "00000002-0000-4000-8000-000000000002";
/** Andrés Pardo, el mánager de la demo (seed 0003): membership 'admin'. */
const USER_MANAGER = "00000002-0000-4000-8000-000000000004";
const ROLE_MANAGER_CONECTA = "00000009-0000-4000-8000-00000000ac81";
const USER_EDITOR = "00000009-0000-4000-8000-0000000000c2";

let db: EmbeddedDb;
let guard: NetworkGuard;
let fetch: FixtureFetch;
let handlers: OAuthHandlers;
let clock = NOW;

const withWorkspace = <T,>(fn: (tx: WorkspaceTx) => Promise<T>) => db.withWorkspace(SEED_WORKSPACE_ID, fn);
/** Los mismos handlers con la sesión de una persona (app.user_id fijado, como lib/db desde CIM-3). */
function handlersAs(userId: string): OAuthHandlers {
  return createOAuthHandlers({ env: ENV, withWorkspace: (fn) => db.withWorkspace(SEED_WORKSPACE_ID, fn, { userId }), fetch: fetch.fetch, now: () => clock });
}

beforeAll(async () => {
  guard = withoutNetwork();
  db = await createEmbeddedDb({ seeds: true });
  fetch = new FixtureFetch([
    ...(await loadFixtures("tiktok", [["oauth.token", "code.ok"], ["user.info", "ok"]])),
    ...(await loadFixtures("instagram", [["oauth.access_token", "ok"], ["oauth.long_lived", "ok"], ["me", "ok"]])),
  ]);
  handlers = createOAuthHandlers({ env: ENV, withWorkspace, fetch: fetch.fetch, now: () => clock });
  await db.execAsSuperuser(`
    INSERT INTO app_user (id, email, name) VALUES ('${USER_EDITOR}', 'edita@ejemplo.com', 'Edita Ruiz') ON CONFLICT DO NOTHING;
    INSERT INTO membership (workspace_id, user_id, role_id) VALUES ('${SEED_WORKSPACE_ID}', '${USER_EDITOR}', system_role_id('creator', 'editor')) ON CONFLICT DO NOTHING;
    -- «El mánager con la casilla de ACC-4» (ACC-4 aún no existe): un rol a medida del workspace con los permisos del
    -- Mánager de fábrica más conectar y desconectar. Andrés (seed 0003) es 'manager' de fábrica y pasa a este rol.
    INSERT INTO role (id, workspace_id, key, workspace_kind, label_es, is_system)
    VALUES ('${ROLE_MANAGER_CONECTA}', '${SEED_WORKSPACE_ID}', 'manager_conecta', 'creator', 'Mánager (también conecta mis cuentas)', false) ON CONFLICT DO NOTHING;
    INSERT INTO role_permission (role_id, permission_key)
      SELECT '${ROLE_MANAGER_CONECTA}', permission_key FROM role_permission WHERE role_id = system_role_id('creator', 'manager')
      UNION VALUES ('${ROLE_MANAGER_CONECTA}'::uuid, 'conexiones.cuenta.conectar'), ('${ROLE_MANAGER_CONECTA}'::uuid, 'conexiones.cuenta.desconectar')
    ON CONFLICT DO NOTHING;
    UPDATE membership SET role_id = '${ROLE_MANAGER_CONECTA}' WHERE workspace_id = '${SEED_WORKSPACE_ID}' AND user_id = '${USER_MANAGER}';
  `);
}, 300_000); // Postgres embebido con las migraciones y los seeds: con la máquina cargada pasa del minuto.

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

async function start(provider: string, h: OAuthHandlers = handlers) {
  const res = await h.start(startRequest(provider, { acepto: "on", policy_version: CONSENT_POLICY_VERSION }), provider);
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
    expect(evidence.rows[0]!.evidence).toMatchObject({
      v: 2, method: "oauth", declaredOwner: false, ipHash: createHash("sha256").update("203.0.113.7").digest("hex"), userAgent: "vitest",
      policyVersion: CONSENT_POLICY_VERSION, scopesGranted: row.scopes, at: NOW.toISOString(), onBehalfOf: { creatorId: CREATOR_LAURA },
    });
    expect(evidence.rows[0]!.evidence).not.toHaveProperty("ip");
    expect(evidence.rows[0]!.evidence).not.toHaveProperty("actedBy");
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

  it("híbrido: una cuenta agregada por @ se convierte en autorizada conservando id e historial", async () => {
    // Fila por @ con el handle que devolverá userInfo (laura.cocinafacil) y un snapshot previo.
    const created = await db.queryAsSuperuser<{ id: string }>(
      `INSERT INTO social_connection (workspace_id, creator_id, platform_id, external_account_id, handle, secret_ref, scopes, access_mode)
       VALUES ($1, '00000002-0000-4000-8000-000000000003', 'tiktok', 'laura.cocinafacil', 'laura.cocinafacil', 'public:tiktok:laura.cocinafacil', '{}', 'public_profile') RETURNING id`,
      [SEED_WORKSPACE_ID],
    );
    const publicId = created.rows[0]!.id;
    await db.queryAsSuperuser(`INSERT INTO account_metric_snapshot (connection_id, workspace_id, day, followers, source) VALUES ($1, $2, '2026-09-21', 412000, 'public_profile')`, [publicId, SEED_WORKSPACE_ID]);
    // La autorización anterior de la misma cuenta (open_id_demo_laura, tiktokId) queda desactivada para no chocar con el UNIQUE.
    const { cookie, state } = await start("tiktok");
    const res = await handlers.callback(callbackRequest("tiktok", { code: CODE_TT, state }, cookie), "tiktok");
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).searchParams.get("conectada")).toBe(publicId);
    const row = (await withWorkspace((tx) => listConnections(tx))).find((r) => r.id === publicId)!;
    expect(row.externalAccountId).toBe("open_id_demo_laura");
    expect(row.secretRef).toMatch(/^enc:tiktok:/);
    expect(row.scopes.length).toBeGreaterThan(0);
    const mode = await db.queryAsSuperuser<{ access_mode: string; n: number }>("SELECT access_mode, (SELECT count(*)::int FROM account_metric_snapshot WHERE connection_id = $1) AS n FROM social_connection WHERE id = $1", [publicId]);
    expect(mode.rows[0]).toEqual({ access_mode: "direct_oauth", n: 1 });
    const old = await db.queryAsSuperuser<{ status: string; deleted_at: string | null }>("SELECT status, deleted_at FROM social_connection WHERE id = $1", [tiktokId]);
    expect(old.rows[0]!.status).toBe("disabled");
    expect(old.rows[0]!.deleted_at).not.toBeNull();
    tiktokId = publicId;
  });

  it("una fila con ref de otro proveedor (Login Kit) no presta su ref: la Accounts API tendría la suya", async () => {
    const refs = await db.queryAsSuperuser<{ secret_ref: string }>("SELECT secret_ref FROM social_connection WHERE id = $1", [tiktokId]);
    expect(refs.rows[0]!.secret_ref.startsWith("enc:tiktok:")).toBe(true);
    expect(refs.rows[0]!.secret_ref.startsWith("enc:tiktok-business:")).toBe(false);
  });

  it("R4: ninguna columna de texto, jsonb, arreglo o bytea de ninguna tabla contiene un token, el code ni el client secret", async () => {
    const dump = await dumpTextColumns({ query: (text, params) => db.queryAsSuperuser(text, params) });
    expect(findSecretInDump(dump, ["203.0.113.7"]), "la IP no va en claro en ninguna evidencia").toBeNull();
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

describe("consentimiento delegado (ACC-8): el callback de CON-3 deja la misma evidencia", () => {
  it("el mánager autoriza el Instagram de la creadora: consentimiento a nombre de ella con él como operador, aviso a ella, bitácora con él", async () => {
    const manager = handlersAs(USER_MANAGER);
    const { cookie, state } = await start("instagram", manager);
    const res = await manager.callback(callbackRequest("instagram", { code: CODE_IG, state }, cookie), "instagram");
    expect(res.status).toBe(303);
    const id = new URL(res.headers.get("location")!).searchParams.get("conectada")!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const active = (await withWorkspace((tx) => listConsents(tx, id))).filter((c) => c.revokedAt === null);
    expect(active.length).toBe(2);
    for (const c of active) {
      const ev = await db.queryAsSuperuser<{ creator_id: string; evidence: Record<string, unknown> }>("SELECT creator_id, evidence FROM data_consent WHERE id = $1", [c.id]);
      expect(ev.rows[0]!.creator_id).toBe(CREATOR_LAURA);
      expect(ev.rows[0]!.evidence).toMatchObject({ v: 2, method: "oauth", onBehalfOf: { creatorId: CREATOR_LAURA }, actedBy: { userId: USER_MANAGER, email: "andres@ejemplo.com", roleKey: "manager_conecta" } });
    }
    const notice = await db.queryAsSuperuser<{ user_id: string; body_es: string }>("SELECT user_id, body_es FROM notification WHERE kind = 'connection_added' AND entity_id = $1", [id]);
    expect(notice.rows.length).toBe(1);
    expect(notice.rows[0]!.user_id).toBe(USER_LAURA);
    expect(notice.rows[0]!.body_es).toMatch(/^Andrés Pardo conectó la cuenta @laura\.cocinafacil de Instagram el .+ en tu nombre\./);
    const audit = await db.queryAsSuperuser<{ actor_user_id: string; after: Record<string, unknown> }>("SELECT actor_user_id, after FROM audit_log WHERE action IN ('connection.added', 'connection.reconnected', 'connection.authorized') AND entity_id = $1 ORDER BY id DESC LIMIT 1", [id]);
    expect(audit.rows[0]!.actor_user_id).toBe(USER_MANAGER);
    expect(audit.rows[0]!.after).toMatchObject({ accessMode: "direct_oauth", onBehalfOf: { creatorId: CREATOR_LAURA }, actedBy: { userId: USER_MANAGER, roleKey: "manager_conecta" } });
    expect(JSON.stringify(audit.rows[0]!.after)).not.toContain("@ejemplo.com");
    const row = (await withWorkspace((tx) => listConnections(tx))).find((r) => r.id === id)!;
    expect(row.secretRef).toMatch(/^enc:instagram:/);
    for (const s of SECRETS) expect(JSON.stringify(notice.rows) + JSON.stringify(audit.rows)).not.toContain(s);
  });

  it("un editor sin conexiones.cuenta.conectar no llega a la plataforma, y con una cookie ajena el callback tampoco escribe", async () => {
    const editor = handlersAs(USER_EDITOR);
    const before = await countConnections();
    const calls = fetch.calls.length;
    const denied = await editor.start(startRequest("tiktok", { acepto: "on", policy_version: CONSENT_POLICY_VERSION }), "tiktok");
    expect(denied.status).toBe(303);
    expect(denied.headers.get("location")).toBe(`${ORIGIN}/conexiones?error=sin_permiso`);
    expect(denied.headers.get("set-cookie")).toBeNull();
    // Con el inicio de otra sesión (la cookie del mánager) el callback comprueba el permiso antes de guardar nada.
    const { cookie, state } = await start("tiktok", handlersAs(USER_MANAGER));
    const res = await editor.callback(callbackRequest("tiktok", { code: CODE_TT, state }, cookie), "tiktok");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/conexiones?error=sin_permiso`);
    expect(await countConnections()).toBe(before);
    expect(fetch.calls.length, "sin permiso no se canjea el code: ningún token que luego habría que tirar").toBe(calls);
    const consents = await db.queryAsSuperuser<{ n: number }>("SELECT count(*)::int AS n FROM data_consent WHERE evidence->'actedBy'->>'userId' = $1", [USER_EDITOR]);
    expect(Number(consents.rows[0]!.n)).toBe(0);
  });
});

describe("alcance (ACC-6): un miembro acotado no se queda con la cuenta de otra creadora", () => {
  it("con alcance por marca no hay creador en su alcance: el arranque vuelve con ?error=fuera_de_alcance y no va a la plataforma", async () => {
    const MARCA = "0000000a-0000-4000-8000-0000000000f4";
    await db.execAsSuperuser(`
      INSERT INTO app_user (id, email) VALUES ('${MARCA}', 'marca.oauth@ejemplo.com') ON CONFLICT DO NOTHING;
      INSERT INTO membership (workspace_id, user_id, role_id) VALUES ('${SEED_WORKSPACE_ID}', '${MARCA}', '${ROLE_MANAGER_CONECTA}') ON CONFLICT DO NOTHING;
      INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id)
      SELECT '${SEED_WORKSPACE_ID}', '${MARCA}', 'company', company_id FROM company_link WHERE workspace_id = '${SEED_WORKSPACE_ID}' LIMIT 1
      ON CONFLICT DO NOTHING;
    `);
    const calls = fetch.calls.length;
    const res = await handlersAs(MARCA).start(startRequest("tiktok", { acepto: "on", policy_version: CONSENT_POLICY_VERSION }), "tiktok");
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("fuera_de_alcance");
    expect(fetch.calls.length, "no se habló con la plataforma").toBe(calls);
  });

  const MIEMBRO = "0000000a-0000-4000-8000-0000000000f2";
  const SOFIA = "0000000a-0000-4000-8000-0000000000f3";

  it("la cuenta de TikTok ya es de Sofía y el miembro (que sí puede conectar) solo tiene alcance a Laura: ?error=fuera_de_alcance y la fila no cambia", async () => {
    await db.execAsSuperuser(`
      INSERT INTO app_user (id, email) VALUES ('${MIEMBRO}', 'miembro.oauth@ejemplo.com') ON CONFLICT DO NOTHING;
      INSERT INTO membership (workspace_id, user_id, role_id) VALUES ('${SEED_WORKSPACE_ID}', '${MIEMBRO}', '${ROLE_MANAGER_CONECTA}') ON CONFLICT DO NOTHING;
      INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id) VALUES ('${SEED_WORKSPACE_ID}', '${MIEMBRO}', 'creator', '${CREATOR_LAURA}') ON CONFLICT DO NOTHING;
      INSERT INTO creator_profile (id, workspace_id, display_name) VALUES ('${SOFIA}', '${SEED_WORKSPACE_ID}', 'Sofía') ON CONFLICT DO NOTHING;
    `);
    // La autorización viva de open_id_demo_laura pasa a ser de Sofía (una agencia que reparte cuentas).
    await db.queryAsSuperuser(`UPDATE social_connection SET creator_id = $1 WHERE external_account_id = 'open_id_demo_laura'`, [SOFIA]);
    const antes = await db.queryAsSuperuser<{ creator_id: string; secret_ref: string }>(
      "SELECT creator_id, secret_ref FROM social_connection WHERE external_account_id = 'open_id_demo_laura'",
    );
    expect(antes.rows).toHaveLength(1);

    try {
      const acotado = handlersAs(MIEMBRO);
      const s = await acotado.start(startRequest("tiktok", { acepto: "on", policy_version: CONSENT_POLICY_VERSION }), "tiktok");
      const state = new URL(s.headers.get("location")!).searchParams.get("state")!;
      const res = await acotado.callback(callbackRequest("tiktok", { code: CODE_TT, state }, cookieOf(s)), "tiktok");
      expect(res.status).toBe(303);
      expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("fuera_de_alcance");

      const despues = await db.queryAsSuperuser<{ creator_id: string; secret_ref: string }>(
        "SELECT creator_id, secret_ref FROM social_connection WHERE external_account_id = 'open_id_demo_laura'",
      );
      expect(despues.rows).toEqual(antes.rows);
    } finally {
      await db.queryAsSuperuser(`UPDATE social_connection SET creator_id = $1 WHERE external_account_id = 'open_id_demo_laura'`, [CREATOR_LAURA]);
    }
  });
});
