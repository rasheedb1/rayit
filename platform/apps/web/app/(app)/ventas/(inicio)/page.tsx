import type { Metadata } from "next";
import { getSalesKpis, getStageTotals, listPipeline, listSignals } from "@mc/db/queries/ventas";
import { PageHeader } from "@/components/page-header";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
// El (i) de las cifras es de Resumen (lo envuelve sin tocar el Kpi del
// kit, que es de Nicolás). Ventas lo usa tal cual para explicar el
// ponderado y el trimestre, en vez de contarlo en la cabecera.
import { KpiConInfo } from "../../resumen/kpi-con-info";
import { RadarView } from "../_radar/vista";
import { PipelineView } from "../_pipeline/vista";
import { withWorkspace } from "../_lib/db";
import { MESSAGES } from "../_lib/messages";
import { pipelineForma, tabKey } from "../_lib/estado";
import { ModuleTabs } from "../_componentes/pestanas";

export const metadata: Metadata = { title: MESSAGES.header.metaTitle };
// Lee la base en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

export default async function VentasPage({ searchParams }: { searchParams: Promise<{ vista?: string; forma?: string }> }) {
  const params = await searchParams;
  const vista = tabKey(params.vista);
  const forma = pipelineForma(params.forma);

  // Una sola transacción para toda la pantalla: los KPI y la vista
  // activa se leen con el mismo workspace fijado y el mismo instante.
  const { kpis, signals, deals, stages } = await withWorkspace(async (tx) => ({
    kpis: await getSalesKpis(tx),
    signals: vista === "radar" ? await listSignals(tx, { status: "pending" }) : [],
    deals: vista === "pipeline" ? await listPipeline(tx) : [],
    stages: vista === "pipeline" ? await getStageTotals(tx) : [],
  }));

  const workspace = await getCurrentWorkspace();
  const f = formatterFor(workspace);
  const t = MESSAGES;

  // Las notas de los KPI salen de números que ya vienen contados de
  // SQL; aquí solo se elige la frase.
  const pendingNote = kpis.pendingSignals === 0 ? t.kpis.pendingNoteZero : undefined;
  const openNote =
    kpis.overdueCount > 0
      ? t.kpis.overdue(kpis.overdueCount)
      : kpis.noNextActionCount > 0
        ? t.kpis.noNextAction(kpis.noNextActionCount)
        : undefined;

  return (
    <>
      <PageHeader
        eyebrow={t.header.eyebrow}
        title={t.header.title}
        description={t.header.description}
      />

      <KpiRow>
        <Kpi
          label={t.kpis.pending}
          value={f.int(kpis.pendingSignals)}
          note={pendingNote}
          href={kpis.pendingSignals > 0 ? "/ventas" : undefined}
        />
        <Kpi label={t.kpis.open} value={f.money(kpis.openAmount, kpis.currency, { mode: "short" })} note={t.kpis.openCount(f.int(kpis.openDeals))} />
        <KpiConInfo
          label={t.kpis.weighted}
          value={f.money(kpis.weightedAmount, kpis.currency, { mode: "short" })}
          note={openNote ?? t.kpis.weightedNote}
          info={[...t.kpis.weightedInfo]}
          infoLabel={t.kpis.infoLabel(t.kpis.weighted)}
        />
        <KpiConInfo
          label={t.kpis.won}
          value={f.money(kpis.wonQuarter, kpis.currency, { mode: "short" })}
          note={
            kpis.wonQuarterCount === 0
              ? t.kpis.wonNoteZero
              : t.kpis.wonCount(
                  f.int(kpis.wonQuarterCount),
                  kpis.wonQuarterNoAmountCount > 0 ? f.int(kpis.wonQuarterNoAmountCount) : undefined,
                )
          }
          info={[...t.kpis.wonInfo]}
          infoLabel={t.kpis.infoLabel(t.kpis.won)}
        />
      </KpiRow>

      <div className="mt-10">
        <ModuleTabs active={vista === "radar" ? "/ventas" : "/ventas?vista=pipeline"} />
        {vista === "radar" ? (
          <RadarView signals={signals} f={f} currency={workspace.currency} />
        ) : (
          <PipelineView deals={deals} stages={stages} f={f} forma={forma} />
        )}
      </div>
    </>
  );
}
