"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { Aviso } from "../../_lib/aviso";
import { crearDesdePlantilla, type CadenciaState } from "./actions";
import { MESSAGES } from "./messages";

export interface PlantillaOpcion {
  value: string;
  label: string;
  /** «6 pasos en 9 días · Campaña activa», ya formateado en el servidor. */
  resumen: string;
  /** Para qué sirve (outbound_sequence_template.description_es). */
  descripcion: string;
}

/**
 * «Empezar desde una plantilla»: copia una plantilla tal cual, en
 * borrador. Debajo del selector, lo que trae la elegida (cuántos pasos,
 * en cuántos días, para qué señal y para qué sirve): se elige sabiendo
 * qué se obtiene.
 */
export function PlantillaForm({ opciones }: { opciones: PlantillaOpcion[] }) {
  const t = MESSAGES.plantillas;
  const [state, action, pending] = useActionState<CadenciaState, FormData>(crearDesdePlantilla, {});
  const [slug, setSlug] = useState("");
  const elegida = opciones.find((o) => o.value === slug);
  return (
    <form action={action} className="grid gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label={t.label} className="min-w-0 flex-1">
          <Select
            name="slug"
            options={opciones.map(({ value, label }) => ({ value, label }))}
            placeholder={t.placeholder}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            required
          />
        </Field>
        <Button type="submit" variant="secondary" loading={pending}>
          {t.crear}
        </Button>
      </div>
      <div aria-live="polite">
        {elegida && (
          <div className="rounded-md border border-line bg-surface p-3 text-sm">
            <p className="text-xs tabular-nums text-fg-3">{elegida.resumen}</p>
            <p className="mt-1 break-words text-fg-2">{elegida.descripcion}</p>
          </div>
        )}
      </div>
      <Aviso message={state.error} size="xs" />
    </form>
  );
}
