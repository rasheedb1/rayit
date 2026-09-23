// @vitest-environment node
/**
 * ACC-2 × ACC-1, de punta a punta sobre el Postgres embebido con el seed:
 * una Server Action real (crearFactura) con un rol sin el permiso lanza
 * SinPermisoError y NO deja ni factura ni fila en audit_log; con el Dueño,
 * el mismo formulario deja exactamente una factura y su fila
 * 'invoice.created'. El rol se inyecta sustituyendo lib/permisos/sesion,
 * igual que require-permission.test.ts (el archivo que ACC-3 cambiará).
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { permisosDeRol, SinPermisoError } from "@mc/core";

const sesion = vi.hoisted(() => ({ permisos: null as ReadonlySet<string> | null }));
const redirect = vi.hoisted(() => vi.fn());

vi.mock("@/lib/permisos/sesion", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/permisos/sesion")>();
  return { permisosDeLaSesion: async () => sesion.permisos ?? real.permisosDeLaSesion() };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (...a: unknown[]) => redirect(...a) }));

import { crearFactura, registrarPago } from "@/app/(app)/finanzas/facturas/actions";
import { closeDb, getDbMode, withWorkspace } from "./index";

/** Café Alma, vinculada al workspace del seed (0002). */
const COMPANY_CAFE_ALMA = "00000002-0000-4000-8000-0000000000e1";
/** Un monto que ninguna otra factura del seed tiene, para encontrarla sin ids. */
const SUBTOTAL = "271828.18";

const entorno = { DATABASE_URL: process.env.DATABASE_URL, DEMO_WORKSPACE_ID: process.env.DEMO_WORKSPACE_ID };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  delete process.env.DEMO_WORKSPACE_ID;
  expect(await getDbMode()).toBe("embedded");
}, 120_000);

afterAll(async () => {
  await closeDb();
  for (const [k, v] of Object.entries(entorno)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function formulario(): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries({
    companyId: COMPANY_CAFE_ALMA, campaignId: "", subtotal: SUBTOTAL, taxPct: "19", withholdingPct: "11",
    issuedOn: "2026-09-23", dueOn: "2026-10-23", externalRef: "",
  })) f.set(k, v);
  return f;
}

/** Facturas con ese subtotal y sus filas de bitácora, leídas sin pedir el id de audit_log. */
async function estado(): Promise<{ facturas: string[]; bitacora: string[] }> {
  return withWorkspace(async (tx) => {
    const facturas = await tx.query<{ id: string }>("SELECT id FROM invoice WHERE subtotal = $1::numeric", [SUBTOTAL]);
    const ids = facturas.rows.map((r) => r.id);
    const bitacora = await tx.query<{ action: string }>(
      "SELECT action FROM audit_log WHERE entity_id = ANY($1::uuid[]) ORDER BY created_at",
      [ids],
    );
    return { facturas: ids, bitacora: bitacora.rows.map((r) => r.action) };
  });
}

describe("sin el permiso no hay escritura ni bitácora (ACC-1 + ACC-2)", () => {
  test("el Editor no factura: SinPermisoError y cero filas; el Dueño factura: una factura y una fila", async () => {
    sesion.permisos = permisosDeRol("creator", "editor");
    const err = await crearFactura({}, formulario()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SinPermisoError);
    expect((err as SinPermisoError).permiso).toBe("finanzas.factura.crear");
    expect(await estado()).toEqual({ facturas: [], bitacora: [] });

    sesion.permisos = null; // Dueño (la sesión de hoy, TODO(ACC-3))
    const r = await crearFactura({}, formulario());
    expect(r).toBeUndefined();
    expect(redirect).toHaveBeenCalledTimes(1);
    const despues = await estado();
    expect(despues.facturas).toHaveLength(1);
    expect(despues.bitacora).toEqual(["invoice.created"]);
    expect(redirect).toHaveBeenCalledWith(`/finanzas/facturas/${despues.facturas[0]}`);
  });

  /**
   * FIN-2. El mánager es el caso que importa del piloto: ve el estado de
   * cobro de sus campañas (`finanzas.cobro.ver`) y NO puede registrar un
   * cobro, que es dinero. Sobre la factura de FIN-1, recién enviada.
   */
  test("el Mánager no cobra: SinPermisoError, sin pago, sin apartado y sin bitácora; el Dueño sí", async () => {
    const id = (await estado()).facturas[0];
    expect(id).toBeDefined();
    await withWorkspace((tx) => tx.query("UPDATE invoice SET status = 'sent' WHERE id = $1", [id]));
    const cobro = () => {
      const f = new FormData();
      for (const [k, v] of Object.entries({
        invoiceId: id ?? "", amount: "100000.00", receivedOn: "2026-09-23",
        method: "transferencia", reference: "", notes: "", expectedPaidAmount: "0.00",
      })) f.set(k, v);
      return f;
    };
    const cobros = async () =>
      withWorkspace(async (tx) => {
        const p = await tx.query<{ id: string }>("SELECT id FROM payment WHERE invoice_id = $1", [id]);
        const r = await tx.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM tax_reserve tr JOIN payment p ON p.id = tr.payment_id WHERE p.invoice_id = $1",
          [id],
        );
        const b = await tx.query<{ action: string }>(
          "SELECT action FROM audit_log WHERE entity_id = $1::uuid AND action = 'invoice.payment_recorded'",
          [id],
        );
        return { pagos: p.rows.length, apartados: r.rows[0]?.n ?? -1, bitacora: b.rows.map((x) => x.action) };
      });

    sesion.permisos = permisosDeRol("creator", "manager");
    expect(sesion.permisos.has("finanzas.cobro.ver")).toBe(true);
    expect(sesion.permisos.has("finanzas.pago.registrar")).toBe(false);
    const err = await registrarPago({}, cobro()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SinPermisoError);
    expect((err as SinPermisoError).permiso).toBe("finanzas.pago.registrar");
    expect(await cobros()).toEqual({ pagos: 0, apartados: 0, bitacora: [] });

    sesion.permisos = null; // Dueño
    expect(await registrarPago({}, cobro())).toEqual({ ok: true });
    expect(await cobros()).toEqual({ pagos: 1, apartados: 1, bitacora: ["invoice.payment_recorded"] });
  });
});
