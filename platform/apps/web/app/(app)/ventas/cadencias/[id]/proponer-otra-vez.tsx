"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { Aviso } from "../../../_lib/aviso";
import { SIN_PERSONA } from "../_lib/protocolo";
import { proponerDesdeSenal, type CadenciaState } from "../actions";
import { MESSAGES } from "../messages";

/**
 * «Proponer desde esta señal» en el borrador: otra persona de la marca,
 * otra propuesta. Reemplaza los pasos (solo sin nadie dentro). «Sin
 * persona todavía» manda un valor propio (SIN_PERSONA), no
 * el vacío: el vacío es «la de por defecto» y planearía para alguien.
 */
export function ProponerOtraVez({
  sequenceId,
  signalId,
  personas,
  elegida,
  bloqueo,
}: {
  sequenceId: string;
  signalId: string;
  /** Por qué no se puede volver a proponer (todas las personas de la marca de baja): en vez del formulario. */
  bloqueo?: string;
  /**
   * Las personas de la marca que se pueden elegir: en la opción, el nombre
   * (y una marca corta si ya está en otra cadencia); en `detalle`, por
   * dónde se le llega y en qué cadencia está, que va debajo del campo
   * para la elegida (en la opción se cortaba).
   */
  personas: { value: string; label: string; detalle: string }[];
  elegida: string | null;
}) {
  const t = MESSAGES.proponer;
  const [state, action, pending] = useActionState<CadenciaState, FormData>(proponerDesdeSenal, {});
  const [valor, setValor] = useState(elegida ?? SIN_PERSONA);
  const ayuda = valor === SIN_PERSONA ? t.sinPersonaAyuda : personas.find((p) => p.value === valor)?.detalle;
  return (
    <section aria-labelledby="proponer" className="rounded-md border border-line bg-surface p-4">
      <h2 id="proponer" className="text-sm font-semibold">
        {t.titulo}
      </h2>
      <p className="mt-1 text-xs text-fg-2">{t.descripcion}</p>
      {bloqueo ? (
        <p className="mt-3 text-xs text-fg-3">{bloqueo}</p>
      ) : (
        <form action={action} className="mt-3 grid gap-3">
          <input type="hidden" name="signalId" value={signalId} />
          <input type="hidden" name="sequenceId" value={sequenceId} />
          <Field label={t.persona} help={ayuda}>
            <Select
              name="contactId"
              options={[{ value: SIN_PERSONA, label: t.sinPersona }, ...personas.map(({ value, label }) => ({ value, label }))]}
              value={valor}
              onChange={(e) => setValor(e.target.value)}
            />
          </Field>
          <div>
            <Button type="submit" size="sm" variant="secondary" loading={pending}>
              {pending ? MESSAGES.senales.proponiendo : t.boton}
            </Button>
          </div>
          <Aviso message={state.error} size="xs" />
        </form>
      )}
    </section>
  );
}
