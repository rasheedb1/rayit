"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

/** Lo que se puede enfocar dentro del diálogo, para que Tab no se salga. */
const ENFOCABLES =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Un diálogo modal: una pregunta que hay que contestar antes de seguir
 * («¿Por qué lo pierdes?»). No está en el kit porque hoy solo lo usa el
 * tablero; si otro módulo lo pide, sube a components/ui/ con su prueba y
 * su sección en /kit.
 *
 * Es un div con role="dialog" y aria-modal, no un <dialog> nativo: el
 * showModal() de jsdom no existe y las pruebas del tablero tienen que
 * poder abrirlo. Lo que el nativo daba gratis se hace a mano:
 *   · el foco entra al abrir (al primer control, o al que lleve
 *     autoFocus) y vuelve a donde estaba al cerrar;
 *   · Tab y Mayús+Tab dan la vuelta dentro;
 *   · Escape cierra, igual que «Cancelar»;
 *   · clic en el fondo cierra; clic dentro, no.
 *
 * Estilo: el fondo es el color de la página velado (bg-bg/70), así que
 * funciona igual en el tema claro y en el oscuro sin un color nuevo.
 * A 400 px el panel se apoya abajo y ocupa el ancho, como una hoja.
 */
export function Dialogo({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  // Dónde estaba el foco ANTES de abrir. Se toma al primer render y no en
  // el efecto: para entonces el autoFocus de un control del diálogo ya lo
  // movió adentro, y al cerrar no habría a dónde volver.
  const [previo] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    const panel = panelRef.current;
    const primero = panel?.querySelector<HTMLElement>("[autofocus]") ?? panel?.querySelector<HTMLElement>(ENFOCABLES);
    (primero ?? panel)?.focus();
    return () => {
      if (previo && document.contains(previo)) previo.focus();
    };
  }, [previo]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) return;
    const items = [...panelRef.current.querySelectorAll<HTMLElement>(ENFOCABLES)];
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-bg/70 p-4 backdrop-blur-[2px] sm:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="w-full max-w-md rounded-md border border-border bg-surface p-5 shadow-lg focus:outline-none"
      >
        <h2 id={titleId} className="text-base font-semibold text-ink">
          {title}
        </h2>
        {description && (
          <p id={descId} className="mt-1 text-sm leading-5 text-ink-2">
            {description}
          </p>
        )}
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
