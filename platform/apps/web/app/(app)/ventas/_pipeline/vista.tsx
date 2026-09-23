import Link from "next/link";
import type { PipelineDealRow, StageTotal } from "@mc/db/queries/ventas";
import { SectionTitle } from "@/components/page-header";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import type { Formatter } from "@/lib/format";
import { dealLabel } from "@/lib/negocio";
import { MESSAGES } from "../_lib/messages";
import { needsNextAction, pillForDue, type PipelineForma } from "../_lib/estado";
import { PipelineBoard, type BoardDeal, type BoardStage } from "./tablero";

/**
 * El pipeline en sus dos formas: el tablero por etapa (arrastrar y
 * soltar) y la lista. La forma viaja en la URL (`?forma=lista`) igual
 * que la vista, para que un enlace a «la lista del pipeline» se pueda
 * compartir.
 *
 * Este componente es de servidor: formatea montos y fechas con el
 * formateador del workspace y le pasa al tablero, que es de cliente,
 * los textos ya hechos. Los montos de cada columna llegan de
 * getStageTotals, sumados en SQL.
 */
export function PipelineView({
  deals,
  stages,
  f,
  forma,
}: {
  deals: PipelineDealRow[];
  stages: StageTotal[];
  f: Formatter;
  forma: PipelineForma;
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

  const boardDeals: BoardDeal[] = deals.map((d) => ({
    id: d.id,
    companyId: d.companyId,
    companyName: d.companyName,
    name: d.name,
    stageId: d.stageId,
    stageLabel: d.stageLabel,
    daysInStage: d.daysInStage,
    amountText: d.amount ? f.money(d.amount, d.currency, { mode: "short" }) : null,
    // Un negocio cerrado no tiene siguiente acción aunque la fila la
    // conserve: «Enviar pitch» en un ganado solo confunde.
    nextAction: d.isWon || d.isLost ? null : d.nextAction,
    nextActionDueText: d.isWon || d.isLost || !d.nextActionDue ? null : f.date(d.nextActionDue),
    due: d.isWon || d.isLost ? null : pillForDue(d.dueState),
    needsNextAction: needsNextAction(d),
    // El atajo a Cotizar, solo en los abiertos: son los que Cotizar
    // ofrece (listQuotableDeals) y los que tiene sentido cotizar.
    quoteHref: d.isWon || d.isLost ? null : quoteHref(d.id),
  }));
  const boardStages: BoardStage[] = stages.map((s) => ({
    id: s.stageId,
    label: s.labelEs,
    countText: f.int(s.dealCount),
    amountText: f.money(s.amount, undefined, { mode: "short" }),
  }));

  return (
    <section aria-labelledby="pipeline">
      <SectionTitle meta={t.meta(deals.length)}>
        <span id="pipeline">{t.title}</span>
      </SectionTitle>

      <FormaSwitch forma={forma} />

      {forma === "tablero" ? <PipelineBoard deals={boardDeals} stages={boardStages} /> : <PipelineList deals={boardDeals} />}
    </section>
  );
}

/** «Cotizar» desde un negocio: la nueva cotización ya lo trae elegido (COT-3). */
export function quoteHref(dealId: string): string {
  return `/cotizar/cotizaciones/nueva?negocio=${encodeURIComponent(dealId)}`;
}

/** Tablero o lista. Enlaces con aria-current, como las pestañas del módulo. */
function FormaSwitch({ forma }: { forma: PipelineForma }) {
  const t = MESSAGES.pipeline;
  const options: { key: PipelineForma; label: string; href: string }[] = [
    { key: "tablero", label: t.board, href: "/ventas?vista=pipeline" },
    { key: "lista", label: t.list, href: "/ventas?vista=pipeline&forma=lista" },
  ];
  return (
    <nav aria-label={t.viewLabel} className="mb-4 inline-flex gap-0.5 rounded-[7px] border border-border bg-surface-2 p-0.5">
      {options.map((o) => {
        const on = o.key === forma;
        return (
          <Link
            key={o.key}
            href={o.href}
            aria-current={on ? "page" : undefined}
            className={`rounded-[5px] px-2.5 py-1 text-sm font-medium transition-colors ${on ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink"}`}
          >
            {o.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** La lista: los mismos negocios, en el orden del tablero (etapa y luego fecha de la siguiente acción). */
function PipelineList({ deals }: { deals: BoardDeal[] }) {
  const t = MESSAGES.pipeline;
  const columns: Column<BoardDeal>[] = [
    {
      key: "deal",
      header: t.columns.deal,
      render: (d) => (
        <CellMain sub={dealLabel(d.companyName, d.name) ?? undefined}>
          <Link href={`/ventas/empresas/${d.companyId}`} className="hover:underline">
            {d.companyName}
          </Link>
        </CellMain>
      ),
    },
    { key: "stage", header: t.columns.stage, render: (d) => d.stageLabel },
    { key: "amount", header: t.columns.amount, align: "num", render: (d) => d.amountText ?? <span className="text-muted">{t.noAmount}</span> },
    {
      key: "next",
      header: t.columns.nextAction,
      render: (d) =>
        d.nextAction ? (
          <span className="flex flex-wrap items-center gap-1.5">
            {d.due && <Pill kind={d.due.kind}>{d.due.text}</Pill>}
            <span>
              {d.nextAction}
              {d.nextActionDueText && <span className="text-muted"> · {d.nextActionDueText}</span>}
            </span>
          </span>
        ) : d.needsNextAction ? (
          <span className="text-warn">{t.noNextAction}</span>
        ) : (
          ""
        ),
    },
    { key: "days", header: t.columns.daysInStage, align: "num", render: (d) => t.days(d.daysInStage) },
    {
      key: "quote",
      header: t.quote,
      align: "num",
      render: (d) =>
        d.quoteHref ? (
          <Link href={d.quoteHref} aria-label={t.quoteLabel(d.companyName)} className="text-sm text-ink underline underline-offset-4 hover:text-ink-2">
            {t.quote}
          </Link>
        ) : null,
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={deals}
      rowKey={(d) => d.id}
      caption={t.listCaption}
      emptyState={<EmptyState title={t.empty.title} description={t.empty.description} />}
    />
  );
}
