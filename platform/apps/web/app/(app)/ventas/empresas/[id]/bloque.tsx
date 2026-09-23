import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/**
 * Un bloque de la ficha que se pliega, como en Attio: el título (con su
 * dato al lado) abre y cierra, y lo de dentro no se pierde al plegarlo.
 *
 * Es un <details> nativo: se pliega con teclado (Enter o espacio sobre el
 * título) y con lector de pantalla sin una línea de JavaScript, y el
 * buscador del navegador abre el bloque si encuentra algo dentro.
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
  return (
    <section aria-labelledby={id}>
      <details open={defaultOpen} className="group">
        <summary className="mb-3 flex cursor-pointer list-none flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink [&::-webkit-details-marker]:hidden">
          <h2 id={id} className="flex items-center gap-1.5 text-sm font-semibold">
            <ChevronRight className="h-3.5 w-3.5 text-muted transition-transform group-open:rotate-90" aria-hidden="true" />
            {title}
          </h2>
          {meta && <span className="text-xs text-fg-3">{meta}</span>}
        </summary>
        {children}
      </details>
    </section>
  );
}
