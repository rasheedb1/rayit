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
}: {
  signalId: string;
  label?: string;
  variant?: "primary" | "secondary" | "ghost";
}) {
  const [state, action, pending] = useActionState<CadenciaState, FormData>(proponerDesdeSenal, {});
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
