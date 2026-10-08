"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Textarea } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Pill, TruncatedPill, type PillKind } from "@/components/ui/pill";
import { aceptarSenal, descartarSenal, type VentasState } from "../actions";
import { noAceptarMarca } from "../brief/actions";
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
  /**
   * El encaje («82 %», o «82 % · alimentos» si es de una categoría que
   * busca el brief) y, si lo hay, la frase entera para el title y el
   * lector de pantalla.
   */
  fit: { kind: PillKind; text: string; label?: string } | null;
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
   * La marca tiene un negocio abierto de un creador que quien mira no
   * lleva (ACC-7): aceptarla no abre otro y la señal queda para quien lo
   * lleva. La tarjeta lo dice antes, como «se sumará a…».
   */
  hiddenDeal?: boolean;
  /**
   * Por qué el brief la deja fuera, con la regla que lo decidió («Tu
   * brief no acepta «harinas»»), solo cuando se están viendo las ocultas
   * (VEN-7). Null si se ve.
   */
  hiddenReason: string | null;
  /**
   * Lo que la aparta de «Qué buscas» («Bajo tu mínimo», «Fuera de tus
   * países», «Fuera de lo que buscas»): Pills neutras, no oculta nada.
   */
  fitNotes: string[];
  /** Ofrece «No aceptar esta marca» (VEN-7 r4): quien mira puede cambiar el brief y la señal tiene marca. */
  canReject: boolean;
  /**
   * Lo que «¿No aceptar…?» tiene que avisar antes de confirmar: la marca
   * tiene negocios abiertos y sus toques programados se cancelan. Ya
   * escrito en el servidor, con la cifra del espacio. Null si no tiene.
   */
  rejectWarning: string | null;
}

/** Los creadores con brief activo, para elegir en cuáles no aceptar la marca (VEN-7 r4). */
export interface RejectOptions {
  creators: { id: string; name: string }[];
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
  reject = null,
}: {
  cards: SignalCardData[];
  currency: string;
  countries: CountryOption[];
  hiddenLine?: HiddenLine | null;
  reject?: RejectOptions | null;
}) {
  const t = MESSAGES.radar;
  const [panel, setPanel] = useState<Panel>("none");
  const visibles = cards.filter((c) => c.hiddenReason === null);
  const ocultas = cards.filter((c) => c.hiddenReason !== null);
  const [aviso, setAviso] = useState<AvisoRadar | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const avisoRef = useRef<HTMLDivElement>(null);
  /**
   * Aceptar, descartar o no aceptar la marca quitan la tarjeta de la
   * bandeja (la revalidación la desmonta) y con ella el botón que tenía el
   * foco, que caía en <body> (VEN-7 r5). El foco pasa al aviso, que dice
   * qué pasó: quien usa teclado o lector de pantalla no pierde su sitio.
   */
  const [focoAviso, setFocoAviso] = useState(0);
  useEffect(() => {
    if (focoAviso > 0) avisoRef.current?.focus();
  }, [focoAviso]);

  function resultado(a: AvisoRadar) {
    setAviso(a);
    setFocoAviso((n) => n + 1);
  }

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
        <div
          ref={avisoRef}
          tabIndex={-1}
          data-testid="radar-aviso"
          className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md focus:outline-none"
        >
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
                <SignalCard key={card.id} card={card} onResult={resultado} reject={reject} />
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
                  <SignalCard key={card.id} card={card} onResult={resultado} reject={reject} />
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
  reject,
}: {
  card: SignalCardData;
  onResult: (aviso: AvisoRadar) => void;
  reject: RejectOptions | null;
}) {
  const t = MESSAGES.radar;
  const [discarding, setDiscarding] = useState(false);
  const [reasonError, setReasonError] = useState<string | undefined>();
  const [cardError, setCardError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<"accept" | "discard" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [confirmingAccept, setConfirmingAccept] = useState(false);
  /** El CRM ya tiene una empresa con este nombre y otra web: se pregunta si es la misma (pulido r2). */
  const [mismaMarca, setMismaMarca] = useState<{ id: string; name: string } | null>(null);
  const name = card.companyName ?? t.unknownBrand;
  // Una oculta por el brief no se acepta con un clic: el negocio se abriría, pero ninguna cadencia le escribiría.
  const oculta = card.hiddenReason !== null;

  function report(res: VentasState, kind: "accept" | "discard") {
    if (res.ok) {
      setMismaMarca(null);
      onResult({ notice: res.notice, link: res.link });
      return;
    }
    if (kind === "accept" && res.sameName) {
      setMismaMarca(res.sameName);
      return;
    }
    if (res.errors?.reason) setReasonError(res.errors.reason);
    else setCardError(res.message ?? res.errors?.signalId ?? (kind === "accept" ? t.acceptError : t.discardError));
  }

  function accept(respuesta?: { useCompanyId: string } | { createAnyway: string }) {
    const data = new FormData();
    data.set("signalId", card.id);
    data.set("companyName", card.companyName ?? "");
    if (respuesta && "useCompanyId" in respuesta) data.set("useCompanyId", respuesta.useCompanyId);
    if (respuesta && "createAnyway" in respuesta) data.set("createAnyway", respuesta.createAnyway);
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
        {/* Con base de 18rem: si no caben el texto y las tres acciones, las acciones bajan a su propia línea en vez de exprimir el texto. */}
        <div className="min-w-0 flex-1 basis-72">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink">{name}</span>
            {card.fit && (
              <span className="inline-flex min-w-0 max-w-full items-center">
                <span className="sr-only">{card.fit.label ?? `${t.fit} ${card.fit.text}`}</span>
                <span aria-hidden="true" className="inline-flex min-w-0 max-w-full">
                  <TruncatedPill kind={card.fit.kind}>{card.fit.text}</TruncatedPill>
                </span>
              </span>
            )}
            {card.hiddenReason && <TruncatedPill kind="warn">{card.hiddenReason}</TruncatedPill>}
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
          {card.hiddenDeal && !card.crm?.joinsDeal && <p className="mt-1 text-xs leading-5 text-muted">{t.hiddenDeal}</p>}
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

        {/*
          «No aceptar esta marca» va junto a Descartar, como tercera acción
          y más discreta (ghost), no en una franja propia (VEN-7 r5): es
          secundaria, como en Passionfroot y Pipedrive. A 400 px el grupo
          envuelve en vez de desbordar.
        */}
        {!discarding && (
          <div className="flex min-w-0 flex-wrap gap-2">
            <Button
              variant={oculta ? "secondary" : "primary"}
              size="sm"
              onClick={oculta ? () => setConfirmingAccept(true) : () => accept()}
              loading={busy === "accept"}
              disabled={pending}
              aria-label={`${t.accept}: ${name}`}
            >
              {t.accept}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setDiscarding(true)} disabled={pending} aria-label={`${t.discard}: ${name}`}>
              {t.discard}
            </Button>
            {card.canReject && reject && (
              <Button variant="ghost" size="sm" onClick={() => setRejecting(true)} disabled={pending} aria-label={t.reject.actionFor(name)}>
                {t.reject.action}
              </Button>
            )}
          </div>
        )}
      </div>

      {confirmingAccept && card.hiddenReason && (
        <Dialog title={t.hidden.acceptTitle(name)} description={t.hidden.acceptDescription(card.hiddenReason)} onClose={() => setConfirmingAccept(false)}>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Link href="/ventas/brief" className="mr-auto text-sm text-ink underline underline-offset-4 hover:text-ink-2">
              {t.hidden.editBrief}
            </Link>
            <Button variant="ghost" size="sm" onClick={() => setConfirmingAccept(false)}>
              {MESSAGES.acciones.cancel}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setConfirmingAccept(false);
                accept();
              }}
            >
              {t.hidden.acceptConfirm}
            </Button>
          </div>
        </Dialog>
      )}

      {rejecting && reject && (
        <NoAceptarDialog
          signalId={card.id}
          name={name}
          inCrm={card.crm !== null}
          warning={card.rejectWarning}
          creators={reject.creators}
          onClose={() => setRejecting(false)}
          onDone={(notice) => {
            setRejecting(false);
            onResult({ notice });
          }}
        />
      )}

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

      {mismaMarca && (
        <div role="group" aria-label={t.sameBrand.question(mismaMarca.name)} className="mt-4 border-t border-border pt-4">
          <p className="text-sm font-medium text-ink">{t.sameBrand.question(mismaMarca.name)}</p>
          <p className="mt-1 text-sm leading-5 text-ink-2">{t.sameBrand.help}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" onClick={() => accept({ useCompanyId: mismaMarca.id })} loading={busy === "accept"}>
              {t.sameBrand.same}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => accept({ createAnyway: mismaMarca.name })} disabled={pending}>
              {t.sameBrand.other}
            </Button>
            <Link
              href={`/ventas/empresas/${mismaMarca.id}`}
              className="text-sm text-ink underline underline-offset-4 hover:text-ink-2"
            >
              {t.sameBrand.see}
            </Link>
          </div>
        </div>
      )}

      {cardError && <Aviso message={cardError} className="mt-3" />}
    </li>
  );
}

/**
 * «¿No aceptar esta marca?» (VEN-7 r4): la da de alta en el CRM como
 * bloqueada y la agrega a «Marcas que no aceptas» de los briefs activos,
 * en la misma transacción (rejectSignalBrand). Con un solo brief activo
 * no hay nada que elegir; con varios, una casilla por creador, todas
 * marcadas: lo que uno no acepta otro puede aceptarlo, y el radar solo
 * oculta lo que excluyen todos.
 */
function NoAceptarDialog({
  signalId,
  name,
  inCrm,
  warning,
  creators,
  onClose,
  onDone,
}: {
  signalId: string;
  name: string;
  /** La marca ya está en el CRM: su relación no cambia, no «entra como bloqueada». */
  inCrm: boolean;
  /** Sus negocios abiertos y lo que se cancela, o null. */
  warning: string | null;
  creators: { id: string; name: string }[];
  onClose: () => void;
  onDone: (notice: string) => void;
}) {
  const t = MESSAGES.radar.reject;
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    data.set("signalId", signalId);
    if (creators.length > 1 && data.getAll("creatorIds").length === 0) {
      setError(t.noCreator);
      return;
    }
    setError(undefined);
    startTransition(async () => {
      const res = await noAceptarMarca({}, data);
      if (res.ok && res.notice) onDone(res.notice);
      else setError(res.message ?? t.error);
    });
  }

  return (
    <Dialog
      title={t.title(name)}
      description={
        creators.length > 1 ? (inCrm ? t.descriptionManyInCrm : t.descriptionMany) : inCrm ? t.descriptionInCrm : t.description
      }
      onClose={onClose}
    >
      <form onSubmit={submit} noValidate className="space-y-4" aria-label={t.title(name)}>
        {warning && <p className="rounded-md bg-warn-wash px-3 py-2 text-sm leading-5 text-warn">{warning}</p>}
        {creators.length > 1 && (
          <fieldset className="space-y-2" aria-describedby={`no-aceptar-${signalId}-ayuda`}>
            <legend className="text-sm font-medium text-ink">{t.creators}</legend>
            <p id={`no-aceptar-${signalId}-ayuda`} className="text-xs leading-4 text-muted">
              {t.creatorsHelp}
            </p>
            {creators.map((c) => (
              <Checkbox key={c.id} name="creatorIds" value={c.id} label={c.name} defaultChecked />
            ))}
          </fieldset>
        )}
        {error && <Aviso message={error} />}
        {/*
          El mismo pie que «¿Por qué lo pierdes?» (PerderDialogo) y que el
          README del kit pide a todo Dialog: a la derecha, Cancelar primero y
          la acción que no se deshace al final. Con un solo brief no hay
          casillas y Cancelar es el primer control: el foco inicial cae ahí,
          y dos Enter seguidos ya no excluyen la marca (VEN-7 r5). Con
          varios, cae en la primera casilla.
        */}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            {MESSAGES.acciones.cancel}
          </Button>
          <Button type="submit" variant="danger" size="sm" loading={pending}>
            {t.confirm}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
