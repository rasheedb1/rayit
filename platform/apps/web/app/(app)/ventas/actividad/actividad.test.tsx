import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelUsage, FunnelStep, SequenceHealth } from "@mc/db/queries/actividad";
import { formatterFor } from "@/lib/format";

/**
 * La pantalla de actividad y sus dos piezas montables, con las acciones
 * del servidor falsas: la lista (selección, cancelar en masa con
 * confirmación, reintentar uno), el reintento por tipo, el widget de uso
 * con su semáforo y el embudo con la vista de flujo y sus explicaciones.
 */
const { cancelarSeleccion, reintentarUno, reintentarPorTipo } = vi.hoisted(() => ({
  cancelarSeleccion: vi.fn(async (ids: string[]) => ({ ok: `${ids.length} mensajes cancelados.` })),
  reintentarUno: vi.fn(async () => ({ ok: "1 mensaje volvió a la cola." })),
  reintentarPorTipo: vi.fn(async () => ({ ok: "2 mensajes volvieron a la cola." })),
}));
vi.mock("./actions", () => ({ cancelarSeleccion, reintentarUno, reintentarPorTipo }));
vi.mock("@/lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));

import { ListaActividad, type FilaVista } from "./lista";
import { ReintentarPorTipo } from "./reintentar";
import { UsoPorCanalVista, usoVista } from "./_componentes/uso-por-canal";
import { MetricasCadenciaVista } from "./_componentes/metricas-cadencia";

const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });

const fila = (id: string, over: Partial<FilaVista> = {}): FilaVista => ({
  id,
  estado: "Programado",
  estadoKind: "neutral",
  titulo: `Mensaje ${id}`,
  contacto: `Persona ${id}`,
  contexto: "Marca A · Semana de prueba",
  paso: "Paso 1 · Correo",
  cuando: "Sale 26 sep 10:30",
  cuandoTitulo: null,
  motivo: null,
  motivoDetalle: null,
  motivoTono: "muted",
  marcas: [],
  intentos: null,
  reintentable: false,
  noReintentable: false,
  cancelable: true,
  enviando: false,
  fichaHref: "/ventas/empresas/x",
  ...over,
});

beforeEach(() => {
  cancelarSeleccion.mockClear();
  reintentarUno.mockClear();
  reintentarPorTipo.mockClear();
});

describe("la lista de la cola", () => {
  const filas = [
    fila("a", {
      estado: "Falló", estadoKind: "bad", reintentable: true, intentos: "5 intentos",
      motivo: "Fallaron los cinco intentos", motivoDetalle: "Fallaron los cinco intentos (código: max_attempts)", motivoTono: "bad",
    }),
    fila("b"),
    fila("c", { estado: "Enviando", cancelable: false, enviando: true }),
  ];

  it("el fallido enseña su motivo cortado, con la frase entera y el código al pasar el cursor", () => {
    render(<ListaActividad filas={filas} seleccionable caption="Mensajes · Cola" locale="es-CO" />);
    const motivo = screen.getByText("Fallaron los cinco intentos");
    expect(motivo.closest("p")?.getAttribute("title")).toBe("Fallaron los cinco intentos (código: max_attempts)");
    expect(motivo.closest("p")?.className).toContain("truncate");
  });

  it("selecciona lo cancelable (no lo que se está enviando) y cancela en masa tras confirmar", async () => {
    render(<ListaActividad filas={filas} seleccionable caption="Mensajes · Cola" locale="es-CO" />);
    expect(screen.queryByRole("checkbox", { name: "Seleccionar el mensaje a Persona c" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Seleccionar todo lo cancelable" }));
    expect(screen.getByText("2 seleccionados")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar seleccionados" }));
    expect(screen.getByText("¿Cancelar 2 mensajes?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sí, cancelar" }));
    await waitFor(() => expect(cancelarSeleccion).toHaveBeenCalledWith(["a", "b"]));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("2 mensajes cancelados."));
  });

  it("«Reintentar» en un fallido llama a la acción con su id y anuncia el resultado", async () => {
    render(<ListaActividad filas={filas} seleccionable caption="Mensajes · Cola" locale="es-CO" />);
    const reintentar = screen.getAllByRole("button", { name: "Reintentar" });
    expect(reintentar).toHaveLength(1);
    fireEvent.click(reintentar[0]!);
    await waitFor(() => expect(reintentarUno).toHaveBeenCalledWith("a"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("1 mensaje volvió a la cola."));
  });

  it("el historial no lleva casillas", () => {
    render(<ListaActividad filas={[fila("d", { cancelable: false })]} seleccionable={false} caption="Mensajes · Historial" locale="es-CO" />);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("reintentar por tipo de paso", () => {
  it("un botón por tipo, con los filtros de la pantalla", async () => {
    render(<ReintentarPorTipo tipos={[{ stepType: "email", label: "Correo · 2" }]} sequenceId="s1" contact="sofía" />);
    fireEvent.click(screen.getByRole("button", { name: /Correo · 2/ }));
    await waitFor(() => expect(reintentarPorTipo).toHaveBeenCalledWith({ stepType: "email", sequenceId: "s1", contact: "sofía" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("2 mensajes volvieron a la cola."));
  });

  it("sin nada que reintentar ni resultado, no pinta nada", () => {
    const { container } = render(<ReintentarPorTipo tipos={[]} sequenceId={null} contact={null} />);
    expect(container.textContent).toBe("");
  });
});

const uso = (over: Partial<ChannelUsage>): ChannelUsage => ({
  accountId: "acc", channel: "email", accountName: "laura@marca-a.test", accountStatus: "connected", used: 17, softLimit: 16,
  hardLimit: 20, dailyLimit: 50, providerLimit: 2000, warmingUp: true, level: "near", usedShare: 0.85, softShare: 0.8,
  history: [{ day: "2026-09-25", used: 17, limit: 20, share: 0.85, level: "near" }], ...over,
});

describe("el uso por canal", () => {
  it("cada cuenta con su cifra, su semáforo en palabras, sus dos límites y el calentamiento", () => {
    render(<UsoPorCanalVista cuentas={[usoVista(uso({}), f), usoVista(uso({ accountId: "li", channel: "linkedin", accountName: "Laura Méndez", used: 25, hardLimit: 25, softLimit: 20, dailyLimit: 25, providerLimit: 100, warmingUp: false, level: "full", usedShare: 1 }), f)]} />);
    const meters = screen.getAllByRole("meter");
    expect(meters).toHaveLength(2);
    expect(meters[0]!.getAttribute("aria-valuetext")).toBe("laura@marca-a.test: 17 de 20 hoy, Cerca del límite");
    expect(screen.getByText("Cerca del límite")).toBeTruthy();
    expect(screen.getByText("Límite alcanzado")).toBeTruthy();
    expect(screen.getByText("Límite blando 16")).toBeTruthy();
    expect(screen.getByText("Límite duro 20")).toBeTruthy();
    expect(screen.getByText("Calentando: hoy hasta 20, luego sube hasta 50")).toBeTruthy();
    expect((meters[1]!.getAttribute("style") ?? "").replace(/\s/g, "")).toContain("--usado:1");
  });

  it("sin cuentas, lo dice", () => {
    render(<UsoPorCanalVista cuentas={[]} />);
    expect(screen.getByText("Conecta una cuenta para ver su uso.")).toBeTruthy();
  });
});

const paso = (n: number, over: Partial<FunnelStep> = {}): FunnelStep => ({
  stepId: `p${n}`, position: n, stepType: n === 3 ? "linkedin_message" : "email", channel: n === 3 ? "linkedin" : "email",
  dayOffset: (n - 1) * 2, opensTracked: n !== 3, touches: 8, sent: 5, opened: 3, replied: 2, positive: 2, pending: 0, failed: 3, stopped: 0,
  openRate: 0.6, replyRate: 0.4, positiveRate: 0.4, ...over,
});
const salud: SequenceHealth = {
  sequenceId: "s1", name: "Semana de prueba", status: "active", steps: 3, enrolled: 8, enrolledActive: 4, enrolledPaused: 0,
  enrolledReplied: 3, enrolledCompleted: 1, enrolledStopped: 0, pending: 5, held: 1, failed: 4, sent: 9, replied: 4, positive: 3,
  sent7d: 7, failed7d: 4, lastSentAt: null, nextDueAt: null, replyRate: 0.4444, positiveRate: 0.3333, failureRate7d: 0.3636, health: "failing",
};

describe("el embudo y la vista de flujo de la cadencia", () => {
  it("la salud en palabras, las cifras de arriba y un paso por nodo con la espera entre ellos", () => {
    render(<MetricasCadenciaVista sequenceId="s1" health={salud} funnel={[paso(1), paso(2), paso(3, { sent: 0, opened: 0, replied: 0, positive: 0, openRate: null, replyRate: null, positiveRate: null })]} f={f} />);
    expect(screen.getByText("Fallando")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ver en la actividad" }).getAttribute("href")).toBe("/ventas/actividad?cadencia=s1");
    const flujo = screen.getByRole("region", { name: "Flujo de la cadencia" });
    const nodos = within(flujo).getAllByRole("listitem", { name: /^Paso \d/ });
    expect(nodos.map((n) => n.getAttribute("aria-label"))).toEqual([
      "Paso 1 · Día 0 · Correo", "Paso 2 · Día 2 · Correo", "Paso 3 · Día 4 · Mensaje en LinkedIn",
    ]);
  });

  it("cada cifra se explica: el tooltip es su descripción, también con teclado", () => {
    render(<MetricasCadenciaVista sequenceId="s1" health={salud} funnel={[paso(1), paso(3)]} f={f} />);
    const flujo = screen.getByRole("region", { name: "Flujo de la cadencia" });
    const respondidos = within(flujo).getAllByText("respondidos")[0]!.closest("[tabindex]")!;
    const tooltip = document.getElementById(respondidos.getAttribute("aria-describedby")!)!;
    expect(tooltip.getAttribute("role")).toBe("tooltip");
    expect(tooltip.textContent).toContain("2: de los enviados, los que recibieron respuesta");
    expect(tooltip.textContent).toContain("40");
    // LinkedIn no avisa de la apertura: la cifra no se inventa.
    const abiertos = within(flujo).getAllByText("abiertos")[1]!.closest("[tabindex]")!;
    expect(document.getElementById(abiertos.getAttribute("aria-describedby")!)!.textContent).toBe("Este canal no avisa cuando se abre un mensaje.");
  });

  it("sin envíos todavía, lo dice en vez de un gráfico vacío", () => {
    render(<MetricasCadenciaVista sequenceId="s1" health={{ ...salud, sent: 0, health: "healthy" }} funnel={[paso(1, { sent: 0 })]} f={f} />);
    expect(screen.getByText("Todavía no sale nada de esta cadencia")).toBeTruthy();
  });
});
