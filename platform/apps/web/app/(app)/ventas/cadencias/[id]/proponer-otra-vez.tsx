"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { Aviso } from "../../../_lib/aviso";
import { proponerDesdeSenal, type CadenciaState } from "../actions";
import { MESSAGES } from "../messages";

/**
 * «Proponer desde esta señal» en el borrador: otra persona de la marca,
 * otra propuesta. Reemplaza los pasos (solo sin nadie dentro). «Sin
 * persona todavía» manda un valor propio (MESSAGES.proponer.ninguna), no
 * el vacío: el vacío es «la de por defecto» y planearía para alguien.
 */
export function ProponerOtraVez({
  sequenceId,
  signalId,
  personas,
  elegida,
}: {
  sequenceId: string;
  signalId: string;
  /** Las personas de la marca que se pueden elegir, con sus canales ya dichos en la etiqueta. */
  personas: { value: string; label: string }[];
  elegida: string | null;
}) {
  const t = MESSAGES.proponer;
  const [state, action, pending] = useActionState<CadenciaState, FormData>(proponerDesdeSenal, {});
  return (
    <section aria-labelledby="proponer" className="rounded-md border border-line bg-surface p-4">
      <h2 id="proponer" className="text-sm font-semibold">
        {t.titulo}
      </h2>
      <p className="mt-1 text-xs text-fg-2">{t.descripcion}</p>
      <form action={action} className="mt-3 grid gap-3">
        <input type="hidden" name="signalId" value={signalId} />
        <input type="hidden" name="sequenceId" value={sequenceId} />
        <Field label={t.persona}>
          <Select
            name="contactId"
            options={[{ value: t.ninguna, label: t.sinPersona }, ...personas]}
            defaultValue={elegida ?? t.ninguna}
          />
        </Field>
        <div>
          <Button type="submit" size="sm" variant="secondary" loading={pending}>
            {pending ? MESSAGES.senales.proponiendo : t.boton}
          </Button>
        </div>
        <Aviso message={state.error} size="xs" />
      </form>
    </section>
  );
}
