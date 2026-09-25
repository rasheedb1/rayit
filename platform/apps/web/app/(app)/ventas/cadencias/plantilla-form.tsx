"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { Aviso } from "../../_lib/aviso";
import { crearDesdePlantilla, type CadenciaState } from "./actions";
import { MESSAGES } from "./messages";

/** «Empezar desde una plantilla»: copia una plantilla tal cual, en borrador. */
export function PlantillaForm({ opciones }: { opciones: { value: string; label: string }[] }) {
  const t = MESSAGES.plantillas;
  const [state, action, pending] = useActionState<CadenciaState, FormData>(crearDesdePlantilla, {});
  return (
    <form action={action} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <Field label={t.label} className="min-w-0 flex-1">
        <Select name="slug" options={opciones} placeholder={t.placeholder} defaultValue="" required />
      </Field>
      <Button type="submit" variant="secondary" loading={pending}>
        {t.crear}
      </Button>
      <Aviso message={state.error} size="xs" />
    </form>
  );
}
