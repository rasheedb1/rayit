"use client";

import Link from "next/link";
import { useOptimistic, useState, useTransition, type DragEvent } from "react";
import { Pill, type PillKind } from "@/components/ui/pill";
import { dealLabel } from "@/lib/negocio";
import { moverNegocio } from "../actions";
import { Aviso } from "../_componentes/aviso";
import { applyMove } from "../_lib/estado";
import { MESSAGES } from "../_lib/messages";

/** Un negocio listo para pintar: montos y fechas ya formateados en el servidor. */
export interface BoardDeal {
  id: string;
  companyId: string;
  companyName: string;
  name: string;
  stageId: string;
  stageLabel: string;
  daysInStage: number;
  amountText: string | null;
  nextAction: string | null;
  nextActionDueText: string | null;
  /** Null en los cerrados: a un negocio ganado no le vence nada. */
  due: { kind: PillKind; text: string } | null;
  needsNextAction: boolean;
  /** A dónde lleva «Cotizar»; null en los cerrados. */
  quoteHref: string | null;
}

/** Una columna con su cabecera ya contada y sumada en SQL. */
export interface BoardStage {
  id: string;
  label: string;
  countText: string;
  amountText: string;
}

type Move = { dealId: string; toStageId: string; toStageLabel: string };

/** El tipo MIME con el que viaja el id del negocio al arrastrar. */
const DRAG_TYPE = "application/x-oncue-deal";

/**
 * El tablero por etapa, con arrastrar y soltar.
 *
 * Arrastrar no es la única forma de mover: cada tarjeta tiene su menú
 * «Mover a», que funciona con teclado y con lector de pantalla. El
 * movimiento es optimista (la tarjeta cambia de columna al soltarla) y,
 * si el servidor lo rechaza, `useOptimistic` la devuelve sola a su
 * etapa cuando termina la transición.
 *
 * Los montos de cada columna NO se recalculan aquí: llegan de
 * getStageTotals, y la acción revalida la página para traerlos nuevos.
 */
export function PipelineBoard({ deals, stages }: { deals: BoardDeal[]; stages: BoardStage[] }) {
  const t = MESSAGES.pipeline;
  const [optimistic, addOptimistic] = useOptimistic(deals, (current: BoardDeal[], move: Move) => applyMove(current, move));
  const [pending, startTransition] = useTransition();
  const [aviso, setAviso] = useState<{ notice?: string; message?: string } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  function move(dealId: string, toStageId: string) {
    const deal = optimistic.find((d) => d.id === dealId);
    const stage = stages.find((s) => s.id === toStageId);
    if (!deal || !stage || deal.stageId === toStageId) return;
    setAviso(null);
    startTransition(async () => {
      addOptimistic({ dealId, toStageId, toStageLabel: stage.label });
      const res = await moverNegocio(dealId, toStageId);
      setAviso(res.ok ? { notice: t.moved(deal.companyName, stage.label) } : { message: res.message ?? t.moveError });
    });
  }

  function onDrop(event: DragEvent<HTMLElement>, stageId: string) {
    event.preventDefault();
    const dealId = event.dataTransfer.getData(DRAG_TYPE);
    setOver(null);
    setDragging(null);
    if (dealId) move(dealId, stageId);
  }

  return (
    <div aria-busy={pending || undefined}>
      <p className="mb-3 text-xs text-muted">{t.dragHint}</p>
      {/* El aviso se anuncia con role=status/alert; sin él, mover una
          tarjeta con el menú no le diría nada a un lector de pantalla. */}
      <Aviso message={aviso?.message} notice={aviso?.notice} className="mb-3" />

      {/* Scroll horizontal solo del tablero: a 400 px se ve una columna
          entera y se desliza, en vez de exprimir siete a la vez. */}
      <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
        <ul className="flex min-w-max gap-3">
          {stages.map((stage) => {
            const cards = optimistic.filter((d) => d.stageId === stage.id);
            const isOver = over === stage.id && dragging !== null;
            return (
              <li
                key={stage.id}
                className="w-64 shrink-0"
                aria-label={stage.label}
                onDragOver={(e) => {
                  if (!dragging) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (over !== stage.id) setOver(stage.id);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
                }}
                onDrop={(e) => onDrop(e, stage.id)}
              >
                <div className="mb-2 flex items-baseline justify-between gap-2 border-b border-border pb-2">
                  <span className="text-sm font-medium text-ink">{stage.label}</span>
                  <span className="text-xs tabular-nums text-muted">{stage.countText}</span>
                </div>
                <p className="mb-2 whitespace-nowrap text-xs tabular-nums text-muted">{stage.amountText}</p>

                <div
                  className={`min-h-24 rounded-md transition-colors ${isOver ? "bg-hover outline-2 outline-dashed outline-axis" : ""}`}
                  data-testid={`columna-${stage.id}`}
                >
                  {cards.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted">
                      {isOver ? t.dropHere(stage.label) : t.stageEmpty}
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {cards.map((deal) => (
                        <DealCard
                          key={deal.id}
                          deal={deal}
                          stages={stages}
                          dragging={dragging === deal.id}
                          onDragStart={() => setDragging(deal.id)}
                          onDragEnd={() => {
                            setDragging(null);
                            setOver(null);
                          }}
                          onMove={(to) => move(deal.id, to)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function DealCard({
  deal,
  stages,
  dragging,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  deal: BoardDeal;
  stages: BoardStage[];
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (toStageId: string) => void;
}) {
  const t = MESSAGES.pipeline;
  const selectId = `mover-${deal.id}`;

  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, deal.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={`relative cursor-grab rounded-md border bg-surface p-3 active:cursor-grabbing ${deal.needsNextAction ? "border-warn" : "border-border"} ${
        dragging ? "opacity-50" : ""
      }`}
      // El borde ámbar no puede ser la única señal: quien no distingue
      // el color necesita leerlo. `relative` no es decorativo: sin él, la
      // etiqueta sr-only del menú (absolute) escapa del scroll del
      // tablero y ensancha la página entera en el móvil.
      aria-label={deal.needsNextAction ? `${deal.companyName}, ${deal.name}. ${t.noNextAction}` : `${deal.companyName}, ${deal.name}`}
    >
      <Link href={`/ventas/empresas/${deal.companyId}`} className="text-sm font-medium leading-5 text-ink hover:underline" draggable={false}>
        {deal.companyName}
      </Link>
      {/* Un negocio que se llama como la marca (los viejos del radar): repetirlo es ruido. */}
      {dealLabel(deal.companyName, deal.name) && <p className="mt-0.5 text-xs leading-4 text-ink-2">{deal.name}</p>}

      <p className="mt-2 whitespace-nowrap text-sm tabular-nums text-ink">{deal.amountText ?? <span className="text-muted">{t.noAmount}</span>}</p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {deal.due && <Pill kind={deal.due.kind}>{deal.due.text}</Pill>}
        <span className="text-xs tabular-nums text-muted">{t.days(deal.daysInStage)}</span>
      </div>

      {(deal.nextAction || deal.needsNextAction) && (
        <p className="mt-2 text-xs leading-4 text-ink-2">
          {deal.nextAction ? (
            <>
              {deal.nextAction}
              {deal.nextActionDueText && <span className="text-muted"> · {deal.nextActionDueText}</span>}
            </>
          ) : (
            <span className="text-warn">{t.noNextAction}</span>
          )}
        </p>
      )}

      {deal.quoteHref && (
        <Link
          href={deal.quoteHref}
          draggable={false}
          aria-label={t.quoteLabel(deal.companyName)}
          className="mt-2 inline-block text-xs text-ink underline underline-offset-4 hover:text-ink-2"
        >
          {t.quote}
        </Link>
      )}

      <label htmlFor={selectId} className="sr-only">
        {t.moveToLabel(deal.companyName)}
      </label>
      <select
        id={selectId}
        value=""
        onChange={(e) => {
          if (e.target.value) onMove(e.target.value);
        }}
        className="mt-3 h-7 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-ink-2 hover:border-axis focus-visible:border-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/15"
      >
        <option value="">{t.moveTo}…</option>
        {stages
          .filter((s) => s.id !== deal.stageId)
          .map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
      </select>
    </li>
  );
}
