// @vitest-environment node
/**
 * La costura del workspace es UNA: lib/workspace/current.ts. Esta prueba
 * lo demuestra por el camino real de Finanzas —withWorkspace de lib/db
 * y listInvoices— sobre Postgres embebido con el seed, sin red:
 * cambiar DEMO_WORKSPACE_ID cambia lo que ve la pantalla, y la variable
 * provisional MC_WORKSPACE_ID ya no tiene efecto.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createInvoice, listInvoices } from "@mc/db/queries/finanzas";
import {
  createMediaKit, createQuote, getPrimaryCreator, getQuote, listMediaKitLockNotices, listQuotableDeals, sendQuote,
} from "@mc/db/queries/cotizar";
import { acceptQuoteFromLink, closeDb, getDbMode, openProtectedMediaKit, withPublicShare, withWorkspace } from "./index";
import { readPublicQuote } from "@mc/db/queries/cotizar";
import { TEXTOS_BLOQUEO_MEDIA_KIT, TEXTOS_COTIZAR } from "@/app/(app)/cotizar/_lib/textos";
import { SEED_WORKSPACE_ID } from "@/lib/workspace/current";

/** Un workspace que no existe en el seed: RLS no devuelve nada suyo. */
const OTRO = "0000000a-0000-4000-8000-000000000001";
const POR_COBRAR = { status: ["sent", "partial", "overdue"] as const };

const entorno = {
  DATABASE_URL: process.env.DATABASE_URL,
  DEMO_WORKSPACE_ID: process.env.DEMO_WORKSPACE_ID,
  MC_WORKSPACE_ID: process.env.MC_WORKSPACE_ID,
};

beforeAll(async () => {
  // Sin DATABASE_URL la web levanta el embebido con el seed: es lo que
  // se quiere probar, y además la prueba no puede tocar Supabase.
  delete process.env.DATABASE_URL;
  delete process.env.DEMO_WORKSPACE_ID;
  delete process.env.MC_WORKSPACE_ID;
  expect(await getDbMode()).toBe("embedded");
}, 120_000);

afterAll(async () => {
  await closeDb();
  for (const [k, v] of Object.entries(entorno)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("withWorkspace toma el workspace de lib/workspace/current", () => {
  test("sin DEMO_WORKSPACE_ID, Finanzas lista las tres facturas por cobrar de la creadora del seed", async () => {
    const { rows } = await withWorkspace((tx) => listInvoices(tx, { status: [...POR_COBRAR.status] }));
    expect(rows.map((r) => r.number).sort()).toEqual(["FV-2026-007", "FV-2026-010", "FV-2026-011"]);
  });

  test("con DEMO_WORKSPACE_ID apuntando a un workspace que no existe, no pinta una lista vacía: lanza", async () => {
    // Hasta la ronda 5 salía vacía, y Campañas y Conexiones pintaban
    // «Todavía no hay campañas» como si fuera un workspace nuevo. Ahora
    // withWorkspace comprueba la fila y el error cae en la frontera.
    process.env.DEMO_WORKSPACE_ID = OTRO;
    try {
      await expect(withWorkspace((tx) => listInvoices(tx))).rejects.toThrow(/no existe en esta base/);
    } finally {
      delete process.env.DEMO_WORKSPACE_ID;
    }
  });

  test("con DEMO_WORKSPACE_ID igual al del seed vuelve a verse todo", async () => {
    process.env.DEMO_WORKSPACE_ID = SEED_WORKSPACE_ID;
    const { rows } = await withWorkspace((tx) => listInvoices(tx, { status: [...POR_COBRAR.status] }));
    expect(rows).toHaveLength(3);
    delete process.env.DEMO_WORKSPACE_ID;
  });

  test("MC_WORKSPACE_ID (la variable provisional de FIN-1) ya no cambia nada", async () => {
    process.env.MC_WORKSPACE_ID = OTRO;
    const { rows } = await withWorkspace((tx) => listInvoices(tx, { status: [...POR_COBRAR.status] }));
    expect(rows).toHaveLength(3);
    delete process.env.MC_WORKSPACE_ID;
  });
});

describe("acceptQuoteFromLink: aceptar desde el enlace deja la campaña planeada (COT-4)", () => {
  test("la marca acepta con su nombre, el negocio queda ganado y Campañas ve la campaña sin otro clic", async () => {
    const creada = await withWorkspace(async (tx) => {
      const creador = await getPrimaryCreator(tx);
      const [deal] = await listQuotableDeals(tx);
      const q = await createQuote(tx, {
        dealId: deal!.id,
        creatorId: creador!.id,
        items: [{ deliverable: "tiktok", platformId: "tiktok", description: "TikTok dedicado", quantity: 1, unitPrice: "4000000" }],
        taxRate: "0.19",
        campaignStartsOn: "2026-11-02",
        campaignEndsOn: "2026-11-30",
      });
      return sendQuote(tx, q.id, TEXTOS_COTIZAR);
    });

    // El enlace abre por la operación con nombre, sin forzar tipos.
    const abierta = await withPublicShare((tx) => readPublicQuote(tx, creada.slug, { count: false }));
    expect(abierta.status).toBe("ok");

    const r = await acceptQuoteFromLink(creada.slug, { name: "Ana Gómez", email: "ana@cafealma.co" }, TEXTOS_COTIZAR);
    expect(r).toEqual({ status: "ok", quoteNumber: creada.number, campaignPending: false });

    const despues = await withWorkspace((tx) => getQuote(tx, creada.id));
    expect(despues?.status).toBe("accepted");
    expect(despues?.acceptedByName).toBe("Ana Gómez");
    expect(despues?.campaignId).toBeTruthy();
    const campana = await withWorkspace(async (tx) => {
      const { rows } = await tx.query<{ status: string }>("SELECT status FROM campaign WHERE quote_id = $1", [creada.id]);
      return rows;
    });
    expect(campana).toEqual([{ status: "planned" }]);

    // Bitácora (ACC-2): la campaña que creó COT-4 dejó su fila sin que Cotizar la escribiera.
    const bitacora = await withWorkspace(async (tx) => {
      const { rows } = await tx.query<{ action: string; actor_kind: string; after: { quoteId: string } }>(
        "SELECT action, actor_kind, after FROM audit_log WHERE entity_id = $1 ORDER BY created_at",
        [despues!.campaignId],
      );
      return rows;
    });
    expect(bitacora.map((f) => f.action)).toEqual(["campaign.created"]);
    expect(bitacora[0]?.after.quoteId).toBe(creada.id);

    // Las frases que quedaron en la base son las de messages.ts.
    const aviso = await withWorkspace(async (tx) => {
      const { rows } = await tx.query<{ title_es: string; body_es: string }>(
        "SELECT title_es, body_es FROM notification WHERE entity_id = $1",
        [creada.id],
      );
      return rows[0];
    });
    expect(aviso?.title_es).toBe(`${creada.companyName} aceptó la cotización ${creada.number}`);
    expect(aviso?.body_es).toMatch(/^Aceptada por Ana Gómez <ana@cafealma\.co>\. La campaña «.+» ya está planeada\.$/);

    // Otra vez (otra pestaña): ya no es aceptable, dice por qué, y no hay segunda campaña.
    const otra = await acceptQuoteFromLink(creada.slug, { name: "Ana Gómez", email: "ana@cafealma.co" }, TEXTOS_COTIZAR);
    expect(otra).toEqual({ status: "not_acceptable", quoteStatus: "accepted" });
  });
});

describe("openProtectedMediaKit: el techo del enlace avisa al creador (pulido r6)", () => {
  test("el fallo que bloquea el enlace para todos deja el aviso en el workspace del kit, y la visita no ve de quién es", async () => {
    const kit = await withWorkspace(async (tx) => {
      const creador = await getPrimaryCreator(tx);
      return createMediaKit(tx, { creatorId: creador!.id, password: "la-contraseña-buena" });
    });
    let ultimo: Awaited<ReturnType<typeof openProtectedMediaKit>> | null = null;
    // Nueve por origen: ninguno llega a su propio bloqueo; el enlace sí.
    for (let o = 0; o < 6 && ultimo?.status !== "locked"; o++) {
      for (let i = 0; i < 9 && ultimo?.status !== "locked"; i++) {
        ultimo = await openProtectedMediaKit(kit.slug, `mala-${o}-${i}`, { origin: `192.0.2.${o}` }, TEXTOS_BLOQUEO_MEDIA_KIT);
      }
    }
    expect(ultimo?.status).toBe("locked");
    // Ni el workspace ni el id del kit salen hacia la página.
    expect(Object.keys(ultimo ?? {}).sort()).toEqual(["lockedUntil", "status"]);

    const avisos = await withWorkspace((tx) => listMediaKitLockNotices(tx));
    expect(avisos.filter((a) => a.mediaKitId === kit.id)).toHaveLength(1);
    const guardado = await withWorkspace(async (tx) => {
      const { rows } = await tx.query<{ title_es: string; severity: string }>(
        "SELECT title_es, severity FROM notification WHERE kind = 'media_kit_locked' AND entity_id = $1",
        [kit.id],
      );
      return rows;
    });
    expect(guardado).toEqual([{ title_es: "Un media kit quedó bloqueado por contraseñas fallidas", severity: "warning" }]);
  }, 60_000);
});

describe("la bitácora por el camino real de la web (ACC-2)", () => {
  test("crear una factura con withWorkspace de lib/db deja su fila; sin sesión (modo demo) el actor es system", async () => {
    const factura = await withWorkspace(async (tx) => {
      const { rows } = await tx.query<{ id: string }>("SELECT company_id AS id FROM company_link LIMIT 1");
      return createInvoice(tx, { companyId: rows[0]!.id, subtotal: "100000.00", issuedOn: "2026-09-23", dueOn: "2026-10-23" });
    });
    const filas = await withWorkspace(async (tx) => {
      const { rows } = await tx.query<{ action: string; actor_kind: string; actor_user_id: string | null; before: unknown; after: { number: string; total: string } }>(
        "SELECT action, actor_kind, actor_user_id, before, after FROM audit_log WHERE entity_id = $1",
        [factura.id],
      );
      return rows;
    });
    expect(filas).toHaveLength(1);
    expect(filas[0]?.action).toBe("invoice.created");
    expect(filas[0]?.actor_kind).toBe("system");
    expect(filas[0]?.actor_user_id).toBeNull();
    expect(filas[0]?.before).toBeNull();
    expect(filas[0]?.after.number).toBe(factura.number);
    expect(filas[0]?.after.total).toBe("119000.00");
  });
});
