import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /ventas/politica sin base: la validación y los errores de la acción,
 * el interruptor y la curva de calentamiento que se mueve con lo escrito.
 * Guardar de verdad (RLS, la dirección con el envío encendido) está
 * probado en pglite: packages/db/test/entregabilidad.test.ts.
 */
const saveOutboundPolicy = vi.fn();
const enableOutreach = vi.fn();
const disableOutreach = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../_lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@mc/db/queries/entregabilidad", async (importOriginal) => {
  const real = await importOriginal<typeof import("@mc/db/queries/entregabilidad")>();
  return {
    POLICY_LIMITS: real.POLICY_LIMITS,
    POSTAL_ADDRESS_MAX: real.POSTAL_ADDRESS_MAX,
    PolicyNeedsAddressError: real.PolicyNeedsAddressError,
    saveOutboundPolicy: (...a: unknown[]) => saveOutboundPolicy(...a),
  };
});
vi.mock("@mc/db/queries/outreach", () => ({
  enableOutreach: (...a: unknown[]) => enableOutreach(...a),
  disableOutreach: (...a: unknown[]) => disableOutreach(...a),
}));

import { PolicyNeedsAddressError } from "@mc/db/queries/entregabilidad";
import { apagarEnvio, encenderEnvio, guardarPolitica } from "./actions";
import { diasDeLaCurva, PoliticaForm } from "./form";
import { MESSAGES } from "./messages";

const t = MESSAGES;

function formulario(over: Record<string, string> = {}): FormData {
  const f = new FormData();
  const base = {
    maxTouchesPerCompany: "4", minDaysBetweenTouches: "3", maxEmailsPerDay: "60", cooldownDaysAfterNo: "180",
    warmupDays: "14", requireHumanReview: "si", claimsMustBeSourced: "si", postalAddress: "Calle 93 # 11-26, Bogotá",
    ...over,
  };
  for (const [k, v] of Object.entries(base)) f.set(k, v);
  return f;
}

beforeEach(() => {
  saveOutboundPolicy.mockReset();
  enableOutreach.mockReset();
  disableOutreach.mockReset();
});

describe("guardarPolitica", () => {
  it("guarda con los tipos de la base y sin workspace en el formulario", async () => {
    saveOutboundPolicy.mockResolvedValue({});
    expect(await guardarPolitica({}, formulario({ requireHumanReview: "no" }))).toEqual({ ok: true });
    expect(saveOutboundPolicy).toHaveBeenCalledWith({}, {
      maxTouchesPerCompany: 4, minDaysBetweenTouches: 3, maxEmailsPerDay: 60, cooldownDaysAfterNo: 180, warmupDays: 14,
      requireHumanReview: false, claimsMustBeSourced: true, postalAddress: "Calle 93 # 11-26, Bogotá",
    });
  });

  it("un número fuera de rango o que no es entero no llega a la base", async () => {
    const r = await guardarPolitica({}, formulario({ maxEmailsPerDay: "5000", minDaysBetweenTouches: "2,5" }));
    expect(r.errors?.maxEmailsPerDay).toBe(t.rango("1", "2000"));
    expect(r.errors?.minDaysBetweenTouches).toBe(t.entero);
    expect(saveOutboundPolicy).not.toHaveBeenCalled();
  });

  it("quitar la dirección con el envío encendido se explica en el campo", async () => {
    saveOutboundPolicy.mockRejectedValue(new PolicyNeedsAddressError());
    const r = await guardarPolitica({}, formulario({ postalAddress: "" }));
    expect(r.errors?.postalAddress).toBe(t.necesitaDireccion);
    expect(saveOutboundPolicy.mock.calls[0]?.[1]).toMatchObject({ postalAddress: null });
  });
});

describe("el interruptor", () => {
  it("encender sin dirección dice qué falta", async () => {
    enableOutreach.mockRejectedValue(Object.assign(new Error("check"), { code: "23514" }));
    expect(await encenderEnvio()).toEqual({ ok: false, message: t.interruptor.sinDireccion });
  });

  it("apagar deja el motivo", async () => {
    disableOutreach.mockResolvedValue(3);
    expect(await apagarEnvio()).toEqual({ ok: true });
    expect(disableOutreach).toHaveBeenCalledWith({}, t.interruptor.motivoManual);
  });
});

describe("la curva de calentamiento", () => {
  it("enseña el primer día, el primero que sube, uno intermedio y el del tope", () => {
    expect(diasDeLaCurva(14)).toEqual([1, 8, 11, 14]);
    expect(diasDeLaCurva(8)).toEqual([1, 8]);
    expect(diasDeLaCurva(7)).toEqual([]);
    expect(diasDeLaCurva(0)).toEqual([]);
  });

  it("se mueve con lo escrito, con la misma función que el despachador", () => {
    const policy = {
      maxTouchesPerCompany: 4, minDaysBetweenTouches: 3, maxEmailsPerDay: 100, cooldownDaysAfterNo: 180, warmupDays: 14,
      requireHumanReview: true, claimsMustBeSourced: true, postalAddress: null,
    };
    const rangos = { maxTouchesPerCompany: "", minDaysBetweenTouches: "", maxEmailsPerDay: "", cooldownDaysAfterNo: "", warmupDays: "" };
    const maximos = { maxTouchesPerCompany: 12, minDaysBetweenTouches: 30, maxEmailsPerDay: 2000, cooldownDaysAfterNo: 730, warmupDays: 90 };
    render(<PoliticaForm policy={policy} rangos={rangos} maximos={maximos} locale="es-CO" />);
    const tabla = screen.getByRole("table", { name: t.calentamiento.caption });
    expect(within(tabla).getByRole("row", { name: /Día 1 20 al día/ })).toBeInTheDocument();
    expect(within(tabla).getByRole("row", { name: /Día 14 100 al día/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(new RegExp(t.campos.warmupDays.label)), { target: { value: "0" } });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText(t.calentamiento.sinCalentamiento)).toBeInTheDocument();
  });
});
