// @vitest-environment node
/**
 * CAM-3 · «Actualizar ahora» contra Postgres embebido con el seed y fuentes
 * sobre fixtures: deja la fila de hoy con el mismo INSERT que el job; la
 * segunda vez el mismo día no duplica ni corrige; TikTok deja la razón sin
 * llamar; una cuenta que no existe deja la suya; una campaña reportada o de
 * otro workspace no se toca; sin la migración 0034 lo dice en español; y
 * ninguna credencial queda en la base.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dumpTextColumns, findSecretInDump, FixtureFetch, loadFixtures, withoutNetwork, type Fixture, type NetworkGuard } from "@mc/connectors";
import type { WorkspaceTx } from "@mc/db";
import { createEmbeddedDb, type EmbeddedDb } from "@mc/db/embedded";
import { SEED_WORKSPACE_ID } from "@/lib/workspace/current";
import { createMarcaService, type MarcaService } from "./marca-service";
import { MESSAGES } from "./messages";

const NOW = new Date("2026-09-23T15:00:00Z");
const ENV = { INSTAGRAM_HOUSE_TOKEN: "IGAA-house-marca-SECRETO", GOOGLE_API_KEY: "AIza-marca-key-SECRETO" };
const COMPANY_CAFE_ALMA = "00000002-0000-4000-8000-0000000000e1";
const CAMPAIGN_CAFE_ALMA_SEED = "00000003-0000-4000-8000-000000ca0001"; // reported
const CAMPAIGN_FRESKO = "00000003-0000-4000-8000-000000ca0002"; // measuring, TikTok
const CAMPAIGN_LIVE = "00000003-0000-4000-8000-00000ca3e001";
const CAMPAIGN_GONE = "00000003-0000-4000-8000-00000ca3e002";
const OTRO_WS = "00000009-0000-4000-8000-00000000ca31";

let db: EmbeddedDb;
let guard: NetworkGuard;
let fetch: FixtureFetch;
let service: MarcaService;
const withWorkspace = <T,>(fn: (tx: WorkspaceTx) => Promise<T>) => db.withWorkspace(SEED_WORKSPACE_ID, fn);

function forHandle(f: Fixture, handle: string): Fixture {
  return { ...f, request: { ...f.request, urlPattern: `${f.request.urlPattern}${handle}` } };
}

async function filas(campaignId: string) {
  const r = await db.queryAsSuperuser<{ day: string; followers: string | null; source: string; handle: string | null }>(
    "SELECT to_char(day, 'YYYY-MM-DD') AS day, followers::text AS followers, source, handle FROM brand_account_snapshot WHERE campaign_id = $1 ORDER BY day",
    [campaignId],
  );
  return r.rows;
}

beforeAll(async () => {
  guard = withoutNetwork();
  db = await createEmbeddedDb({ seeds: true });
  await db.execAsSuperuser(`
    INSERT INTO campaign (id, workspace_id, company_id, name, status, starts_on, ends_on, brand_baseline_from, brand_accounts) VALUES
      ('${CAMPAIGN_LIVE}', '${SEED_WORKSPACE_ID}', '${COMPANY_CAFE_ALMA}', 'Café Alma en curso', 'live', DATE '2026-09-20', DATE '2026-09-27', DATE '2026-09-06', '[{"platform_id": "instagram", "handle": "@cafealma"}]'),
      ('${CAMPAIGN_GONE}', '${SEED_WORKSPACE_ID}', '${COMPANY_CAFE_ALMA}', 'Handle mal escrito', 'planned', DATE '2026-10-01', DATE '2026-10-08', DATE '2026-09-17', '[{"platform_id": "instagram", "handle": "cafe_alma_mal"}]');
    INSERT INTO workspace (id, slug, name) VALUES ('${OTRO_WS}', 'otro-cam3', 'Otro') ON CONFLICT DO NOTHING;
  `);
  const [igOk] = await loadFixtures("instagram", [["business_discovery", "ok"]]);
  const [igNotFound] = await loadFixtures("instagram", [["business_discovery", "not_found"]]);
  fetch = new FixtureFetch([forHandle(igNotFound!, "cafe_alma_mal%29"), forHandle(igOk!, "cafealma%29")]);
  service = createMarcaService({ env: ENV, withWorkspace, fetch: fetch.fetch, now: () => NOW });
}, 120_000);

afterAll(async () => {
  await db.close();
  guard.restore();
});

describe("actualizar ahora", () => {
  it("lee a la marca y deja la fila de hoy; la segunda vez el mismo día no duplica ni corrige", async () => {
    expect(await service.actualizar(CAMPAIGN_LIVE)).toEqual({ ok: true, resultado: "guardada", avisos: [] });
    expect(await filas(CAMPAIGN_LIVE)).toEqual([{ day: "2026-09-23", followers: "267793", source: "instagram.business_discovery", handle: "cafealma" }]);
    expect(await service.actualizar(CAMPAIGN_LIVE)).toEqual({ ok: true, resultado: "ya_hoy", avisos: [] });
    expect(await filas(CAMPAIGN_LIVE)).toHaveLength(1);
    const log = await db.queryAsSuperuser<{ endpoint: string }>("SELECT endpoint FROM api_call_log WHERE endpoint = 'instagram.business_discovery'");
    expect(log.rows.length).toBe(2);
  });

  it("TikTok: fila sin cifra con su razón, sin llamar a nadie", async () => {
    const antes = fetch.calls.length;
    expect(await service.actualizar(CAMPAIGN_FRESKO)).toEqual({ ok: true, resultado: "guardada", avisos: [] });
    expect(await filas(CAMPAIGN_FRESKO)).toEqual([{ day: "2026-09-23", followers: null, source: "no_public_source", handle: "freskomarket" }]);
    expect(fetch.calls.length).toBe(antes);
  });

  it("un handle que no existe deja la fila con la razón, para que la ficha lo explique", async () => {
    expect(await service.actualizar(CAMPAIGN_GONE)).toEqual({ ok: true, resultado: "guardada", avisos: [] });
    expect(await filas(CAMPAIGN_GONE)).toEqual([{ day: "2026-09-23", followers: null, source: "not_found", handle: "cafe_alma_mal" }]);
  });

  it("una campaña reportada ya no se mide; la de otro workspace no existe para quien pide", async () => {
    expect(await service.actualizar(CAMPAIGN_CAFE_ALMA_SEED)).toEqual({ ok: false, code: "cerrada", message: MESSAGES.seguidores.errores.cerrada });
    const otro = createMarcaService({ env: ENV, withWorkspace: (fn) => db.withWorkspace(OTRO_WS, fn), fetch: fetch.fetch, now: () => NOW });
    expect(await otro.actualizar(CAMPAIGN_LIVE)).toEqual({ ok: false, code: "no_existe", message: MESSAGES.seguidores.errores.no_existe });
  });

  it("sin la credencial de Instagram no escribe nada y dice qué falta", async () => {
    const sin = createMarcaService({ env: {}, withWorkspace, fetch: fetch.fetch, now: () => new Date("2026-09-24T15:00:00Z") });
    const out = await sin.actualizar(CAMPAIGN_LIVE);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("lectura");
    expect(out.message).toMatch(/INSTAGRAM_HOUSE_TOKEN/);
    expect(await filas(CAMPAIGN_LIVE)).toHaveLength(1);
  });

  it("si la base aún no tiene 0034 (42501), lo dice en español en vez de romper la ficha", async () => {
    let n = 0;
    const sinPrivilegio = createMarcaService({
      env: ENV,
      fetch: fetch.fetch,
      now: () => new Date("2026-09-25T15:00:00Z"),
      withWorkspace: async (fn) => {
        if (++n === 2) throw Object.assign(new Error("permission denied for table brand_account_snapshot"), { code: "42501" });
        return withWorkspace(fn);
      },
    });
    expect(await sinPrivilegio.actualizar(CAMPAIGN_LIVE)).toEqual({ ok: false, code: "sin_permiso_base", message: MESSAGES.seguidores.errores.sin_permiso_base });
  });

  it("ninguna credencial de la casa en ninguna columna de la base, y sin red", async () => {
    const dump = await dumpTextColumns({ query: (text, params) => db.queryAsSuperuser(text, params as unknown[]) }, "public");
    expect(findSecretInDump(dump, [ENV.INSTAGRAM_HOUSE_TOKEN, ENV.GOOGLE_API_KEY])).toBeNull();
    expect(guard.attempts).toBe(0);
  });
});
