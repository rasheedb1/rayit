"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as TeclaEvent } from "react";

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
 *
 * Quién es parada de tabulación y qué hacen las flechas lo decide su paso
 * (CifrasPaso): aquí llegan `tabIndex`, `alEnfocar`, `alTecla` y `enlazar`.
 */
export function Cifra({
  c, id, tabIndex = 0, alEnfocar, alTecla, enlazar,
}: {
  c: CifraFlujo;
  id: string;
  tabIndex?: 0 | -1;
  alEnfocar?: () => void;
  alTecla?: (e: TeclaEvent<HTMLSpanElement>) => void;
  enlazar?: (el: HTMLSpanElement | null) => void;
}) {
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
        ref={enlazar}
        tabIndex={tabIndex}
        aria-describedby={id}
        onFocus={() => {
          volver();
          setFoco(true);
          alEnfocar?.();
        }}
        onBlur={() => setFoco(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && abierta) {
            e.stopPropagation();
            setCerrada(true);
            return;
          }
          alTecla?.(e);
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

/** Qué cifra enfoca cada tecla, desde la `actual` de `total`; null si la tecla no mueve el foco. */
export function siguienteCifra(key: string, actual: number, total: number): number | null {
  if (total <= 0) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return (actual + 1) % total;
  if (key === "ArrowLeft" || key === "ArrowUp") return (actual - 1 + total) % total;
  if (key === "Home") return 0;
  if (key === "End") return total - 1;
  return null;
}

/**
 * Las cifras de un paso, con UNA sola parada de tabulación por paso
 * (roving tabindex, como una barra de herramientas): Tab entra en la
 * cifra activa del paso (la primera, o la última que se enfocó) y sale al
 * paso siguiente; las flechas, Inicio y Fin recorren las cifras del paso.
 * Con siete cifras por paso, una cadencia de seis pasos eran 42 paradas
 * antes de salir de la sección; ahora son seis.
 */
export function CifrasPaso({ cifras, idBase }: { cifras: CifraFlujo[]; idBase: string }) {
  const [activa, setActiva] = useState(0);
  const nodos = useRef<(HTMLSpanElement | null)[]>([]);

  const alTecla = (i: number) => (e: TeclaEvent<HTMLSpanElement>) => {
    const destino = siguienteCifra(e.key, i, cifras.length);
    if (destino === null) return;
    e.preventDefault();
    setActiva(destino);
    nodos.current[destino]?.focus();
  };

  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {cifras.map((c, i) => (
        <Cifra
          key={c.key}
          c={c}
          id={`${idBase}-${c.key}`}
          tabIndex={i === activa ? 0 : -1}
          alEnfocar={() => setActiva(i)}
          alTecla={alTecla(i)}
          enlazar={(el) => {
            nodos.current[i] = el;
          }}
        />
      ))}
    </ul>
  );
}
