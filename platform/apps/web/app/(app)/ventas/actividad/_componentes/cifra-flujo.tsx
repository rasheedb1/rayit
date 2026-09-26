"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

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

const TONO = { fg: "text-fg", good: "text-good", bad: "text-bad", muted: "text-fg-3" } as const;
/** El margen que el tooltip deja con el borde de la ventana. */
const MARGEN = 8;

/**
 * Una cifra con su explicación, un tooltip de verdad (WCAG 1.4.13):
 *   · aparece al pasar el cursor, al tocar la cifra y al enfocarla con el
 *     teclado, y un lector de pantalla la lee como descripción
 *     (aria-describedby), aunque esté oculta a la vista;
 *   · se puede pasar el cursor por encima del tooltip sin que se cierre
 *     (el hover es del <li>, que lo contiene);
 *   · Escape lo cierra sin mover el foco ni el puntero: mientras está
 *     abierto escucha la tecla en todo el documento, así que también se
 *     descarta cuando se abrió con el cursor y el foco está en otra parte;
 *   · no se sale de la ventana: si al abrirse su borde derecho pasa del de
 *     la ventana (la última cifra de una fila a 400 px), se alinea a la
 *     derecha de su cifra.
 */
export function Cifra({ c, id }: { c: CifraFlujo; id: string }) {
  const [hover, setHover] = useState(false);
  const [foco, setFoco] = useState(false);
  const [cerrada, setCerrada] = useState(false);
  const [derecha, setDerecha] = useState(false);
  const tip = useRef<HTMLSpanElement>(null);
  const abierta = (hover || foco) && !cerrada;

  useLayoutEffect(() => {
    if (!abierta || !tip.current) return;
    const ancho = document.documentElement.clientWidth;
    if (ancho > 0 && tip.current.getBoundingClientRect().right > ancho - MARGEN) setDerecha(true);
  }, [abierta]);

  // Descartable sin mover el puntero: con el tooltip abierto, Escape lo cierra venga de donde venga.
  useEffect(() => {
    if (!abierta) return;
    const alPulsar = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCerrada(true);
    };
    document.addEventListener("keydown", alPulsar);
    return () => document.removeEventListener("keydown", alPulsar);
  }, [abierta]);

  const volver = () => {
    setCerrada(false);
    setDerecha(false);
  };

  return (
    <li
      className="relative"
      onMouseEnter={() => {
        volver();
        setHover(true);
      }}
      onMouseLeave={() => setHover(false)}
    >
      <span
        tabIndex={0}
        aria-describedby={id}
        onFocus={() => {
          volver();
          setFoco(true);
        }}
        onBlur={() => setFoco(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && abierta) {
            e.stopPropagation();
            setCerrada(true);
          }
        }}
        className="inline-flex min-w-16 flex-col rounded-md border border-line bg-surface px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
      >
        <span className={`text-sm font-medium tabular-nums ${TONO[c.tono]}`}>{c.valor}</span>
        <span className="text-[11px] leading-4 text-fg-3">{c.etiqueta}</span>
      </span>
      {/* El relleno de arriba (pt-1) es parte del tooltip: el cursor cruza de la cifra al texto sin salir del <li>. */}
      <span
        ref={tip}
        role="tooltip"
        id={id}
        className={`absolute top-full z-10 pt-1 ${derecha ? "right-0" : "left-0"} ${abierta ? "block" : "hidden"}`}
      >
        <span className="block w-max max-w-[min(14rem,calc(100vw-2rem))] rounded-md bg-tooltip-bg px-2.5 py-1.5 text-xs leading-4 text-tooltip-ink shadow-sm">
          {c.explica}
          {c.tasa && <span className="mt-0.5 block text-tooltip-ink-2">{c.tasa}</span>}
        </span>
      </span>
    </li>
  );
}
