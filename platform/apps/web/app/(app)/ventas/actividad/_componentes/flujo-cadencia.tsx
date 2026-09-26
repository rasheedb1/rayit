import Link from "next/link";
import { Fragment, type CSSProperties, type ReactNode } from "react";
import { MESSAGES } from "../messages";
import { CifrasPaso, type CifraFlujo } from "./cifra-flujo";

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
  /**
   * Lo enviado, abierto y respondido de este paso sobre lo enviado en el primero (fracciones de la vista, 0 a 1),
   * como barras finas: la caída de un paso al siguiente se ve sin leer cifras. null si el primero no envió nada.
   */
  barras: Array<{ key: string; etiqueta: string; fraccion: number; valor: string }> | null;
  /** Hay fallidos que se pueden reintentar: adónde ir (la cola de la actividad con este tipo de paso). */
  reintentar: { texto: string; href: string } | null;
}

/** El color de cada barra: lo enviado en el acento, lo abierto más suave, lo respondido en verde. */
const BARRA: Record<string, string> = { sent: "bg-accent", opened: "bg-accent/50", replied: "bg-good" };
const ancho = (value: number): CSSProperties => ({ "--barra": String(value) }) as CSSProperties;

/**
 * La vista de flujo de una cadencia, de solo lectura, como el flow viewer
 * de Chief: los pasos en su orden, unidos por la espera entre ellos, y en
 * cada uno lo que pasó (enviados, abiertos, respondidos, positivos, lo que
 * sigue en cola, lo fallido y lo detenido), con una explicación por cifra
 * (Cifra, un tooltip accesible que se cierra con Escape). Con el teclado,
 * cada paso es una sola parada de tabulación y las flechas recorren sus
 * cifras (CifrasPaso).
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
              <CifrasPaso cifras={p.cifras} idBase={`flujo-${i}`} />
              {p.barras && (
                <div className="mt-2 flex flex-col gap-1" aria-label={T.barras.titulo} role="group">
                  {p.barras.map((b) => (
                    <p key={b.key} className="flex items-center gap-2 text-[11px] leading-4 text-fg-3">
                      <span className="w-20 shrink-0">{b.etiqueta}</span>
                      <span aria-hidden="true" className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-hover">
                        <span
                          className={`absolute inset-y-0 left-0 w-[calc(var(--barra)*100%)] rounded-full ${BARRA[b.key] ?? "bg-fg-3"}`}
                          style={ancho(b.fraccion)}
                        />
                      </span>
                      <span className="w-10 shrink-0 text-right tabular-nums">{b.valor}</span>
                    </p>
                  ))}
                </div>
              )}
              {p.reintentar && (
                <Link href={p.reintentar.href} className="mt-2 inline-block text-xs text-fg-2 underline underline-offset-2 hover:text-fg">
                  {p.reintentar.texto}
                </Link>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </section>
  );
}
