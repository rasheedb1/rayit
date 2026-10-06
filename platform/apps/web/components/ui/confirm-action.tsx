"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/button";

/**
 * Lo que devuelve la acción: la misma forma que ActionState de
 * lib/forms.ts (aquí estructural, para que el kit no dependa de lib).
 */
export interface ConfirmActionState {
  ok?: boolean;
  message?: string;
}

export interface ConfirmActionProps {
  /** Una Server Action con la firma de useActionState: (estado, formulario) → estado. */
  action: (prev: ConfirmActionState, formData: FormData) => Promise<ConfirmActionState>;
  /** Campos ocultos del formulario: el id de lo que se toca. */
  fields?: Record<string, string>;
  /** El texto del primer botón: «Quitar». */
  label: string;
  variant?: ButtonVariant;
  /** El tamaño del primer botón; el formulario abierto usa siempre `sm`. */
  size?: ButtonSize;
  question: string;
  consequence: string;
  confirmLabel: string;
  cancelLabel: string;
  /**
   * Deshabilita el primer botón y explica por qué, debajo y a la vista:
   * «No se puede quitar al último dueño». La acción sigue siendo la
   * barrera real; esto solo no ofrece lo que se va a rechazar.
   */
  disabledReason?: string;
  /** Las clases de ancho de la pregunta abierta (como en ConfirmInline). */
  openWidth?: string;
}

/**
 * ConfirmInline para una acción que RESPONDE: «no se puede quitar al
 * último dueño», «esa invitación ya no está». Mismos dos pasos en el
 * mismo sitio, y además:
 *
 *   - el formulario abierto se queda abierto, con el botón en carga,
 *     mientras la acción corre: no se puede volver a pulsar «Quitar»;
 *   - al volver la acción se cierra, y su mensaje (si lo hay) queda
 *     debajo del primer botón, con role="alert";
 *   - el foco vuelve SIEMPRE al primer botón: al cancelar, con Escape y
 *     al volver de la acción. Nunca cae en <body>.
 *
 * Si la acción hace desaparecer la fila (quitar a alguien), el
 * componente se desmonta con ella y no hay foco que devolver.
 *
 * Nació en Equipo (ACC-4, QuitarMiembro y Revocar). Cliente.
 */
export function ConfirmAction({
  action, fields = {}, label, variant = "secondary", size = "md", question, consequence, confirmLabel, cancelLabel,
  disabledReason, openWidth = "w-full",
}: ConfirmActionProps) {
  const [estado, enviar, enviando] = useActionState<ConfirmActionState, FormData>(action, {});
  const [abierta, setAbierta] = useState(false);
  const id = useId();
  const preguntaRef = useRef<HTMLParagraphElement>(null);
  const disparadorRef = useRef<HTMLSpanElement>(null);
  const volverAlDisparador = useRef(false);
  const estadoVisto = useRef(estado);

  // La acción volvió: se cierra y el foco regresa al primer botón.
  useEffect(() => {
    if (estado === estadoVisto.current) return;
    estadoVisto.current = estado;
    volverAlDisparador.current = true;
    setAbierta(false);
  }, [estado]);

  useEffect(() => {
    if (abierta) {
      preguntaRef.current?.focus();
    } else if (volverAlDisparador.current) {
      volverAlDisparador.current = false;
      disparadorRef.current?.querySelector("button")?.focus();
    }
  }, [abierta]);

  function cerrar() {
    if (enviando) return;
    volverAlDisparador.current = true;
    setAbierta(false);
  }

  if (!abierta) {
    return (
      <span className="inline-flex max-w-full flex-col items-start gap-1">
        <span ref={disparadorRef} className="inline-flex">
          <Button
            variant={variant}
            size={size}
            onClick={() => setAbierta(true)}
            disabled={Boolean(disabledReason)}
            className="whitespace-nowrap"
          >
            {label}
          </Button>
        </span>
        {/* Texto visible justo después del botón: un botón deshabilitado no
            recibe foco, así que el motivo se lee en el flujo, no por aria. */}
        {disabledReason && (
          <span className="max-w-xs text-xs leading-4 text-muted">
            {disabledReason}
          </span>
        )}
        {estado.message && (
          <span role="alert" className="max-w-xs text-xs leading-4 text-bad">
            {estado.message}
          </span>
        )}
      </span>
    );
  }

  return (
    <form
      action={enviar}
      role="group"
      aria-labelledby={`${id}-pregunta`}
      aria-describedby={`${id}-consecuencia`}
      aria-busy={enviando || undefined}
      className={`${openWidth} rounded-md border border-border bg-surface-2 p-3`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          cerrar();
        }
      }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <p id={`${id}-pregunta`} ref={preguntaRef} tabIndex={-1} className="text-sm font-medium focus:outline-none">
        {question}
      </p>
      <p id={`${id}-consecuencia`} className="mt-1 text-xs leading-4 text-ink-2">
        {consequence}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" type="submit" variant={variant === "danger" ? "danger" : "primary"} loading={enviando}>
          {confirmLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={cerrar} disabled={enviando}>
          {cancelLabel}
        </Button>
      </div>
    </form>
  );
}
