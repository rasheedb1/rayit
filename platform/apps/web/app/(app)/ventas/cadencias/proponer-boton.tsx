"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Aviso } from "../../_lib/aviso";
import { proponerDesdeSenal, type CadenciaState } from "./actions";
import { MESSAGES } from "./messages";

/**
 * El primer clic: «Proponer cadencia» para una señal. El recomendador
 * decide los pasos y la pantalla salta a la línea de tiempo, donde el
 * segundo clic la activa. Si falla, el motivo queda debajo del botón.
 */
export function ProponerBoton({
  signalId,
  label = MESSAGES.senales.proponer,
  variant = "primary",
  bloqueo,
}: {
  signalId: string;
  label?: string;
  variant?: "primary" | "secondary" | "ghost";
  /** Por qué no se puede proponer (todas las personas de la marca de baja): el botón queda deshabilitado con el motivo. */
  bloqueo?: string;
}) {
  const [state, action, pending] = useActionState<CadenciaState, FormData>(proponerDesdeSenal, {});
  if (bloqueo) {
    return (
      <div className="grid gap-2">
        <Button size="sm" variant={variant} disabled>
          {label}
        </Button>
        <p className="max-w-xs text-xs text-fg-3">{bloqueo}</p>
      </div>
    );
  }
  return (
    <form action={action} className="grid gap-2">
      <input type="hidden" name="signalId" value={signalId} />
      <Button type="submit" size="sm" variant={variant} loading={pending}>
        {pending ? MESSAGES.senales.proponiendo : label}
      </Button>
      <Aviso message={state.error} size="xs" />
    </form>
  );
}
