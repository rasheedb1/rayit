import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CampaignReportRow } from "@mc/db";
import { formatterFor } from "@/lib/format";

// Las Server Actions se sustituyen: aquí importa qué ofrece la sección en cada estado.
vi.mock("./actions", () => ({ generarReporte: vi.fn(), marcarReporteEnviado: vi.fn() }));

import { MESSAGES } from "../_lib/messages";
import { ReporteSeccion } from "./reporte-seccion";

const t = MESSAGES.reporte;
const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });
const CAMPANA = "00000003-0000-4000-8000-000000ca0001";

function reporte(extra: Partial<CampaignReportRow> = {}): CampaignReportRow {
  return {
    id: "00000000-0000-4000-8000-00000000a001",
    campaignId: CAMPANA,
    slug: "abcdefghjkmnpqrstuvwxyz234",
    status: "draft",
    sentAt: null,
    sentVia: null,
    viewedAt: null,
    viewCount: 0,
    createdAt: "2026-09-23T15:00:00Z",
    supersededById: null,
    ...extra,
  };
}

describe("ReporteSeccion (CAM-6)", () => {
  it("una campaña planeada sin reporte explica por qué no hay nada que generar", () => {
    render(<ReporteSeccion campaignId={CAMPANA} status="planned" reports={[]} origin="https://on-cue.test" f={f} />);
    expect(screen.getByText(t.noDisponible.planned)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t.generar })).toBeNull();
  });

  it("sin reporte ofrece «Generar reporte» con lo que hace", () => {
    render(<ReporteSeccion campaignId={CAMPANA} status="measuring" reports={[]} origin="https://on-cue.test" f={f} />);
    expect(screen.getByRole("button", { name: t.generar })).toBeInTheDocument();
    expect(screen.getByText(t.ayudaSinReporte)).toBeInTheDocument();
  });

  it("un borrador: enlace absoluto con el origen público, aviso de que no abre y los dos «Enviado»", () => {
    render(<ReporteSeccion campaignId={CAMPANA} status="measuring" reports={[reporte()]} origin="https://on-cue.test" f={f} />);
    expect(screen.getByText("https://on-cue.test/reporte/abcdefghjkmnpqrstuvwxyz234")).toBeInTheDocument();
    expect(screen.getByText(t.enlaceBorrador)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t.marcarEnlace })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t.marcarPdf })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t.previsualizar })).toHaveAttribute("href", `/campanas/${CAMPANA}/reporte/${reporte().id}`);
  });

  it("enviado y abierto: fechas en frases, sin botones de enviar, y «Generar de nuevo» explica las versiones", () => {
    const r = reporte({ status: "viewed", sentAt: "2026-09-23T16:00:00Z", sentVia: "pdf", viewedAt: "2026-09-24T13:00:00Z", viewCount: 3 });
    render(<ReporteSeccion campaignId={CAMPANA} status="reported" reports={[r]} origin="https://on-cue.test" f={f} />);
    expect(screen.getByText(/^Enviado como PDF el /)).toBeInTheDocument();
    expect(screen.getByText(/^Abierto por la marca el .* · 3 aperturas$/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t.marcarEnlace })).toBeNull();
    expect(screen.getByRole("button", { name: t.regenerar })).toBeInTheDocument();
    expect(screen.getByText(t.ayudaEnviado)).toBeInTheDocument();
  });

  it("enviado y sin abrir lo dice con una frase, no con un guion", () => {
    const r = reporte({ status: "sent", sentAt: "2026-09-23T16:00:00Z", sentVia: "link" });
    render(<ReporteSeccion campaignId={CAMPANA} status="reported" reports={[r]} origin="https://on-cue.test" f={f} />);
    expect(screen.getByText(t.sinAbrir)).toBeInTheDocument();
  });

  it("sin origen público no inventa un enlace: muestra la ruta y por qué", () => {
    render(<ReporteSeccion campaignId={CAMPANA} status="measuring" reports={[reporte()]} origin={null} f={f} />);
    expect(screen.getByText("/reporte/abcdefghjkmnpqrstuvwxyz234")).toBeInTheDocument();
    expect(screen.getByText(t.sinOrigen)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /copiar/i })).toBeNull();
  });

  it("con varias versiones las lista y marca la reemplazada", () => {
    const nueva = reporte({ id: "00000000-0000-4000-8000-00000000a002", status: "sent", sentAt: "2026-09-25T10:00:00Z", sentVia: "link" });
    const vieja = reporte({ status: "viewed", sentAt: "2026-09-23T16:00:00Z", sentVia: "link", viewedAt: "2026-09-24T13:00:00Z", supersededById: nueva.id });
    render(<ReporteSeccion campaignId={CAMPANA} status="reported" reports={[nueva, vieja]} origin="https://on-cue.test" f={f} />);
    expect(screen.getByText(t.versiones)).toBeInTheDocument();
    expect(screen.getByText(t.version(2))).toBeInTheDocument();
    expect(screen.getByText(t.version(1))).toBeInTheDocument();
    expect(screen.getByText(t.versionReemplazada)).toBeInTheDocument();
  });
});
