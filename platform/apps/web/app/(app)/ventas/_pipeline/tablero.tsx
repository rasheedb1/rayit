"use client";

import Link from "next/link";
import { useEffect, useOptimistic, useState, useTransition, type DragEvent, type FormEvent } from "react";
import { MONTO_MAXIMO, excedeMontoMaximo } from "@mc/core";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { formatMoney } from "@/lib/format";
import { dealLabel } from "@/lib/negocio";
import { moverNegocio } from "../actions";
import { Aviso } from "../../_lib/aviso";
import { Dialogo } from "../_componentes/dialogo";
import { LOST_REASON_OPTIONS, applyMove } from "../_lib/estado";
import { MESSAGES } from "../_lib/messages";
import type { SeguimientoContexto, SiguienteAccionData, UltimoContactoData } from "../_seguimiento/datos";
import { SiguienteAccion } from "../_seguimiento/siguiente-accion";
import { UltimoContacto } from "../_seguimiento/ultimo-contacto";
import { StageConversionRow, type ConversionView } from "./conversion";

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
  /** La moneda del negocio: la del monto que se pide al ganarlo si no tiene. */
  currency: string;
  /** A dónde lleva «Cotizar»; null en los cerrados. */
  quoteHref: string | null;
  /** Por qué se perdió («Por el precio»); null si no está perdido o no se dijo. */
  lostReasonText: string | null;
  /**
   * La siguiente acción, editable en la tarjeta (VEN-4); null en los
   * cerrados, que no tienen: a un negocio ganado no le vence nada.
   */
  siguiente: SiguienteAccionData | null;
  /**
   * «Último contacto: hace 3 días» (VEN-5), o «Sin contacto todavía»;
   * null en los cerrados. Hace cuántos días no se le habla es la señal de
   * que un negocio se enfría.
   */
  lastContact: UltimoContactoData | null;
}

/** Un negocio abierto sin siguiente acción: la tarjeta lo marca en ámbar y lo dice. */
export function sinSiguienteAccion(deal: Pick<BoardDeal, "siguiente">): boolean {
  return deal.siguiente !== null && deal.siguiente.action === null;
}

/** Una columna con su cabecera ya contada y sumada en SQL. */
export interface BoardStage {
  id: string;
  label: string;
  countText: string;
  /** Null en una columna vacía: no se pinta «COP 0» encima de «Nada aquí». */
  amountText: string | null;
  /** Una etapa perdida: pasar a ella pide el motivo. */
  isLost: boolean;
  /** Una etapa ganada: pasar a ella un negocio sin monto pide el monto. */
  isWon: boolean;
  /** La conversión de la etapa (VEN-8), ya escrita; null en las cerradas. */
  conversion: ConversionView | null;
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
 *
 * Soltar (o elegir en el menú) una etapa perdida no mueve todavía: abre
 * un diálogo, «¿Por qué lo pierdes?», con el motivo obligatorio (VEN-8).
 * Sin motivo el servidor tampoco lo mueve (LostReasonRequired), y la base
 * no deja llegar al COMMIT un perdido sin motivo (0043).
 *
 * Debajo de cada columna abierta va su conversión (StageConversionRow):
 * qué parte de los negocios que entraron llegó más lejos, y sobre cuántos.
 *
 * Soltar en una etapa ganada un negocio «Sin monto» tampoco mueve
 * todavía: pregunta «¿Por cuánto lo ganaste?» en la tarjeta. Sin monto el
 * servidor no lo mueve (AmountRequired): si no, «N cerrados» subía y
 * «Ganado este trimestre» no, y las dos cifras dejaban de cuadrar.
 *
 * `locale` es el del espacio: con él se escribe el tope del monto ganado
 * cuando alguien pone ceros de más (pulido r8).
 */
export function PipelineBoard({
  deals,
  stages,
  ctx,
  locale,
}: {
  deals: BoardDeal[];
  stages: BoardStage[];
  ctx: SeguimientoContexto | null;
  locale?: string;
}) {
  const t = MESSAGES.pipeline;
  const [optimistic, addOptimistic] = useOptimistic(deals, (current: BoardDeal[], move: Move) => applyMove(current, move));
  const [pending, startTransition] = useTransition();
  const [aviso, setAviso] = useState<{ notice?: string; message?: string } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  /**
   * El negocio al que se le está preguntando algo antes de moverlo, y a
   * qué etapa va: por qué se pierde, o por cuánto se gana si no tiene monto.
   */
  const [pregunta, setPregunta] = useState<{ dealId: string; toStageId: string; kind: "lost" | "won" } | null>(null);
  /**
   * El negocio que se acaba de mover: su tarjeta se desmonta de una
   * columna y se monta en otra, y el foco caía en <body>. Cuando termina,
   * vuelve a su menú «Mover a», en la columna donde quedó (pulido r8).
   */
  const [focusDeal, setFocusDeal] = useState<string | null>(null);

  useEffect(() => {
    if (!focusDeal || pending) return;
    document.getElementById(`mover-${focusDeal}`)?.focus();
    setFocusDeal(null);
  }, [focusDeal, pending, optimistic]);

  function move(dealId: string, toStageId: string, extra: { lostReason?: string; amount?: string } = {}) {
    const deal = optimistic.find((d) => d.id === dealId);
    const stage = stages.find((s) => s.id === toStageId);
    if (!deal || !stage || deal.stageId === toStageId) return;
    setAviso(null);
    if (stage.isLost && !extra.lostReason) {
      setPregunta({ dealId, toStageId, kind: "lost" });
      return;
    }
    if (stage.isWon && deal.amountText === null && !extra.amount) {
      setPregunta({ dealId, toStageId, kind: "won" });
      return;
    }
    setPregunta(null);
    startTransition(async () => {
      addOptimistic({ dealId, toStageId, toStageLabel: stage.label });
      const res = extra.lostReason || extra.amount ? await moverNegocio(dealId, toStageId, extra) : await moverNegocio(dealId, toStageId);
      setAviso(
        res.ok
          ? {
              notice: res.closedQuotes?.length
                ? `${t.moved(deal.companyName, stage.label)} ${t.quotesClosed(res.closedQuotes)}`
                : t.moved(deal.companyName, stage.label),
            }
          : { message: res.message ?? t.moveError },
      );
      setFocusDeal(dealId);
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
                <p className="mb-2 min-h-4 whitespace-nowrap text-xs tabular-nums text-muted">{stage.amountText}</p>

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
                          ctx={ctx}
                          locale={locale}
                          dragging={dragging === deal.id}
                          onDragStart={() => setDragging(deal.id)}
                          onDragEnd={() => {
                            setDragging(null);
                            setOver(null);
                          }}
                          onMove={(to) => move(deal.id, to)}
                          asking={
                            pregunta?.dealId === deal.id && pregunta.kind === "won"
                              ? (() => {
                                  const to = stages.find((s) => s.id === pregunta.toStageId);
                                  return to ? { stage: to } : null;
                                })()
                              : null
                          }
                          onConfirm={(extra) => pregunta && move(deal.id, pregunta.toStageId, extra)}
                          onCancel={() => setPregunta(null)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
                <StageConversionRow view={stage.conversion} />
              </li>
            );
          })}
        </ul>
      </div>

      {pregunta?.kind === "lost" &&
        (() => {
          const deal = optimistic.find((d) => d.id === pregunta.dealId);
          const stage = stages.find((s) => s.id === pregunta.toStageId);
          return deal && stage ? (
            <PerderDialogo
              deal={deal}
              stage={stage}
              onConfirm={(lostReason) => move(deal.id, stage.id, { lostReason })}
              onCancel={() => setPregunta(null)}
            />
          ) : null;
        })()}
    </div>
  );
}

/**
 * «¿Por qué lo pierdes?»: el motivo es obligatorio y sale de la lista de
 * la base (deal.lost_reason). Cancelar, Escape o clic fuera dejan el
 * negocio donde estaba.
 */
function PerderDialogo({
  deal,
  stage,
  onConfirm,
  onCancel,
}: {
  deal: BoardDeal;
  stage: BoardStage;
  onConfirm: (lostReason: string) => void;
  onCancel: () => void;
}) {
  const t = MESSAGES.pipeline.lost;
  const [error, setError] = useState<string | undefined>();
  const selectId = `perdido-${deal.id}`;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("lostReason") ?? "");
    if (!reason) {
      setError(MESSAGES.validacion.lostReason);
      document.getElementById(selectId)?.focus();
      return;
    }
    setError(undefined);
    onConfirm(reason);
  }

  return (
    <Dialogo title={t.dialogTitle(deal.companyName)} description={t.help} onClose={onCancel}>
      <form onSubmit={submit} noValidate aria-label={t.formLabel(deal.companyName)}>
        <Field label={t.title} error={error} required htmlFor={selectId}>
          <Select name="lostReason" defaultValue="" placeholder={t.placeholder} options={LOST_REASON_OPTIONS} autoFocus />
        </Field>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {MESSAGES.acciones.cancel}
          </Button>
          <Button type="submit" variant="danger" size="sm">
            {t.confirm(stage.label)}
          </Button>
        </div>
      </form>
    </Dialogo>
  );
}

function DealCard({
  deal,
  stages,
  ctx,
  locale,
  dragging,
  onDragStart,
  onDragEnd,
  onMove,
  asking,
  onConfirm,
  onCancel,
}: {
  deal: BoardDeal;
  stages: BoardStage[];
  ctx: SeguimientoContexto | null;
  locale?: string;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (toStageId: string) => void;
  /**
   * La etapa ganada a la que se quiere pasar un negocio sin monto,
   * mientras se pregunta por cuánto. El motivo de pérdida no se pregunta
   * en la tarjeta: va en su diálogo (PerderDialogo).
   */
  asking: { stage: BoardStage } | null;
  onConfirm: (extra: { amount?: string }) => void;
  onCancel: () => void;
}) {
  const t = MESSAGES.pipeline;
  const selectId = `mover-${deal.id}`;
  const [askError, setAskError] = useState<string | undefined>();
  const [amount, setAmount] = useState("");
  const amountId = `ganado-${deal.id}`;
  const askingWon = asking !== null;
  /** Mientras se escribe la siguiente acción, la tarjeta no se arrastra: seleccionar texto la movía. */
  const [editingNext, setEditingNext] = useState(false);
  const sinAccion = sinSiguienteAccion(deal);

  // «¿Por cuánto lo ganaste?» aparece debajo del menú: el foco va al
  // monto, como el motivo de «Perdido» (que lleva autoFocus en su
  // Select). MoneyInput no acepta autoFocus y cambiar su API pide PR del
  // kit, así que se enfoca por id, el mismo que le da el Field.
  useEffect(() => {
    if (askingWon) document.getElementById(amountId)?.focus();
  }, [askingWon, amountId]);

  function win(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // MoneyInput deja pasar el signo: un monto ganado es cero o más.
    if (!amount || amount.startsWith("-")) {
      setAskError(t.won.required);
      // Con el error, el foco vuelve al campo que lo tiene, no se queda en el botón.
      document.getElementById(amountId)?.focus();
      return;
    }
    // numeric(14,2): con ceros de más la base lo rechazaría. Se dice en
    // el campo, con el tope, y el foco se queda en él (pulido r8).
    if (excedeMontoMaximo(amount)) {
      setAskError(MESSAGES.validacion.amountMax(formatMoney(MONTO_MAXIMO, deal.currency, { mode: "full", locale })));
      document.getElementById(amountId)?.focus();
      return;
    }
    setAskError(undefined);
    onConfirm({ amount });
  }

  function cancel() {
    setAskError(undefined);
    setAmount("");
    onCancel();
  }

  return (
    <li
      draggable={!editingNext}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, deal.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={`relative cursor-grab rounded-md border bg-surface p-3 active:cursor-grabbing ${sinAccion ? "border-warn" : "border-border"} ${
        dragging ? "opacity-50" : ""
      }`}
      // El borde ámbar no puede ser la única señal: quien no distingue
      // el color necesita leerlo. `relative` no es decorativo: sin él, la
      // etiqueta sr-only del menú (absolute) escapa del scroll del
      // tablero y ensancha la página entera en el móvil.
      aria-label={sinAccion ? `${deal.companyName}, ${deal.name}. ${t.noNextAction}` : `${deal.companyName}, ${deal.name}`}
    >
      <Link href={`/ventas/empresas/${deal.companyId}`} className="text-sm font-medium leading-5 text-ink hover:underline" draggable={false}>
        {deal.companyName}
      </Link>
      {/* Un negocio que se llama como la marca (los viejos del radar): repetirlo es ruido. */}
      {dealLabel(deal.companyName, deal.name) && <p className="mt-0.5 text-xs leading-4 text-ink-2">{deal.name}</p>}

      <p className="mt-2 whitespace-nowrap text-sm tabular-nums text-ink">{deal.amountText ?? <span className="text-muted">{t.noAmount}</span>}</p>

      {/* La pastilla del vencimiento es la de la siguiente acción, abajo: una sola. */}
      <p className="mt-2 text-xs tabular-nums text-muted">{t.days(deal.daysInStage)}</p>
      {deal.lastContact && <UltimoContacto data={deal.lastContact} className="mt-1" />}

      {deal.lostReasonText && <p className="mt-2 text-xs leading-4 text-muted">{deal.lostReasonText}</p>}

      {deal.siguiente && ctx && (
        <div className="mt-2 cursor-auto">
          <SiguienteAccion data={deal.siguiente} ctx={ctx} compact onEditingChange={setEditingNext} />
        </div>
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

      {asking && (
        <form onSubmit={win} noValidate aria-label={t.won.formLabel(deal.companyName)} className="mt-3 border-t border-border pt-3">
          <Field label={t.won.title} help={t.won.help} error={askError} required htmlFor={amountId}>
            <MoneyInput value={amount} currency={deal.currency} onChange={(v) => setAmount(v)} />
          </Field>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="submit" variant="primary" size="sm">
              {t.won.confirm(asking.stage.label)}
            </Button>
            <Button variant="ghost" size="sm" onClick={cancel}>
              {MESSAGES.acciones.cancel}
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}
