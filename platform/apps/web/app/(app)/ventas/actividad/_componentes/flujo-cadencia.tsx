import { Fragment, type ReactNode } from "react";
import { MESSAGES } from "../messages";
import { Cifra, type CifraFlujo } from "./cifra-flujo";

export type { CifraFlujo };

const T = MESSAGES.flujo;

/** Un paso del flujo, ya formateado. */
export interface PasoFlujo {
  id: string;
  titulo: string;
  /** «2 días después» desde el paso anterior; null en el primero. */
  espera: string | null;
  icono: ReactNode;
  cifras: CifraFlujo[];
}

/**
 * La vista de flujo de una cadencia, de solo lectura, como el flow viewer
 * de Chief: los pasos en su orden, unidos por la espera entre ellos, y en
 * cada uno lo que pasó (enviados, abiertos, respondidos, positivos, lo que
 * sigue en cola, lo fallido y lo detenido), con una explicación por cifra
 * (Cifra, un tooltip accesible que se cierra con Escape).
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
