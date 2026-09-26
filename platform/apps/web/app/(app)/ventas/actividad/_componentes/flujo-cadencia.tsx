import { Fragment, type ReactNode } from "react";
import { MESSAGES } from "../messages";

const T = MESSAGES.flujo;

/** Una cifra de un paso, ya formateada, con la frase que explica qué cuenta (el tooltip). */
export interface CifraFlujo {
  key: string;
  valor: string;
  etiqueta: string;
  explica: string;
  /** «40 % de lo enviado», si aplica. */
  tasa: string | null;
  tono: "fg" | "good" | "bad" | "muted";
}

/** Un paso del flujo, ya formateado. */
export interface PasoFlujo {
  id: string;
  titulo: string;
  /** «2 días después» desde el paso anterior; null en el primero. */
  espera: string | null;
  icono: ReactNode;
  cifras: CifraFlujo[];
}

const TONO = { fg: "text-fg", good: "text-good", bad: "text-bad", muted: "text-fg-3" } as const;

/**
 * Una cifra con su explicación. La explicación es un tooltip de verdad:
 * aparece al pasar el cursor Y al enfocar la cifra con el teclado, y un
 * lector de pantalla la lee como descripción (aria-describedby), aunque
 * esté oculta a la vista.
 */
function Cifra({ c, id }: { c: CifraFlujo; id: string }) {
  return (
    <li className="group relative">
      <span
        tabIndex={0}
        aria-describedby={id}
        className="inline-flex min-w-16 flex-col rounded-md border border-line bg-surface px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
      >
        <span className={`text-sm font-medium tabular-nums ${TONO[c.tono]}`}>{c.valor}</span>
        <span className="text-[11px] leading-4 text-fg-3">{c.etiqueta}</span>
      </span>
      <span
        role="tooltip"
        id={id}
        className="pointer-events-none absolute left-0 top-full z-10 mt-1 hidden w-max max-w-56 rounded-md bg-tooltip-bg px-2.5 py-1.5 text-xs leading-4 text-tooltip-ink shadow-sm group-focus-within:block group-hover:block"
      >
        {c.explica}
        {c.tasa && <span className="mt-0.5 block text-tooltip-ink-2">{c.tasa}</span>}
      </span>
    </li>
  );
}

/**
 * La vista de flujo de una cadencia, de solo lectura, como el flow viewer
 * de Chief: los pasos en su orden, unidos por la espera entre ellos, y en
 * cada uno lo que pasó (enviados, abiertos, respondidos, positivos, lo que
 * sigue en cola, lo fallido y lo detenido), con una explicación por cifra.
 */
export function FlujoCadencia({ pasos }: { pasos: PasoFlujo[] }) {
  return (
    <section aria-labelledby="flujo-cadencia">
      <h2 id="flujo-cadencia" className="text-sm font-semibold">{T.titulo}</h2>
      <p className="mb-3 mt-1 max-w-2xl text-xs text-fg-2">{T.descripcion}</p>
      <ol className="flex flex-col">
        {pasos.map((p, i) => (
          <Fragment key={p.id}>
            {p.espera && (
              <li aria-hidden="true" className="ml-4 border-l border-dashed border-line-2 py-2 pl-4 text-xs text-fg-3">
                {p.espera}
              </li>
            )}
            <li className="rounded-md border border-line bg-surface-2 p-3" aria-label={p.titulo}>
              {p.espera && <span className="sr-only">{p.espera}. </span>}
              <p className="flex items-center gap-2 text-sm font-medium">
                <span className="text-fg-3">{p.icono}</span>
                {p.titulo}
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {p.cifras.map((c) => <Cifra key={c.key} c={c} id={`flujo-${i}-${c.key}`} />)}
              </ul>
            </li>
          </Fragment>
        ))}
      </ol>
    </section>
  );
}
