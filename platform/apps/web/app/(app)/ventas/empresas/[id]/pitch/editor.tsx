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
    /** La IA se rindió con este borrador (0058): se dice, y se puede pedir otra versión. */
    failed: boolean;
  } | null;
  /** ¿El worker redacta con IA? Lo dice su última corrida, no la web. */
  ai: AiStatus;
  sendingOn: boolean;
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
export function EditorDePitch({ data }: { data: EditorData }) {
  const d = data.draft;
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

  useEffect(() => {
    if (state.stamp) noticeRef.current?.focus();
  }, [state.stamp]);
  // Mientras la IA redacta, la página se actualiza sola hasta que termine.
  const waiting = d?.pending != null || aiState.intent === "ai";
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
  });
  const summary = revisionSummary(revision);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const form = new FormData(event.currentTarget, submitter);
    if (form.get("intent") === "copy") {
      // Se copia en el clic (el navegador exige el gesto de la persona) y después se guarda.
      void navigator.clipboard?.writeText(`${preview.subject}\n\n${preview.body}`).catch(() => undefined);
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
  const touchId = aiState.touchId ?? state.touchId ?? d?.touchId ?? "";
  const shown = aiState.stamp && (!state.stamp || aiState.stamp > state.stamp) ? aiState : state;
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
        {d?.generated && !d.pending && <p className="text-sm text-ink-2">{PITCH.revision.generado}</p>}

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
              onChange={(e) => setContactId(e.target.value)}
              placeholder={t.contactoPlaceholder}
              options={data.contacts.map((c) => ({ value: c.id, label: c.fullName ? `${c.fullName} · ${c.email}` : c.email }))}
            />
          </Field>
          <Field className="min-w-0" label={t.negocio} help={t.negocioHelp} htmlFor="pitch-negocio" error={shown.errors?.dealId}>
            <Select
              name="dealId"
              value={dealId}
              onChange={(e) => setDealId(e.target.value)}
              placeholder={t.negocioNinguno}
              options={data.deals.map((x) => ({ value: x.id, label: x.label }))}
            />
          </Field>
        </div>

        <PanelIA
          status={data.ai}
          pending={d?.pending ?? null}
          failed={d?.failed ?? false}
          hasBody={body.trim() !== ""}
          hasContact={contact !== null}
          signalHeadline={deal?.signalHeadline ?? null}
          busy={aiPending}
          onRequest={requestAi}
        />

        <Field className="min-w-0" label={t.asunto} help={t.asuntoHelp} htmlFor="pitch-asunto">
          <Input name="subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} />
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
          />
          <p id="pitch-cuerpo-help" className="text-xs text-muted">
            {t.cuerpoHelp}
          </p>
        </div>

        {/* Las acciones van pegadas al mensaje, como en el compositor de Superhuman: la biblioteca de fichas va debajo. */}
        <div className="grid gap-2 border-t border-border pt-4">
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
          {/* Por qué «Programar» está apagado, junto al botón: a 400 px la revisión completa queda muy abajo. */}
          {summary && (
            <p id="pitch-resumen" className="min-w-0 break-words text-xs text-ink-2">
              {summary}{" "}
              {!revision.pristine && (
                <a href="#pitch-revision" className="underline underline-offset-4 hover:text-ink">
                  {PITCH.revision.verRevision}
                </a>
              )}
            </p>
          )}
          {revision.copyBlockedBy && <p className="text-xs text-muted">{a.copiarBloqueado[revision.copyBlockedBy]}</p>}
        </div>
        <div aria-live="polite" className="grid min-w-0 gap-1 text-sm">
          {shown.notice && (
            <p ref={noticeRef} tabIndex={-1} className="text-ink">
              {shown.notice}{" "}
              <Link href={`/ventas/empresas/${data.companyId}`} className="underline underline-offset-4 hover:text-ink-2">
                {a.verFicha}
              </Link>
            </p>
          )}
          {shown.message && <p className="text-bad">{shown.message}</p>}
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
        <FichasInsertables
          claims={variant.claims}
          companyName={data.company.name}
          onVariable={(v: TemplateVariable) => cuerpo.current?.insert([{ kind: "variable", name: v }])}
          onClaim={(c) => cuerpo.current?.insert([{ kind: "claim", id: c.id, raw: c.display }])}
        />

      </form>

      <aside className="min-w-0" aria-label={PITCH.vista.titulo}>
        <VistaYRevision
          preview={preview}
          recipient={contact ? (contact.fullName ?? contact.email) : null}
          revision={revision}
          quality={d ? { score: d.score, note: d.note, held: d.held } : null}
        />
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
