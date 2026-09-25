import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /ventas/politica sin base: la validación y los errores de la acción
 * (con las cifras en el locale del workspace), el interruptor con su
 * confirmación en el sitio, y la curva de calentamiento que se mueve con
 * lo escrito y sale de la misma regla que el despachador. Guardar de
 * verdad (RLS, la dirección con el envío encendido) está probado en
 * pglite: packages/db/test/entregabilidad.test.ts.
 */
const saveOutboundPolicy = vi.fn();
const enableOutreach = vi.fn();
const disableOutreach = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../_lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));
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

import { warmupCurve } from "@mc/core/outreach/warmup";
import { PolicyNeedsAddressError, POLICY_LIMITS } from "@mc/db/queries/entregabilidad";
import { apagarEnvio, encenderEnvio, guardarPolitica } from "./actions";
import { calentamientoDe, PoliticaForm } from "./form";
import { Interruptor } from "./interruptor";
import { MESSAGES } from "./messages";

const t = MESSAGES;
const LIMITES = { tope: POLICY_LIMITS.maxEmailsPerDay, dias: POLICY_LIMITS.warmupDays };

function formulario(over: Record<string, string> = {}): FormData {
  const f = new FormData();
  const base = {
    maxTouchesPerCompany: "4", minDaysBetweenTouches: "3", maxEmailsPerDay: "60", cooldownDaysAfterNo: "180",
    warmupDays: "14", requireHumanReview: "si", claimsMustBeSourced: "si", stopCompanyOnReply: "si", postalAddress: "1 Main St, Springfield, US",
    sendWindowStart: "09:00", sendWindowEnd: "17:00",
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
    expect(await guardarPolitica({}, formulario({ requireHumanReview: "no", stopCompanyOnReply: "no" }))).toEqual({ ok: true });
    expect(saveOutboundPolicy).toHaveBeenCalledWith({}, {
      maxTouchesPerCompany: 4, minDaysBetweenTouches: 3, maxEmailsPerDay: 60, cooldownDaysAfterNo: 180, warmupDays: 14,
      requireHumanReview: false, claimsMustBeSourced: true, stopCompanyOnReply: false, postalAddress: "1 Main St, Springfield, US",
      sendWindowStart: "09:00", sendWindowEnd: "17:00",
    });
  });

  it("el horario de envío: el fin va después del inicio, y una hora que no es HH:MM no llega a la base (VEN-10 r5)", async () => {
    const alReves = await guardarPolitica({}, formulario({ sendWindowStart: "12:00", sendWindowEnd: "08:00" }));
    expect(alReves.errors?.sendWindowEnd).toBe(t.campos.sendWindow.error);
    const rara = await guardarPolitica({}, formulario({ sendWindowStart: "9h" }));
    expect(rara.errors?.sendWindowStart).toBe(t.campos.sendWindow.invalida);
    expect(saveOutboundPolicy).not.toHaveBeenCalled();
    saveOutboundPolicy.mockResolvedValue({});
    expect(await guardarPolitica({}, formulario({ sendWindowStart: "08:00", sendWindowEnd: "12:00" }))).toEqual({ ok: true });
    expect(saveOutboundPolicy.mock.calls[0]?.[1]).toMatchObject({ sendWindowStart: "08:00", sendWindowEnd: "12:00" });
  });

  it("un número fuera de rango o que no es entero no llega a la base, y el rango sale con Intl", async () => {
    const r = await guardarPolitica({}, formulario({ maxEmailsPerDay: "5000", minDaysBetweenTouches: "2,5" }));
    expect(r.errors?.maxEmailsPerDay).toBe(t.rango("1", "2.000"));
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

  it("apagar pide confirmación en el sitio, con el patrón del producto y sin window.confirm", () => {
    const confirmar = vi.spyOn(window, "confirm");
    render(<Interruptor enabled hasAddress motivo={null} nuncaEncendido={false} />);
    fireEvent.click(screen.getByRole("button", { name: t.interruptor.apagar }));
    expect(screen.getByRole("group", { name: t.interruptor.confirmarApagar })).toHaveAccessibleDescription(
      t.interruptor.consecuenciaApagar,
    );
    expect(screen.getByRole("button", { name: t.interruptor.siApagar })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t.interruptor.cancelar }));
    expect(screen.getByRole("button", { name: t.interruptor.apagar })).toBeInTheDocument();
    expect(confirmar).not.toHaveBeenCalled();
    expect(disableOutreach).not.toHaveBeenCalled();
  });

  it("una política que nunca se encendió no dice que se canceló nada", () => {
    const { unmount } = render(<Interruptor enabled={false} hasAddress motivo={null} nuncaEncendido />);
    expect(screen.getByText(t.interruptor.offHelpNunca)).toBeInTheDocument();
    unmount();
    render(<Interruptor enabled={false} hasAddress motivo={null} nuncaEncendido={false} />);
    expect(screen.getByText(t.interruptor.offHelp)).toBeInTheDocument();
  });
});

describe("la curva de calentamiento", () => {
  it("sale de warmupCurve, la regla del despachador, para 0 a 21 días", () => {
    for (let dias = 0; dias <= 21; dias++) {
      const c = calentamientoDe("60", String(dias), LIMITES, "es-CO");
      const motor = warmupCurve(60, dias);
      if (motor.length) {
        expect(c.tipo).toBe("curva");
        if (c.tipo === "curva") expect(c.filas.map((f) => f.correos)).toEqual(motor.map((p) => t.calentamiento.correos(String(p.limit))));
      } else {
        expect(c.tipo).not.toBe("curva");
      }
    }
  });

  it("con 5 días no dice «sin calentamiento»: enseña los días que sube", () => {
    const c = calentamientoDe("60", "5", LIMITES, "es-CO");
    expect(c.tipo).toBe("curva");
    if (c.tipo === "curva") expect(c.filas.map((f) => f.dia)).toEqual(["Día 1", "Día 3", "Día 4", "Día 5"]);
  });

  it("fuera de rango no pinta nada engañoso, y con un tope bajo lo explica", () => {
    expect(calentamientoDe("5000", "14", LIMITES, "es-CO")).toEqual({ tipo: "fueraDeRango" });
    expect(calentamientoDe("60", "200", LIMITES, "es-CO")).toEqual({ tipo: "fueraDeRango" });
    expect(calentamientoDe("", "14", LIMITES, "es-CO")).toEqual({ tipo: "fueraDeRango" });
    expect(calentamientoDe("20", "14", LIMITES, "es-CO")).toEqual({ tipo: "topeBajo", texto: t.calentamiento.topeBajo("20") });
    expect(calentamientoDe("60", "0", LIMITES, "es-CO")).toEqual({ tipo: "sinCalentamiento" });
  });

  it("se mueve con lo escrito, con cifras en el locale del workspace", () => {
    const policy = {
      maxTouchesPerCompany: 4, minDaysBetweenTouches: 3, maxEmailsPerDay: 1500, cooldownDaysAfterNo: 180, warmupDays: 14,
      requireHumanReview: true, claimsMustBeSourced: true, stopCompanyOnReply: true, postalAddress: null, sendWindowStart: "09:15",
      sendWindowEnd: "17:00",
    };
    const rangos = { maxTouchesPerCompany: "", minDaysBetweenTouches: "", maxEmailsPerDay: "", cooldownDaysAfterNo: "", warmupDays: "" };
    const maximos = { maxTouchesPerCompany: 12, minDaysBetweenTouches: 30, maxEmailsPerDay: 2000, cooldownDaysAfterNo: 730, warmupDays: 90 };
    const minimos = { maxTouchesPerCompany: 1, minDaysBetweenTouches: 1, maxEmailsPerDay: 1, cooldownDaysAfterNo: 0, warmupDays: 0 };
    const horas = [
      { value: "08:00", label: "8:00 a. m." },
      { value: "09:00", label: "9:00 a. m." },
      { value: "17:00", label: "5:00 p. m." },
    ];
    render(
      <PoliticaForm
        policy={policy}
        rangos={rangos}
        maximos={maximos}
        minimos={minimos}
        locale="es-CO"
        horas={horas}
        zona="hora estándar de Colombia"
        ventanaMarca="90"
      />,
    );
    // El horario de envío, con la zona del espacio a la vista; una hora guardada fuera de la lista se conserva.
    expect(screen.getByText(t.campos.sendWindow.help("hora estándar de Colombia"))).toBeInTheDocument();
    expect(screen.getByLabelText(t.campos.sendWindow.desde)).toHaveValue("09:15");
    expect(screen.getByLabelText(t.campos.sendWindow.hasta)).toHaveValue("17:00");
    expect(screen.getByText(new RegExp(t.campos.maxTouchesPerCompany.help("90").slice(0, 60)))).toBeInTheDocument();
    const tabla = screen.getByRole("table", { name: t.calentamiento.caption });
    expect(within(tabla).getByRole("row", { name: /Día 1 20 al día/ })).toBeInTheDocument();
    expect(within(tabla).getByRole("row", { name: /Día 14 1\.500 al día/ })).toBeInTheDocument();
    expect(tabla.querySelector(".font-mono")).toBeNull();
    expect(screen.getAllByText(t.campos.warmupDays.help("20")).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText(new RegExp(t.campos.warmupDays.label)), { target: { value: "0" } });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText(t.calentamiento.sinCalentamiento)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(new RegExp(t.campos.maxEmailsPerDay.label)), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText(new RegExp(t.campos.warmupDays.label)), { target: { value: "14" } });
    expect(screen.getByText(t.calentamiento.topeBajo("20"))).toBeInTheDocument();
  });

  it("la dirección de ejemplo no es de ningún país", () => {
    expect(t.campos.postalAddress.placeholder).not.toMatch(/Bogotá|Colombia/);
    expect(t.campos.postalAddress.help).not.toMatch(/habeas/i);
  });
});
