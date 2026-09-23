"use client";

import { createContext, useContext, useTransition, type ReactNode, type TransitionStartFunction } from "react";
import { MESSAGES } from "./messages";

/**
 * La navegación de un filtro, compartida entre quien la empieza (los
 * filtros, en la cabecera) y quien tiene que decir que sus cifras son
 * las de ANTES (los KPIs, los gráficos y la frescura, más abajo).
 *
 * Los filtros marcan la opción nueva en el acto (useOptimistic), pero
 * las cifras siguen siendo las del filtro anterior hasta que responde el
 * servidor: con la base lenta se leía «90 días» encima de cifras de 30.
 * Mientras dura la transición, `Cifras` las atenúa y las marca
 * aria-busy, en vez de saltar a esqueleto en cada clic.
 */

interface EnCurso {
  pendiente: boolean;
  empezar: TransitionStartFunction;
}

const Contexto = createContext<EnCurso | null>(null);

/** Envuelve la página: una sola transición para los filtros y las cifras. */
export function FiltroEnCurso({ children }: { children: ReactNode }) {
  const [pendiente, empezar] = useTransition();
  return <Contexto.Provider value={{ pendiente, empezar }}>{children}</Contexto.Provider>;
}

/** La transición de la página, o null fuera de ella (las pruebas de Filtros, sueltas). */
export function useFiltroEnCurso(): EnCurso | null {
  return useContext(Contexto);
}

/** Las cifras de la página: atenuadas y aria-busy mientras llega el filtro nuevo. */
export function Cifras({ children }: { children: ReactNode }) {
  const pendiente = useContext(Contexto)?.pendiente ?? false;
  return (
    <div
      aria-busy={pendiente || undefined}
      data-pendiente={pendiente || undefined}
      className={`transition-opacity duration-150 ${pendiente ? "opacity-60" : ""}`}
    >
      {/* Lo que se ve atenuado, dicho: el lector de pantalla no ve la opacidad. */}
      <p className="sr-only" aria-live="polite">
        {pendiente ? MESSAGES.filtros.actualizando : ""}
      </p>
      {children}
    </div>
  );
}
