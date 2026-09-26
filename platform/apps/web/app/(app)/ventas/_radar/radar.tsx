"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Textarea } from "@/components/ui/field";
import { Pill, type PillKind } from "@/components/ui/pill";
import { aceptarSenal, descartarSenal, type VentasState } from "../actions";
import { Aviso } from "../../_lib/aviso";
import { MESSAGES } from "../_lib/messages";
import type { CountryOption } from "../_lib/paises";
import { CargarListaForm, NuevaSenalForm } from "./formularios";

/**
 * Una señal lista para pintar. Las cifras y fechas llegan ya
 * formateadas del servidor: el formateador del workspace no cruza la
 * frontera servidor → cliente (es un objeto de funciones).
 */
export interface SignalCardData {
  id: string;
  companyName: string | null;
  headline: string;
  fit: { kind: PillKind; text: string } | null;
  sourceLabel: string;
  detectedText: string;
  budgetText: string | null;
  evidenceUrl: string | null;
  viaCsv: boolean;
  /**
   * La marca ya está en el CRM (pulido r8). Null si aceptarla crea la
   * empresa. `joinsDeal`: tiene un negocio abierto y la señal se sumará a
   * él en vez de abrir otro; `dealName` es su nombre, o null si se llama
   * como la marca.
   */
  crm: { companyHref: string; joinsDeal: boolean; dealName: string | null } | null;
  /**
   * Por qué el brief la deja fuera, con la regla que lo decidió («Tu
   * brief no acepta «harinas»»), solo cuando se están viendo las ocultas
   * (VEN-7). Null si se ve.
   */
  hiddenReason: string | null;
  /** Cómo encaja con «Qué buscas» («Bajo tu mínimo», «Fuera de tus países»): Pills neutras, no oculta nada. */
  fitNotes: string[];
}

/** La línea de las señales que el brief deja fuera, ya escrita en el servidor. */
export interface HiddenLine {
  text: string;
  /** «Verlas» (?ocultas=1) u «Ocultarlas». */
  toggle: { href: string; label: string };
  brief: { href: string; label: string };
}

type Panel = "none" | "manual" | "csv";

/** El aviso de arriba de la bandeja: qué pasó y, si hay, adónde seguir. */
type AvisoRadar = { notice?: string; message?: string; link?: { href: string; label: string } };

/**
 * La bandeja del radar con sus herramientas: anotar una marca, cargar
 * una lista, y aceptar o descartar cada señal.
 *
 * El aviso de «aceptaste» vive aquí y no en la tarjeta: al aceptar, la
 * página se revalida y la tarjeta desaparece de la bandeja, y con ella
 * se iría el mensaje que explica adónde fue.
 */
export function Radar({
  cards,
  currency,
  countries,
  hiddenLine = null,
}: {
  cards: SignalCardData[];
  currency: string;
  countries: CountryOption[];
  hiddenLine?: HiddenLine | null;
}) {
  const t = MESSAGES.radar;
  const [panel, setPanel] = useState<Panel>("none");
  const visibles = cards.filter((c) => c.hiddenReason === null);
  const ocultas = cards.filter((c) => c.hiddenReason !== null);
  const [aviso, setAviso] = useState<AvisoRadar | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  function open(next: Panel) {
    setPanel((cur) => (cur === next ? "none" : next));
    setAviso(null);
  }

  return (
    <section aria-labelledby="radar">
      <SectionTitle meta={cards.length > 0 ? t.meta(cards.length) : undefined}>
        <span id="radar">{t.title}</span>
      </SectionTitle>

      {hiddenLine && (
        <p className="-mt-2 mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted" data-testid="ocultas-por-brief">
          <span className="tabular-nums">{hiddenLine.text}</span>
          <Link href={hiddenLine.toggle.href} className="text-ink underline underline-offset-4 hover:text-ink-2">
            {hiddenLine.toggle.label}
          </Link>
          <Link href={hiddenLine.brief.href} className="text-ink underline underline-offset-4 hover:text-ink-2">
            {hiddenLine.brief.label}
          </Link>
        </p>
      )}

      <div ref={toolbarRef} role="group" aria-label={t.toolbar} className="mb-4 flex flex-wrap gap-2">
        <Button variant={panel === "manual" ? "primary" : "secondary"} size="sm" onClick={() => open("manual")} aria-expanded={panel === "manual"}>
          {t.newSignal}
        </Button>
        <Button variant={panel === "csv" ? "primary" : "secondary"} size="sm" onClick={() => open("csv")} aria-expanded={panel === "csv"}>
          {t.importCsv}
        </Button>
      </div>

      {panel === "manual" && (
        <div className="mb-6">
          <NuevaSenalForm currency={currency} countries={countries} onCancel={() => setPanel("none")} />
        </div>
      )}
      {panel === "csv" && (
        <div className="mb-6">
          <CargarListaForm onCancel={() => setPanel("none")} />
        </div>
      )}

      {aviso && (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
          <Aviso message={aviso.message} notice={aviso.notice} className="flex-1" />
          {aviso.link && (
            <Link href={aviso.link.href} className="text-sm text-ink underline underline-offset-4 hover:text-ink-2">
              {aviso.link.label}
            </Link>
          )}
        </div>
      )}

      {cards.length === 0 ? (
        <EmptyState
          title={t.empty.title}
          description={t.empty.description}
          action={panel === "none" ? { label: t.empty.action, onClick: () => open("manual") } : undefined}
        />
      ) : (
        <>
          {visibles.length > 0 && (
            <ul className="flex flex-col gap-2">
              {visibles.map((card) => (
                <SignalCard key={card.id} card={card} onResult={setAviso} />
              ))}
            </ul>
          )}
          {/* Con «Verlas», las ocultas van aparte, al final: no mezcladas por encaje con las que se ven. */}
          {ocultas.length > 0 && (
            <section aria-labelledby="radar-ocultas" className={visibles.length > 0 ? "mt-6" : undefined}>
              <h3 id="radar-ocultas" className="mb-2 border-t border-border pt-4 text-xs font-medium uppercase tracking-wide text-muted">
                {t.hidden.group}
              </h3>
              <ul className="flex flex-col gap-2">
                {ocultas.map((card) => (
                  <SignalCard key={card.id} card={card} onResult={setAviso} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <p className="mt-6 text-xs leading-5 text-muted">{t.manualOnly}</p>
    </section>
  );
}

function SignalCard({
  card,
  onResult,
}: {
  card: SignalCardData;
  onResult: (aviso: AvisoRadar) => void;
}) {
  const t = MESSAGES.radar;
  const [discarding, setDiscarding] = useState(false);
  const [reasonError, setReasonError] = useState<string | undefined>();
  const [cardError, setCardError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<"accept" | "discard" | null>(null);
  const name = card.companyName ?? t.unknownBrand;

  function report(res: VentasState, kind: "accept" | "discard") {
    if (res.ok) {
      onResult({ notice: res.notice, link: res.link });
      return;
    }
    if (res.errors?.reason) setReasonError(res.errors.reason);
    else setCardError(res.message ?? res.errors?.signalId ?? (kind === "accept" ? t.acceptError : t.discardError));
  }

  function accept() {
    const data = new FormData();
    data.set("signalId", card.id);
    data.set("companyName", card.companyName ?? "");
    setCardError(undefined);
    setBusy("accept");
    startTransition(async () => {
      report(await aceptarSenal({}, data), "accept");
      setBusy(null);
    });
  }

  function discard(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    data.set("signalId", card.id);
    setReasonError(undefined);
    setCardError(undefined);
    setBusy("discard");
    startTransition(async () => {
      report(await descartarSenal({}, data), "discard");
      setBusy(null);
    });
  }

  return (
    <li className="rounded-md border border-border bg-surface p-4" aria-busy={pending || undefined}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink">{name}</span>
            {card.fit && (
              <span className="inline-flex items-center">
                <span className="sr-only">{t.fit} </span>
                <Pill kind={card.fit.kind}>{card.fit.text}</Pill>
              </span>
            )}
            {card.hiddenReason && <Pill kind="warn">{card.hiddenReason}</Pill>}
            {card.fitNotes.map((nota) => (
              <Pill key={nota} kind="neutral">
                {nota}
              </Pill>
            ))}
            {card.crm && (
              <Link
                href={card.crm.companyHref}
                aria-label={t.inCrmLink(name)}
                className="inline-flex rounded-full hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
              >
                <Pill kind="neutral">{t.inCrm}</Pill>
              </Link>
            )}
          </div>
          <p className="mt-1 text-sm leading-5 text-ink-2">{card.headline}</p>
          {card.crm?.joinsDeal && (
            <p className="mt-1 text-xs leading-5 text-muted">{card.crm.dealName ? t.joinsDeal(card.crm.dealName) : t.joinsOpenDeal}</p>
          )}
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span>
              {t.source}: {card.sourceLabel}
              {card.viaCsv && ` · ${t.fromCsv}`}
            </span>
            <span className="tabular-nums">
              {t.detected} {card.detectedText}
            </span>
            {card.budgetText && (
              <span className="tabular-nums">
                {/* La cifra no se parte entre la moneda y el número («COP» / «7,0 M») a 400 px. */}
                {t.budget}: <span className="whitespace-nowrap">{card.budgetText}</span>
              </span>
            )}
            {card.evidenceUrl && (
              <a href={card.evidenceUrl} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2 hover:text-ink">
                {t.evidence}
              </a>
            )}
          </p>
        </div>

        {!discarding && (
          <div className="flex shrink-0 gap-2">
            <Button variant="primary" size="sm" onClick={accept} loading={busy === "accept"} disabled={pending} aria-label={`${t.accept}: ${name}`}>
              {t.accept}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setDiscarding(true)} disabled={pending} aria-label={`${t.discard}: ${name}`}>
              {t.discard}
            </Button>
          </div>
        )}
      </div>

      {discarding && (
        <form onSubmit={discard} noValidate className="mt-4 border-t border-border pt-4" aria-label={`${t.discardTitle} ${name}`}>
          <Field label={t.discardTitle} help={t.discardHelp} error={reasonError} required htmlFor={`reason-${card.id}`}>
            <Textarea name="reason" rows={2} maxLength={280} placeholder={t.discardPlaceholder} autoFocus />
          </Field>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="submit" variant="danger" size="sm" loading={busy === "discard"}>
              {t.discardConfirm}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDiscarding(false)} disabled={pending}>
              {MESSAGES.acciones.cancel}
            </Button>
          </div>
        </form>
      )}

      {cardError && <Aviso message={cardError} className="mt-3" />}
    </li>
  );
}
