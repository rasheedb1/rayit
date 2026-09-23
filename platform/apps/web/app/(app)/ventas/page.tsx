import type { Metadata } from "next";
import Link from "next/link";
import { getSalesKpis, getStageTotals, listPipeline, listSignals } from "@mc/db/queries/ventas";
import { PageHeader } from "@/components/page-header";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { RadarView } from "./_radar/vista";
import { PipelineView } from "./_pipeline/vista";
import { withWorkspace } from "./_lib/db";
import { MESSAGES } from "./_lib/messages";
import { MODULE_LINKS, tabKey } from "./_lib/estado";

export const metadata: Metadata = { title: "Ventas" };
// Lee la base en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

/**
 * La tira de navegación del módulo. Son enlaces, no botones: cada vista
 * tiene su URL, se puede compartir y el botón de atrás hace lo que se
 * espera. `aria-current="page"` es lo que un lector de pantalla
 * anuncia; el color solo lo acompaña.
 */
function ModuleTabs({ active }: { active: string }) {
  return (
    <nav aria-label={MESSAGES.tabs.label} className="mb-6 flex flex-wrap gap-1.5 border-b border-border pb-px">
      {MODULE_LINKS.map((link) => {
        const on = link.href === active;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={on ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              on ? "border-ink font-medium text-ink" : "border-transparent text-ink-2 hover:text-ink"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

export default async function VentasPage({ searchParams }: { searchParams: Promise<{ vista?: string }> }) {
  const params = await searchParams;
  const vista = tabKey(params.vista);

  // Una sola transacción para toda la pantalla: los KPI y la vista
  // activa se leen con el mismo workspace fijado y el mismo instante.
  const { kpis, signals, deals, stages } = await withWorkspace(async (tx) => ({
    kpis: await getSalesKpis(tx),
    signals: vista === "radar" ? await listSignals(tx, { status: "pending" }) : [],
    deals: vista === "pipeline" ? await listPipeline(tx) : [],
    stages: vista === "pipeline" ? await getStageTotals(tx) : [],
  }));

  const f = formatterFor(await getCurrentWorkspace());
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
          <Link href="/plan/ventas" className="text-xs text-muted underline-offset-4 hover:text-ink hover:underline">
            {t.header.plan}
          </Link>
        }
      />

      <KpiRow>
        <Kpi
          label={t.kpis.pending}
          value={f.int(kpis.pendingSignals)}
          note={pendingNote}
          href={kpis.pendingSignals > 0 ? "/ventas" : undefined}
        />
        <Kpi label={t.kpis.open} value={f.money(kpis.openAmount, kpis.currency, { mode: "compact" })} note={`${f.int(kpis.openDeals)} abiertos`} />
        <Kpi
          label={t.kpis.weighted}
          value={f.money(kpis.weightedAmount, kpis.currency, { mode: "compact" })}
          note={openNote ?? t.kpis.weightedNote}
        />
        <Kpi
          label={t.kpis.won}
          value={f.money(kpis.wonQuarter, kpis.currency, { mode: "compact" })}
          note={kpis.wonQuarterCount === 0 ? t.kpis.wonNoteZero : `${f.int(kpis.wonQuarterCount)} cerrados`}
        />
      </KpiRow>

      <div className="mt-10">
        <ModuleTabs active={vista === "radar" ? "/ventas" : "/ventas?vista=pipeline"} />
        {vista === "radar" ? <RadarView signals={signals} f={f} /> : <PipelineView deals={deals} stages={stages} f={f} />}
      </div>
    </>
  );
}
