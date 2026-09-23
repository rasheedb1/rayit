"use client";

import type { Relationship } from "@mc/db/queries/ventas";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { cambiarRelacion } from "../../actions";
import { Aviso } from "../../_componentes/aviso";
import { RELATIONSHIP_OPTIONS } from "../../_lib/estado";
import { MESSAGES } from "../../_lib/messages";
import { useVentasForm } from "../../_lib/use-ventas-form";

/** Cambiar la relación con la empresa (prospecto, contactada, cliente…) desde su ficha. */
export function RelacionForm({ companyId, relationship }: { companyId: string; relationship: Relationship }) {
  const t = MESSAGES.empresas.detail;
  const { state, pending, formRef, onSubmit, errors } = useVentasForm(cambiarRelacion);
  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="companyId" value={companyId} />
      <Field label={t.relationship} error={errors.relationship} htmlFor="ficha-relationship" className="w-48">
        {/* key: al revalidar con otra relación, el select arranca de la nueva. */}
        <Select key={relationship} name="relationship" defaultValue={relationship} options={RELATIONSHIP_OPTIONS} />
      </Field>
      <Button type="submit" size="md" loading={pending}>
        {t.saveRelationship}
      </Button>
      <Aviso message={state.message} notice={state.notice} className="basis-full" />
    </form>
  );
}
