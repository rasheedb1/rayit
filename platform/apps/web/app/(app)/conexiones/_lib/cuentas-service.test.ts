// @vitest-environment node
/**
 * CON-10 · el servicio de cuentas por @ contra Postgres embebido con el seed
 * y fuentes sobre fixtures: agregar deja la fila, el consentimiento con la
 * declaración y el snapshot del día; actualizar el mismo día no duplica el snapshot;
 * TikTok se agrega sin métricas; errores en español; sin credenciales en
 * ninguna tabla.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dumpTextColumns, findSecretInDump, FixtureFetch, loadFixtures, withoutNetwork, type NetworkGuard } from "@mc/connectors";
import { listConsents, type WorkspaceTx } from "@mc/db";
import { createEmbeddedDb, type EmbeddedDb } from "@mc/db/embedded";
import { SEED_WORKSPACE_ID } from "@/lib/workspace/current";
import { createCuentasService, OWNERSHIP_DECLARATION_ES, type CuentasService } from "./cuentas-service";

const NOW = new Date("2026-09-22T15:00:00Z");
const ENV = { INSTAGRAM_HOUSE_TOKEN: "IGAA-house-web-SECRETO", GOOGLE_API_KEY: "AIza-web-key-SECRETO" };
const WHO = { ip: "203.0.113.7", userAgent: "vitest" };

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
}, 60_000);

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
    expect(ev.rows[0]!.evidence).toMatchObject({ declaredOwner: true, handle: "cafealma", platformId: "instagram", ip: "203.0.113.7", userAgent: "vitest", textShown: OWNERSHIP_DECLARATION_ES });
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
    expect(upd).toMatchObject({ ok: true, withMetrics: true });
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
