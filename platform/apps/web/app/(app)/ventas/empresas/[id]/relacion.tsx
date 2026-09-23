"use client";

import type { OwnerOption, Relationship } from "@mc/db/queries/ventas";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { cambiarRelacion } from "../../actions";
import { Aviso } from "../../_componentes/aviso";
import { RELATIONSHIP_OPTIONS } from "../../_lib/estado";
import { MESSAGES } from "../../_lib/messages";
import { useVentasForm } from "../../_lib/use-ventas-form";

/**
 * La relación con la empresa (prospecto, contactada, cliente…) y su
 * responsable, desde la ficha. Las dos son de este espacio
 * (company_link), también en una empresa del catálogo compartido.
 *
 * El responsable se elige entre las personas del espacio; «Sin
 * responsable» lo deja vacío.
 */
export function RelacionForm({
  companyId,
  relationship,
  ownerUserId,
  owners,
}: {
  companyId: string;
  relationship: Relationship;
  ownerUserId: string | null;
  owners: OwnerOption[];
}) {
  const t = MESSAGES.empresas.detail;
  const { state, pending, formRef, onSubmit, errors } = useVentasForm(cambiarRelacion);
  const ownerOptions = owners.map((o) => ({ value: o.userId, label: o.label }));
  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className="grid gap-3">
      <input type="hidden" name="companyId" value={companyId} />
      <Field label={t.relationship} error={errors.relationship} htmlFor="ficha-relationship">
        {/* key: al revalidar con otra relación, el select arranca de la nueva. */}
        <Select key={relationship} name="relationship" defaultValue={relationship} options={RELATIONSHIP_OPTIONS} />
      </Field>
      <Field label={t.owner} error={errors.ownerUserId} htmlFor="ficha-owner">
        <Select key={ownerUserId ?? ""} name="ownerUserId" defaultValue={ownerUserId ?? ""} placeholder={t.noOwner} options={ownerOptions} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="md" loading={pending}>
          {t.save}
        </Button>
      </div>
      <Aviso message={state.message} notice={state.notice} />
    </form>
  );
}
