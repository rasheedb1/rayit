import { beforeEach, describe, expect, it, vi } from "vitest";
import { FINANCE_SETTINGS_DEFAULTS, FINANCE_TEXT_MAX } from "@mc/core";

/**
 * guardarConfiguracion sin base y sin Next: lo que importa aquí es qué
 * NO llega a la base (un porcentaje de 200, un plazo de un año, un
 * enlace http://) y que la compuerta de permiso es lo PRIMERO que corre.
 */
const withWorkspace = vi.fn();
const revalidatePath = vi.fn();
const updateFinanceSettings = vi.fn();
const puedeConfigurar = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/db", () => ({ withWorkspace: (...a: unknown[]) => withWorkspace(...a) }));
vi.mock("@mc/db/queries/finanzas", () => ({
  updateFinanceSettings: (...a: unknown[]) => updateFinanceSettings(...a),
  countInvoicesInOtherCurrency: vi.fn(),
}));
vi.mock("@/lib/workspace/current", () => ({ getCurrentContext: vi.fn() }));

// La compuerta se sustituye por su respuesta: quién puede lo decide
// _lib/permiso.ts y eso se prueba aparte (permiso.test.ts).
vi.mock("../_lib/permiso", async () => {
  const { SinPermisoError } = await vi.importActual<typeof import("../_lib/permiso")>("../_lib/permiso");
  return {
    SinPermisoError,
    exigirConfigurarFinanzas: async () => {
      if (!puedeConfigurar()) throw new SinPermisoError();
    },
  };
});

import { guardarConfiguracion } from "./actions";

/** El formulario completo, con lo del seed, para cambiarle un campo por prueba. */
function datos(cambios: Record<string, string> = {}): FormData {
  const fd = new FormData();
  const base: Record<string, string> = {
    ivaPct: "19",
    retencionPct: "11",
    reservaPct: "11",
    plazoDias: "30",
    currency: "COP",
    razonSocial: "",
    identificacion: "",
    direccion: "",
    regimen: "",
    correoFacturacion: "",
    banco: "",
    cuenta: "",
    enlacePago: "",
  };
  for (const [k, v] of Object.entries({ ...base, ...cambios })) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  withWorkspace.mockReset();
  revalidatePath.mockReset();
  updateFinanceSettings.mockReset();
  puedeConfigurar.mockReset();
  puedeConfigurar.mockReturnValue(true);
  // withWorkspace(fn) corre fn con un tx de mentira.
  withWorkspace.mockImplementation((fn: (tx: unknown) => unknown) => fn({ workspaceId: "ws" }));
  updateFinanceSettings.mockResolvedValue({
    settings: FINANCE_SETTINGS_DEFAULTS,
    currency: "COP",
    previousCurrency: "COP",
    invoicesInOtherCurrency: 0,
  });
});

describe("guardarConfiguracion · permiso", () => {
  it("sin el permiso no se abre ninguna transacción ni se guarda nada", async () => {
    puedeConfigurar.mockReturnValue(false);
    const r = await guardarConfiguracion({}, datos());
    expect(r.ok).toBeUndefined();
    expect(r.message).toBe("No tienes permiso para configurar Finanzas en este espacio.");
    expect(withWorkspace).not.toHaveBeenCalled();
    expect(updateFinanceSettings).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("el permiso se comprueba ANTES de validar: un formulario basura sin permiso dice lo del permiso", async () => {
    puedeConfigurar.mockReturnValue(false);
    const r = await guardarConfiguracion({}, datos({ ivaPct: "doscientos", plazoDias: "-5" }));
    expect(r.errors).toBeUndefined();
    expect(r.message).toBe("No tienes permiso para configurar Finanzas en este espacio.");
  });
});

describe("guardarConfiguracion · validación", () => {
  it("un porcentaje fuera de 0–100 vuelve por campo y no llega a la base", async () => {
    for (const [campo, valor] of [
      ["ivaPct", "200"],
      ["retencionPct", "-1"],
      ["reservaPct", "19,555"],
    ] as const) {
      const r = await guardarConfiguracion({}, datos({ [campo]: valor }));
      expect(r.errors?.[campo], `${campo}=${valor}`).toBe("Es un porcentaje entre 0 y 100, con hasta dos decimales.");
      expect(updateFinanceSettings).not.toHaveBeenCalled();
    }
  });

  it("cero y cien por ciento sí valen: no todo país tiene IVA", async () => {
    for (const valor of ["0", "100", "19,5"]) {
      const r = await guardarConfiguracion({}, datos({ ivaPct: valor }));
      expect(r.errors, `iva=${valor}`).toBeUndefined();
      expect(r.ok).toBe(true);
    }
  });

  it("un plazo que no es un entero de 0 a 180 días vuelve por campo", async () => {
    for (const valor of ["365", "-1", "30.5", "", "treinta"]) {
      const r = await guardarConfiguracion({}, datos({ plazoDias: valor }));
      expect(r.errors?.plazoDias, `plazo=${valor}`).toBe("Es un número entero de días, entre 0 y 180.");
    }
    expect(updateFinanceSettings).not.toHaveBeenCalled();
  });

  it("la moneda tiene que ser tres letras", async () => {
    for (const valor of ["PESOS", "C0P", "", "CO"]) {
      const r = await guardarConfiguracion({}, datos({ currency: valor }));
      expect(r.errors?.currency, `moneda=${valor}`).toBe("Escribe un código de tres letras: COP, MXN, USD.");
    }
  });

  it("un correo inventado y un enlace que no es https no pasan; vacíos sí", async () => {
    const malCorreo = await guardarConfiguracion({}, datos({ correoFacturacion: "arroba-no" }));
    expect(malCorreo.errors?.correoFacturacion).toBe("Escribe un correo válido, o déjalo vacío.");

    const malEnlace = await guardarConfiguracion({}, datos({ enlacePago: "http://pagos.example" }));
    expect(malEnlace.errors?.enlacePago).toBe("Tiene que ser una dirección https://.");

    const vacios = await guardarConfiguracion({}, datos({ correoFacturacion: "", enlacePago: "" }));
    expect(vacios.errors).toBeUndefined();
    expect(vacios.ok).toBe(true);
  });

  it("un texto por encima del tope vuelve por campo", async () => {
    const r = await guardarConfiguracion({}, datos({ razonSocial: "x".repeat(FINANCE_TEXT_MAX + 1) }));
    expect(r.errors?.razonSocial).toBe(`No puede pasar de ${FINANCE_TEXT_MAX} caracteres.`);
  });
});

describe("guardarConfiguracion · lo que guarda", () => {
  it("normaliza como la lectura (coma a punto, recorte) y guarda ausencias como null", async () => {
    const r = await guardarConfiguracion(
      {},
      datos({
        ivaPct: "19,5",
        plazoDias: "45",
        currency: "mxn",
        razonSocial: "  Laura Méndez S.A.S.  ",
        banco: "   ",
        enlacePago: "https://pagos.example/laura",
      }),
    );
    expect(r.ok).toBe(true);
    const [, entrada] = updateFinanceSettings.mock.calls[0] as [unknown, { settings: Record<string, unknown>; currency: string }];
    expect(entrada.settings.ivaPct).toBe("19.5");
    expect(entrada.settings.plazoDias).toBe(45);
    expect(entrada.settings.razonSocial).toBe("Laura Méndez S.A.S.");
    expect(entrada.settings.banco).toBeNull();
    expect(entrada.settings.enlacePago).toBe("https://pagos.example/laura");
    expect(entrada.currency).toBe("mxn");
  });

  it("al guardar bien revalida el segmento y devuelve la moneda, la ANTERIOR y el aviso", async () => {
    // La anterior es la que el aviso tiene que nombrar: es la moneda en
    // la que están las facturas que nadie convirtió. Sin ella, la
    // pantalla repintada sin JavaScript (que ya tiene la moneda nueva en
    // sus props) decía «17 facturas vivas en MXN» de unas que están en
    // COP. Lo encontró la verificación en dev.
    updateFinanceSettings.mockResolvedValue({
      settings: FINANCE_SETTINGS_DEFAULTS,
      currency: "MXN",
      previousCurrency: "COP",
      invoicesInOtherCurrency: 11,
    });
    const r = await guardarConfiguracion({}, datos({ currency: "MXN" }));
    expect(r).toEqual({ ok: true, moneda: "MXN", monedaAnterior: "COP", facturasEnOtraMoneda: 11 });
    expect(revalidatePath).toHaveBeenCalledWith("/finanzas", "layout");
  });

  it("si la base falla, el mensaje vuelve y no se revalida nada", async () => {
    updateFinanceSettings.mockRejectedValue(new Error("falta la RLS de la migración 0024 en esta base"));
    const r = await guardarConfiguracion({}, datos());
    expect(r.ok).toBeUndefined();
    expect(r.message).toMatch(/0024/);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
