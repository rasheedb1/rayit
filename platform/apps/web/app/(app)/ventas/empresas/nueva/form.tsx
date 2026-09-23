"use client";

import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { crearEmpresa, editarEmpresa } from "../../actions";
import { Aviso } from "../../_componentes/aviso";
import { RELATIONSHIP_OPTIONS } from "../../_lib/estado";
import { MESSAGES } from "../../_lib/messages";
import type { CountryOption } from "../../_lib/paises";
import { useVentasForm } from "../../_lib/use-ventas-form";

/** Lo que el formulario necesita de una empresa para editarla. */
export interface EmpresaEditable {
  id: string;
  name: string;
  domain: string | null;
  country: string | null;
  city: string | null;
  industry: string | null;
  notes: string | null;
  /** La ficha es de este espacio. Si no (catálogo compartido), solo se editan las notas. */
  isOwn: boolean;
}

/**
 * «Nueva empresa». Si sale bien, la acción redirige a la ficha; aquí
 * solo se ven los errores. Un dominio que ya es de otra empresa del
 * espacio se marca en su campo, con el nombre de la que ya existe.
 */
export function NuevaEmpresaForm({ countries }: { countries: CountryOption[] }) {
  return <EmpresaForm countries={countries} />;
}

/**
 * El formulario de una empresa, para crearla y para corregirla desde su
 * ficha (VEN-1): los mismos campos, las mismas validaciones y los mismos
 * errores de campo.
 *
 * Al editar, la relación no está aquí (se cambia al lado, con el
 * responsable) y, si la empresa es del catálogo compartido, solo se
 * ofrecen las notas, con el aviso de por qué: su nombre y su web son de
 * todos los espacios.
 */
export function EmpresaForm({
  company,
  countries,
  onCancel,
  onSaved,
}: {
  /** Sin empresa, es «Nueva empresa». */
  company?: EmpresaEditable;
  /**
   * Las opciones de país (countryOptions, en el servidor). Un país
   * guardado que no está en la lista (un «XX» de antes) sale como «Sin
   * país»: al guardar se limpia en vez de volver a escribirse.
   */
  countries: CountryOption[];
  onCancel?: () => void;
  onSaved?: (notice: string) => void;
}) {
  const t = MESSAGES.empresas.form;
  const editing = company !== undefined;
  const { state, pending, formRef, onSubmit, errors } = useVentasForm(editing ? editarEmpresa : crearEmpresa, (s) =>
    onSaved?.(s.notice ?? t.saved),
  );
  const soloNotas = editing && !company.isOwn;
  // En la ficha el formulario vive en la columna estrecha: una sola columna.
  const grid = editing ? "grid gap-4" : "grid gap-4 sm:grid-cols-2";
  const span = editing ? "" : "sm:col-span-2";

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      noValidate
      aria-label={editing ? t.editTitle : undefined}
      className={editing ? "space-y-4" : "max-w-2xl space-y-6"}
    >
      {editing && <input type="hidden" name="companyId" value={company.id} />}
      {soloNotas && <input type="hidden" name="scope" value="notes" />}
      <Aviso message={state.message} />
      {soloNotas && <p className="text-xs leading-5 text-muted">{t.notOwn}</p>}
      <div className={grid}>
        {!soloNotas && (
          <>
            <Field label={t.name} required error={errors.name} htmlFor="empresa-name" className={span}>
              <Input name="name" maxLength={200} autoComplete="organization" autoFocus defaultValue={company?.name} />
            </Field>
            <Field label={t.domain} error={errors.domain} help={MESSAGES.radar.form.domainHelp} htmlFor="empresa-domain" className={span}>
              <Input
                name="domain"
                inputMode="url"
                placeholder={t.domainPlaceholder}
                maxLength={253}
                autoComplete="off"
                defaultValue={company?.domain ?? undefined}
              />
            </Field>
            <Field label={t.country} error={errors.country} htmlFor="empresa-country">
              <Select
                name="country"
                defaultValue={company?.country?.toUpperCase() ?? ""}
                placeholder={t.countryPlaceholder}
                options={countries}
                autoComplete="country"
              />
            </Field>
            <Field label={t.city} error={errors.city} htmlFor="empresa-city">
              <Input name="city" maxLength={120} defaultValue={company?.city ?? undefined} />
            </Field>
            <Field label={t.industry} error={errors.industry} htmlFor="empresa-industry">
              <Input name="industry" maxLength={120} defaultValue={company?.industry ?? undefined} />
            </Field>
          </>
        )}
        {!editing && (
          <Field label={t.relationship} error={errors.relationship} htmlFor="empresa-relationship">
            <Select name="relationship" defaultValue="prospect" options={RELATIONSHIP_OPTIONS} />
          </Field>
        )}
        <Field label={t.notes} error={errors.notes} htmlFor="empresa-notes" className={span}>
          <Textarea name="notes" rows={3} maxLength={2000} defaultValue={company?.notes ?? undefined} autoFocus={soloNotas} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={pending}>
          {editing ? t.save : t.submit}
        </Button>
        {editing ? (
          <Button variant="ghost" onClick={onCancel}>
            {MESSAGES.acciones.cancel}
          </Button>
        ) : (
          <Button variant="ghost" href="/ventas/empresas">
            {MESSAGES.acciones.cancel}
          </Button>
        )}
      </div>
    </form>
  );
}
