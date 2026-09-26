import type { Metadata } from "next";
import { countHiddenSignals } from "@mc/db/queries/brief";
import { getStageConversion } from "@mc/db/queries/conversion";
import {
  PIPELINE_SEGUIMIENTOS,
  getSalesKpis,
  getStageTotals,
  listOwnerOptions,
  listPipeline,
  listSignals,
  type PipelineSeguimiento,
} from "@mc/db/queries/ventas";
import { getLocalDates, nextActionOf } from "@mc/db/queries/ventas-ficha";
import { countUrgentOutreachAlerts } from "@mc/db/queries/entregabilidad";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { Pill } from "@/components/ui/pill";
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
import { contextoDeSeguimiento } from "../_seguimiento/datos";
import { ParaHoy } from "../_seguimiento/para-hoy";

export const metadata: Metadata = { title: MESSAGES.header.metaTitle };
// Lee la base en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

export default async function VentasPage({
  searchParams,
}: {
  searchParams: Promise<{ vista?: string; forma?: string; seguimiento?: string; ocultas?: string }>;
}) {
  const params = await searchParams;
  const vista = tabKey(params.vista);
  const forma = pipelineForma(params.forma);
  // «Ponérsela» y «y N más» de «Para hoy» llevan a la lista filtrada
  // (?seguimiento=sin_accion|para_hoy). En el tablero no se filtra: sus
  // columnas suman todo el pipeline (getStageTotals) y no cuadrarían.
  const filtro: PipelineSeguimiento | null =
    forma === "lista" && PIPELINE_SEGUIMIENTOS.includes(params.seguimiento as PipelineSeguimiento)
      ? (params.seguimiento as PipelineSeguimiento)
      : null;

  // «Verlas»: las señales que el brief activo deja fuera, marcadas (VEN-7).
  const verOcultas = params.ocultas === "1";

  // Una sola transacción para toda la pantalla: los KPI y la vista
  // activa se leen con el mismo workspace fijado y el mismo instante.
  const { kpis, signals, hidden, deals, stages, conversion, owners, dates, urgentes } = await withWorkspace(async (tx) => ({
    kpis: await getSalesKpis(tx),
    signals: vista === "radar" ? await listSignals(tx, { status: "pending", brief: verOcultas ? "show_hidden" : "apply" }) : [],
    hidden: vista === "radar" ? await countHiddenSignals(tx) : null,
    deals: vista === "pipeline" ? await listPipeline(tx, { seguimiento: filtro }) : [],
    stages: vista === "pipeline" ? await getStageTotals(tx) : [],
    conversion: vista === "pipeline" ? await getStageConversion(tx) : [],
    // La siguiente acción de cada negocio abierto, editable en la tarjeta
    // (VEN-4), sale de listPipeline: aquí solo las personas y el reloj.
    owners: vista === "pipeline" ? await listOwnerOptions(tx) : [],
    dates: vista === "pipeline" ? await getLocalDates(tx) : null,
    // Los avisos urgentes del outreach de hoy (VEN-15): la web no tiene
    // campana, así que se señalan junto al enlace a la política.
    urgentes: await countUrgentOutreachAlerts(tx),
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
        aside={
          <Button variant="ghost" href={urgentes > 0 ? "/ventas/politica#salud" : "/ventas/politica"}>
            {t.header.politica}
            {urgentes > 0 && <Pill kind="bad">{t.header.politicaUrgentes(f.int(urgentes), urgentes)}</Pill>}
          </Button>
        }
      />

      {/* VEN-4: lo vencido y lo de hoy, antes que cualquier cifra. */}
      <ParaHoy />

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
          info={t.kpis.wonInfo(f.zoneName())}
          infoLabel={t.kpis.infoLabel(t.kpis.won)}
        />
      </KpiRow>

      <div className="mt-10">
        <ModuleTabs active={vista === "radar" ? "/ventas" : "/ventas?vista=pipeline"} />
        {vista === "radar" ? (
          <RadarView
            signals={signals}
            f={f}
            currency={workspace.currency}
            hidden={hidden ? { count: hidden.total, showing: verOcultas } : undefined}
          />
        ) : (
          <PipelineView
            deals={deals}
            stages={stages}
            conversion={conversion}
            f={f}
            forma={forma}
            filtro={filtro}
            ctx={dates ? contextoDeSeguimiento(owners, deals.flatMap((d) => nextActionOf(d) ?? []), dates, f) : null}
          />
        )}
      </div>
    </>
  );
}
