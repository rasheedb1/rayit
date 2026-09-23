import type { PipelineDealRow, StageTotal } from "@mc/db/queries/ventas";
import { SectionTitle } from "@/components/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import type { Formatter } from "@/lib/format";
import { MESSAGES } from "../_lib/messages";
import { needsNextAction, pillForDue } from "../_lib/estado";

/**
 * El tablero por etapa. Cada columna lleva su monto en la cabecera
 * —como Pipedrive— y ese monto NO se suma aquí: llega de
 * getStageTotals, que lo agrupa en SQL sobre la vista deal_pipeline.
 *
 * Las columnas son todas las etapas, también las vacías: un tablero al
 * que le faltan columnas según el día no se puede leer de un vistazo.
 */
export function PipelineView({
  deals,
  stages,
  f,
}: {
  deals: PipelineDealRow[];
  stages: StageTotal[];
  f: Formatter;
}) {
  const t = MESSAGES.pipeline;

  if (deals.length === 0) {
    return (
      <section aria-labelledby="pipeline">
        <SectionTitle>
          <span id="pipeline">{t.title}</span>
        </SectionTitle>
        <EmptyState title={t.empty.title} description={t.empty.description} action={{ label: t.empty.action, href: "/ventas" }} />
      </section>
    );
  }

  return (
    <section aria-labelledby="pipeline">
      <SectionTitle meta={`${deals.length} ${deals.length === 1 ? "negocio" : "negocios"}`}>
        <span id="pipeline">{t.title}</span>
      </SectionTitle>

      {/* Scroll horizontal solo del tablero: a 400 px se ve una columna
          entera y se desliza, en vez de exprimir siete a la vez. */}
      <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
        <ul className="flex min-w-max gap-3">
          {stages.map((stage) => (
            <StageColumn key={stage.stageId} stage={stage} deals={deals.filter((d) => d.stageId === stage.stageId)} f={f} />
          ))}
        </ul>
      </div>
    </section>
  );
}

function StageColumn({ stage, deals, f }: { stage: StageTotal; deals: PipelineDealRow[]; f: Formatter }) {
  const t = MESSAGES.pipeline;
  return (
    <li className="w-64 shrink-0">
      <div className="mb-2 flex items-baseline justify-between gap-2 border-b border-border pb-2">
        <span className="text-sm font-medium text-ink">{stage.labelEs}</span>
        <span className="text-xs tabular-nums text-muted">{f.int(stage.dealCount)}</span>
      </div>
      <p className="mb-2 text-xs tabular-nums text-muted">{f.money(stage.amount, undefined, { mode: "compact" })}</p>

      {deals.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted">{t.stageEmpty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {deals.map((deal) => (
            <DealCard key={deal.id} deal={deal} f={f} />
          ))}
        </ul>
      )}
    </li>
  );
}

function DealCard({ deal, f }: { deal: PipelineDealRow; f: Formatter }) {
  const t = MESSAGES.pipeline;
  const due = pillForDue(deal.dueState);
  const marcado = needsNextAction(deal);

  return (
    <li
      className={`rounded-md border bg-surface p-3 ${marcado ? "border-warn" : "border-border"}`}
      // El borde ámbar no puede ser la única señal: quien no distingue
      // el color necesita leerlo.
      aria-label={marcado ? `${deal.name}. ${t.noNextAction}` : undefined}
    >
      <p className="text-sm font-medium leading-5 text-ink">{deal.companyName}</p>
      <p className="mt-0.5 text-xs leading-4 text-ink-2">{deal.name}</p>

      <p className="mt-2 text-sm tabular-nums text-ink">
        {deal.amount ? f.money(deal.amount, deal.currency, { mode: "compact" }) : <span className="text-muted">{t.noAmount}</span>}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {!deal.isWon && !deal.isLost && <Pill kind={due.kind}>{due.text}</Pill>}
        <span className="text-xs tabular-nums text-muted">{t.days(deal.daysInStage)}</span>
      </div>

      <p className="mt-2 text-xs leading-4 text-ink-2">
        {deal.nextAction ? (
          <>
            {deal.nextAction}
            {deal.nextActionDue && <span className="text-muted"> · {f.date(deal.nextActionDue)}</span>}
          </>
        ) : marcado ? (
          <span className="text-warn">{t.noNextAction}</span>
        ) : null}
      </p>
    </li>
  );
}
