"use client";

import { useState } from "react";
import type { ContactRow } from "@mc/db/queries/ventas";
import { SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/field";
import { Pill } from "@/components/ui/pill";
import { crearContacto, darDeBaja } from "../../actions";
import { Aviso } from "../../_componentes/aviso";
import { SOURCE_META, SOURCE_OPTIONS } from "../../_lib/estado";
import { MESSAGES } from "../../_lib/messages";
import { useVentasForm } from "../../_lib/use-ventas-form";

/**
 * Los contactos de una empresa (VEN-1): los que guardó este espacio y
 * los de fuente pública de otros, que se ven pero no se editan.
 *
 * Añadir uno exige decir de dónde salió el dato; la baja se pide con
 * confirmación porque no se puede deshacer (un trigger de la base lo
 * impide, no solo esta pantalla).
 */
export function Contactos({ companyId, contacts }: { companyId: string; contacts: ContactRow[] }) {
  const t = MESSAGES.contacto;
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();

  return (
    <section aria-labelledby="contactos">
      <SectionTitle
        meta={
          !adding && contacts.length > 0 ? (
            <Button size="sm" variant="secondary" onClick={() => { setAdding(true); setNotice(undefined); }}>
              {t.new}
            </Button>
          ) : undefined
        }
      >
        <span id="contactos">{t.title}</span>
      </SectionTitle>

      {notice && !adding && <Aviso notice={notice} className="mb-3" />}

      {adding && (
        <NuevoContactoForm
          companyId={companyId}
          onCancel={() => setAdding(false)}
          onSaved={(msg) => {
            setNotice(msg);
            setAdding(false);
          }}
        />
      )}

      {contacts.length === 0 && !adding ? (
        <EmptyState title={t.empty.title} description={t.empty.description} action={{ label: t.empty.action, onClick: () => setAdding(true) }} />
      ) : (
        <ul className="mt-3 divide-y divide-border rounded-md border border-border">
          {contacts.map((c) => (
            <ContactItem key={c.id} contact={c} companyId={companyId} />
          ))}
        </ul>
      )}
    </section>
  );
}

function NuevoContactoForm({ companyId, onCancel, onSaved }: { companyId: string; onCancel: () => void; onSaved: (notice: string) => void }) {
  const t = MESSAGES.contacto;
  const [source, setSource] = useState("");
  const { state, pending, formRef, onSubmit, errors } = useVentasForm(crearContacto, (s) => onSaved(s.notice ?? t.saved));
  const sourceHelp = source ? SOURCE_META[source as keyof typeof SOURCE_META]?.help : t.sourceHelp;

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate aria-label={t.new} className="mb-3 rounded-md border border-border bg-surface p-4">
      <input type="hidden" name="companyId" value={companyId} />
      <p className="mb-4 text-xs text-muted">{t.atLeastOne}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.fullName} error={errors.fullName} htmlFor="contacto-name">
          <Input name="fullName" maxLength={200} autoComplete="off" autoFocus />
        </Field>
        <Field label={t.roleTitle} error={errors.roleTitle} htmlFor="contacto-role">
          <Input name="roleTitle" maxLength={120} />
        </Field>
        <Field label={t.email} error={errors.email} htmlFor="contacto-email">
          <Input name="email" type="email" inputMode="email" autoComplete="off" />
        </Field>
        <Field label={t.phone} error={errors.phone} htmlFor="contacto-phone">
          <Input name="phone" type="tel" inputMode="tel" maxLength={40} autoComplete="off" />
        </Field>
        <Field label={t.instagram} error={errors.instagramHandle} htmlFor="contacto-instagram">
          <Input name="instagramHandle" placeholder={t.instagramPlaceholder} maxLength={31} autoComplete="off" />
        </Field>
        <Field label={t.linkedin} error={errors.linkedinUrl} htmlFor="contacto-linkedin">
          <Input name="linkedinUrl" type="url" inputMode="url" placeholder={t.linkedinPlaceholder} />
        </Field>
        <Field label={t.source} help={sourceHelp} error={errors.source} required htmlFor="contacto-source">
          <Select name="source" value={source} onChange={(e) => setSource(e.target.value)} placeholder={t.sourcePlaceholder} options={SOURCE_OPTIONS} />
        </Field>
        <Field label={t.sourceUrl} help={t.sourceUrlHelp} error={errors.sourceUrl} htmlFor="contacto-source-url">
          <Input name="sourceUrl" type="url" inputMode="url" placeholder={t.urlPlaceholder} />
        </Field>
      </div>
      <Aviso message={state.message} className="mt-4" />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={pending}>
          {t.submit}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {MESSAGES.acciones.cancel}
        </Button>
      </div>
    </form>
  );
}

function ContactItem({ contact: c, companyId }: { contact: ContactRow; companyId: string }) {
  const t = MESSAGES.contacto;
  const [confirming, setConfirming] = useState(false);
  const { state, pending, formRef, onSubmit } = useVentasForm(darDeBaja, () => setConfirming(false));
  const name = c.fullName ?? c.email ?? (c.instagramHandle ? `@${c.instagramHandle}` : MESSAGES.contacto.noName);

  return (
    <li className="p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
            <span className={c.optedOut ? "text-muted line-through" : undefined}>{name}</span>
            {c.optedOut && <Pill kind="bad">{t.optedOut}</Pill>}
            {c.bounced && <Pill kind="warn">{t.bounced}</Pill>}
            {!c.isOwn && <Pill kind="neutral">{t.publicSource}</Pill>}
          </p>
          {c.roleTitle && <p className="mt-0.5 text-xs text-ink-2">{c.roleTitle}</p>}
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-2">
            {/* Sin nombre, el correo o el Instagram hacen de título: no se repiten aquí. */}
            {c.email && name !== c.email &&
              (c.optedOut ? (
                <span>{c.email}</span>
              ) : (
                <a href={`mailto:${c.email}`} className="hover:underline">
                  {c.email}
                </a>
              ))}
            {c.phone && <span>{c.phone}</span>}
            {c.instagramHandle && name !== `@${c.instagramHandle}` && <span>@{c.instagramHandle}</span>}
            {c.linkedinUrl && (
              <a href={c.linkedinUrl} target="_blank" rel="noreferrer noopener" className="hover:underline">
                {t.linkedin}
              </a>
            )}
          </p>
          <p className="mt-1 text-xs text-muted">
            {t.sourceLabel}: {SOURCE_META[c.source].label}
            {c.sourceUrl && (
              <>
                {" · "}
                <a href={c.sourceUrl} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2 hover:text-ink">
                  {t.seeSource}
                </a>
              </>
            )}
          </p>
          {!c.isOwn && <p className="mt-1 text-xs text-muted">{t.notOwn}</p>}
          {c.optedOut && c.optedOutReason && <p className="mt-1 text-xs text-muted">{c.optedOutReason}</p>}
        </div>
        {c.isOwn && !c.optedOut && !confirming && (
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} aria-label={`${t.optOut}: ${name}`}>
            {t.optOut}
          </Button>
        )}
      </div>

      {confirming && (
        <form ref={formRef} onSubmit={onSubmit} noValidate aria-label={t.optOutTitle} className="mt-3 rounded-md border border-bad/30 bg-bad-wash p-3">
          <input type="hidden" name="contactId" value={c.id} />
          <input type="hidden" name="companyId" value={companyId} />
          <p className="text-sm font-medium text-ink">{t.optOutTitle}</p>
          <p className="mt-1 text-xs leading-5 text-ink-2">{t.optOutHelp}</p>
          <Field label={t.optOutReason} htmlFor={`baja-${c.id}`} className="mt-3">
            <Input name="reason" maxLength={280} />
          </Field>
          <Aviso message={state.message} className="mt-3" />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="danger" loading={pending}>
              {t.optOutConfirm}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              {MESSAGES.acciones.cancel}
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}
