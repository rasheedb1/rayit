import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ActivityRow } from "@mc/db/queries/ventas-ficha";
import { formatterFor } from "@/lib/format";
import { LineaDeTiempo } from "./linea-de-tiempo";

const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });

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
  meta: { lostReason: null, quoteNumber: null, durationMin: 20 },
};

describe("LineaDeTiempo", () => {
  it("sin actividad invita a registrar la primera", () => {
    render(<LineaDeTiempo rows={[]} hasMore={false} companyName="Café Alma" f={f} />);
    expect(screen.getByText("Todavía no hay actividad")).toBeInTheDocument();
  });

  it("cada actividad dice qué, quién, cuándo, de qué negocio y con quién", () => {
    render(<LineaDeTiempo rows={[base]} hasMore={false} companyName="Café Alma" f={f} />);
    const item = within(screen.getByRole("list", { name: "Historia de la empresa, la más reciente primero" })).getByRole("listitem");
    expect(within(item).getByText("Llamada")).toBeInTheDocument();
    expect(item).toHaveTextContent("Ana");
    expect(item).toHaveTextContent("Renovación Q4");
    expect(item).toHaveTextContent("con Laura Gómez");
    expect(item).toHaveTextContent("20 min");
    expect(within(item).getByText("Quedamos en enviar la propuesta el lunes")).toBeInTheDocument();
    expect(item.querySelector("time")).toHaveAttribute("dateTime", "2026-09-23T15:00:00Z");
    expect(item.querySelector("time")).toHaveTextContent(f.time(base.occurredAt));
  });

  it("lo que deja el producto va en la misma historia, firmado por On Cue, con el motivo de una pérdida", () => {
    const rows: ActivityRow[] = [
      { ...base, id: "a2", kind: "stage_change", subject: "Propuesta → Perdido", body: null, userName: null, contactName: null, meta: { lostReason: "precio", quoteNumber: null, durationMin: null } },
      { ...base, id: "a3", kind: "signal_detected", subject: "Pauta en TikTok", body: null, userName: null, contactName: null, dealName: null, meta: { lostReason: null, quoteNumber: null, durationMin: null } },
    ];
    render(<LineaDeTiempo rows={rows} hasMore companyName="Café Alma" f={f} />);
    const [etapa, senal] = screen.getAllByRole("listitem");
    expect(etapa).toHaveTextContent("Cambio de etapa · Propuesta → Perdido");
    expect(etapa).toHaveTextContent("On Cue");
    expect(etapa).toHaveTextContent("Por el precio");
    expect(senal).toHaveTextContent("Señal detectada · Pauta en TikTok");
    expect(screen.getByText("Se ven las 2 más recientes.")).toBeInTheDocument();
  });
});
