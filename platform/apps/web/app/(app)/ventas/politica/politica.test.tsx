import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /ventas/politica sin base: la validación y los errores de la acción
 * (con las cifras en el locale del workspace), el interruptor con su
 * confirmación en el sitio, y la curva de calentamiento que se mueve con
 * lo escrito y sale de la misma regla que el despachador. Ronda 3: solo
 * owner y admin cambian la política y el interruptor; encender pide una
 * cuenta conectada y confirmación con lo aprobado de hoy; la curva va
 * debajo del campo que la mueve; y «Salud de hoy» dice cuál cuenta está
 * caída. Guardar de verdad (RLS, la dirección con el envío encendido, los
 * roles) está probado en pglite: packages/db/test/entregabilidad.test.ts.
 */
const saveOutboundPolicy = vi.fn();
const enableOutreach = vi.fn();
const disableOutreach = vi.fn();
const readSendReadiness = vi.fn();
const puedeCambiarLaPolitica = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../_lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("./permiso", () => ({ puedeCambiarLaPolitica: () => puedeCambiarLaPolitica() }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));
vi.mock("@mc/db/queries/entregabilidad", async (importOriginal) => {
  const real = await importOriginal<typeof import("@mc/db/queries/entregabilidad")>();
  return {
    POLICY_LIMITS: real.POLICY_LIMITS,
    POSTAL_ADDRESS_MAX: real.POSTAL_ADDRESS_MAX,
    DISABLED_REASON_MANUAL: real.DISABLED_REASON_MANUAL,
    PolicyNeedsAddressError: real.PolicyNeedsAddressError,
    PolicyForbiddenError: real.PolicyForbiddenError,
    isPolicyForbidden: real.isPolicyForbidden,
    saveOutboundPolicy: (...a: unknown[]) => saveOutboundPolicy(...a),
    readSendReadiness: (...a: unknown[]) => readSendReadiness(...a),
  };
});
vi.mock("@mc/db/queries/outreach", () => ({
  enableOutreach: (...a: unknown[]) => enableOutreach(...a),
  disableOutreach: (...a: unknown[]) => disableOutreach(...a),
}));

import { warmupCurve } from "@mc/core/outreach/warmup";
import { DISABLED_REASON_MANUAL, PolicyNeedsAddressError, POLICY_LIMITS, POSTAL_ADDRESS_MAX } from "@mc/db/queries/entregabilidad";
import { apagarEnvio, encenderEnvio, guardarPolitica } from "./actions";
import { calentamientoDe, PoliticaForm } from "./form";
import { Interruptor } from "./interruptor";
import { MESSAGES } from "./messages";
import { Salud } from "./salud";
import { formatterFor } from "@/lib/format";

const t = MESSAGES;
/** El instante de la página en las pruebas de «Salud de hoy»: 9:00 en Bogotá. */
const AHORA = "2026-09-23T14:00:00Z";
const LIMITES = { tope: POLICY_LIMITS.maxEmailsPerDay, dias: POLICY_LIMITS.warmupDays };

function formulario(over: Record<string, string> = {}): FormData {
  const f = new FormData();
  const base = {
    maxTouchesPerCompany: "4", minDaysBetweenTouches: "3", maxEmailsPerDay: "60", cooldownDaysAfterNo: "180",
    warmupDays: "14", requireHumanReview: "si", claimsMustBeSourced: "si", postalAddress: "1 Main St, Springfield, US",
    ...over,
  };
  for (const [k, v] of Object.entries(base)) f.set(k, v);
  return f;
}

beforeEach(() => {
  saveOutboundPolicy.mockReset();
  enableOutreach.mockReset();
  disableOutreach.mockReset();
  readSendReadiness.mockReset();
  readSendReadiness.mockResolvedValue({ connectedAccounts: 1, downAccounts: [], approvedDueToday: 0 });
  puedeCambiarLaPolitica.mockReset();
  puedeCambiarLaPolitica.mockResolvedValue(true);
});

/** El formulario con una política de 1.500 correos al día y 14 días de calentamiento. */
const PROPS_DEL_FORMULARIO = {
  policy: {
    maxTouchesPerCompany: 4, minDaysBetweenTouches: 3, maxEmailsPerDay: 1500, cooldownDaysAfterNo: 180, warmupDays: 14,
    requireHumanReview: true, claimsMustBeSourced: true, postalAddress: null,
  },
  rangos: { maxTouchesPerCompany: "", minDaysBetweenTouches: "", maxEmailsPerDay: "", cooldownDaysAfterNo: "", warmupDays: "" },
  maximos: { maxTouchesPerCompany: 12, minDaysBetweenTouches: 30, maxEmailsPerDay: 2000, cooldownDaysAfterNo: 730, warmupDays: 90 },
  minimos: { maxTouchesPerCompany: 1, minDaysBetweenTouches: 1, maxEmailsPerDay: 1, cooldownDaysAfterNo: 0, warmupDays: 0 },
  direccionMax: POSTAL_ADDRESS_MAX,
  locale: "es-CO",
};

/** «Salud de hoy» con los rebotes leídos hace poco: sin aviso encima de la tabla. */
const LEIDA = { estado: "ok" as const, desde: "2026-09-23T13:40:00Z" };

/** El interruptor con lo de siempre: dueña, una cuenta conectada, nada aprobado para hoy. */
const interruptor = (p: Partial<Parameters<typeof Interruptor>[0]> = {}) => (
  <Interruptor
    enabled={false}
    hasAddress
    motivo={null}
    nuncaEncendido={false}
    puedeCambiar
    cuentasConectadas={1}
    aprobadosHoy={{ n: "0", cuantos: 0 }}
    {...p}
  />
);

describe("guardarPolitica", () => {
  it("guarda con los tipos de la base y sin workspace en el formulario", async () => {
    saveOutboundPolicy.mockResolvedValue({});
    expect(await guardarPolitica({}, formulario({ requireHumanReview: "no" }))).toEqual({ ok: true });
    expect(saveOutboundPolicy).toHaveBeenCalledWith({}, {
      maxTouchesPerCompany: 4, minDaysBetweenTouches: 3, maxEmailsPerDay: 60, cooldownDaysAfterNo: 180, warmupDays: 14,
      requireHumanReview: false, claimsMustBeSourced: true, postalAddress: "1 Main St, Springfield, US",
    });
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
    // Un código, no una frase (r4): la página lo traduce con interruptor.motivos.
    expect(disableOutreach).toHaveBeenCalledWith({}, DISABLED_REASON_MANUAL);
    // El código vive en @mc/db (r5), no en los textos: traducir messages.ts no lo rompe.
    expect(DISABLED_REASON_MANUAL).toBe("manual");
    expect(t.interruptor.motivos[DISABLED_REASON_MANUAL]).toBe("lo apagaste desde la política");
  });

  it("apagar pide confirmación en el sitio, con el patrón del producto y sin window.confirm", () => {
    const confirmar = vi.spyOn(window, "confirm");
    render(interruptor({ enabled: true }));
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
    // Con la dirección guardada y una cuenta conectada no pide lo que ya está (r5).
    const { unmount } = render(interruptor({ nuncaEncendido: true }));
    expect(screen.getByText(t.interruptor.offHelpListo)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t.interruptor.encender })).toBeEnabled();
    expect(document.body.textContent).not.toMatch(/cuando tengas tu dirección postal/);
    unmount();
    render(interruptor());
    expect(screen.getByText(t.interruptor.offHelp)).toBeInTheDocument();
  });

  it("encender también pide confirmación y dice cuántos mensajes aprobados salen hoy", () => {
    render(interruptor({ aprobadosHoy: { n: "3", cuantos: 3 } }));
    fireEvent.click(screen.getByRole("button", { name: t.interruptor.encender }));
    expect(screen.getByRole("group", { name: t.interruptor.confirmarEncender })).toHaveAccessibleDescription(
      t.interruptor.consecuenciaEncender("3", 3),
    );
    expect(screen.getByRole("button", { name: t.interruptor.siEncender })).toBeInTheDocument();
    expect(enableOutreach).not.toHaveBeenCalled();
  });

  it("sin ninguna cuenta de envío conectada no se ofrece encender, y dice por qué", async () => {
    render(interruptor({ cuentasConectadas: 0 }));
    expect(screen.getByRole("button", { name: t.interruptor.encender })).toBeDisabled();
    expect(screen.getByText(t.interruptor.sinCanal)).toBeInTheDocument();
    // Y la acción tampoco lo hace, aunque alguien la llame a mano.
    readSendReadiness.mockResolvedValue({ connectedAccounts: 0, downAccounts: [], approvedDueToday: 0 });
    expect(await encenderEnvio()).toEqual({ ok: false, message: t.interruptor.sinCanal });
    expect(enableOutreach).not.toHaveBeenCalled();
  });
});

describe("solo quien administra el espacio (0038 §7, r3)", () => {
  it("las tres acciones se niegan a un 'viewer' o un 'client' sin tocar la base", async () => {
    puedeCambiarLaPolitica.mockResolvedValue(false);
    expect(await guardarPolitica({}, formulario())).toEqual({ message: t.sinPermiso });
    expect(await encenderEnvio()).toEqual({ ok: false, message: t.interruptor.sinPermiso });
    expect(await apagarEnvio()).toEqual({ ok: false, message: t.interruptor.sinPermiso });
    expect(saveOutboundPolicy).not.toHaveBeenCalled();
    expect(enableOutreach).not.toHaveBeenCalled();
    expect(disableOutreach).not.toHaveBeenCalled();
  });

  it("si la base lo rechaza de todos modos (42501 de outbound_policy), se explica igual", async () => {
    enableOutreach.mockRejectedValue(
      Object.assign(new Error('new row violates row-level security policy for table "outbound_policy"'), { code: "42501" }),
    );
    expect(await encenderEnvio()).toEqual({ ok: false, message: t.interruptor.sinPermiso });
  });

  it("el interruptor y el formulario se enseñan deshabilitados, con una línea que dice por qué", () => {
    render(interruptor({ puedeCambiar: false, enabled: true }));
    expect(screen.getByRole("button", { name: t.interruptor.apagar })).toBeDisabled();
    expect(screen.getByText(t.interruptor.sinPermiso)).toBeInTheDocument();

    render(<PoliticaForm {...PROPS_DEL_FORMULARIO} editable={false} />);
    expect(screen.getByText(t.sinPermiso)).toBeInTheDocument();
    expect(screen.getByLabelText(new RegExp(t.campos.maxEmailsPerDay.label), { selector: "input" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: t.guardar })).not.toBeInTheDocument();
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
    render(<PoliticaForm {...PROPS_DEL_FORMULARIO} />);
    const tabla = screen.getByRole("table", { name: t.calentamiento.caption });
    expect(within(tabla).getByRole("row", { name: /Día 1 20 al día/ })).toBeInTheDocument();
    expect(within(tabla).getByRole("row", { name: /Día 14 1\.500 al día/ })).toBeInTheDocument();
    expect(tabla.querySelector(".font-mono")).toBeNull();
    // La explicación del calentamiento sale UNA vez, en la ayuda del campo (r3).
    expect(screen.getAllByText(t.campos.warmupDays.help("20"), { exact: false })).toHaveLength(1);

    // En el móvil (una columna, el orden del DOM) la curva va justo debajo del
    // campo que la mueve y antes de «Guardar», no al final de la página.
    const dias = screen.getByLabelText(new RegExp(t.campos.warmupDays.label), { selector: "input" });
    const guardar = screen.getByRole("button", { name: t.guardar });
    expect(dias.compareDocumentPosition(tabla) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tabla.compareDocumentPosition(guardar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.change(screen.getByLabelText(new RegExp(t.campos.warmupDays.label), { selector: "input" }), { target: { value: "0" } });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText(t.calentamiento.sinCalentamiento)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(new RegExp(t.campos.maxEmailsPerDay.label), { selector: "input" }), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText(new RegExp(t.campos.warmupDays.label), { selector: "input" }), { target: { value: "14" } });
    expect(screen.getByText(t.calentamiento.topeBajo("20"))).toBeInTheDocument();
  });

  it("la dirección de ejemplo no es de ningún país", () => {
    expect(t.campos.postalAddress.placeholder).not.toMatch(/Bogotá|Colombia/);
    expect(t.campos.postalAddress.help).not.toMatch(/habeas/i);
  });
});

describe("«Salud de hoy»: la cuenta caída", () => {
  const health = {
    enabled: true, disabledReason: null, disabledAt: null, shouldPause: false, since: "2026-09-23T14:00:00Z", hours: 24,
    queue: { draft: 0, scheduled: 1, due: 0, processing: 0, stuck: 0, held: 1 },
    window: { sent: 3, failed: 0, canceled: 0, opened: 1, replied: 1, optedOut: 0, sentAfterOptOut: 0 },
    byChannel: {}, breakersOpen: [], accountsDown: 1, lastSentAt: null,
    llm: { spentToday: 0, dailyCap: 5, currency: "USD" as const },
  };
  const counts = { emailsSent: 3, hardBounces: 0, dueToSend: 0, unreadMailboxes: 0, hardBounceRate: 0 };
  const caida = {
    id: "c1", channel: "linkedin" as const, name: "Laura · Cocina fácil", status: "needs_reconnect" as const,
    lastError: "Unipile: la sesión de LinkedIn expiró.", lastErrorAt: "2026-09-22T14:00:00Z",
  };

  it("la nota dice CUÁL es, y la lista de #cuentas dice qué pasó y qué hacer (adonde lleva la alerta)", () => {
    const { container } = render(
      <Salud lectura={LEIDA} health={health} counts={counts} rebotes={[]} caidas={[caida]} f={formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" })} ahora={AHORA} />,
    );
    expect(screen.getAllByText("LinkedIn: Laura · Cocina fácil").length).toBeGreaterThan(0);
    const cuentas = container.querySelector("#cuentas");
    expect(cuentas).not.toBeNull();
    expect(within(cuentas as HTMLElement).getByText(caida.lastError)).toBeInTheDocument();
    expect(within(cuentas as HTMLElement).getByText(t.salud.caidas.estado.needs_reconnect)).toBeInTheDocument();
    expect(within(cuentas as HTMLElement).getByText(t.salud.caidas.paso.otro)).toBeInTheDocument();
    // Ningún enlace a una pantalla que no resuelve nada.
    expect(within(cuentas as HTMLElement).queryByRole("link")).not.toBeInTheDocument();
  });

  it("sin cuentas caídas, «Todas conectadas» y nada más", () => {
    const { container } = render(
      <Salud lectura={LEIDA}
        health={{ ...health, accountsDown: 0 }}
        counts={counts}
        rebotes={[]}
        caidas={[]}
        f={formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" })}
        ahora={AHORA}
      />,
    );
    expect(screen.getByText(t.salud.cuentas.noteBien)).toBeInTheDocument();
    expect(container.querySelector("#cuentas")?.children.length).toBe(0);
  });
});

describe("ronda 4", () => {
  const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });
  const health = {
    enabled: true, disabledReason: null, disabledAt: null, shouldPause: false, since: "2026-09-22T14:00:00Z", hours: 24,
    queue: { draft: 0, scheduled: 1, due: 1, processing: 0, stuck: 1, held: 0 },
    window: { sent: 3, failed: 0, canceled: 0, opened: 1, replied: 1, optedOut: 0, sentAfterOptOut: 0 },
    byChannel: {}, breakersOpen: [], accountsDown: 0, lastSentAt: null,
    llm: { spentToday: 0, dailyCap: 5, currency: "USD" as const },
  };
  const counts = { emailsSent: 40, hardBounces: 1, dueToSend: 0, unreadMailboxes: 0, hardBounceRate: 0.025 };

  it("después de encender se ve «Apagar el envío», no la confirmación de apagar ya abierta; y al revés", async () => {
    enableOutreach.mockResolvedValue(undefined);
    disableOutreach.mockResolvedValue(0);
    const { rerender } = render(interruptor());
    fireEvent.click(screen.getByRole("button", { name: t.interruptor.encender }));
    fireEvent.click(screen.getByRole("button", { name: t.interruptor.siEncender }));
    await waitFor(() => expect(enableOutreach).toHaveBeenCalledTimes(1));
    // La página vuelve a pintarse con la política encendida (revalidatePath).
    rerender(interruptor({ enabled: true }));
    expect(screen.getByRole("button", { name: t.interruptor.apagar })).toBeInTheDocument();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t.interruptor.siApagar })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: t.interruptor.apagar }));
    fireEvent.click(screen.getByRole("button", { name: t.interruptor.siApagar }));
    await waitFor(() => expect(disableOutreach).toHaveBeenCalledTimes(1));
    rerender(interruptor({ enabled: false }));
    expect(screen.getByRole("button", { name: t.interruptor.encender })).toBeInTheDocument();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it("sin dirección, la línea de arriba no repite lo que dice la de abajo", () => {
    render(interruptor({ nuncaEncendido: true, hasAddress: false }));
    expect(screen.getByText(t.interruptor.offHelpNuncaCorto)).toBeInTheDocument();
    expect(screen.getByText(t.interruptor.sinDireccion)).toBeInTheDocument();
    expect(screen.queryByText(t.interruptor.offHelpListo)).not.toBeInTheDocument();
  });

  it("los plurales salen de Intl.PluralRules, con 1 y con 2", () => {
    expect(t.interruptor.consecuenciaEncender("1", 1)).toMatch(/^Hoy sale 1 mensaje aprobado, /);
    expect(t.interruptor.consecuenciaEncender("2", 2)).toMatch(/^Hoy salen 2 mensajes aprobados, /);
    expect(t.salud.cola.note("1", 1)).toBe("1 atascado");
    expect(t.salud.cola.note("2", 2)).toBe("2 atascados");
    expect(t.salud.rebotes.note("1", "40", 1)).toBe("1 de 40 no existe");
    expect(t.salud.rebotes.note("2", "40", 2)).toBe("2 de 40 no existen");
    render(<Salud lectura={LEIDA} health={health} counts={counts} rebotes={[]} caidas={[]} f={f} ahora={AHORA} />);
    expect(screen.getByText("1 atascado")).toBeInTheDocument();
    expect(screen.getByText("1 de 40 no existe")).toBeInTheDocument();
  });

  it("si un Gmail no se leyó nunca, «Salud de hoy» lo dice encima de la tabla de rebotes", () => {
    render(<Salud health={health} counts={counts} rebotes={[]} caidas={[]} f={f} ahora={AHORA} lectura={{ estado: "never", desde: null }} />);
    expect(screen.getByRole("note")).toHaveTextContent(t.salud.lectura.never.title);
    expect(screen.getByRole("note")).toHaveTextContent(t.salud.lectura.never.description);
  });

  it("si la lectura se paró (cursor viejo), lo dice con la hora de la última lectura (r5)", () => {
    const desde = "2026-09-23T11:00:00Z";
    render(<Salud health={health} counts={counts} rebotes={[]} caidas={[]} f={f} ahora={AHORA} lectura={{ estado: "stale", desde }} />);
    const nota = screen.getByRole("note");
    expect(nota).toHaveTextContent(t.salud.lectura.stale.title);
    expect(nota).toHaveTextContent(t.salud.lectura.stale.description(f.dateTime(desde)));
    // «Ningún rebote» sigue debajo, pero ya no se lee como «todo bien».
    expect(screen.getByText(t.salud.sinRebotes.title)).toBeInTheDocument();
  });

  it("leída hace poco, o sin ningún Gmail que leer, no hay aviso", () => {
    const { unmount } = render(<Salud health={health} counts={counts} rebotes={[]} caidas={[]} f={f} ahora={AHORA} lectura={LEIDA} />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    unmount();
    render(<Salud health={health} counts={counts} rebotes={[]} caidas={[]} f={f} ahora={AHORA} lectura={{ estado: "no_email", desde: null }} />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("una cuenta cuyo nombre ya dice el canal no lo repite", () => {
    const caida = {
      id: "c2", channel: "linkedin" as const, name: "Laura (LinkedIn)", status: "error" as const,
      lastError: null, lastErrorAt: null,
    };
    render(<Salud lectura={LEIDA} health={{ ...health, accountsDown: 1 }} counts={counts} rebotes={[]} caidas={[caida]} f={f} ahora={AHORA} />);
    expect(screen.getAllByText("Laura (LinkedIn)").length).toBeGreaterThan(0);
    expect(screen.queryByText(/LinkedIn: Laura/)).not.toBeInTheDocument();
  });

  it("la fecha de un rebote es corta: la hora si es de hoy, el día y el mes si no", () => {
    const rebotes = [
      { id: "b1", recipientAddress: "hoy@marca.test", kind: "hard" as const, reason: "550 5.1.1", detectedAt: "2026-09-23T13:55:00Z" },
      { id: "b2", recipientAddress: "antes@marca.test", kind: "soft" as const, reason: "452 4.2.2", detectedAt: "2026-09-21T16:55:00Z" },
    ];
    render(<Salud lectura={LEIDA} health={health} counts={counts} rebotes={rebotes} caidas={[]} f={f} ahora={AHORA} />);
    const tabla = screen.getByRole("table", { name: t.salud.rebotesCaption });
    expect(within(tabla).getByText(f.time("2026-09-23T13:55:00Z"))).toBeInTheDocument();
    expect(within(tabla).getByText("21 sep")).toBeInTheDocument();
    expect(tabla.textContent).not.toMatch(/de septiembre de 2026/);
  });

  it("la rampa de calentamiento se pinta con el LineChart del kit, un punto por día", () => {
    const c = calentamientoDe("60", "14", LIMITES, "es-CO");
    expect(c.tipo).toBe("curva");
    if (c.tipo === "curva") {
      expect(c.serie.dias[0]).toBe("1");
      expect(c.serie.topes[0]).toBe(20);
      expect(c.serie.topes.at(-1)).toBe(60);
      expect(c.serie.topes.length).toBe(c.serie.dias.length);
      // No baja nunca.
      expect(c.serie.topes.every((v, i, a) => i === 0 || v >= (a[i - 1] ?? 0))).toBe(true);
    }
    render(<PoliticaForm {...PROPS_DEL_FORMULARIO} />);
    expect(screen.getByRole("img", { name: t.calentamiento.caption })).toBeInTheDocument();
    // La tabla sigue, para quien no ve el gráfico.
    expect(screen.getByRole("table", { name: t.calentamiento.caption })).toBeInTheDocument();
  });
});

describe("ronda 5", () => {
  it("después de encender o apagar, el foco va al título del interruptor y una región status lo dice", async () => {
    enableOutreach.mockResolvedValue(undefined);
    disableOutreach.mockResolvedValue(0);
    const { rerender } = render(interruptor());
    fireEvent.click(screen.getByRole("button", { name: t.interruptor.encender }));
    fireEvent.click(screen.getByRole("button", { name: t.interruptor.siEncender }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(t.interruptor.anuncioEncendido));
    rerender(interruptor({ enabled: true }));
    const titulo = screen.getByRole("heading", { name: t.interruptor.title });
    await waitFor(() => expect(titulo).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);

    fireEvent.click(screen.getByRole("button", { name: t.interruptor.apagar }));
    fireEvent.click(screen.getByRole("button", { name: t.interruptor.siApagar }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(t.interruptor.anuncioApagado));
    rerender(interruptor({ enabled: false }));
    await waitFor(() => expect(screen.getByRole("heading", { name: t.interruptor.title })).toHaveFocus());
  });

  it("si falla, el foco no se mueve y el error lo dice", async () => {
    enableOutreach.mockRejectedValue(new Error("base caída"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(interruptor());
    fireEvent.click(screen.getByRole("button", { name: t.interruptor.encender }));
    fireEvent.click(screen.getByRole("button", { name: t.interruptor.siEncender }));
    expect(await screen.findByRole("alert")).toHaveTextContent(t.interruptor.errorEncender);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByRole("heading", { name: t.interruptor.title })).not.toHaveFocus();
  });

  it("el tope de la dirección es POSTAL_ADDRESS_MAX, el mismo que valida la acción", () => {
    render(<PoliticaForm {...PROPS_DEL_FORMULARIO} direccionMax={120} />);
    expect(screen.getByLabelText(new RegExp(t.campos.postalAddress.label), { selector: "textarea" })).toHaveAttribute(
      "maxLength",
      "120",
    );
  });

  it("la tabla accesible de la curva va DENTRO de un div sr-only: una <table> con sr-only no se encoge y daba scroll horizontal", () => {
    // jsdom no calcula el layout, así que se comprueba la forma; la medida
    // (scrollWidth = clientWidth a 400 y a 1280 px) se hizo en el navegador.
    const { container } = render(<PoliticaForm {...PROPS_DEL_FORMULARIO} />);
    const tabla = screen.getByRole("table", { name: t.calentamiento.caption });
    expect(tabla.className).not.toMatch(/sr-only/);
    expect(tabla.parentElement?.tagName).toBe("DIV");
    expect(tabla.parentElement?.className).toMatch(/(^|\s)sr-only(\s|$)/);
    for (const el of container.querySelectorAll("table.sr-only")) throw new Error(`una tabla con sr-only: ${el.outerHTML.slice(0, 80)}`);
  });
});
