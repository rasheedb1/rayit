"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field } from "@/components/ui/field";
import type { ActionState } from "@/lib/forms";
import { crearCampanaConVentana } from "../../actions";
import { MESSAGES } from "../../messages";

/**
 * COT-4 · La salida de una cotización que se aceptó sin la ventana de la
 * campaña: una aceptada ya no se edita, así que las fechas se dan aquí y
 * Campañas (CAM-2) crea la campaña con ellas. La validación de verdad
 * (fechas, fin ≥ inicio) es la de la Server Action.
 */
export function VentanaCampana({ id }: { id: string }) {
  const t = MESSAGES.detalle;
  const [state, formAction, pending] = useActionState<ActionState, FormData>(crearCampanaConVentana.bind(null, id), {});
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const errors = state.errors ?? {};

  return (
    <form action={formAction} className="mt-3 space-y-3" noValidate>
      {state.message && (
        <p role="alert" className="rounded-md border border-bad/30 bg-bad-wash px-3 py-2 text-xs text-bad">
          {state.message}
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
        <Field label={t.ventanaDesde} required error={errors.startsOn} htmlFor={`ventana-desde-${id}`}>
          <DateInput name="startsOn" value={desde} onChange={setDesde} />
        </Field>
        <Field label={t.ventanaHasta} required error={errors.endsOn} htmlFor={`ventana-hasta-${id}`}>
          <DateInput name="endsOn" value={hasta} min={desde || undefined} onChange={setHasta} />
        </Field>
      </div>
      <Button size="sm" variant="primary" type="submit" loading={pending}>
        {t.crearCampana}
      </Button>
    </form>
  );
}
