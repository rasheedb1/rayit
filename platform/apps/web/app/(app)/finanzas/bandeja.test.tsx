import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReminderRow } from "@mc/db/queries/finanzas";

// La Server Action no se ejerce aquí: la bandeja es servidor, y lo que
// se comprueba es qué pinta y qué manda el formulario.
vi.mock("./recordatorios-actions", () => ({ marcarRecordatorioEnviado: vi.fn() }));

import { BandejaRecordatorios, RecordatoriosDeLaFactura } from "./bandeja";
import { formatterFor } from "@/lib/format";

const f = formatterFor({ currency: "COP", locale: "es-CO", timezone: "America/Bogota" });
const FACTURA = "00000003-0000-4000-8000-0000fac26007";

const fila = (over: Partial<ReminderRow> = {}): ReminderRow => ({
  id: "00000004-0000-4000-8000-00000000fa03",
  paso: 3,
  etiquetaEs: "Primer aviso de mora",
  severity: "warning",
  asunto: "Factura FV-2026-007 pendiente · 41 días de mora",
  cuerpo: "Hola, equipo de Hogar Lindo:\n\nLa factura FV-2026-007 lleva 41 días de mora.",
  actionUrl: `/finanzas/facturas/${FACTURA}?recordatorio=3`,
  invoiceId: FACTURA,
  invoiceNumber: "FV-2026-007",
  companyName: "Hogar Lindo",
  currency: "COP",
  outstanding: "1100000.00",
  dueOn: "2026-08-13",
  daysOverdue: 41,
  createdAt: "2026-09-23T10:00:00Z",
  sentAt: null,
  ...over,
});

describe("bandeja de recordatorios", () => {
  it("cuenta los que hay por enviar y muestra asunto, cuerpo y las dos acciones", () => {
    const rows = [
      fila({ id: "a", paso: 2, etiquetaEs: "Aviso de vencimiento", severity: "info" }),
      fila({ id: "b" }),
      fila({ id: "c", paso: 4, etiquetaEs: "Segundo aviso de mora" }),
    ];
    render(<BandejaRecordatorios rows={rows} f={f} />);

    expect(screen.getByText("3 recordatorios por enviar")).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(3);

    const uno = screen.getAllByRole("article")[1]!;
    expect(within(uno).getByRole("heading", { level: 3 })).toHaveTextContent("Hogar Lindo · FV-2026-007");
    expect(within(uno).getByText("Primer aviso de mora")).toBeInTheDocument();
    expect(within(uno).getByText("41 días de mora")).toBeInTheDocument();
    // El monto sale con la moneda de la factura y el locale del workspace.
    expect(within(uno).getByText("COP 1.100.000")).toBeInTheDocument();
    expect(uno.textContent).toContain("Factura FV-2026-007 pendiente · 41 días de mora");
    expect(uno.textContent).toContain("Hola, equipo de Hogar Lindo:");
    expect(within(uno).getByRole("button", { name: /copiar/i })).toBeInTheDocument();
    expect(within(uno).getByRole("button", { name: "Marcar como enviado" })).toBeInTheDocument();
    expect(within(uno).getByRole("link", { name: "Ver la factura" })).toHaveAttribute("href", `/finanzas/facturas/${FACTURA}`);
  });

  it("uno solo se cuenta en singular", () => {
    render(<BandejaRecordatorios rows={[fila()]} f={f} />);
    expect(screen.getByText("1 recordatorio por enviar")).toBeInTheDocument();
  });

  it("sin recordatorios explica por qué, sin guion mudo ni un cero suelto", () => {
    render(<BandejaRecordatorios rows={[]} f={f} />);
    const vacio = screen.getByRole("status");
    expect(vacio).toHaveTextContent("No hay recordatorios por enviar");
    expect(vacio.textContent).toContain("una semana antes del vencimiento");
    expect(screen.queryByText("—")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Marcar como enviado" })).not.toBeInTheDocument();
  });

  it("el que ya se marcó muestra la fecha en vez del botón", () => {
    render(<BandejaRecordatorios rows={[fila({ sentAt: "2026-09-23T15:00:00Z" })]} f={f} />);
    expect(screen.queryByRole("button", { name: "Marcar como enviado" })).not.toBeInTheDocument();
    expect(screen.getByText(/Marcado como enviado el/)).toBeInTheDocument();
  });

  it("antes del vencimiento dice cuánto falta, y el día que vence lo dice", () => {
    render(<BandejaRecordatorios rows={[fila({ daysOverdue: -7, paso: 1, etiquetaEs: "Recordatorio amable", severity: "info" })]} f={f} />);
    expect(screen.getByText(f.daysRelative(7))).toBeInTheDocument();

    render(<BandejaRecordatorios rows={[fila({ daysOverdue: 0 })]} f={f} />);
    expect(screen.getByText("vence hoy")).toBeInTheDocument();
  });

  it("un día de mora va en singular", () => {
    render(<BandejaRecordatorios rows={[fila({ daysOverdue: 1 })]} f={f} />);
    expect(screen.getByText("1 día de mora")).toBeInTheDocument();
  });
});

describe("los recordatorios en la ficha de la factura", () => {
  it("lista los que tiene, incluidos los ya marcados", () => {
    render(<RecordatoriosDeLaFactura rows={[fila(), fila({ id: "d", sentAt: "2026-09-20T15:00:00Z" })]} f={f} />);
    expect(screen.getByRole("heading", { name: "Recordatorios de esta factura" })).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getByText(/Marcado como enviado el/)).toBeInTheDocument();
  });

  it("sin ninguno lo explica con una frase", () => {
    render(<RecordatoriosDeLaFactura rows={[]} f={f} />);
    expect(screen.getByText(/se escriben solos desde una semana antes del vencimiento/)).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});
