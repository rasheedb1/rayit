"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button, type ButtonVariant } from "@/components/ui/button";

export interface ConfirmarAccionProps {
  /** La Server Action ya atada a su id (`accion.bind(null, id)`). */
  action: () => Promise<void>;
  /** El texto del primer botón: «Marcar aceptada». */
  label: string;
  variant?: ButtonVariant;
  /** «¿Rechazar COT-2026-003?» */
  pregunta: string;
  /** Qué va a pasar y que no se deshace. */
  consecuencia: string;
  /** El botón que de verdad ejecuta: «Sí, rechazar». */
  confirmar: string;
  cancelar: string;
}

/**
 * Una acción que no se deshace, en dos pasos y en el mismo sitio: el
 * primer botón no hace nada más que mostrar qué va a pasar, y el segundo
 * («Sí, rechazar») es el que envía. Es el patrón de Stripe Quotes para
 * aceptar o cancelar una cotización, sin un modal que tape el documento.
 *
 * Accesibilidad: al abrir, el foco va a la pregunta (el lector la lee
 * con su consecuencia); al cancelar, vuelve al botón que la abrió.
 * Escape cancela.
 */
export function ConfirmarAccion({
  action, label, variant = "secondary", pregunta, consecuencia, confirmar, cancelar,
}: ConfirmarAccionProps) {
  const [abierta, setAbierta] = useState(false);
  const id = useId();
  const preguntaRef = useRef<HTMLParagraphElement>(null);
  const disparadorRef = useRef<HTMLSpanElement>(null);
  const volverAlDisparador = useRef(false);

  useEffect(() => {
    if (abierta) {
      preguntaRef.current?.focus();
    } else if (volverAlDisparador.current) {
      volverAlDisparador.current = false;
      disparadorRef.current?.querySelector("button")?.focus();
    }
  }, [abierta]);

  function cerrar() {
    volverAlDisparador.current = true;
    setAbierta(false);
  }

  if (!abierta) {
    return (
      <span ref={disparadorRef} className="inline-flex">
        <Button variant={variant} onClick={() => setAbierta(true)}>
          {label}
        </Button>
      </span>
    );
  }

  return (
    <form
      action={action}
      role="group"
      aria-labelledby={`${id}-pregunta`}
      aria-describedby={`${id}-consecuencia`}
      className="w-full rounded-md border border-border bg-surface-2 p-3"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          cerrar();
        }
      }}
    >
      <p id={`${id}-pregunta`} ref={preguntaRef} tabIndex={-1} className="text-sm font-medium focus:outline-none">
        {pregunta}
      </p>
      <p id={`${id}-consecuencia`} className="mt-1 text-xs leading-4 text-ink-2">
        {consecuencia}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Enviar variant={variant === "danger" ? "danger" : "primary"}>{confirmar}</Enviar>
        <Button size="sm" variant="ghost" onClick={cerrar}>
          {cancelar}
        </Button>
      </div>
    </form>
  );
}

/** El botón que envía, con su estado de carga: un doble clic no manda dos veces. */
function Enviar({ variant, children }: { variant: ButtonVariant; children: string }) {
  const { pending } = useFormStatus();
  return (
    <Button size="sm" type="submit" variant={variant} loading={pending}>
      {children}
    </Button>
  );
}
