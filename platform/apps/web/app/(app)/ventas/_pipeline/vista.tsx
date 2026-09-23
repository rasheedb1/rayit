import Link from "next/link";
import type { PipelineDealRow, PipelineSeguimiento, StageTotal } from "@mc/db/queries/ventas";
import { SectionTitle } from "@/components/page-header";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { nextActionOf } from "@mc/db/queries/ventas-ficha";
import { EmptyState } from "@/components/ui/empty-state";
import type { Formatter } from "@/lib/format";
import { dealLabel } from "@/lib/negocio";
import { FICHA } from "../empresas/messages";
import { MESSAGES } from "../_lib/messages";
import { lostReasonText, type PipelineForma } from "../_lib/estado";
import { siguienteAccionData, ultimoContacto, type SeguimientoContexto } from "../_seguimiento/datos";
import { SiguienteAccion } from "../_seguimiento/siguiente-accion";
import { UltimoContacto } from "../_seguimiento/ultimo-contacto";
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
 *
 * La siguiente acción de cada negocio abierto (VEN-4) se edita en su
 * tarjeta y en su fila. Sale de la misma lectura que el negocio
 * (listPipeline trae el día, la hora y el responsable): un solo modelo de
 * «siguiente acción», sin una segunda consulta ni una versión de solo
 * lectura que mantener al lado.
 */
export function PipelineView({
  deals,
  stages,
  f,
  forma,
  filtro = null,
  ctx,
}: {
  deals: PipelineDealRow[];
  stages: StageTotal[];
  f: Formatter;
  forma: PipelineForma;
  /** La lista filtrada desde «Para hoy» (VEN-4): ya viene filtrada de SQL; aquí se dice y se ofrece quitarlo. */
  filtro?: PipelineSeguimiento | null;
  /** Lo que el editor de la siguiente acción necesita del espacio. Sin él (la vista del radar), no se pinta el pipeline. */
  ctx: SeguimientoContexto | null;
}) {
  const t = MESSAGES.pipeline;
  const x = FICHA.filtro;

  if (filtro && deals.length === 0) {
    return (
      <section aria-labelledby="pipeline">
        <SectionTitle>
          <span id="pipeline">{t.title}</span>
        </SectionTitle>
        <FormaSwitch forma={forma} />
        <EmptyState title={x.empty[filtro].title} description={x.empty[filtro].description} action={{ label: x.clear, href: LISTA_HREF }} />
      </section>
    );
  }

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
    currency: d.currency,
    // El atajo a Cotizar, solo en los abiertos: son los que Cotizar
    // ofrece (listQuotableDeals) y los que tiene sentido cotizar.
    quoteHref: d.isWon || d.isLost ? null : quoteHref(d.id),
    lostReasonText: lostReasonText(d.lostReason),
    // Un negocio cerrado no tiene siguiente acción aunque la fila la
    // conserve: «Enviar pitch» en un ganado solo confunde.
    siguiente: (() => {
      const row = ctx ? nextActionOf(d) : null;
      if (!row || !ctx) return null;
      const negocio = dealLabel(d.companyName, d.name);
      return siguienteAccionData(row, f, ctx, negocio ? `${d.companyName} · ${negocio}` : d.companyName);
    })(),
    // Los días los cuenta listPipeline en SQL; aquí solo se escriben.
    lastContact: ultimoContacto(d, f),
  }));
  const boardStages: BoardStage[] = stages.map((s) => ({
    id: s.stageId,
    label: s.labelEs,
    countText: f.int(s.dealCount),
    // Una columna vacía no dice «COP 0»: el conteo 0 ya lo dice (pulido r8).
    amountText: s.dealCount > 0 ? f.money(s.amount, undefined, { mode: "short" }) : null,
    isLost: s.isLost,
    isWon: s.isWon,
  }));

  return (
    <section aria-labelledby="pipeline">
      <SectionTitle meta={t.meta(deals.length)}>
        <span id="pipeline">{t.title}</span>
      </SectionTitle>

      <FormaSwitch forma={forma} />

      {filtro && (
        <p className="-mt-2 mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
          <span className="text-warn">{x[filtro]}</span>
          <Link href={LISTA_HREF} className="underline underline-offset-4 hover:text-ink">
            {x.clear}
          </Link>
        </p>
      )}

      {forma === "tablero" ? (
        <PipelineBoard deals={boardDeals} stages={boardStages} ctx={ctx} locale={f.locale} />
      ) : (
        <PipelineList deals={boardDeals} ctx={ctx} />
      )}
    </section>
  );
}

/** La lista del pipeline sin filtro: «Ver todos». */
const LISTA_HREF = "/ventas?vista=pipeline&forma=lista";

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

/**
 * La lista: los mismos negocios, en el orden del tablero (etapa y luego
 * fecha de la siguiente acción).
 *
 * Por debajo de sm no es una tabla: a 400 px sus seis columnas hacían
 * scroll dentro de la tabla y «Siguiente acción» —con su fecha y si está
 * vencida, que es lo que esta vista existe para enseñar— quedaba fuera de
 * la pantalla. Ahí cada negocio es una tarjeta, como en el tablero.
 */
function PipelineList({ deals, ctx }: { deals: BoardDeal[]; ctx: SeguimientoContexto | null }) {
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
    {
      key: "stage",
      header: t.columns.stage,
      render: (d) => (d.lostReasonText ? <CellMain sub={d.lostReasonText}>{d.stageLabel}</CellMain> : d.stageLabel),
    },
    { key: "amount", header: t.columns.amount, align: "num", render: (d) => d.amountText ?? <span className="text-muted">{t.noAmount}</span> },
    {
      key: "next",
      header: t.columns.nextAction,
      render: (d) => (d.siguiente && ctx ? <SiguienteAccion data={d.siguiente} ctx={ctx} compact /> : ""),
    },
    {
      key: "contact",
      header: FICHA.ultimoContacto.column,
      render: (d) => (d.lastContact ? <UltimoContacto data={d.lastContact} short /> : ""),
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
    <>
      <div className="hidden sm:block">
        <DataTable
          columns={columns}
          rows={deals}
          rowKey={(d) => d.id}
          caption={t.listCaption}
          emptyState={<EmptyState title={t.empty.title} description={t.empty.description} />}
        />
      </div>
      <ul aria-label={t.listCaption} className="flex flex-col gap-2 sm:hidden">
        {deals.map((d) => (
          <FilaMovil key={d.id} deal={d} ctx={ctx} />
        ))}
      </ul>
    </>
  );
}

/** Un negocio de la lista en el teléfono: marca y negocio; etapa y monto; la siguiente acción con su estado. */
function FilaMovil({ deal: d, ctx }: { deal: BoardDeal; ctx: SeguimientoContexto | null }) {
  const t = MESSAGES.pipeline;
  const negocio = dealLabel(d.companyName, d.name);
  return (
    <li className="rounded-md border border-border bg-surface p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/ventas/empresas/${d.companyId}`} className="text-sm font-medium text-ink hover:underline">
            {d.companyName}
          </Link>
          {negocio && <p className="mt-0.5 text-xs text-ink-2">{negocio}</p>}
        </div>
        <span className="shrink-0 whitespace-nowrap text-sm tabular-nums text-ink">
          {d.amountText ?? <span className="text-muted">{t.noAmount}</span>}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted">
        {d.stageLabel} · <span className="tabular-nums">{t.days(d.daysInStage)}</span>
        {d.lostReasonText && ` · ${d.lostReasonText}`}
      </p>
      {d.lastContact && <UltimoContacto data={d.lastContact} className="mt-1" />}
      {d.siguiente && ctx && (
        <div className="mt-2">
          <SiguienteAccion data={d.siguiente} ctx={ctx} compact />
        </div>
      )}
      {d.quoteHref && (
        <Link
          href={d.quoteHref}
          aria-label={t.quoteLabel(d.companyName)}
          className="mt-2 inline-block text-xs text-ink underline underline-offset-4 hover:text-ink-2"
        >
          {t.quote}
        </Link>
      )}
    </li>
  );
}
