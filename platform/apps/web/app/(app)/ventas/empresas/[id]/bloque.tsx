"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ChevronRight } from "lucide-react";

/**
 * El evento con el que algo de dentro del bloque le pide abrirse (el
 * registro rápido, cuando una tecla N/L/C/R llega con el bloque plegado).
 * Se despacha sobre el panel; el bloque lo abre en el acto, para que el
 * foco pueda entrar en la misma pulsación.
 */
export const BLOQUE_ABRIR = "bloque:abrir";

/** Abre el bloque que contiene `el`, si está plegado. Devuelve si hizo falta. */
export function abrirBloqueDe(el: Element | null): boolean {
  const panel = el?.closest<HTMLElement>("[data-bloque-panel]");
  if (!panel || !panel.hasAttribute("hidden")) return false;
  panel.dispatchEvent(new CustomEvent(BLOQUE_ABRIR));
  return true;
}

/**
 * Un bloque de la ficha que se pliega, como en Attio: el título (con su
 * dato al lado) abre y cierra, y lo de dentro no se pierde al plegarlo.
 *
 * Es el patrón de disclosure de WAI-ARIA: un <h2> con un <button
 * aria-expanded aria-controls> dentro, y el panel con `hidden`. No es un
 * <details>: su <summary> tiene rol de botón y vuelve presentacional al
 * <h2> de dentro, así que VoiceOver y NVDA dejaban de anunciar «Negocios»,
 * «Actividad» o «Contactos» como encabezados y quien recorre la ficha con
 * la tecla H perdía la estructura. Aquí el encabezado es encabezado y el
 * botón, botón; se pliega con Enter o espacio sobre el título.
 *
 * Plegado, el panel lleva `hidden="until-found"`: el buscador del
 * navegador (Chrome, Edge) sigue encontrando lo de dentro y el bloque se
 * abre solo (evento beforematch), como hacía el <details>. Donde no se
 * entiende, es un `hidden` normal.
 */
export function Bloque({
  id,
  title,
  meta,
  children,
  defaultOpen = true,
}: {
  /** El id del título, para el aria-labelledby de la sección. */
  id: string;
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = `${id}-panel`;

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (!open) panel.setAttribute("hidden", "until-found");
    const abrir = () => flushSync(() => setOpen(true));
    panel.addEventListener(BLOQUE_ABRIR, abrir);
    panel.addEventListener("beforematch", abrir);
    return () => {
      panel.removeEventListener(BLOQUE_ABRIR, abrir);
      panel.removeEventListener("beforematch", abrir);
    };
  }, [open]);

  return (
    <section aria-labelledby={id}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={id} className="text-sm font-semibold">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            <ChevronRight
              className={`h-3.5 w-3.5 text-muted transition-transform ${open ? "rotate-90" : ""}`}
              aria-hidden="true"
            />
            {title}
          </button>
        </h2>
        {meta && <span className="text-xs text-fg-3">{meta}</span>}
      </div>
      <div id={panelId} ref={panelRef} hidden={!open} data-bloque-panel="">
        {children}
      </div>
    </section>
  );
}
