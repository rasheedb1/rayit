"use client";

import { useState } from "react";
import { ConfirmInline } from "@/components/ui/confirm-inline";

/**
 * La confirmación en línea de una acción que no se deshace (Cotizar:
 * aceptar, rechazar, eliminar; Ventas: apagar el envío, reenviar un
 * intento). Aquí la acción no hace nada más que contar.
 */
export function ConfirmDemo({ variant = "danger", openWidth }: { variant?: "danger" | "primary" | "ghost"; openWidth?: string }) {
  const [veces, setVeces] = useState(0);
  return (
    <div className="space-y-2">
      <ConfirmInline
        action={async () => setVeces((n) => n + 1)}
        label={variant === "danger" ? "Marcar rechazada" : "Enviar la cotización"}
        variant={variant}
        question={variant === "danger" ? "¿Rechazar COT-2026-003?" : "¿Enviar COT-2026-003 a Vitalé?"}
        consequence={
          variant === "danger"
            ? "La cotización queda rechazada y el negocio pasa a perdido. No se deshace."
            : "La marca recibe el enlace y la cotización ya no se puede editar. Una cotización con un nombre muy largo sigue leyéndose en dos líneas sin mover nada."
        }
        confirmLabel={variant === "danger" ? "Sí, rechazar" : "Sí, enviar"}
        cancelLabel="Cancelar"
        openWidth={openWidth}
      />
      <p className="font-mono text-xs text-muted">acciones ejecutadas: {veces}</p>
    </div>
  );
}
