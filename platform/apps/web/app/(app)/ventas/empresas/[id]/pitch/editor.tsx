"use client";

import Link from "next/link";
import { startTransition, useActionState, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { SalesClaim } from "@mc/core/outreach/claims";
import { templateValuesFrom, type TemplateVariable } from "@mc/core/outreach/render";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { guardarPitch, type PitchState } from "./actions";
import { FichasInsertables } from "./fichas";
import { PITCH } from "./messages";
import { VistaYRevision } from "./revision";
import { claimSnippet, insertAt, previewOf, reviseDraft } from "./vista";

export interface EditorData {
  companyId: string;
  company: { name: string; industry: string | null; city: string | null };
  contacts: Array<{ id: string; fullName: string | null; roleTitle: string | null; email: string; firstTouch: boolean }>;
  deals: Array<{ id: string; label: string; signalHeadline: string | null }>;
  claims: SalesClaim[];
  creator: { name: string; handle: string | null; niche: string | null } | null;
  /** La ruta del media kit público («/kit/abc»); se vuelve absoluta en el navegador. */
  mediaKitPath: string | null;
  draft: {
    touchId: string;
    contactId: string | null;
    dealId: string | null;
    subject: string;
    body: string;
    held: string | null;
    generated: boolean;
    score: string | null;
    note: string | null;
  } | null;
  aiConfigured: boolean;
  sendingOn: boolean;
}

/**
 * El editor del pitch: a la izquierda, para quién, el asunto, el mensaje
 * y las fichas insertables; a la derecha, cómo lo recibe la marca y la
 * revisión en línea. «Copiar» copia el texto limpio y guarda el borrador;
 * «Programar» solo se puede con la revisión en verde (y el servidor la
 * repite). Como el generador de Chief y el compositor de Superhuman: el
 * texto manda y todo lo demás está a un toque.
 */
export function EditorDePitch({ data }: { data: EditorData }) {
  const d = data.draft;
  const [contactId, setContactId] = useState(d?.contactId ?? data.contacts[0]?.id ?? "");
  const [dealId, setDealId] = useState(d?.dealId ?? data.deals[0]?.id ?? "");
  const [subject, setSubject] = useState(d?.subject ?? "");
  const [body, setBody] = useState(d?.body ?? "");
  const [origin, setOrigin] = useState<string | null>(null);
  // El Textarea del kit no reenvía ref: el cursor se lee de su contenedor.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [state, dispatch, pending] = useActionState<PitchState, FormData>(guardarPitch, {});
  const noticeRef = useRef<HTMLParagraphElement>(null);

  // La URL del media kit se arma con el dominio con el que entró la visita, no con una variable del servidor.
  useEffect(() => setOrigin(window.location.origin), []);
  useEffect(() => {
    if (state.stamp) noticeRef.current?.focus();
  }, [state.stamp]);

  const contact = data.contacts.find((c) => c.id === contactId) ?? null;
  const deal = data.deals.find((x) => x.id === dealId) ?? null;
  const mediaKitUrl = data.mediaKitPath && origin ? new URL(data.mediaKitPath, origin).toString() : null;
  const values = useMemo(
    () =>
      templateValuesFrom({
        contact: contact ? { fullName: contact.fullName, roleTitle: contact.roleTitle } : null,
        company: data.company,
        signal: { headline: deal?.signalHeadline ?? null },
        creator: data.creator ? { senderName: data.creator.name, handle: data.creator.handle, niche: data.creator.niche, mediaKitUrl } : null,
      }),
    [contact, deal, data.company, data.creator, mediaKitUrl],
  );
  const preview = previewOf(subject, body, values);
  const revision = reviseDraft({ subject, body, values, claims: data.claims, firstTouch: contact?.firstTouch ?? true });

  function insert(snippet: string) {
    const el = bodyRef.current?.querySelector("textarea") ?? null;
    const { text, cursor } = insertAt(body, el?.selectionStart ?? body.length, el?.selectionEnd ?? body.length, snippet);
    setBody(text);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(cursor, cursor);
    });
  }

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

  const t = PITCH.campos;
  const a = PITCH.acciones;
  const touchId = state.touchId ?? d?.touchId ?? "";
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_360px]">
      <form onSubmit={onSubmit} noValidate className="grid min-w-0 content-start gap-5" aria-label={PITCH.title(data.company.name)}>
        <input type="hidden" name="companyId" value={data.companyId} />
        <input type="hidden" name="touchId" value={touchId} />
        <input type="hidden" name="mediaKitUrl" value={mediaKitUrl ?? ""} />
        {!data.aiConfigured && !d?.generated && <p className="rounded-md border border-dashed border-border p-3 text-sm text-ink-2">{PITCH.revision.iaNoConfigurada}</p>}
        {d?.generated && <p className="text-sm text-ink-2">{PITCH.revision.generado}</p>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.contacto} help={data.contacts.length > 0 ? t.contactoHelp : t.sinContactos} htmlFor="pitch-contacto" error={state.errors?.contactId}>
            <Select
              name="contactId"
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
              placeholder={t.contactoPlaceholder}
              options={data.contacts.map((c) => ({ value: c.id, label: c.fullName ? `${c.fullName} · ${c.email}` : c.email }))}
            />
          </Field>
          <Field label={t.negocio} help={t.negocioHelp} htmlFor="pitch-negocio">
            <Select
              name="dealId"
              value={dealId}
              onChange={(e) => setDealId(e.target.value)}
              placeholder={t.negocioNinguno}
              options={data.deals.map((x) => ({ value: x.id, label: x.label }))}
            />
          </Field>
        </div>
        <Field label={t.asunto} help={t.asuntoHelp} htmlFor="pitch-asunto">
          <Input name="subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} />
        </Field>
        <div ref={bodyRef}>
          <Field label={t.cuerpo} help={t.cuerpoHelp} htmlFor="pitch-cuerpo">
            <Textarea name="body" rows={12} value={body} onChange={(e) => setBody(e.target.value)} maxLength={20_000} />
          </Field>
        </div>

        <FichasInsertables
          claims={data.claims}
          onVariable={(v: TemplateVariable) => insert(`{{${v}}}`)}
          onClaim={(c) => insert(claimSnippet(c))}
        />

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <Button type="submit" name="intent" value="schedule" variant="primary" loading={pending} disabled={!revision.ok || !contact}>
            {a.programar}
          </Button>
          <Button type="submit" name="intent" value="copy" disabled={!revision.canCopy || !contact || pending} aria-label={a.copiarLabel}>
            {a.copiar}
          </Button>
          <Button type="submit" name="intent" value="draft" variant="ghost" disabled={!contact || pending}>
            {a.guardar}
          </Button>
        </div>
        {!revision.canCopy && <p className="text-xs text-muted">{a.copiarBloqueado}</p>}
        <div aria-live="polite" className="grid gap-1 text-sm">
          {state.notice && (
            <p ref={noticeRef} tabIndex={-1} className="text-ink">
              {state.notice}{" "}
              <Link href={`/ventas/empresas/${data.companyId}`} className="underline underline-offset-4 hover:text-ink-2">
                {a.verFicha}
              </Link>
            </p>
          )}
          {state.message && <p className="text-bad">{state.message}</p>}
          {state.issues && state.issues.length > 0 && (
            <ul className="list-disc pl-5 text-ink-2">
              {state.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
          {state.link && (
            <Link href={state.link.href} className="underline underline-offset-4 hover:text-ink-2">
              {state.link.label}
            </Link>
          )}
        </div>
      </form>

      <aside className="min-w-0" aria-label={PITCH.vista.titulo}>
        <VistaYRevision
          preview={preview}
          recipient={contact ? (contact.fullName ?? contact.email) : null}
          revision={revision}
          quality={d ? { score: d.score, note: d.note, held: d.held } : null}
        />
        {!data.sendingOn && <p className="mt-4 text-xs text-muted">{a.programadoApagado}</p>}
      </aside>
    </div>
  );
}
