import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { Salud, motivoCaida } from "./salud";
import { formatterFor } from "@/lib/format";
import { ESPERA_UI_LARGA_MS, PRUEBA_LENTA_MS } from "@/lib/testing/tiempos";

const t = MESSAGES;
/** El instante de la página en las pruebas de «Salud de hoy»: 9:00 en Bogotá. */
const AHORA = "2026-09-23T14:00:00Z";
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
  readSendReadiness.mockReset();
  readSendReadiness.mockResolvedValue({ connectedAccounts: 1, downAccounts: [], approvedDueToday: 0 });
  puedeCambiarLaPolitica.mockReset();
  puedeCambiarLaPolitica.mockResolvedValue(true);
});

/** El formulario con una política de 1.500 correos al día y 14 días de calentamiento. */
const PROPS_DEL_FORMULARIO = {
  policy: {
    maxTouchesPerCompany: 4, minDaysBetweenTouches: 3, maxEmailsPerDay: 1500, cooldownDaysAfterNo: 180, warmupDays: 14,
    requireHumanReview: true, claimsMustBeSourced: true, stopCompanyOnReply: true, postalAddress: null, sendWindowStart: "09:15",
    sendWindowEnd: "17:00",
  },
  rangos: { maxTouchesPerCompany: "", minDaysBetweenTouches: "", maxEmailsPerDay: "", cooldownDaysAfterNo: "", warmupDays: "" },
  maximos: { maxTouchesPerCompany: 12, minDaysBetweenTouches: 30, maxEmailsPerDay: 2000, cooldownDaysAfterNo: 730, warmupDays: 90 },
  minimos: { maxTouchesPerCompany: 1, minDaysBetweenTouches: 1, maxEmailsPerDay: 1, cooldownDaysAfterNo: 0, warmupDays: 0 },
  direccionMax: POSTAL_ADDRESS_MAX,
  locale: "es-CO",
  horas: [
    { value: "08:00", label: "8:00 a. m." },
    { value: "09:00", label: "9:00 a. m." },
    { value: "17:00", label: "5:00 p. m." },
  ],
  zona: "hora estándar de Colombia",
  ventanaMarca: "90",
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
    expect(await guardarPolitica({}, formulario({ requireHumanReview: "no", stopCompanyOnReply: "no" }))).toEqual({ ok: true });
    expect(saveOutboundPolicy).toHaveBeenCalledWith({}, {
      maxTouchesPerCompany: 4, minDaysBetweenTouches: 3, maxEmailsPerDay: 60, cooldownDaysAfterNo: 180, warmupDays: 14,
      requireHumanReview: false, claimsMustBeSourced: true, stopCompanyOnReply: false, postalAddress: "1 Main St, Springfield, US",
      sendWindowStart: "09:00", sendWindowEnd: "17:00",
    });
  });

  it("el horario de envío: el fin va después del inicio, y una hora que no es HH:MM no llega a la base", async () => {
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
    enableOutreach.mockRejectedValue(
      Object.assign(new Error("check"), { code: "23514", constraint: "outbound_policy_enabled_needs_address" }),
    );
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

  it("encender dice cuántos mensajes, y de cuántas personas, vuelven a la cola desde el apagado", () => {
    const vuelven = { mensajes: "23", cuantos: 23, personas: "9", cuantasPersonas: 9 };
    render(interruptor({ vuelven }));
    fireEvent.click(screen.getByRole("button", { name: t.interruptor.encender }));
    const texto = t.interruptor.consecuenciaEncender("0", 0, vuelven);
    expect(texto).toMatch(/^Vuelven a la cola 23 mensajes de 9 personas que el apagado había parado/);
    expect(screen.getByRole("group", { name: t.interruptor.confirmarEncender })).toHaveAccessibleDescription(texto);
    expect(t.interruptor.consecuenciaEncender("0", 0, { mensajes: "1", cuantos: 1, personas: "1", cuantasPersonas: 1 })).toMatch(
      /^Vuelve a la cola 1 mensaje de 1 persona que/,
    );
  });

  it("si la base no enciende por falta de canal (23514 sin la restricción de la dirección), lo dice", async () => {
    enableOutreach.mockRejectedValue(Object.assign(new Error("Sin un canal conectado"), { code: "23514" }));
    expect(await encenderEnvio()).toEqual({ ok: false, message: t.interruptor.sinCanal });
    enableOutreach.mockRejectedValue(
      Object.assign(new Error("Sin dirección postal"), { code: "23514", constraint: "outbound_policy_enabled_needs_address" }),
    );
    expect(await encenderEnvio()).toEqual({ ok: false, message: t.interruptor.sinDireccion });
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

describe("solo quien administra el espacio (entregabilidad §7, r3)", () => {
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
    // El horario de envío, con la zona del espacio a la vista; una hora guardada fuera de la lista se conserva.
    expect(screen.getByText(t.campos.sendWindow.help("hora estándar de Colombia"))).toBeInTheDocument();
    expect(screen.getByLabelText(t.campos.sendWindow.desde)).toHaveValue("09:15");
    expect(screen.getByLabelText(t.campos.sendWindow.hasta)).toHaveValue("17:00");
    expect(screen.getByText(new RegExp(t.campos.maxTouchesPerCompany.help("90", "4").slice(0, 60)))).toBeInTheDocument();
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
  const counts = { emailsSent: 3, hardBounces: 0, blockedBounces: 0, bounces: 0, dueToSend: 0, unreadMailboxes: 0, bounceRate: 0 };
  const caida = {
    id: "c1", channel: "linkedin" as const, name: "Laura · Cocina fácil", status: "needs_reconnect" as const,
    lastError: "unipile_status:CREDENTIALS", lastErrorAt: "2026-09-22T14:00:00Z",
  };

  it("la nota dice CUÁL es, y la lista de #cuentas dice qué pasó y qué hacer (adonde lleva la alerta)", () => {
    const { container } = render(
      <Salud avisos={[]} lectura={LEIDA} health={health} counts={counts} rebotes={[]} caidas={[caida]} f={formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" })} ahora={AHORA} />,
    );
    expect(screen.getAllByText("LinkedIn: Laura · Cocina fácil").length).toBeGreaterThan(0);
    const cuentas = container.querySelector("#cuentas");
    expect(cuentas).not.toBeNull();
    // El código se traduce; nunca se enseña crudo.
    expect(within(cuentas as HTMLElement).getByText("LinkedIn cerró la sesión.")).toBeInTheDocument();
    expect(cuentas?.textContent).not.toMatch(/unipile_status|CREDENTIALS/);
    expect(within(cuentas as HTMLElement).getByText(t.salud.caidas.estado.needs_reconnect)).toBeInTheDocument();
    // Sin botón ni SUPPORT_EMAIL, no se pide una acción imposible (r5): ni «hay que conectar otra vez».
    expect(within(cuentas as HTMLElement).queryByText(t.salud.caidas.paso.otro)).not.toBeInTheDocument();
    // Ningún enlace a una pantalla que no resuelve nada.
    expect(within(cuentas as HTMLElement).queryByRole("link")).not.toBeInTheDocument();
    // Sin SUPPORT_EMAIL: que no se pierde nada, sin prometer una función futura.
    expect(within(cuentas as HTMLElement).getByText(t.salud.caidas.donde(null))).toBeInTheDocument();
    expect(cuentas?.textContent).not.toMatch(/llega con|Ventas → Canales/);
  });

  it("con SUPPORT_EMAIL, la cuenta caída dice a quién escribir para reconectarla", () => {
    const { container } = render(
      <Salud avisos={[]} lectura={LEIDA} health={health} counts={counts} rebotes={[]} caidas={[caida]} f={formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" })} ahora={AHORA} soporte="ayuda@oncue.test" />,
    );
    const cuentas = container.querySelector("#cuentas") as HTMLElement;
    expect(within(cuentas).getByText(/Escríbenos a ayuda@oncue\.test y la reconectamos contigo/)).toBeInTheDocument();
    // Con a quién escribir, el paso sí va: se puede dar.
    expect(within(cuentas).getByText(t.salud.caidas.paso.otro)).toBeInTheDocument();
  });

  it("last_error guarda códigos (VEN-9): 'missing_scopes' sale en frase; un código desconocido o la jerga del proveedor, nunca crudos", () => {
    const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });
    const gmail = { ...caida, id: "c3", channel: "email" as const, name: "laura@gmail.com", lastError: "missing_scopes" };
    const { container } = render(
      <Salud avisos={[]} lectura={LEIDA} health={health} counts={counts} rebotes={[]} caidas={[gmail]} f={f} ahora={AHORA} />,
    );
    const cuentas = container.querySelector("#cuentas") as HTMLElement;
    expect(within(cuentas).getByText(t.salud.caidas.motivos.missing_scopes!)).toBeInTheDocument();
    expect(cuentas.textContent).not.toMatch(/missing_scopes/);
    expect(motivoCaida("unipile_gone", "Instagram")).toBe("Instagram ya no reconoce esta cuenta.");
    expect(motivoCaida("webhooks_missing", "LinkedIn")).toBe(t.salud.caidas.motivos.webhooks_missing);
    expect(motivoCaida("algo_nuevo", "Gmail")).toBe(t.salud.caidas.sinDetalle);
    expect(motivoCaida("Unipile: la sesión expiró (CREDENTIALS).", "LinkedIn")).toBe(t.salud.caidas.sinDetalle);
    expect(motivoCaida("toString", "Gmail")).toBe(t.salud.caidas.sinDetalle);
    expect(motivoCaida(null, "Gmail")).toBe(t.salud.caidas.sinDetalle);
  });

  it("con la pantalla de canales (reconectarUrl), cada cuenta lleva su botón «Reconectar» y sobra la línea de mientras tanto", () => {
    const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });
    const { container } = render(
      <Salud avisos={[]} lectura={LEIDA} health={health} counts={counts} rebotes={[]} caidas={[caida]} f={f} ahora={AHORA}
        reconectarUrl="/ventas/canales" />,
    );
    const cuentas = container.querySelector("#cuentas") as HTMLElement;
    const boton = within(cuentas).getByRole("link", { name: t.salud.caidas.reconectarCuenta("LinkedIn: Laura · Cocina fácil") });
    expect(boton).toHaveAttribute("href", "/ventas/canales");
    expect(boton).toHaveTextContent(t.salud.caidas.reconectar);
    expect(within(cuentas).queryByText(t.salud.caidas.donde(null))).not.toBeInTheDocument();
  });

  it("sin cuentas caídas, «Todas conectadas» y nada más", () => {
    const { container } = render(
      <Salud avisos={[]} lectura={LEIDA}
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
  const counts = { emailsSent: 40, hardBounces: 1, blockedBounces: 0, bounces: 1, dueToSend: 0, unreadMailboxes: 0, bounceRate: 0.025 };

  it("después de encender se ve «Apagar el envío», no la confirmación de apagar ya abierta; y al revés", async () => {
    enableOutreach.mockResolvedValue(undefined);
    disableOutreach.mockResolvedValue(0);
    // Pulido r4 (CIM-12): el rerender espera a que la transición del formulario termine (el botón que envía deja
    // de estar ocupado); en medio, la confirmación de encender se quedaba abierta.
    const espera = { timeout: ESPERA_UI_LARGA_MS };
    const confirmar = async (nombre: string, accion: typeof enableOutreach) => {
      const boton = screen.getByRole("button", { name: nombre });
      await act(async () => {
        fireEvent.click(boton);
      });
      await waitFor(() => expect(accion).toHaveBeenCalledTimes(1), espera);
      await waitFor(() => {
        for (const b of screen.queryAllByRole("button", { name: nombre })) expect(b).not.toHaveAttribute("aria-busy");
      }, espera);
    };
    const { rerender } = render(interruptor());
    fireEvent.click(screen.getByRole("button", { name: t.interruptor.encender }));
    await confirmar(t.interruptor.siEncender, enableOutreach);
    // La página vuelve a pintarse con la política encendida (revalidatePath).
    await act(async () => {
      rerender(interruptor({ enabled: true }));
    });
    expect(screen.getByRole("button", { name: t.interruptor.apagar })).toBeInTheDocument();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t.interruptor.siApagar })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: t.interruptor.apagar }));
    await confirmar(t.interruptor.siApagar, disableOutreach);
    await act(async () => {
      rerender(interruptor({ enabled: false }));
    });
    expect(screen.getByRole("button", { name: t.interruptor.encender })).toBeInTheDocument();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  }, PRUEBA_LENTA_MS);

  it("sin dirección, la línea de arriba no repite lo que dice la de abajo", () => {
    render(interruptor({ nuncaEncendido: true, hasAddress: false }));
    expect(screen.getByText(t.interruptor.offHelpNuncaCorto)).toBeInTheDocument();
    expect(screen.getByText(t.interruptor.sinDireccion)).toBeInTheDocument();
    expect(screen.queryByText(t.interruptor.offHelpListo)).not.toBeInTheDocument();
  });

  it("lo que falta lleva a donde se arregla: la dirección (con el foco en el campo) o /ventas/canales", () => {
    const campo = document.createElement("textarea");
    campo.id = "postalAddress";
    document.body.appendChild(campo);
    render(interruptor({ hasAddress: false }));
    const aDireccion = screen.getByRole("link", { name: t.interruptor.irADireccion });
    expect(aDireccion).toHaveAttribute("href", "#postalAddress");
    fireEvent.click(aDireccion);
    expect(document.activeElement).toBe(campo);
    campo.remove();
    cleanup();
    render(interruptor({ cuentasConectadas: 0 }));
    expect(screen.getByRole("link", { name: t.interruptor.irACanales })).toHaveAttribute("href", "/ventas/canales");
  });

  it("los plurales salen de Intl.PluralRules, con 1 y con 2", () => {
    expect(t.interruptor.consecuenciaEncender("1", 1)).toMatch(/^Hoy sale 1 mensaje aprobado, /);
    expect(t.interruptor.consecuenciaEncender("2", 2)).toMatch(/^Hoy salen 2 mensajes aprobados, /);
    expect(t.salud.cola.note("1", 1)).toBe("1 atascado");
    expect(t.salud.cola.note("2", 2)).toBe("2 atascados");
    expect(t.salud.rebotes.note("1", "40", 1)).toBe("1 de 40 no existe");
    expect(t.salud.rebotes.note("2", "40", 2)).toBe("2 de 40 no existen");
    render(<Salud avisos={[]} lectura={LEIDA} health={health} counts={counts} rebotes={[]} caidas={[]} f={f} ahora={AHORA} />);
    expect(screen.getByText("1 atascado")).toBeInTheDocument();
    expect(screen.getByText(/^1 de 40 no existe/)).toBeInTheDocument();
  });

  it("los avisos del día se ven arriba de «Salud de hoy», urgentes en rojo, con su enlace; sin avisos, «Nada que revisar hoy»", () => {
    const avisos = [
      {
        id: "n1", kind: "account_down", severity: "critical" as const, title: "Una cuenta de envío necesita atención",
        body: "No sale nada por Gmail: laura@gmail.com hasta que se reconecte.", actionUrl: "/ventas/politica#cuentas",
        createdAt: "2026-09-23T13:30:00Z",
      },
      {
        id: "n2", kind: "queue_stuck", severity: "warning" as const, title: "Hay un mensaje atascado en la cola", body: null,
        actionUrl: null, createdAt: "2026-09-23T12:00:00Z",
      },
    ];
    const { unmount } = render(
      <Salud avisos={avisos} lectura={LEIDA} health={health} counts={counts} rebotes={[]} caidas={[]} f={f} ahora={AHORA} />,
    );
    const lista = screen.getByRole("heading", { name: t.salud.avisos.title }).parentElement!;
    const items = within(lista).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent(t.salud.avisos.severidad.critical);
    expect(items[0]).toHaveTextContent("Una cuenta de envío necesita atención");
    // El enlace dice adónde lleva, y es solo el ancla: la misma página, sin recargar.
    const enlace = within(items[0]!).getByRole("link", { name: t.salud.avisos.verPor.account_down });
    expect(enlace).toHaveAttribute("href", "#cuentas");
    expect(enlace).toHaveAccessibleDescription("Una cuenta de envío necesita atención");
    expect(items[1]).toHaveTextContent(t.salud.avisos.severidad.warning);
    expect(within(items[1]!).queryByRole("link")).toBeNull();
    unmount();

    render(<Salud avisos={[]} lectura={LEIDA} health={health} counts={counts} rebotes={[]} caidas={[]} f={f} ahora={AHORA} />);
    expect(screen.getByText(t.salud.avisos.vacio.title)).toBeInTheDocument();
  });

  it("sin correos en la ventana, la nota de rebotes dice «en las últimas 24 horas», no «todavía»", () => {
    const sinEnvios = { emailsSent: 0, hardBounces: 0, blockedBounces: 0, bounces: 0, dueToSend: 0, unreadMailboxes: 0, bounceRate: null };
    render(<Salud avisos={[]} lectura={LEIDA} health={health} counts={sinEnvios} rebotes={[]} caidas={[]} f={f} ahora={AHORA} />);
    expect(screen.getByText("Sin envíos en las últimas 24 horas")).toBeInTheDocument();
    expect(screen.queryByText(/todavía/)).toBeNull();
  });

  it("si un Gmail no se leyó nunca, «Salud de hoy» lo dice encima de la tabla de rebotes", () => {
    render(<Salud avisos={[]} health={health} counts={counts} rebotes={[]} caidas={[]} f={f} ahora={AHORA} lectura={{ estado: "never", desde: null }} />);
    expect(screen.getByRole("note")).toHaveTextContent(t.salud.lectura.never.title);
    expect(screen.getByRole("note")).toHaveTextContent(t.salud.lectura.never.description);
  });

  it("si la lectura se paró (cursor viejo), lo dice con la hora de la última lectura (r5)", () => {
    const desde = "2026-09-23T11:00:00Z";
    render(<Salud avisos={[]} health={health} counts={counts} rebotes={[]} caidas={[]} f={f} ahora={AHORA} lectura={{ estado: "stale", desde }} />);
    const nota = screen.getByRole("note");
    expect(nota).toHaveTextContent(t.salud.lectura.stale.title);
    expect(nota).toHaveTextContent(t.salud.lectura.stale.description(f.dateTime(desde)));
    // «Ningún rebote» sigue debajo, pero ya no se lee como «todo bien».
    expect(screen.getByText(t.salud.sinRebotes.title)).toBeInTheDocument();
  });

  it("leída hace poco, o sin ningún Gmail que leer, no hay aviso", () => {
    const { unmount } = render(<Salud avisos={[]} health={health} counts={counts} rebotes={[]} caidas={[]} f={f} ahora={AHORA} lectura={LEIDA} />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    unmount();
    render(<Salud avisos={[]} health={health} counts={counts} rebotes={[]} caidas={[]} f={f} ahora={AHORA} lectura={{ estado: "no_email", desde: null }} />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("una cuenta cuyo nombre ya dice el canal no lo repite", () => {
    const caida = {
      id: "c2", channel: "linkedin" as const, name: "Laura (LinkedIn)", status: "error" as const,
      lastError: null, lastErrorAt: null,
    };
    render(<Salud avisos={[]} lectura={LEIDA} health={{ ...health, accountsDown: 1 }} counts={counts} rebotes={[]} caidas={[caida]} f={f} ahora={AHORA} />);
    expect(screen.getAllByText("Laura (LinkedIn)").length).toBeGreaterThan(0);
    expect(screen.queryByText(/LinkedIn: Laura/)).not.toBeInTheDocument();
  });

  it("la fecha de un rebote es corta: la hora si es de hoy, el día y el mes si no", () => {
    const rebotes = [
      { id: "b1", recipientAddress: "hoy@marca.test", kind: "hard" as const, reason: "550 5.1.1", detectedAt: "2026-09-23T13:55:00Z" },
      { id: "b2", recipientAddress: "antes@marca.test", kind: "soft" as const, reason: "452 4.2.2", detectedAt: "2026-09-21T16:55:00Z" },
    ];
    render(<Salud avisos={[]} lectura={LEIDA} health={health} counts={counts} rebotes={rebotes} caidas={[]} f={f} ahora={AHORA} />);
    const tabla = screen.getByRole("table", { name: t.salud.rebotesCaption });
    expect(within(tabla).getByText(f.time("2026-09-23T13:55:00Z"))).toBeInTheDocument();
    expect(within(tabla).getByText("21 sep")).toBeInTheDocument();
    expect(tabla.textContent).not.toMatch(/de septiembre de 2026/);
  });

  it("en el móvil los rebotes van en una lista: la dirección y debajo el tipo, la fecha y lo que dijo el servidor", () => {
    const rebotes = [
      { id: "b1", recipientAddress: "natalia.velez@nutrive.test", kind: "hard" as const, reason: "550 5.1.1 no existe", detectedAt: "2026-09-23T13:55:00Z" },
    ];
    render(<Salud avisos={[]} lectura={LEIDA} health={health} counts={counts} rebotes={rebotes} caidas={[]} f={f} ahora={AHORA} />);
    const lista = screen.getByRole("list", { name: t.salud.rebotesCaption });
    // Oculta desde sm (la tabla se ve ahí), y la tabla oculta por debajo.
    expect(lista).toHaveClass("sm:hidden");
    expect(screen.getByRole("table", { name: t.salud.rebotesCaption }).closest("div.hidden")).toHaveClass("sm:block");
    const [fila] = within(lista).getAllByRole("listitem");
    expect(fila).toHaveTextContent("natalia.velez@nutrive.test");
    expect(fila).toHaveTextContent(t.salud.tipos.hard);
    expect(within(fila!).getByText(f.time("2026-09-23T13:55:00Z"))).toBeInTheDocument();
    expect(fila).toHaveTextContent("550 5.1.1 no existe");
  });

  it("sin rebotes, un solo «Ningún rebote» (ni lista ni tabla)", () => {
    render(<Salud avisos={[]} lectura={LEIDA} health={health} counts={counts} rebotes={[]} caidas={[]} f={f} ahora={AHORA} />);
    expect(screen.getAllByText(t.salud.sinRebotes.title)).toHaveLength(1);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("con pocos envíos la cifra grande es «1 de 4», no un 25 % que alarma; la tasa sale con volumen (r5)", () => {
    const { container } = render(
      <Salud avisos={[]} lectura={LEIDA} health={health} f={f} ahora={AHORA} rebotes={[]} caidas={[]}
        counts={{ emailsSent: 4, hardBounces: 1, blockedBounces: 0, bounces: 1, dueToSend: 0, unreadMailboxes: 0, bounceRate: 0.25 }} />,
    );
    expect(screen.getByText("1 de 4")).toBeInTheDocument();
    expect(screen.getByText(t.salud.rebotes.umbral.pocos("10"))).toBeInTheDocument();
    expect(container.textContent).not.toContain(f.pct(0.25, 1));
    cleanup();
    render(
      <Salud avisos={[]} lectura={LEIDA} health={health} f={f} ahora={AHORA} rebotes={[]} caidas={[]}
        counts={{ emailsSent: 20, hardBounces: 2, blockedBounces: 0, bounces: 2, dueToSend: 0, unreadMailboxes: 0, bounceRate: 0.1 }} />,
    );
    expect(screen.getByText(f.pct(0.1, 1))).toBeInTheDocument();
  });

  it("la nota de rebotes dice si la tasa pasa del umbral, con volumen suficiente", () => {
    const nota = (emailsSent: number, hardBounces: number) => {
      const { unmount } = render(
        <Salud avisos={[]} lectura={LEIDA} health={health} f={f} ahora={AHORA} rebotes={[]} caidas={[]}
          counts={{ emailsSent, hardBounces, blockedBounces: 0, bounces: hardBounces, dueToSend: 0, unreadMailboxes: 0, bounceRate: hardBounces / emailsSent }} />,
      );
      const texto = screen.getByText(new RegExp(`^${hardBounces} de ${emailsSent} no exist`)).textContent;
      unmount();
      return texto;
    };
    expect(nota(40, 1)).toBe(`1 de 40 no existe · ${t.salud.rebotes.umbral.bajo(f.pct(0.05, 0))}`);
    expect(nota(20, 2)).toBe(`2 de 20 no existen · ${t.salud.rebotes.umbral.sobre(f.pct(0.05, 0))}`);
  });

  it("los bloqueos suman a la tasa y la nota dice cuántos fueron", () => {
    render(
      <Salud avisos={[]} lectura={LEIDA} health={health} f={f} ahora={AHORA} rebotes={[]} caidas={[]}
        counts={{ emailsSent: 20, hardBounces: 0, blockedBounces: 3, bounces: 3, dueToSend: 0, unreadMailboxes: 0, bounceRate: 0.15 }} />,
    );
    expect(screen.getByText(f.pct(0.15, 1))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`^0 de 20 no existen · 3 bloqueados por el servidor · `))).toBeInTheDocument();
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
    // Pulido r4 (CIM-12): la prueba competía con la transición del
    // formulario de ConfirmInline. El anuncio se pinta en cuanto la acción
    // responde, pero la transición (el botón ocupado) sigue abierta unos
    // ticks más; un rerender en ese hueco dejaba la confirmación de
    // encender a la vista. Ahora cada clic va dentro de act, se espera a
    // que la acción se llame y a que el botón se suelte, y el rerender (la
    // página con el estado nuevo) también va dentro de act.
    const espera = { timeout: ESPERA_UI_LARGA_MS };
    enableOutreach.mockResolvedValue(undefined);
    disableOutreach.mockResolvedValue(0);
    const clic = async (nombre: string) => {
      const boton = await screen.findByRole("button", { name: nombre }, espera);
      await waitFor(() => expect(boton).toBeEnabled(), espera);
      await act(async () => {
        fireEvent.click(boton);
      });
    };
    const confirmar = async (nombre: string, accion: typeof enableOutreach, anuncio: string) => {
      await clic(nombre);
      await waitFor(() => expect(accion).toHaveBeenCalledTimes(1), espera);
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(anuncio), espera);
      // La transición del formulario terminó: el botón que envía ya no está ocupado.
      await waitFor(() => {
        for (const b of screen.queryAllByRole("button", { name: nombre })) expect(b).not.toHaveAttribute("aria-busy");
      }, espera);
    };
    const { rerender } = render(interruptor());
    await clic(t.interruptor.encender);
    await confirmar(t.interruptor.siEncender, enableOutreach, t.interruptor.anuncioEncendido);
    await act(async () => {
      rerender(interruptor({ enabled: true }));
    });
    const titulo = screen.getByRole("heading", { name: t.interruptor.title });
    await waitFor(() => expect(titulo).toHaveFocus(), espera);
    expect(document.activeElement).not.toBe(document.body);

    await clic(t.interruptor.apagar);
    await confirmar(t.interruptor.siApagar, disableOutreach, t.interruptor.anuncioApagado);
    await act(async () => {
      rerender(interruptor({ enabled: false }));
    });
    await waitFor(() => expect(screen.getByRole("heading", { name: t.interruptor.title })).toHaveFocus(), espera);
  }, PRUEBA_LENTA_MS);

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
