"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/**
 * Abre el <details> que contiene el elemento del ancla, si lo hay. La
 * usa la cifra antes de navegar a su fila (#origen-<id>) y Plegable al
 * llegar con el ancla en la dirección: una fila dentro de un bloque
 * plegado no se ve ni recibe el desplazamiento.
 */
export function abrirPlegableDe(hash: string): HTMLElement | null {
  const id = decodeURIComponent(hash.replace(/^#/, ""));
  if (!id) return null;
  const el = document.getElementById(id);
  const plegable = el?.closest("details");
  if (plegable && !plegable.open) plegable.open = true;
  return el;
}

/**
 * Un bloque plegado por defecto, con su resumen como botón. Es un
 * <details> nativo: su <summary> solo lleva texto (el encabezado de la
 * sección queda fuera, en Seccion), y el buscador del navegador lo abre
 * solo si encuentra algo dentro. También se abre si la dirección trae el
 * ancla de algo que tiene dentro, al cargar la página o al cambiar el
 * ancla (hashchange).
 */
export function Plegable({ resumen, children }: { resumen: string; children: ReactNode }) {
  const caja = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const alLlegar = () => {
      const el = abrirPlegableDe(window.location.hash);
      if (el && caja.current?.contains(el)) el.scrollIntoView?.({ block: "center" });
    };
    alLlegar();
    window.addEventListener("hashchange", alLlegar);
    return () => window.removeEventListener("hashchange", alLlegar);
  }, []);

  return (
    <details ref={caja} className="group">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md text-sm text-fg-2 outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" size={14} className="transition-transform group-open:rotate-90" />
        {resumen}
      </summary>
      <div className="mt-4">{children}</div>
    </details>
  );
}
