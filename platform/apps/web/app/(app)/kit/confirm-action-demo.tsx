"use client";

import { ConfirmAction, type ConfirmActionState } from "@/components/ui/confirm-action";

/**
 * La confirmación en línea de una Server Action con estado (Equipo:
 * quitar a alguien, revocar una invitación). Aquí la acción no llama al
 * servidor: espera un momento y contesta como lo haría una acción real,
 * con éxito o con un mensaje que se queda bajo el botón.
 */
export function ConfirmActionDemo({
  resultado = "ok",
  disabledReason,
  openWidth,
}: {
  resultado?: "ok" | "error";
  disabledReason?: string;
  openWidth?: string;
}) {
  const action = async (_prev: ConfirmActionState, formData: FormData): Promise<ConfirmActionState> => {
    await new Promise((r) => setTimeout(r, 900));
    const quien = String(formData.get("userId") ?? "");
    return resultado === "ok" ? { ok: true } : { ok: false, message: `No pudimos quitar a ${quien}: es la única dueña del espacio.` };
  };
  return (
    <ConfirmAction
      action={action}
      fields={{ userId: "Laura" }}
      label="Quitar del equipo"
      variant="danger"
      size="sm"
      question="¿Quitar a Laura del equipo?"
      consequence="Deja de entrar al espacio en cuanto confirmes. Se puede volver a invitar."
      confirmLabel="Sí, quitar"
      cancelLabel="Cancelar"
      disabledReason={disabledReason}
      openWidth={openWidth}
    />
  );
}
