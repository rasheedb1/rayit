"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useActionState, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { SalesClaim } from "@mc/core/outreach/claims";
import { OUTREACH_URLS } from "@mc/core/outreach/messages";
import type { RegenerateHint } from "@mc/core/outreach/preflight";
import { templateValuesFrom, type TemplateSources, type TemplateVariable } from "@mc/core/outreach/render";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { guardarPitch, pedirRedaccion, type PitchState } from "./actions";
import { CuerpoConCifras, type CuerpoApi } from "./cuerpo";
import { FichasInsertables } from "./fichas";
import { PanelIA, type AiStatus, type PendingDraft } from "./ia";
import { PITCH } from "./messages";
import { VistaYRevision } from "./revision";
import { previewOf, reviseDraft, revisionSummary } from "./vista";

/** Lo que cambia con el negocio elegido: quién firma, qué cifras puede citar y con qué se rellenan las variables. */
export interface EditorVariant {
  creator: { id: string; name: string; handle: string | null; niche: string | null } | null;
  claims: SalesClaim[];
  sources: Omit<TemplateSources, "contact">;
}

export interface EditorData {
  companyId: string;
  company: { name: string; industry: string | null; city: string | null };
  contacts: Array<{ id: string; fullName: string | null; roleTitle: string | null; email: string; firstTouch: boolean }>;
  deals: Array<{ id: string; label: string; signalHeadline: string | null }>;
  /** Por negocio (su id) y sin negocio (''). Los enlaces ya vienen armados por el servidor. */
  variants: Record<string, EditorVariant>;
  draft: {
    touchId: string;
    contactId: string | null;
    dealId: string | null;
    subject: string;
    /** Marcado: con sus [claim:id] y sus {{variables}}. El cuerpo los pinta como fichas. */
    body: string;
    held: string | null;
    generated: boolean;
    score: string | null;
    note: string | null;
    pending: PendingDraft | null;
    /** La IA se rindió con este borrador (0063): se dice, y se puede pedir otra versión. */
    failed: boolean;
    /** Se copió con N cifras sin origen (savePitch lo marcó): se dice junto a los botones. Opcional: null si no. */
    copiedUnsourced?: number | null;
  } | null;
  /** ¿El worker redacta con IA? Lo dice su última corrida, no la web. */
  ai: AiStatus;
  sendingOn: boolean;
  /** Cuántas señales vivas tiene la empresa: con más de una, la IA ofrece «Otra señal». Opcional: 0 si no se sabe. */
  signalCount?: number;
  /**
   * Lo que impide programar o retrasa el envío aunque el mensaje esté
   * bien (loadPitchComposer): sin dirección postal el servidor no deja
   * programar; sin correo conectado, lo programado espera.
   */
  policy: { hasPostalAddress: boolean; hasEmailAccount: boolean };
}

/** Sin creador ni cifras: un espacio sin perfil todavía. Constante, para que useMemo no recalcule en cada render. */
const SIN_VARIANTE: EditorVariant = { creator: null, claims: [], sources: {} };

/** Cada cuánto se mira si la IA terminó mientras redacta. */
const POLL_MS = 5_000;

/**
 * El editor del pitch: a la izquierda, para quién, la redacción con IA
 * (instrucciones, pedir un borrador y tres pistas, como el generador de
 * Chief), el asunto, el mensaje (las cifras y las variables son fichas,
 * no marcas; una cifra sin origen se subraya donde está), justo debajo
 * los botones con una línea de por qué «Programar» está apagado, y al
 * final las fichas insertables. A la derecha, cómo lo recibe
 * la marca, la nota de la revisión automática y la revisión completa.
 * «Copiar» copia el texto limpio y guarda el borrador; «Programar» solo
 * con la revisión en verde (y el servidor la repite). Como el compositor
 * de Superhuman: el texto manda y lo demás está a un toque.
 */
export function EditorDePitch({
  data,
  arrived = false,
  onReset,
}: {
  data: EditorData;
  /** Se montó porque llegó un borrador nuevo de la IA (montaje.tsx): el foco va a su aviso. */
  arrived?: boolean;
  /** «Escribir otro pitch» tras programar: el montaje lo vuelve a abrir limpio. */
  onReset?: (scheduledTouch: string | null) => void;
}) {
  // Lo que se abrió al montar: el texto, la nota y el aviso de la IA son de ESTE borrador aunque la página
  // se vuelva a pintar (tras programar, el servidor ya no lo devuelve; tras guardar, deja de ser «de la IA»).
  const [d] = useState(data.draft);
  const router = useRouter();
  const [contactId, setContactId] = useState(d?.contactId ?? data.contacts[0]?.id ?? "");
  const [dealId, setDealId] = useState(d?.dealId ?? data.deals[0]?.id ?? "");
  const [subject, setSubject] = useState(d?.subject ?? "");
  const [body, setBody] = useState(d?.body ?? "");
  const cuerpo = useRef<CuerpoApi>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [state, dispatch, pending] = useActionState<PitchState, FormData>(guardarPitch, {});
  const [aiState, dispatchAi, aiPending] = useActionState<PitchState, FormData>(pedirRedaccion, {});
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const aiNoticeRef = useRef<HTMLParagraphElement>(null);
  /** El resultado del portapapeles de la última copia: si el navegador no dejó, no se dice «Copiado». */
  const [clip, setClip] = useState<"ok" | "failed" | null>(null);
  /** «Copiar» con cifras sin origen: la confirmación en línea está abierta. */
  const [confirmCopy, setConfirmCopy] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (confirmCopy) confirmRef.current?.focus();
  }, [confirmCopy]);

  useEffect(() => {
    if (state.stamp) noticeRef.current?.focus();
  }, [state.stamp]);
  // Un error al guardar o programar también se lleva el foco, como el aviso de éxito.
  useEffect(() => {
    if (state.message || aiState.message) errorRef.current?.focus();
  }, [state, aiState]);
  // Llegó un borrador nuevo de la IA («Más corto», «Otra versión»): el foco va a su aviso y se anuncia.
  useEffect(() => {
    if (arrived) aiNoticeRef.current?.focus();
  }, [arrived]);

  const touchId = aiState.touchId ?? state.touchId ?? d?.touchId ?? "";
  // Lo vivo del borrador (en qué va la IA) sale de la página solo si es el mismo toque que se edita.
  const live = data.draft && data.draft.touchId === touchId ? data.draft : null;
  // Mientras la IA redacta, la página se actualiza sola hasta que termine.
  const waiting = live?.pending != null || aiState.intent === "ai";
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [waiting, router]);

  const contact = data.contacts.find((c) => c.id === contactId) ?? null;
  const deal = data.deals.find((x) => x.id === dealId) ?? null;
  const variant = data.variants[dealId] ?? data.variants[""] ?? SIN_VARIANTE;
  const values = useMemo(
    () => templateValuesFrom({ contact: contact ? { fullName: contact.fullName, roleTitle: contact.roleTitle } : null, ...variant.sources }),
    [contact, variant],
  );
  const preview = previewOf(subject, body, values);
  const revision = reviseDraft({
    subject, body, values, claims: variant.claims, firstTouch: contact?.firstTouch ?? true, companyName: data.company.name,
    policy: data.policy,
    people: {
      recipient: contact?.fullName ?? null,
      others: data.contacts.filter((c) => c.id !== contactId).map((c) => c.fullName),
      sender: variant.creator?.name ?? null,
    },
  });
  const summary = revisionSummary(revision);
  // Tras programar, el correo queda a la vista pero ya no se edita aquí.
  const scheduled = state.ok === true && state.intent === "schedule";
  // La nota de la IA es de su versión: si la persona cambió el texto, se dice.
  const edited = d !== null && (body !== d.body || subject !== d.subject);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const form = new FormData(event.currentTarget, submitter);
    // Una cifra sin origen no impide copiar, pero copiar es enviarlo desde el correo de la creadora:
    // se pregunta antes, en línea, y solo «Copiar igual» copia de verdad.
    if (form.get("intent") === "copy" && revision.unsourced > 0 && !confirmCopy) {
      setConfirmCopy(true);
      return;
    }
    if (form.get("intent") === "copy_confirmed") form.set("intent", "copy");
    setConfirmCopy(false);
    if (form.get("intent") === "copy") {
      // Se copia en el clic (el navegador exige el gesto de la persona) y después se guarda. Si el
      // navegador no deja (permiso, contexto no seguro), se dice en vez de «Copiado». Sin asunto, solo el cuerpo.
      const text = preview.subject ? `${preview.subject}\n\n${preview.body}` : preview.body;
      setClip(null);
      const copying = typeof navigator !== "undefined" && navigator.clipboard ? navigator.clipboard.writeText(text) : null;
      if (copying) copying.then(() => setClip("ok"), () => setClip("failed"));
      else setClip("failed");
    }
    startTransition(() => dispatch(form));
  }

  function requestAi(hint: RegenerateHint | null, instructions: string) {
    if (!formRef.current) return;
    const form = new FormData(formRef.current);
    form.set("hint", hint ?? "");
    form.set("instructions", instructions);
    startTransition(() => dispatchAi(form));
  }

  const t = PITCH.campos;
  const a = PITCH.acciones;
  const shown = aiState.stamp && (!state.stamp || aiState.stamp > state.stamp) ? aiState : state;
  const notice = shown === state && state.intent === "copy" && clip === "failed" ? a.noSeCopio : shown.notice;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[minmax(0,1fr)_360px]">
      <form
        ref={formRef}
        onSubmit={onSubmit}
        noValidate
        className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-5"
        aria-label={PITCH.title(data.company.name)}
      >
        <input type="hidden" name="companyId" value={data.companyId} />
        <input type="hidden" name="touchId" value={touchId} />
        {d?.generated && !d.pending && (
          <p ref={aiNoticeRef} tabIndex={-1} aria-live="polite" className="text-sm text-ink-2">
            {PITCH.revision.generado}
          </p>
        )}

        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-[repeat(2,minmax(0,1fr))]">
          <Field
            className="min-w-0"
            label={t.contacto}
            help={data.contacts.length > 0 ? t.contactoHelp : t.sinContactos}
            htmlFor="pitch-contacto"
            error={shown.errors?.contactId}
          >
            <Select
              name="contactId"
              value={contactId}
              disabled={scheduled}
              onChange={(e) => setContactId(e.target.value)}
              placeholder={t.contactoPlaceholder}
              options={data.contacts.map((c) => ({ value: c.id, label: c.fullName ? `${c.fullName} · ${c.email}` : c.email }))}
            />
          </Field>
          <Field className="min-w-0" label={t.negocio} help={t.negocioHelp} htmlFor="pitch-negocio" error={shown.errors?.dealId}>
            <Select
              name="dealId"
              value={dealId}
              disabled={scheduled}
              onChange={(e) => setDealId(e.target.value)}
              placeholder={t.negocioNinguno}
              options={data.deals.map((x) => ({ value: x.id, label: x.label }))}
            />
          </Field>
        </div>

        {!scheduled && (
          <PanelIA
            status={data.ai}
            pending={live?.pending ?? null}
            failed={live?.failed ?? false}
            hasBody={body.trim() !== ""}
            hasContact={contact !== null}
            signalHeadline={deal?.signalHeadline ?? null}
            manySignals={(data.signalCount ?? 0) > 1}
            busy={aiPending}
            onRequest={requestAi}
          />
        )}

        <Field className="min-w-0" label={t.asunto} help={t.asuntoHelp} htmlFor="pitch-asunto">
          <Input name="subject" value={subject} readOnly={scheduled} onChange={(e) => setSubject(e.target.value)} maxLength={300} />
        </Field>
        {/* El mensaje no es un <textarea>: las cifras y las variables son fichas (cuerpo.tsx). La etiqueta lo enfoca. */}
        <div className="flex min-w-0 flex-col gap-1.5">
          <span id="pitch-cuerpo-label" className="text-sm font-medium text-ink" onClick={() => cuerpo.current?.focus()}>
            {t.cuerpo}
          </span>
          <CuerpoConCifras
            id="pitch-cuerpo"
            name="body"
            value={body}
            onChange={setBody}
            claims={variant.claims}
            labelledBy="pitch-cuerpo-label"
            describedBy="pitch-cuerpo-help"
            api={cuerpo}
            readOnly={scheduled}
          />
          <p id="pitch-cuerpo-help" className="text-xs text-muted">
            {t.cuerpoHelp}
          </p>
        </div>

        {/* Las acciones van pegadas al mensaje, como en el compositor de Superhuman: la biblioteca de fichas va debajo. */}
        <div className="grid gap-2 border-t border-border pt-4">
          {scheduled ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={() => onReset?.(state.touchId ?? null)}>
                {a.escribirOtro}
              </Button>
              <p className="min-w-0 break-words text-xs text-ink-2">{a.yaProgramado}</p>
            </div>
          ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              name="intent"
              value="schedule"
              variant="primary"
              loading={pending}
              disabled={!revision.ok || !contact}
              aria-describedby={summary ? "pitch-resumen" : undefined}
            >
              {a.programar}
            </Button>
            <Button type="submit" name="intent" value="copy" disabled={!revision.canCopy || !contact || pending} aria-label={a.copiarLabel}>
              {a.copiar}
            </Button>
            <Button type="submit" name="intent" value="draft" variant="ghost" disabled={!contact || pending}>
              {a.guardar}
            </Button>
          </div>
          )}
          {/* Por qué «Programar» está apagado, junto al botón: a 400 px la revisión completa queda muy abajo. */}
          {summary && !scheduled && (
            <p id="pitch-resumen" className="min-w-0 break-words text-xs text-ink-2">
              {summary.text}
              {summary.detail && <span className="sr-only"> {summary.detail}</span>}{" "}
              {!revision.pristine && (
                <a href="#pitch-revision" className="underline underline-offset-4 hover:text-ink">
                  {PITCH.revision.verRevision}
                </a>
              )}
            </p>
          )}
          {revision.copyBlockedBy && !scheduled && <p className="text-xs text-muted">{a.copiarBloqueado[revision.copyBlockedBy]}</p>}
          {confirmCopy && !scheduled && (
            <div
              ref={confirmRef}
              tabIndex={-1}
              role="group"
              aria-labelledby="pitch-confirmar-copia"
              className="grid gap-2 rounded-md border border-border bg-surface-2 p-3"
            >
              <p id="pitch-confirmar-copia" className="text-sm font-medium text-ink">
                {a.confirmarCopia(revision.unsourced)}
              </p>
              <p className="text-xs text-ink-2">{a.confirmarCopiaConsecuencia}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" name="intent" value="copy_confirmed" variant="primary" disabled={pending}>
                  {a.copiarIgual}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setConfirmCopy(false)}>
                  {a.noCopiar}
                </Button>
              </div>
            </div>
          )}
          {d?.copiedUnsourced ? <p className="text-xs text-muted">{PITCH.revision.copiadoSinOrigen(d.copiedUnsourced)}</p> : null}
        </div>
        <div aria-live="polite" className="grid min-w-0 gap-1 text-sm">
          {notice && (
            <p ref={noticeRef} tabIndex={-1} className="text-ink">
              {notice}{" "}
              <Link href={`/ventas/empresas/${data.companyId}`} className="underline underline-offset-4 hover:text-ink-2">
                {a.verFicha}
              </Link>
            </p>
          )}
          {shown.message && (
            <p ref={errorRef} tabIndex={-1} className="text-bad">
              {shown.message}
            </p>
          )}
          {shown.issues && shown.issues.length > 0 && (
            <ul className="list-disc pl-5 text-ink-2">
              {shown.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
          {shown.link && (
            <Link href={shown.link.href} className="underline underline-offset-4 hover:text-ink-2">
              {shown.link.label}
            </Link>
          )}
        </div>
        {!scheduled && (
          <FichasInsertables
            claims={variant.claims}
            companyName={data.company.name}
            onVariable={(v: TemplateVariable) => cuerpo.current?.insert([{ kind: "variable", name: v }])}
            onClaim={(c) => cuerpo.current?.insert([{ kind: "claim", id: c.id, raw: c.display }])}
          />
        )}

      </form>

      <aside className="min-w-0" aria-label={PITCH.vista.titulo}>
        <VistaYRevision
          preview={preview}
          recipient={contact ? (contact.fullName ?? contact.email) : null}
          revision={revision}
          quality={d ? { score: d.score, note: d.note, held: d.held, edited } : null}
        />
        {!data.policy.hasEmailAccount && (
          <p className="mt-4 text-xs text-muted">
            {PITCH.revision.sinCorreo}{" "}
            <Link href={OUTREACH_URLS.channels} className="underline underline-offset-4 hover:text-ink-2">
              {PITCH.revision.conectarCorreo}
            </Link>
          </p>
        )}
        {!data.sendingOn && (
          <p className="mt-4 text-xs text-muted">
            {PITCH.revision.envioApagado}{" "}
            <Link href={OUTREACH_URLS.policySwitch} className="underline underline-offset-4 hover:text-ink-2">
              {PITCH.revision.encenderEnvio}
            </Link>
          </p>
        )}
      </aside>
    </div>
  );
}
