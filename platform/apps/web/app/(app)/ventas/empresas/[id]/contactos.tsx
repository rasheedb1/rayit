"use client";

import { useState } from "react";
import type { ContactRow } from "@mc/db/queries/ventas";
import { SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/field";
import { Pill } from "@/components/ui/pill";
import { crearContacto, darDeBaja, editarContacto } from "../../actions";
import { Aviso } from "../../_componentes/aviso";
import { SOURCE_META, SOURCE_OPTIONS } from "../../_lib/estado";
import { MESSAGES } from "../../_lib/messages";
import { useVentasForm } from "../../_lib/use-ventas-form";

/**
 * Los contactos de una empresa (VEN-1): los que guardó este espacio y
 * los de fuente pública de otros, que se ven pero no se editan.
 *
 * Añadir uno exige decir de dónde salió el dato, y editarlo también: se
 * edita con el mismo formulario del alta, con la procedencia puesta. La
 * baja se pide con confirmación porque no se puede deshacer (un trigger
 * de la base lo impide, no solo esta pantalla).
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
        <ContactoForm
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

/**
 * El formulario de un contacto: vacío para añadirlo, con sus datos para
 * editarlo. Los ids de los campos llevan el del contacto, para que dos
 * formularios abiertos a la vez (uno nuevo y uno en edición) no
 * compartan etiquetas.
 */
function ContactoForm({
  companyId,
  contact,
  onCancel,
  onSaved,
}: {
  companyId: string;
  contact?: ContactRow;
  onCancel: () => void;
  onSaved: (notice: string) => void;
}) {
  const t = MESSAGES.contacto;
  const editing = contact !== undefined;
  const [source, setSource] = useState<string>(contact?.source ?? "");
  const { state, pending, formRef, onSubmit, errors } = useVentasForm(editing ? editarContacto : crearContacto, (s) =>
    onSaved(s.notice ?? (editing ? t.edited : t.saved)),
  );
  const sourceHelp = source ? SOURCE_META[source as keyof typeof SOURCE_META]?.help : t.sourceHelp;
  const id = (campo: string) => `contacto-${contact?.id ?? "nuevo"}-${campo}`;

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      noValidate
      aria-label={editing ? t.editTitle : t.new}
      className={`rounded-md border border-border bg-surface p-4 ${editing ? "mt-3" : "mb-3"}`}
    >
      <input type="hidden" name="companyId" value={companyId} />
      {editing && <input type="hidden" name="contactId" value={contact.id} />}
      <p className="mb-4 text-xs text-muted">{t.atLeastOne}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.fullName} error={errors.fullName} htmlFor={id("name")}>
          <Input name="fullName" maxLength={200} autoComplete="off" autoFocus defaultValue={contact?.fullName ?? undefined} />
        </Field>
        <Field label={t.roleTitle} error={errors.roleTitle} htmlFor={id("role")}>
          <Input name="roleTitle" maxLength={120} defaultValue={contact?.roleTitle ?? undefined} />
        </Field>
        <Field label={t.email} error={errors.email} htmlFor={id("email")}>
          <Input name="email" type="email" inputMode="email" autoComplete="off" defaultValue={contact?.email ?? undefined} />
        </Field>
        <Field label={t.phone} error={errors.phone} htmlFor={id("phone")}>
          <Input name="phone" type="tel" inputMode="tel" maxLength={40} autoComplete="off" defaultValue={contact?.phone ?? undefined} />
        </Field>
        <Field label={t.instagram} error={errors.instagramHandle} htmlFor={id("instagram")}>
          <Input
            name="instagramHandle"
            placeholder={t.instagramPlaceholder}
            maxLength={31}
            autoComplete="off"
            defaultValue={contact?.instagramHandle ?? undefined}
          />
        </Field>
        <Field label={t.linkedin} error={errors.linkedinUrl} htmlFor={id("linkedin")}>
          <Input name="linkedinUrl" type="url" inputMode="url" placeholder={t.linkedinPlaceholder} defaultValue={contact?.linkedinUrl ?? undefined} />
        </Field>
        <Field label={t.source} help={sourceHelp} error={errors.source} required htmlFor={id("source")}>
          <Select name="source" value={source} onChange={(e) => setSource(e.target.value)} placeholder={t.sourcePlaceholder} options={SOURCE_OPTIONS} />
        </Field>
        <Field label={t.sourceUrl} help={t.sourceUrlHelp} error={errors.sourceUrl} htmlFor={id("source-url")}>
          <Input name="sourceUrl" type="url" inputMode="url" placeholder={t.urlPlaceholder} defaultValue={contact?.sourceUrl ?? undefined} />
        </Field>
      </div>
      <Aviso message={state.message} className="mt-4" />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={pending}>
          {editing ? t.saveEdit : t.submit}
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
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
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
        {/* Solo los propios y sin baja: uno del catálogo no es de este
            espacio, y a uno que pidió la baja no se le vuelve a escribir. */}
        {c.isOwn && !c.optedOut && !confirming && !editing && (
          <div className="flex shrink-0 gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(true);
                setNotice(undefined);
              }}
              aria-label={t.editLabel(name)}
            >
              {t.edit}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} aria-label={`${t.optOut}: ${name}`}>
              {t.optOut}
            </Button>
          </div>
        )}
      </div>

      {notice && !editing && <Aviso notice={notice} className="mt-3" />}

      {editing && (
        <ContactoForm
          companyId={companyId}
          contact={c}
          onCancel={() => setEditing(false)}
          onSaved={(msg) => {
            setNotice(msg);
            setEditing(false);
          }}
        />
      )}

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
