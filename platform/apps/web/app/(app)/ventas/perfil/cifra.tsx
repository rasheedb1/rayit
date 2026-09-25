"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CifraVista } from "./cifras";
import { MESSAGES } from "./messages";

/** El ancho del globo y lo que deja libre a cada lado de la pantalla, en px. */
export const GLOBO_ANCHO = 240;
export const GLOBO_MARGEN = 16;

/** Lo que separa el globo de su cifra, en px. */
const GLOBO_SEPARACION = 6;

export interface PosicionGlobo {
  /** Borde izquierdo, en px desde el borde izquierdo de la pantalla. */
  left: number;
  /** Borde inferior, en px desde el borde inferior de la pantalla: el globo se abre hacia arriba. */
  bottom: number;
  width: number;
}

/**
 * Dónde va el globo, en coordenadas de la pantalla (position: fixed):
 * encima de su cifra, centrado sobre ella y corrido lo justo para que
 * quepa entero entre los dos márgenes. Con una cifra pegada al borde
 * derecho a 400 px, el globo se abre hacia la izquierda en vez de
 * empujar el ancho de la página; y como es fijo, tampoco lo recorta la
 * tarjeta con overflow-hidden que lo contiene. Puro: se prueba sin
 * navegador.
 */
export function posicionGlobo(
  cifra: { left: number; top: number; width: number },
  pantalla: { width: number; height: number },
  ancho = GLOBO_ANCHO,
  margen = GLOBO_MARGEN,
): PosicionGlobo {
  const w = Math.max(0, Math.min(ancho, pantalla.width - 2 * margen));
  const centro = cifra.left + cifra.width / 2;
  const x = Math.min(Math.max(centro - w / 2, margen), pantalla.width - margen - w);
  return { left: Math.round(x), bottom: Math.round(pantalla.height - cifra.top + GLOBO_SEPARACION), width: w };
}

/**
 * Una cifra del perfil con su origen (la regla del perfil de Stripe
 * Atlas: ningún número sin su fuente). La cifra es un botón: al pasar el
 * cursor, al llegar con el teclado o al tocarla en un teléfono abre un
 * globo que dice qué es, de dónde sale (tabla, red y fecha de la lectura)
 * y lleva a su origen con «Abrir el origen». Así en táctil se puede leer
 * el origen antes de navegar.
 *
 * El globo es fijo a la pantalla, se mide al abrirse y al desplazarse
 * (posicionGlobo) y nunca sale de ella: a 400 px no abre scroll
 * horizontal. Mientras está cerrado está fuera del flujo (display:
 * none). Escape o un toque fuera lo cierran.
 *
 * `tipId` lo pone quien la pinta: la misma cifra puede salir en la
 * narrativa y en su sección, y dos globos no pueden compartir id.
 */
export function Cifra({ cifra, tipId, grande = false }: { cifra: CifraVista; tipId: string; grande?: boolean }) {
  const t = MESSAGES.cifra;
  const caja = useRef<HTMLSpanElement>(null);
  const [fijo, setFijo] = useState(false);
  const [encima, setEncima] = useState(false);
  const [pos, setPos] = useState<PosicionGlobo | null>(null);
  const visible = fijo || encima;

  const medir = useCallback(() => {
    const el = caja.current;
    if (!el) return;
    const pantalla = {
      width: document.documentElement.clientWidth || window.innerWidth,
      height: document.documentElement.clientHeight || window.innerHeight,
    };
    setPos(posicionGlobo(el.getBoundingClientRect(), pantalla));
  }, []);

  useEffect(() => {
    if (!visible) return;
    const fuera = (e: PointerEvent) => {
      if (!caja.current?.contains(e.target as Node)) {
        setFijo(false);
        setEncima(false);
      }
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFijo(false);
        setEncima(false);
      }
    };
    // Fijo a la pantalla: al desplazarse o cambiar de tamaño, se vuelve a medir para seguir a su cifra.
    const seguir = () => medir();
    document.addEventListener("pointerdown", fuera);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", seguir, { capture: true, passive: true });
    window.addEventListener("resize", seguir);
    return () => {
      document.removeEventListener("pointerdown", fuera);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", seguir, { capture: true });
      window.removeEventListener("resize", seguir);
    };
  }, [visible, medir]);

  const texto = grande ? "text-2xl font-semibold tracking-tight" : "font-medium";
  const clase = `tabular-nums ${texto} cursor-pointer text-fg underline decoration-dotted decoration-fg-3 underline-offset-4 outline-none hover:decoration-fg focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-accent`;
  const enlace = "mt-2 inline-block font-medium text-tooltip-ink underline underline-offset-2";
  const cerrar = () => {
    setFijo(false);
    setEncima(false);
  };

  return (
    <span
      ref={caja}
      className="relative inline-block"
      onPointerEnter={(e) => {
        if (e.pointerType !== "mouse") return;
        medir();
        setEncima(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") setEncima(false);
      }}
      onFocus={() => {
        medir();
        setEncima(true);
      }}
      onBlur={(e) => {
        if (!caja.current?.contains(e.relatedTarget as Node | null)) setEncima(false);
      }}
    >
      <button
        type="button"
        className={clase}
        aria-expanded={visible}
        aria-controls={tipId}
        aria-label={t.ver(cifra.valor, cifra.que)}
        onClick={() => {
          medir();
          setFijo((v) => !v);
        }}
      >
        {cifra.valor}
      </button>
      <span
        id={tipId}
        data-globo=""
        // El ::before tiende un puente invisible sobre la separación: el cursor pasa de la cifra al globo sin cerrarlo.
        className={`fixed z-50 rounded-md bg-tooltip-bg px-2.5 py-2 text-left text-xs font-normal leading-4 tracking-normal text-tooltip-ink shadow-lg before:absolute before:inset-x-0 before:top-full before:h-2 before:content-[''] ${visible && pos ? "block" : "hidden"}`}
        style={pos ? { left: pos.left, bottom: pos.bottom, width: pos.width } : undefined}
      >
        <span className="block">{cifra.que}</span>
        <span className="mt-1 block text-tooltip-ink-2">{cifra.origen}</span>
        {cifra.externo ? (
          <a href={cifra.href} className={enlace} aria-label={t.abrirA(cifra.origen)} target="_blank" rel="noopener noreferrer" onClick={cerrar}>
            {t.abrir}
          </a>
        ) : cifra.href.startsWith("#") ? (
          // Un ancla de esta misma página («De dónde sale cada cifra»): un enlace simple, sin navegación de Next.
          <a href={cifra.href} className={enlace} aria-label={t.abrirA(cifra.origen)} onClick={cerrar}>
            {t.abrir}
          </a>
        ) : (
          <Link href={cifra.href} className={enlace} aria-label={t.abrirA(cifra.origen)} onClick={cerrar}>
            {t.abrir}
          </Link>
        )}
      </span>
    </span>
  );
}
