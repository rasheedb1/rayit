import type { ReactNode } from "react";
import { MESSAGES } from "./messages";

/** El id del título del bloque: la lista le devuelve el foco cuando se queda sin filas. */
export const TITULO_SEMANA_ID = "lo-que-importa";

/**
 * La caja de «Lo que importa esta semana» (RES-3): título, contador y
 * descripción. Sin estado ni efectos, para que la usen igual el servidor
 * (el error, el esqueleto) y la lista del cliente (semana-lista.tsx), que
 * es quien sabe cuántas filas quedan tras un «Entendido».
 *
 * La descripción habla del botón «Entendido»: solo se pasa cuando hay
 * filas. El título lleva tabIndex=-1 para poder recibir el foco cuando
 * se quita la última fila: quien navega con teclado no cae en <body>, y
 * el anillo de foco del kit (focus-visible) le enseña dónde quedó.
 */
export function MarcoSemana({ meta, descripcion, children }: { meta?: string; descripcion?: string; children: ReactNode }) {
  return (
    <section className="mb-8" aria-labelledby={TITULO_SEMANA_ID}>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={TITULO_SEMANA_ID} tabIndex={-1} className="rounded-sm text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ink">
          {MESSAGES.semana.titulo}
        </h2>
        {meta && <span className="text-xs text-fg-3 tabular-nums">{meta}</span>}
      </div>
      {descripcion && <p className="mb-3 max-w-2xl text-xs text-fg-3">{descripcion}</p>}
      <div className={descripcion ? undefined : "mt-2"}>{children}</div>
    </section>
  );
}
