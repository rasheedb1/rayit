// @vitest-environment node
/**
 * CON-10 · el servicio de cuentas por @ contra Postgres embebido con el seed
 * y fuentes sobre fixtures: agregar deja la fila, el consentimiento con la
 * declaración y el snapshot del día; actualizar el mismo día no duplica el snapshot;
 * TikTok se agrega sin métricas; errores en español; sin credenciales en
 * ninguna tabla.
 *
 * ACC-8 · consentimiento delegado: el mánager agrega la cuenta del creador
 * → consentimiento a nombre del creador con el mánager en actedBy, aviso
 * al creador, bitácora con el mánager; el propio creador → sin actedBy y
 * sin aviso; un editor sin permiso → falla antes de leer o escribir nada;
 * ningún token en la evidencia ni en el aviso.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dumpTextColumns, findSecretInDump, FixtureFetch, loadFixtures, withoutNetwork, type NetworkGuard } from "@mc/connectors";
import { listConsents, type WorkspaceTx } from "@mc/db";
import { createEmbeddedDb, type EmbeddedDb } from "@mc/db/embedded";
import { SEED_WORKSPACE_ID } from "@/lib/workspace/current";
import { createCuentasService, OWNERSHIP_DECLARATION_ES, type CuentasService } from "./cuentas-service";
import { SinPermisoError } from "./permisos";

const NOW = new Date("2026-09-22T15:00:00Z");
const ENV = { INSTAGRAM_HOUSE_TOKEN: "IGAA-house-web-SECRETO", GOOGLE_API_KEY: "AIza-web-key-SECRETO" };
const WHO = { ip: "203.0.113.7", userAgent: "vitest" };
const IP_HASH = createHash("sha256").update(WHO.ip).digest("hex");
// Cada prueba abre transacciones sobre Postgres embebido y el volcado de R4 recorre todas las tablas: con la máquina cargada pasan de los 5 s por defecto.
vi.setConfig({ testTimeout: 120_000 });
const CREATOR_LAURA = "00000002-0000-4000-8000-000000000003";
const USER_LAURA = "00000002-0000-4000-8000-000000000002";
/** Andrés Pardo, el mánager de la demo (seed 0003): membership 'admin'. */
const USER_MANAGER = "00000002-0000-4000-8000-000000000004";
const ROLE_MANAGER_CONECTA = "00000009-0000-4000-8000-00000000ac81";
const USER_EDITOR = "00000009-0000-4000-8000-0000000000b2";

let db: EmbeddedDb;
let guard: NetworkGuard;
let fetch: FixtureFetch;
let service: CuentasService;
const withWorkspace = <T,>(fn: (tx: WorkspaceTx) => Promise<T>) => db.withWorkspace(SEED_WORKSPACE_ID, fn);

beforeAll(async () => {
  guard = withoutNetwork();
  db = await createEmbeddedDb({ seeds: true });
  fetch = new FixtureFetch([
    ...(await loadFixtures("instagram", [["business_discovery", "ok"]])),
    ...(await loadFixtures("youtube", [["channels.list", "handle.ok"]])),
    ...(await loadFixtures("tiktok", [["oembed.profile", "ok"], ["oembed.profile", "not_found"]])),
  ]);
  service = createCuentasService({ env: ENV, withWorkspace, fetch: fetch.fetch, now: () => NOW });
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

/** El mismo servicio con la sesión de una persona: withWorkspace fija app.user_id como lo hace lib/db con CIM-3. */
function serviceAs(userId: string): CuentasService {
  return createCuentasService({ env: ENV, withWorkspace: (fn) => db.withWorkspace(SEED_WORKSPACE_ID, fn, { userId }), fetch: fetch.fetch, now: () => NOW });
}

afterAll(async () => {
  await db.close();
  guard.restore();
});

describe("agregar", () => {
  it("Instagram por @: fila public_profile, consentimiento con la declaración y snapshot del día", async () => {
    const out = await service.agregar({ platformId: "instagram", handle: "@cafealma" }, WHO);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.created).toBe(true);
    const row = (await service.listar()).find((r) => r.id === out.id)!;
    expect(row.accessMode).toBe("public_profile");
    expect(row.handle).toBe("cafealma");
    expect(row.externalAccountId).toBe("17841400000000e01");
    expect(row.secretRef).toBe("public:instagram:cafealma");
    expect(row.latest).toEqual({ day: "2026-09-22", followers: 267793, following: null, mediaCount: 1205, views: null });
    expect(row.status).toBe("active");
    const consents = await withWorkspace((tx) => listConsents(tx, out.id));
    expect(consents.filter((c) => c.revokedAt === null).map((c) => c.purpose)).toEqual(["analytics"]);
    const ev = await db.queryAsSuperuser<{ evidence: Record<string, unknown> }>("SELECT evidence FROM data_consent WHERE id = $1", [consents[0]!.id]);
    expect(ev.rows[0]!.evidence).toMatchObject({ v: 2, method: "public_handle", declaredOwner: true, handle: "cafealma", platformId: "instagram", ipHash: IP_HASH, userAgent: "vitest", textShown: OWNERSHIP_DECLARATION_ES, onBehalfOf: { creatorId: CREATOR_LAURA } });
    expect(ev.rows[0]!.evidence).not.toHaveProperty("ip");
    expect(ev.rows[0]!.evidence).not.toHaveProperty("actedBy");
    // Modo demo, sin sesión: no hay a quién avisar ni a quién nombrar.
    expect(out.aviso).toBe("sin_sesion");
    const log = await db.queryAsSuperuser<{ endpoint: string; connection_id: string | null }>("SELECT endpoint, connection_id FROM api_call_log ORDER BY id");
    expect(log.rows.at(-1)).toEqual({ endpoint: "instagram.business_discovery", connection_id: out.id });
  });

  it("TikTok por @: se agrega sin métricas y lo dice; un @ inexistente o mal escrito devuelve el mensaje en español", async () => {
    const out = await service.agregar({ platformId: "tiktok", handle: "https://www.tiktok.com/@laura.cocinafacil" }, WHO);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.profile.metrics).toBeNull();
    const row = (await service.listar()).find((r) => r.id === out.id)!;
    expect(row.latest).toBeNull();
    expect(row.displayName).toBe("Laura · Cocina fácil");
    // El seed ya traía esa cuenta de TikTok (open_id distinto): son filas distintas por id externo.
    const nf = await service.agregar({ platformId: "tiktok", handle: "noexiste.zz9" }, WHO);
    expect(nf).toMatchObject({ ok: false, code: "not_found" });
    expect((nf as { message: string }).message).toMatch(/No encontramos @noexiste.zz9/);
    const bad = await service.agregar({ platformId: "instagram", handle: "esto no es un usuario!" }, WHO);
    expect(bad).toMatchObject({ ok: false, code: "invalid_handle" });
    const red = await service.agregar({ platformId: "facebook", handle: "x" }, WHO);
    expect(red).toMatchObject({ ok: false, code: "plataforma" });
  });

  it("YouTube por @ con API key; sin la key el mensaje nombra la variable", async () => {
    const out = await service.agregar({ platformId: "youtube", handle: "@NutriveOficial" }, WHO);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const row = (await service.listar()).find((r) => r.id === out.id)!;
    expect(row.latest?.followers).toBe(38400);
    expect(row.latest?.views).not.toBeNull();
    const sinKey = createCuentasService({ env: { INSTAGRAM_HOUSE_TOKEN: "x" }, withWorkspace, fetch: fetch.fetch, now: () => NOW });
    const res = await sinKey.agregar({ platformId: "youtube", handle: "@NutriveOficial" }, WHO);
    expect(res).toMatchObject({ ok: false, code: "not_configured" });
    expect((res as { message: string }).message).toMatch(/GOOGLE_API_KEY/);
    expect(sinKey.availability().find((a) => a.platformId === "youtube")!.missing).toEqual(["GOOGLE_API_KEY"]);
  });
});

describe("actualizar y quitar", () => {
  it("actualizar el mismo día no duplica el snapshot; volver a agregar no duplica; quitar conserva la historia", async () => {
    const rows = await service.listar();
    const ig = rows.find((r) => r.handle === "cafealma")!;
    const upd = await service.actualizar(ig.id);
    // Ya había lectura de hoy (la del alta): no se guarda otra y la pantalla lo dice.
    expect(upd).toMatchObject({ ok: true, withMetrics: true, alreadyReadToday: true });
    const n = await db.queryAsSuperuser<{ n: number }>("SELECT count(*)::int AS n FROM account_metric_snapshot WHERE connection_id = $1", [ig.id]);
    expect(Number(n.rows[0]!.n)).toBe(1);
    const again = await service.agregar({ platformId: "instagram", handle: "cafealma" }, WHO);
    expect(again).toMatchObject({ ok: true, created: false, id: ig.id });
    const tt = rows.find((r) => r.handle === "laura.cocinafacil" && r.accessMode === "public_profile")!;
    const updTt = await service.actualizar(tt.id);
    expect(updTt).toMatchObject({ ok: true, withMetrics: false });
    await service.quitar(ig.id);
    expect((await service.listar()).some((r) => r.id === ig.id)).toBe(false);
    const hist = await db.queryAsSuperuser<{ n: number }>("SELECT count(*)::int AS n FROM account_metric_snapshot WHERE connection_id = $1", [ig.id]);
    expect(Number(hist.rows[0]!.n)).toBe(1);
    expect(await service.actualizar(ig.id)).toMatchObject({ ok: false, code: "no_existe" });
  });

  it("R4: ni el token casa ni la API key aparecen en ninguna tabla ni en las llamadas grabadas", async () => {
    const dump = await dumpTextColumns({ query: (text, params) => db.queryAsSuperuser(text, params) });
    expect(findSecretInDump(dump, [ENV.INSTAGRAM_HOUSE_TOKEN, ENV.GOOGLE_API_KEY])).toBeNull();
    expect(JSON.stringify(fetch.calls)).not.toContain("SECRETO");
    expect(guard.attempts).toBe(0);
  });
});

describe("consentimiento delegado (ACC-8)", () => {
  it("el mánager agrega el Instagram del creador: consentimiento a nombre del creador con el mánager como operador, aviso al creador, bitácora con el mánager", async () => {
    const manager = serviceAs(USER_MANAGER);
    const out = await manager.agregar({ platformId: "instagram", handle: "@cafealma" }, WHO);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.aviso).toBe("enviado");
    const consents = await withWorkspace((tx) => listConsents(tx, out.id));
    const active = consents.filter((c) => c.revokedAt === null);
    expect(active.map((c) => c.purpose)).toEqual(["analytics"]);
    const ev = await db.queryAsSuperuser<{ creator_id: string; evidence: Record<string, unknown> }>("SELECT creator_id, evidence FROM data_consent WHERE id = $1", [active[0]!.id]);
    expect(ev.rows[0]!.creator_id).toBe(CREATOR_LAURA);
    expect(ev.rows[0]!.evidence).toMatchObject({
      v: 2, declaredOwner: true, onBehalfOf: { creatorId: CREATOR_LAURA },
      actedBy: { userId: USER_MANAGER, email: "andres@ejemplo.com", roleKey: "manager_conecta" },
    });
    const notice = await db.queryAsSuperuser<{ user_id: string; kind: string; title_es: string; body_es: string; action_url: string; entity_id: string }>(
      "SELECT user_id, kind, title_es, body_es, action_url, entity_id FROM notification WHERE kind = 'connection_added' AND entity_id = $1", [out.id],
    );
    expect(notice.rows.length).toBe(1);
    expect(notice.rows[0]).toMatchObject({ user_id: USER_LAURA, kind: "connection_added", title_es: "Una cuenta se conectó en tu nombre", action_url: "/conexiones", entity_id: out.id });
    expect(notice.rows[0]!.body_es).toMatch(/^Andrés Pardo conectó la cuenta @cafealma de Instagram el .+ en tu nombre\./);
    // La última fila de alta de esa cuenta: las pruebas de arriba ya la agregaron y la quitaron en modo demo, así que ahora es una reconexión (ACC-2).
    const audit = await db.queryAsSuperuser<{ action: string; actor_user_id: string; after: Record<string, unknown> }>("SELECT action, actor_user_id, after FROM audit_log WHERE action IN ('connection.added', 'connection.reconnected') AND entity_id = $1 ORDER BY id DESC LIMIT 1", [out.id]);
    expect(audit.rows[0]!.action).toBe("connection.reconnected");
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0]!.actor_user_id).toBe(USER_MANAGER);
    expect(audit.rows[0]!.after).toMatchObject({ onBehalfOf: { creatorId: CREATOR_LAURA }, actedBy: { userId: USER_MANAGER, roleKey: "manager_conecta" } });
    expect(JSON.stringify(audit.rows[0]!.after)).not.toContain("@ejemplo.com");
    // La lista lo dice.
    const row = (await manager.listar()).find((r) => r.id === out.id)!;
    expect(row.connectedBy).toMatchObject({ userId: USER_MANAGER, name: "Andrés Pardo", email: "andres@ejemplo.com" });
    // Volver a agregarla no duplica el aviso mientras el creador no lo lea.
    const again = await manager.agregar({ platformId: "instagram", handle: "cafealma" }, WHO);
    expect(again).toMatchObject({ ok: true, id: out.id, aviso: "ya_habia" });
    expect(Number((await db.queryAsSuperuser<{ n: number }>("SELECT count(*)::int AS n FROM notification WHERE kind = 'connection_added' AND entity_id = $1", [out.id])).rows[0]!.n)).toBe(1);
  });

  it("el propio creador agrega su cuenta: sin actedBy, sin aviso, la bitácora lo nombra a él", async () => {
    const laura = serviceAs(USER_LAURA);
    const out = await laura.agregar({ platformId: "youtube", handle: "@NutriveOficial" }, WHO);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.aviso).toBe("titular_actua");
    const active = (await withWorkspace((tx) => listConsents(tx, out.id))).filter((c) => c.revokedAt === null);
    const ev = await db.queryAsSuperuser<{ evidence: Record<string, unknown> }>("SELECT evidence FROM data_consent WHERE id = $1", [active[0]!.id]);
    expect(ev.rows[0]!.evidence).toMatchObject({ v: 2, onBehalfOf: { creatorId: CREATOR_LAURA } });
    expect(ev.rows[0]!.evidence).not.toHaveProperty("actedBy");
    expect((await db.queryAsSuperuser("SELECT 1 FROM notification WHERE kind = 'connection_added' AND entity_id = $1", [out.id])).rows.length).toBe(0);
    const audit = await db.queryAsSuperuser<{ actor_user_id: string; after: Record<string, unknown> }>("SELECT actor_user_id, after FROM audit_log WHERE action IN ('connection.added', 'connection.reconnected') AND entity_id = $1 ORDER BY id DESC", [out.id]);
    expect(audit.rows[0]!.actor_user_id).toBe(USER_LAURA);
    expect(audit.rows[0]!.after).not.toHaveProperty("actedBy");
    expect((await laura.listar()).find((r) => r.id === out.id)!.connectedBy).toBeNull();
  });

  it("un editor sin el permiso no agrega ni quita: falla antes de llamar a la plataforma y sin escribir nada", async () => {
    const editor = serviceAs(USER_EDITOR);
    const calls = fetch.calls.length;
    const before = await db.queryAsSuperuser<{ n: number }>("SELECT (SELECT count(*) FROM social_connection) + (SELECT count(*) FROM data_consent) + (SELECT count(*) FROM notification) + (SELECT count(*) FROM audit_log) + (SELECT count(*) FROM api_call_log) AS n");
    const out = await editor.agregar({ platformId: "instagram", handle: "@cafealma" }, WHO);
    expect(out).toMatchObject({ ok: false, code: "sin_permiso" });
    expect((out as { message: string }).message).toMatch(/No tienes permiso para conectar cuentas/);
    expect(fetch.calls.length).toBe(calls);
    const ig = (await editor.listar()).find((r) => r.handle === "cafealma")!;
    expect(ig, "sí puede VER la lista").toBeTruthy();
    await expect(editor.quitar(ig.id)).rejects.toBeInstanceOf(SinPermisoError);
    const after = await db.queryAsSuperuser<{ n: number }>("SELECT (SELECT count(*) FROM social_connection) + (SELECT count(*) FROM data_consent) + (SELECT count(*) FROM notification) + (SELECT count(*) FROM audit_log) + (SELECT count(*) FROM api_call_log) AS n");
    expect(Number(after.rows[0]!.n)).toBe(Number(before.rows[0]!.n));
    expect(ig.status).toBe("active");
  });

  it("el mánager quita la cuenta: la revocación queda en la evidencia con él como operador y en la bitácora", async () => {
    const manager = serviceAs(USER_MANAGER);
    const ig = (await manager.listar()).find((r) => r.handle === "cafealma")!;
    await manager.quitar(ig.id);
    const ev = await db.queryAsSuperuser<{ evidence: Record<string, unknown>; revoked_at: string | null }>("SELECT evidence, revoked_at FROM data_consent WHERE connection_id = $1 ORDER BY granted_at DESC LIMIT 1", [ig.id]);
    expect(ev.rows[0]!.revoked_at).not.toBeNull();
    expect(ev.rows[0]!.evidence["revocation"]).toMatchObject({ v: 2, at: NOW.toISOString(), onBehalfOf: { creatorId: CREATOR_LAURA }, actedBy: { userId: USER_MANAGER, roleKey: "manager_conecta" } });
    expect(ev.rows[0]!.evidence["actedBy"], "el otorgamiento no se toca").toMatchObject({ userId: USER_MANAGER });
    const audit = await db.queryAsSuperuser<{ actor_user_id: string | null; after: Record<string, unknown> }>("SELECT actor_user_id, after FROM audit_log WHERE action = 'connection.disconnected' AND entity_id = $1 ORDER BY id DESC", [ig.id]);
    expect(audit.rows.length, "la de arriba en modo demo (sin actor) y esta").toBe(2);
    expect(audit.rows[1]!.actor_user_id).toBeNull();
    expect(audit.rows[0]!.actor_user_id).toBe(USER_MANAGER);
    expect(audit.rows[0]!.after).toMatchObject({ status: "disabled", onBehalfOf: { creatorId: CREATOR_LAURA }, actedBy: { userId: USER_MANAGER, roleKey: "manager_conecta" } });
  });

  it("R4: ni el token casa ni la API key ni una IP en claro aparecen en ninguna evidencia ni en ningún aviso", async () => {
    const dump = await dumpTextColumns({ query: (text, params) => db.queryAsSuperuser(text, params) });
    expect(findSecretInDump(dump, [ENV.INSTAGRAM_HOUSE_TOKEN, ENV.GOOGLE_API_KEY, WHO.ip])).toBeNull();
    const evidences = dump.find((d) => d.table === "data_consent" && d.column === "evidence")!;
    expect(evidences.text).toContain("actedBy");
    const notices = dump.find((d) => d.table === "notification" && d.column === "body_es")!;
    expect(notices.text).toContain("en tu nombre");
    expect(guard.attempts).toBe(0);
  });
});
