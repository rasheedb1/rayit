"use client";

import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { crearEmpresa } from "../../actions";
import { Aviso } from "../../_componentes/aviso";
import { RELATIONSHIP_OPTIONS } from "../../_lib/estado";
import { MESSAGES } from "../../_lib/messages";
import { useVentasForm } from "../../_lib/use-ventas-form";

/**
 * «Nueva empresa». Si sale bien, la acción redirige a la ficha; aquí
 * solo se ven los errores. Un dominio que ya es de otra empresa del
 * espacio se marca en su campo, con el nombre de la que ya existe.
 */
export function NuevaEmpresaForm() {
  const t = MESSAGES.empresas.form;
  const { state, pending, formRef, onSubmit, errors } = useVentasForm(crearEmpresa);

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className="max-w-2xl space-y-6">
      <Aviso message={state.message} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.name} required error={errors.name} htmlFor="empresa-name" className="sm:col-span-2">
          <Input name="name" maxLength={200} autoComplete="organization" autoFocus />
        </Field>
        <Field label={t.domain} error={errors.domain} help={MESSAGES.radar.form.domainHelp} htmlFor="empresa-domain" className="sm:col-span-2">
          <Input name="domain" inputMode="url" placeholder="cafealma.co" maxLength={253} autoComplete="off" />
        </Field>
        <Field label={t.country} help={t.countryHelp} error={errors.country} htmlFor="empresa-country">
          <Input name="country" maxLength={2} className="uppercase" autoComplete="off" />
        </Field>
        <Field label={t.city} error={errors.city} htmlFor="empresa-city">
          <Input name="city" maxLength={120} />
        </Field>
        <Field label={t.industry} error={errors.industry} htmlFor="empresa-industry">
          <Input name="industry" maxLength={120} />
        </Field>
        <Field label={t.relationship} error={errors.relationship} htmlFor="empresa-relationship">
          <Select name="relationship" defaultValue="prospect" options={RELATIONSHIP_OPTIONS} />
        </Field>
        <Field label={t.notes} error={errors.notes} htmlFor="empresa-notes" className="sm:col-span-2">
          <Textarea name="notes" rows={3} maxLength={2000} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={pending}>
          {t.submit}
        </Button>
        <Button variant="ghost" href="/ventas/empresas">
          {MESSAGES.acciones.cancel}
        </Button>
      </div>
    </form>
  );
}
