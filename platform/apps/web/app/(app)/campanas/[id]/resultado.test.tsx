import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BrandInputs, CampaignResultRow } from "@mc/db";
import { formatterFor } from "@/lib/format";
import { Resultado, type ResultadoProps } from "./resultado";

/**
 * La sección «Resultado» (CAM-5) pinta lo que hay en campaign_result y
 * nada más: las cifras de Café Alma tal como las deja el recálculo, y
 * donde falta un dato la frase, nunca un cero.
 */

const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "UTC" });
const SIN_APORTES: BrandInputs = { totals: [], daily: [], currency: "COP" };

/** Café Alma recalculada (packages/db/test/campanas.test.ts la deja así). */
const CAFE_ALMA: CampaignResultRow = {
  campaignId: "00000003-0000-4000-8000-000000ca0001",
  computedAt: "2026-09-23T07:30:00Z",
  cutHours: 720,
  views: 712000, reach: 486000, interactions: 57530, saves: 9600, shares: 5100, linkClicks: 6240,
  reachNonFollowersPct: "0.58025", viewsVsMedian: "4.496",
  brandFollowersGained: 1240, brandFollowersBaselineRate: "12.9286", brandFollowersCampaignRate: "155.0000",
  codeRedemptions: 318, attributedRevenue: "8400000.00", currency: "COP",
  cpm: "4353.93", costPerFollower: "2500.00", cpa: "9748.43", emv: null,
  missingInputs: ["brand_csv_sales"],
};

/** Nutrivé: sin nada de la marca. */
const NUTRIVE: CampaignResultRow = {
  ...CAFE_ALMA,
  campaignId: "00000003-0000-4000-8000-000000ca0003",
  views: 58000, reach: 41000, linkClicks: 420, reachNonFollowersPct: "0.53659", viewsVsMedian: "1.234",
  brandFollowersGained: null, brandFollowersBaselineRate: null, brandFollowersCampaignRate: null,
  codeRedemptions: null, attributedRevenue: null, cpm: "81034.48", costPerFollower: null, cpa: null,
  missingInputs: ["brand_followers", "brand_inputs"],
};

function pintar(props: Partial<ResultadoProps> = {}) {
  const recompute = vi.fn(async () => {});
  render(
    <Resultado
      campaignId={CAFE_ALMA.campaignId}
      status="reported"
      editable
      result={CAFE_ALMA}
      brandInputs={SIN_APORTES}
      canRecompute={false}
      recompute={recompute}
      f={f}
      {...props}
    />,
  );
  return recompute;
}

/** El valor que enseña un KPI, por su etiqueta. */
const valor = (label: string) => within(screen.getByText(label).parentElement as HTMLElement);

describe("Resultado", () => {
  it("los seis KPIs de Café Alma salen de la tabla, con su nota", () => {
    pintar();
    valor("Views").getByText("712.000");
    valor("Views").getByText("4,5× tu mediana");
    valor("Alcance").getByText("486.000");
    valor("Alcance").getByText("58 % no te seguía");
    valor("Clics al enlace").getByText("6.240");
    valor("Canjes del código").getByText("318");
    valor("Canjes del código").getByText(/8,4 M en ventas atribuidas/);
    valor("Seguidores ganados por la marca").getByText("1.240");
    valor("Seguidores ganados por la marca").getByText("12× su ritmo previo");
    valor("CPM").getByText("COP 4.353,93");
    valor("CPM").getByText("CPA COP 9.748,43");
    expect(screen.getByText(/resultado calculado a 30 días/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "el CSV de ventas diarias de la marca" })).toHaveAttribute("href", `/campanas/${CAFE_ALMA.campaignId}#aporte`);
  });

  it("sin datos de la marca la celda lo dice, nunca un cero", () => {
    pintar({ result: NUTRIVE, status: "closed", editable: false });
    valor("Canjes del código").getByText("Sin datos de la marca");
    valor("Seguidores ganados por la marca").getByText("Sin datos de la marca");
    valor("CPM").getByText("CPA sin datos de la marca");
    for (const label of ["Canjes del código", "Seguidores ganados por la marca"]) {
      expect(valor(label).queryByText(/^0$/)).toBeNull();
    }
    expect(screen.getByRole("link", { name: "los seguidores de la marca" })).toBeInTheDocument();
    expect(screen.getByText(/conserva su resultado/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Recalcular" })).toBeNull();
  });

  it("sin posts medidos lo dice en views, alcance, clics y CPM; «posts» sin enlace si la campaña no admite cambios", () => {
    pintar({ result: { ...NUTRIVE, views: null, reach: null, linkClicks: null, cpm: null, reachNonFollowersPct: null, viewsVsMedian: null, missingInputs: ["posts"] }, editable: false });
    for (const label of ["Views", "Alcance", "Clics al enlace", "CPM"]) valor(label).getByText("Sin posts medidos");
    expect(screen.getByText(/^posts con lecturas/).closest("a")).toBeNull();
    expect(screen.getByText(/resultado calculado sin posts medidos/)).toBeInTheDocument();
    expect(screen.queryByText(/a 30 días/)).toBeNull();
  });

  it("un CPM vacío dice por qué solo si missing_inputs lo sabe", () => {
    pintar({ result: { ...NUTRIVE, cpm: null, missingInputs: ["amount"] } });
    valor("CPM").getByText("Sin monto acordado");
  });

  it("un CPM vacío sin causa registrada (la fila del seed de Nutrivé) no inventa el porqué", () => {
    pintar({ result: { ...NUTRIVE, cpm: null } });
    valor("CPM").getByText("Sin calcular");
    expect(screen.queryByText("Sin monto acordado")).toBeNull();
  });

  it("con línea base corta no presume un «×N»; la nota del CPA dice la causa real", () => {
    pintar({ result: { ...CAFE_ALMA, cpa: null, missingInputs: ["amount", "brand_followers_baseline_short"] } });
    valor("Seguidores ganados por la marca").getByText("línea base corta: sin ritmo comparable");
    expect(screen.queryByText(/su ritmo previo/)).toBeNull();
    valor("CPM").getByText("CPA sin monto acordado");
  });

  it("dice qué concepto sale del CSV y qué ingresos no se atribuyen por la moneda", () => {
    pintar({
      brandInputs: {
        currency: "COP",
        daily: [],
        totals: [
          { kind: "code_redemptions", source: "brand_manual", semantics: "total", value: "318.00", currency: null, asOf: "2026-09-11", from: null, count: 1 },
          { kind: "revenue", source: "brand_manual", semantics: "total", value: "400.00", currency: "USD", asOf: "2026-09-11", from: null, count: 1 },
          { kind: "code_redemptions", source: "brand_csv", semantics: "daily", value: "5.00", currency: null, asOf: "2026-09-08", from: "2026-09-02", count: 4 },
        ],
      },
    });
    expect(screen.getByText("Los canjes salen del CSV de ventas; el total por formulario queda como respaldo.")).toBeInTheDocument();
    expect(screen.getByText(/están en USD: no se atribuyen a un resultado en COP/)).toBeInTheDocument();
  });

  it("un resultado a 7 días se marca parcial", () => {
    pintar({ result: { ...CAFE_ALMA, cutHours: 168 } });
    expect(screen.getByText(/parcial, a 7 días/)).toBeInTheDocument();
  });

  it("«Recalcular» solo aparece si la base deja escribir; si no, dice que se recalcula cada mañana", () => {
    pintar();
    expect(screen.queryByRole("button", { name: "Recalcular" })).toBeNull();
    expect(screen.getByText("Se recalcula cada mañana.")).toBeInTheDocument();
  });

  it("con el permiso de la base, «Recalcular» envía la acción", () => {
    const recompute = pintar({ canRecompute: true });
    fireEvent.click(screen.getByRole("button", { name: "Recalcular" }));
    expect(recompute).toHaveBeenCalled();
  });

  it("completo a 30 días en una campaña midiendo: sugiere marcar el reporte listo", () => {
    pintar({ status: "measuring", result: { ...CAFE_ALMA, missingInputs: [] } });
    expect(screen.getByRole("status")).toHaveTextContent("Resultado completo a 30 días");
  });

  it("sin fila todavía: el vacío que explica cuándo llega", () => {
    pintar({ result: null, status: "planned" });
    expect(screen.getByText("Todavía no hay resultado")).toBeInTheDocument();
    expect(screen.getByText(/todavía no tiene posts que medir/)).toBeInTheDocument();
  });
});
