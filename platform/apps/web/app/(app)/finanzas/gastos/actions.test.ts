import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La Server Action de gastos, sin base y sin Next: qué llega a @mc/db con
 * cada formulario, y cómo vuelve cada error (en su campo o arriba del
 * formulario). Las consultas se prueban contra Postgres embebido en
 * packages/db/test/finanzas.test.ts.
 */
const createExpense = vi.fn();
const updateExpense = vi.fn();
const revalidatePath = vi.fn();

const sesion = vi.hoisted(() => ({ permisos: null as ReadonlySet<string> | null }));
vi.mock("@/lib/permisos/sesion", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/permisos/sesion")>();
  return { permisosDeLaSesion: async () => sesion.permisos ?? real.permisosDeLaSesion() };
});
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("../_lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@mc/db/queries/finanzas", async (original) => ({
  ...(await original<typeof import("@mc/db/queries/finanzas")>()),
  createExpense: (...a: unknown[]) => createExpense(...a),
  updateExpense: (...a: unknown[]) => updateExpense(...a),
}));

import { permisosDeRol, SinPermisoError } from "@mc/core";
import { ExpenseNotFound, InvalidExpenseError } from "@mc/db/queries/finanzas";
import { MESSAGES } from "../_lib/messages";
import { guardarGasto } from "./actions";

const GASTO = "00000003-0000-4000-8000-0009a5090001";
const T = MESSAGES.gastos.form;

/** Un formulario válido; cada prueba cambia lo que le interesa. */
function form(over: Record<string, string> = {}): FormData {
  const fd = new FormData();
  const base: Record<string, string> = {
    gastoId: "",
    category: "software",
    vendor: "Adobe",
    description: "Suscripciones",
    amount: "380000.00",
    incurredOn: "2026-09-01",
    isRecurring: "on",
    recurrence: "monthly",
    deductible: "on",
    receiptUrl: "",
  };
  for (const [k, v] of Object.entries({ ...base, ...over })) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  createExpense.mockReset().mockResolvedValue({ id: GASTO });
  updateExpense.mockReset().mockResolvedValue({ id: GASTO });
  revalidatePath.mockReset();
});

describe("guardarGasto · alta", () => {
  it("manda a la consulta lo que escribió el formulario, normalizado", async () => {
    const state = await guardarGasto({}, form({ vendor: "  Adobe  ", receiptUrl: "https://drive.example.com/r " }));
    expect(state).toEqual({ ok: true, message: T.guardado });
    expect(updateExpense).not.toHaveBeenCalled();
    expect(createExpense).toHaveBeenCalledWith({}, {
      category: "software",
      vendor: "Adobe",
      description: "Suscripciones",
      amount: "380000.00",
      incurredOn: "2026-09-01",
      isRecurring: true,
      recurrence: "monthly",
      receiptUrl: "https://drive.example.com/r",
      deductible: true,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/finanzas/gastos");
  });

  it("los campos opcionales vacíos llegan como null, no como cadena vacía", async () => {
    await guardarGasto({}, form({ vendor: "", description: "", receiptUrl: "", isRecurring: "", recurrence: "", deductible: "" }));
    expect(createExpense).toHaveBeenCalledWith({}, expect.objectContaining({
      vendor: null,
      description: null,
      receiptUrl: null,
      isRecurring: false,
      recurrence: null,
      deductible: false,
    }));
  });
});

describe("guardarGasto · corrección", () => {
  it("con gastoId llama a updateExpense y lo dice con otra frase", async () => {
    const state = await guardarGasto({}, form({ gastoId: GASTO, amount: "420000.00" }));
    expect(state).toEqual({ ok: true, message: T.editado });
    expect(createExpense).not.toHaveBeenCalled();
    expect(updateExpense).toHaveBeenCalledWith({}, GASTO, expect.objectContaining({ amount: "420000.00" }));
  });

  it("un gastoId que no es un UUID no llega a la base", async () => {
    const state = await guardarGasto({}, form({ gastoId: "no-es-uuid" }));
    expect(state.errors?.gastoId).toMatch(/no es válido/);
    expect(updateExpense).not.toHaveBeenCalled();
    expect(createExpense).not.toHaveBeenCalled();
  });
});

describe("guardarGasto · validación en español, antes de tocar la base", () => {
  const casos: [string, Record<string, string>, string][] = [
    ["category", { category: "" }, "Elige la categoría del gasto."],
    ["category", { category: "criptomonedas" }, "Elige la categoría del gasto."],
    ["amount", { amount: "" }, "Escribe el monto del gasto."],
    ["amount", { amount: "mucha plata" }, "Escribe el monto del gasto."],
    ["amount", { amount: "0.00" }, "El monto tiene que ser mayor que cero."],
    ["incurredOn", { incurredOn: "01/09/2026" }, "Elige la fecha del gasto."],
    ["recurrence", { isRecurring: "on", recurrence: "" }, "Di cada cuánto se repite."],
    ["recurrence", { isRecurring: "on", recurrence: "daily" }, "Di cada cuánto se repite."],
  ];

  for (const [campo, over, mensaje] of casos) {
    it(`${campo}: ${JSON.stringify(over)}`, async () => {
      const state = await guardarGasto({}, form(over));
      expect(state.errors?.[campo]).toBe(mensaje);
      expect(createExpense).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  }

  it("un texto demasiado largo se rechaza con su medida, no se recorta en silencio", async () => {
    const state = await guardarGasto({}, form({ vendor: "x".repeat(201) }));
    expect(state.errors?.vendor).toMatch(/200 caracteres/);
  });
});

describe("guardarGasto · errores de dominio", () => {
  it("un error de dominio con campo se pinta EN su campo", async () => {
    createExpense.mockRejectedValue(new InvalidExpenseError("El enlace del recibo tiene que empezar por http:// o https://.", "receiptUrl"));
    const state = await guardarGasto({}, form());
    expect(state.errors).toEqual({ receiptUrl: "El enlace del recibo tiene que empezar por http:// o https://." });
    expect(state.message).toBeUndefined();
  });

  it("un error de dominio sin campo va arriba del formulario", async () => {
    createExpense.mockRejectedValue(new InvalidExpenseError("Algo de la regla, sin campo"));
    const state = await guardarGasto({}, form());
    expect(state).toEqual({ message: "Algo de la regla, sin campo" });
  });

  it("corregir un gasto que ya no existe lo dice, y no se revalida nada", async () => {
    updateExpense.mockRejectedValue(new ExpenseNotFound(GASTO));
    const state = await guardarGasto({}, form({ gastoId: GASTO }));
    expect(state.message).toMatch(/no existe en este espacio/);
    expect(state.ok).toBeUndefined();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("un fallo inesperado no se queda callado, pero tampoco enseña el error crudo de la base", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    createExpense.mockRejectedValue(new Error('relation "expense" does not exist'));
    const state = await guardarGasto({}, form());
    expect(state.message).toBe(T.error);
    expect(state.message).not.toContain("relation");
    // Se registra en el servidor, con su causa, para quien lo depure.
    expect(log).toHaveBeenCalledWith("[finanzas] guardarGasto", expect.any(Error));
    log.mockRestore();
  });
});

describe("guardarGasto · permiso (ACC-1)", () => {
  it("el Mánager no registra gastos: lanza antes de validar y no escribe nada", async () => {
    sesion.permisos = permisosDeRol("creator", "manager");
    await expect(guardarGasto({}, form())).rejects.toThrow(SinPermisoError);
    expect(createExpense).not.toHaveBeenCalled();
    expect(updateExpense).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    sesion.permisos = null;
  });

  it("el Contador sí, y el guardado revalida gastos y el flujo de caja", async () => {
    sesion.permisos = permisosDeRol("creator", "finance");
    createExpense.mockResolvedValue({});
    const state = await guardarGasto({}, form());
    expect(state.ok).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith("/finanzas/gastos");
    expect(revalidatePath).toHaveBeenCalledWith("/finanzas/flujo");
    sesion.permisos = null;
  });
});
