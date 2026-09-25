"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button, type ButtonVariant } from "@/components/ui/button";
import { MESSAGES } from "./messages";

/**
 * El botón de conectar, reconectar o volver a intentar de una fila. Es un
 * formulario HTML de verdad (POST con navegación completa): Google y
 * Unipile tienen que recibir al navegador, no a un fetch. Lo que añade
 * este componente es el estado de carga: pedir el enlace a Unipile puede
 * tardar diez segundos, y un botón que no cambia invita a pulsar otra vez
 * (cada clic creaba otra fila pendiente y otro enlace). Desde el primer
 * envío el botón queda ocupado; si la persona vuelve con «atrás» (la
 * página sale de la caché del navegador), se libera.
 */
export function ConectarBoton({
  action,
  fields,
  label,
  variant,
  disabled,
  ariaLabel,
  className,
  icon,
}: {
  action: string;
  fields: Record<string, string>;
  label: string;
  variant: ButtonVariant;
  disabled: boolean;
  ariaLabel?: string;
  /** Para alinear un botón fantasma con el texto de la fila. */
  className?: string;
  /** Decorativo, a la izquierda del texto (el «+» de «Conectar otra cuenta»). */
  icon?: ReactNode;
}) {
  const [sending, setSending] = useState(false);
  useEffect(() => {
    const reset = (e: PageTransitionEvent) => {
      if (e.persisted) setSending(false);
    };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  return (
    <form
      method="post"
      action={action}
      onSubmit={(e) => {
        if (sending) {
          e.preventDefault();
          return;
        }
        setSending(true);
      }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Button type="submit" size="sm" variant={variant} disabled={disabled} loading={sending} aria-label={ariaLabel} className={className} icon={sending ? undefined : icon}>
        {sending ? MESSAGES.actions.connecting : label}
      </Button>
    </form>
  );
}
