import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelUsage, FunnelStep, SequenceHealth } from "@mc/db/queries/actividad";
import { formatterFor } from "@/lib/format";

/**
 * La pantalla de actividad y sus dos piezas montables, con las acciones
 * del servidor falsas: la lista (selección, cancelar en masa con
 * confirmación, reintentar uno, el motivo que se despliega con teclado o
 * con el dedo), el aviso que sobrevive a que la lista se vacíe, el
 * reintento por tipo, el widget de uso con su semáforo (también «Sin
 * envío»), el embudo con la vista de flujo y sus explicaciones (que
 * Escape cierra) y la frontera propia de una pieza montada.
 */
const { cancelarSeleccion, reintentarUno, reintentarPorTipo, refresh } = vi.hoisted(() => ({
  cancelarSeleccion: vi.fn(async (ids: string[]) => ({ ok: `${ids.length} mensajes cancelados.` })),
  reintentarUno: vi.fn(async () => ({ ok: "1 mensaje volvió a la cola." })),
  reintentarPorTipo: vi.fn(async () => ({ ok: "2 mensajes volvieron a la cola." })),
  refresh: vi.fn(),
}));
vi.mock("./actions", () => ({ cancelarSeleccion, reintentarUno, reintentarPorTipo }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));

import { ListaActividad, type FilaVista } from "./lista";
import { PanelActividad } from "./panel";
import { ReintentarPorTipo } from "./reintentar";
import { FronteraWidget } from "./_componentes/frontera-widget";
import { UsoPorCanalVista, usoVista } from "./_componentes/uso-por-canal";
import { MetricasCadenciaVista, SERIES_EMBUDO } from "./_componentes/metricas-cadencia";

const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });
const onResultado = vi.fn();

const fila = (id: string, over: Partial<FilaVista> = {}): FilaVista => ({
  id,
  estado: "Programado",
  estadoKind: "neutral",
  titulo: `Mensaje ${id}`,
  contacto: `Persona ${id}`,
  contexto: "Marca A · Semana de prueba",
  paso: "Paso 1 · Correo",
  cuando: "Sale 26 de sept, 10:30 a. m.",
  cuandoCompleto: "Sale 26 de septiembre de 2026, 10:30 a. m.",
  cuenta: null,
  motivo: null,
  motivoCodigo: null,
  motivoTono: "muted",
  marcas: [],
  intentos: null,
  reintentable: false,
  bloqueo: null,
  reconectar: false,
  cancelable: true,
  enviando: false,
  fichaHref: "/ventas/empresas/x",
  ...over,
});

beforeEach(() => {
  cancelarSeleccion.mockClear();
  reintentarUno.mockClear();
  reintentarPorTipo.mockClear();
  onResultado.mockClear();
});

const filas = [
  fila("a", {
    estado: "Falló", estadoKind: "bad", reintentable: true, intentos: "5 intentos",
    motivo: "La cuenta del canal perdió el permiso y hay que reconectarla", motivoCodigo: "código: account_auth", motivoTono: "bad",
  }),
  fila("b"),
  fila("c", { estado: "Enviando", cancelable: false, enviando: true }),
];
const lista = (over: Partial<Parameters<typeof ListaActividad>[0]> = {}) => (
  <ListaActividad filas={filas} seleccionable caption="Mensajes · Cola" locale="es-CO" onResultado={onResultado} {...over} />
);

describe("la lista de la cola", () => {
  it("el motivo cortado se despliega con el teclado o con el dedo, con su código para soporte", () => {
    render(lista());
    const resumen = screen.getByText("La cuenta del canal perdió el permiso y hay que reconectarla").closest("summary")!;
    expect(resumen.querySelector(".truncate")).not.toBeNull();
    // Alcanzable por foco: un <summary> es un control nativo, no un title que solo ve un ratón.
    resumen.focus();
    expect(document.activeElement).toBe(resumen);
    const detalle = resumen.closest("details")!;
    expect(detalle.open).toBe(false);
    fireEvent.click(resumen);
    expect(detalle.open).toBe(true);
    expect(within(detalle).getByText("código: account_auth")).toBeTruthy();
    expect(within(detalle).getByText("Sale 26 de septiembre de 2026, 10:30 a. m.")).toBeTruthy();
  });

  it("selecciona lo cancelable (no lo que se está enviando) y cancela en masa tras confirmar", async () => {
    render(lista());
    expect(screen.queryByRole("checkbox", { name: "Seleccionar el mensaje a Persona c" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Seleccionar todo lo cancelable" }));
    expect(screen.getByText("2 seleccionados")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar seleccionados" }));
    expect(screen.getByText("¿Cancelar 2 mensajes?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sí, cancelar" }));
    await waitFor(() => expect(cancelarSeleccion).toHaveBeenCalledWith(["a", "b"]));
    await waitFor(() => expect(onResultado).toHaveBeenCalledWith({ ok: "2 mensajes cancelados." }));
  });

  it("«Reintentar» solo en el fallido reintentable; uno bloqueado dice por qué y uno de la cuenta caída lleva a canales", async () => {
    render(lista({
      filas: [
        ...filas,
        fila("d", { estado: "Falló", cancelable: true, bloqueo: "No se reintenta: ya salió un paso posterior." }),
        fila("e", { estado: "Falló", cancelable: true, reconectar: true }),
      ],
    }));
    const reintentar = screen.getAllByRole("button", { name: "Reintentar" });
    expect(reintentar).toHaveLength(1);
    expect(screen.getByText("No se reintenta: ya salió un paso posterior.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ir a canales" }).getAttribute("href")).toBe("/ventas/canales");
    fireEvent.click(reintentar[0]!);
    await waitFor(() => expect(reintentarUno).toHaveBeenCalledWith("a"));
    await waitFor(() => expect(onResultado).toHaveBeenCalledWith({ ok: "1 mensaje volvió a la cola." }));
  });

  it("el historial no lleva casillas", () => {
    render(lista({ filas: [fila("d", { cancelable: false })], seleccionable: false, caption: "Mensajes · Historial" }));
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("el panel: el aviso sobrevive a que la lista se vacíe", () => {
  const vacio = { titulo: "La cola está vacía", descripcion: "Nada que salir." };

  it("tras cancelar lo último, la lista se vuelve el vacío y el aviso sigue ahí, con el foco", async () => {
    const props = { tipos: [], sequenceId: null, contact: null, seleccionable: true, caption: "Mensajes · Cola", locale: "es-CO", vacio };
    const { rerender } = render(<PanelActividad {...props} filas={[fila("a"), fila("b"), fila("c")]} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Seleccionar todo lo cancelable" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar seleccionados" }));
    fireEvent.click(screen.getByRole("button", { name: "Sí, cancelar" }));
    const aviso = await screen.findByText("3 mensajes cancelados.");
    // La revalidación del servidor vuelve a pintar la página sin filas: el panel sigue montado (mismo key).
    rerender(<PanelActividad {...props} filas={[]} />);
    expect(screen.getByText("La cola está vacía")).toBeTruthy();
    expect(screen.getByText("3 mensajes cancelados.")).toBe(aviso);
    expect(document.activeElement).toBe(aviso);
  });
});

describe("reintentar por tipo de paso", () => {
  it("un botón por tipo, con los filtros de la pantalla; el resultado sube al panel", async () => {
    render(<ReintentarPorTipo tipos={[{ stepType: "email", label: "Correo · 2" }]} sequenceId="s1" contact="sofía" onResultado={onResultado} />);
    fireEvent.click(screen.getByRole("button", { name: /Correo · 2/ }));
    await waitFor(() => expect(reintentarPorTipo).toHaveBeenCalledWith({ stepType: "email", sequenceId: "s1", contact: "sofía" }));
    await waitFor(() => expect(onResultado).toHaveBeenCalledWith({ ok: "2 mensajes volvieron a la cola." }));
  });

  it("sin nada que reintentar, no pinta nada", () => {
    const { container } = render(<ReintentarPorTipo tipos={[]} sequenceId={null} contact={null} onResultado={onResultado} />);
    expect(container.textContent).toBe("");
  });
});

const uso = (over: Partial<ChannelUsage>): ChannelUsage => ({
  accountId: "acc", channel: "email", accountName: "laura@marca-a.test", accountStatus: "connected", used: 17, softLimit: 16,
  hardLimit: 20, limitedBy: "day", dailyLimit: 50, dayLimit: 20, weekUsed: 60, weeklyLimit: 200, workspaceUsed: 17, workspaceLimit: 80,
  providerLimit: 2000, warmingUp: true, level: "near", offReason: null, usedShare: 0.85, softShare: 0.8,
  history: [{ day: "2026-09-25", used: 17, limit: 20, share: 0.85, level: "near" }], ...over,
});

describe("el uso por canal", () => {
  it("cada cuenta con su cifra, su semáforo en palabras, sus dos límites y el calentamiento", () => {
    render(<UsoPorCanalVista cuentas={[usoVista(uso({}), f), usoVista(uso({ accountId: "li", channel: "linkedin", accountName: "Laura Méndez", used: 25, hardLimit: 25, softLimit: 20, dailyLimit: 25, dayLimit: 25, providerLimit: 100, warmingUp: false, level: "full", usedShare: 1, workspaceUsed: null, workspaceLimit: null }), f)]} />);
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

  it("cuando manda la semana o el espacio, lo dice; y una cuenta sin envío nunca va en verde", () => {
    render(<UsoPorCanalVista cuentas={[
      usoVista(uso({ accountId: "li", channel: "linkedin", used: 3, hardLimit: 3, limitedBy: "week", weekUsed: 100, weeklyLimit: 100, level: "full", warmingUp: false, workspaceUsed: null, workspaceLimit: null }), f),
      usoVista(uso({ limitedBy: "workspace", workspaceUsed: 79, workspaceLimit: 80, warmingUp: false }), f),
      usoVista(uso({ accountId: "caida", level: "off", offReason: "account", used: 0, usedShare: 0, warmingUp: false }), f),
    ]} />);
    expect(screen.getByText("Manda el tope semanal de la cuenta: 100 de 100 esta semana")).toBeTruthy();
    expect(screen.getByText("Manda el tope de correos del espacio: 79 de 80 hoy entre todas las cuentas")).toBeTruthy();
    expect(screen.getByText("Sin envío")).toBeTruthy();
    expect(screen.queryByText("Con margen")).toBeNull();
    expect(screen.getByRole("link", { name: "Reconectar" }).getAttribute("href")).toBe("/ventas/canales");
  });

  it("sin cuentas, lo dice", () => {
    render(<UsoPorCanalVista cuentas={[]} />);
    expect(screen.getByText("Conecta una cuenta para ver su uso.")).toBeTruthy();
  });
});

describe("la frontera de una pieza montada", () => {
  it("si la pieza falla, cae ella sola con un aviso y «Volver a intentar» pide la página otra vez", () => {
    const Rota = () => {
      throw new Error("relation \"outbound_usage_daily\" does not exist");
    };
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <div>
        <p>El resto de la pantalla</p>
        <FronteraWidget aviso="No pudimos cargar el uso de hoy.">
          <Rota />
        </FronteraWidget>
      </div>,
    );
    expect(screen.getByText("El resto de la pantalla")).toBeTruthy();
    expect(within(screen.getByRole("alert")).getByText("No pudimos cargar el uso de hoy.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Volver a intentar" }));
    expect(refresh).toHaveBeenCalled();
    consola.mockRestore();
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

  it("«Respondidos» no va en el color de alerta: solo «Positivos» lleva un color semántico", () => {
    expect(SERIES_EMBUDO.map((s) => s.color)).toEqual(["deemph", "accent", "tiktok", "good"]);
  });

  it("cada cifra se explica: el tooltip es su descripción, aparece con el foco y Escape lo cierra", () => {
    render(<MetricasCadenciaVista sequenceId="s1" health={salud} funnel={[paso(1), paso(3)]} f={f} />);
    const flujo = screen.getByRole("region", { name: "Flujo de la cadencia" });
    const respondidos = within(flujo).getAllByText("respondidos")[0]!.closest("[tabindex]") as HTMLElement;
    const tooltip = document.getElementById(respondidos.getAttribute("aria-describedby")!)!;
    expect(tooltip.getAttribute("role")).toBe("tooltip");
    expect(tooltip.textContent).toContain("2: de los enviados, los que recibieron respuesta");
    expect(tooltip.textContent).toContain("40");
    expect(tooltip.className).toContain("hidden");
    act(() => respondidos.focus());
    expect(tooltip.className).not.toContain("hidden");
    expect(tooltip.className).not.toContain("pointer-events-none");
    fireEvent.keyDown(respondidos, { key: "Escape" });
    expect(tooltip.className).toContain("hidden");
    expect(document.activeElement).toBe(respondidos);
    // LinkedIn no avisa de la apertura: la cifra no se inventa.
    const abiertos = within(flujo).getAllByText("abiertos")[1]!.closest("[tabindex]")!;
    expect(document.getElementById(abiertos.getAttribute("aria-describedby")!)!.textContent).toBe("Este canal no avisa cuando se abre un mensaje.");
  });

  it("sin envíos todavía, lo dice en vez de un gráfico vacío", () => {
    render(<MetricasCadenciaVista sequenceId="s1" health={{ ...salud, sent: 0, health: "healthy" }} funnel={[paso(1, { sent: 0 })]} f={f} />);
    expect(screen.getByText("Todavía no sale nada de esta cadencia")).toBeTruthy();
  });
});
