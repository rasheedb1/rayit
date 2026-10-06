"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

/**
 * El botón «Entendido» de una fila de «Lo que importa esta semana».
 * Cliente solo por useFormStatus: mientras la acción corre, el botón
 * dice que está ocupado (aria-busy) y no acepta un segundo clic. El
 * formulario y la acción los pone la fila, en el servidor.
 */
export function BotonEntendido({ label, ariaLabel }: { label: string; ariaLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant="ghost" loading={pending} aria-label={ariaLabel}>
      {label}
    </Button>
  );
}
