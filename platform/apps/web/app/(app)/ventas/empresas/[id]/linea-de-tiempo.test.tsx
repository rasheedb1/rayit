import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityRow } from "@mc/db/queries/ventas-ficha";
import { formatterFor } from "@/lib/format";

const verMasActividad = vi.fn();
vi.mock("../actions", () => ({ verMasActividad: (...a: unknown[]) => verMasActividad(...a) }));

import { vistaDeActividad } from "./actividad";
import { LineaDeTiempo } from "./linea-de-tiempo";

const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });
const COMPANY = "00000002-0000-4000-8000-0000000000e1";

const base: ActivityRow = {
  id: "a1",
  kind: "call",
  subject: null,
  body: "Quedamos en enviar la propuesta el lunes",
  occurredAt: "2026-09-23T15:00:00Z",
  dealId: "00000006-0000-4000-8000-000000000001",
  dealName: "Renovación Q4",
  contactName: "Laura Gómez",
  userName: "Ana",
  meta: { lostReason: null, quoteNumber: null, durationMin: 20, timeUnknown: false },
};
const sinMeta = { lostReason: null, quoteNumber: null, durationMin: null, timeUnknown: false };

const vista = (rows: ActivityRow[]) => vistaDeActividad(rows, "Café Alma", f);

beforeEach(() => verMasActividad.mockReset());

describe("LineaDeTiempo", () => {
  it("sin actividad invita a registrar la primera", () => {
    render(<LineaDeTiempo companyId={COMPANY} items={[]} nextCursor={null} />);
    expect(screen.getByText("Todavía no hay actividad")).toBeInTheDocument();
  });

  it("cada actividad dice qué, quién, cuándo, de qué negocio y con quién", () => {
    render(<LineaDeTiempo companyId={COMPANY} items={vista([base])} nextCursor={null} />);
    const item = within(screen.getByRole("list", { name: "Historia de la empresa, la más reciente primero" })).getByRole("listitem");
    expect(within(item).getByText("Llamada")).toBeInTheDocument();
    expect(item).toHaveTextContent("Ana");
    expect(item).toHaveTextContent("Renovación Q4");
    expect(item).toHaveTextContent("con Laura Gómez");
    expect(item).toHaveTextContent("20 min");
    expect(within(item).getByText("Quedamos en enviar la propuesta el lunes")).toBeInTheDocument();
    expect(item.querySelector("time")).toHaveAttribute("dateTime", "2026-09-23T15:00:00Z");
    expect(item.querySelector("time")).toHaveTextContent(f.time(base.occurredAt));
    // Sin más páginas no hay «Ver más».
    expect(screen.queryByRole("button", { name: "Ver más" })).toBeNull();
  });

  it("lo que deja el producto va en la misma historia, firmado por On Cue, con el motivo de una pérdida", () => {
    const rows: ActivityRow[] = [
      { ...base, id: "a2", kind: "stage_change", subject: "Propuesta → Perdido", body: null, userName: null, contactName: null, meta: { ...sinMeta, lostReason: "precio" } },
      { ...base, id: "a3", kind: "signal_detected", subject: "Pauta en TikTok", body: null, userName: null, contactName: null, dealName: null, meta: sinMeta },
    ];
    render(<LineaDeTiempo companyId={COMPANY} items={vista(rows)} nextCursor={null} />);
    const [etapa, senal] = screen.getAllByRole("listitem");
    expect(etapa).toHaveTextContent("Cambio de etapa · Propuesta → Perdido");
    expect(etapa).toHaveTextContent("On Cue");
    expect(etapa).toHaveTextContent("Por el precio");
    expect(senal).toHaveTextContent("Señal detectada · Pauta en TikTok");
  });

  it("una llamada sin autor guardado la escribió una persona: «Alguien del equipo», no «On Cue»", () => {
    const rows: ActivityRow[] = (["call", "note", "email_sent", "meeting"] as const).map((kind, i) => ({
      ...base,
      id: `m${i}`,
      kind,
      userName: null,
    }));
    render(<LineaDeTiempo companyId={COMPANY} items={vista(rows)} nextCursor={null} />);
    for (const item of screen.getAllByRole("listitem")) {
      expect(item).toHaveTextContent("Alguien del equipo");
      expect(item).not.toHaveTextContent("On Cue");
    }
  });

  it("registrada para un día anterior sin hora: solo la fecha, no un «12:00 p. m.» que nadie dijo", () => {
    const ayer: ActivityRow = { ...base, id: "a4", occurredAt: "2026-09-22T17:00:00Z", meta: { ...sinMeta, timeUnknown: true } };
    render(<LineaDeTiempo companyId={COMPANY} items={vista([ayer])} nextCursor={null} />);
    const time = screen.getByRole("listitem").querySelector("time");
    expect(time).toHaveTextContent(f.date(ayer.occurredAt));
    expect(time).not.toHaveTextContent(f.time(ayer.occurredAt));
  });

  it("«Ver más» trae las anteriores por cursor, las añade debajo y lleva el foco a la primera nueva", async () => {
    const vieja: ActivityRow = { ...base, id: "a9", body: "Primera llamada", occurredAt: "2026-09-01T15:00:00Z" };
    verMasActividad.mockResolvedValue({ items: vista([vieja]), nextCursor: null });
    render(<LineaDeTiempo companyId={COMPANY} items={vista([base])} nextCursor="2026-09-23T15:00:00.000000Z_a1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ver más" }));
    });
    expect(verMasActividad).toHaveBeenCalledWith(COMPANY, "2026-09-23T15:00:00.000000Z_a1");
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[1]).toHaveTextContent("Primera llamada");
    expect(document.activeElement).toBe(items[1]);
    // Era la última página: el botón se va.
    expect(screen.queryByRole("button", { name: "Ver más" })).toBeNull();
  });

  it("si «Ver más» falla, lo dice y deja reintentar", async () => {
    verMasActividad.mockResolvedValue({ error: "No se pudo traer la actividad anterior. Vuelve a intentarlo." });
    render(<LineaDeTiempo companyId={COMPANY} items={vista([base])} nextCursor="c1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ver más" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("No se pudo traer la actividad anterior");
    expect(screen.getByRole("button", { name: "Ver más" })).toBeInTheDocument();
  });
});
