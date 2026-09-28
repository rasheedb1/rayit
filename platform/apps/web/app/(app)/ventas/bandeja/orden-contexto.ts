"use client";

import { createContext, useContext } from "react";
import type { VistaBandeja } from "./messages";
import { siguienteTrasHecha } from "./orden";
import type { HiloVista } from "./vista";

/** La lista en el orden que se ve (OrdenBandeja, orden-bandeja.tsx). */
export interface OrdenValor {
  hilos: HiloVista[];
  vista: VistaBandeja;
  listaHref: string;
}

export const OrdenContext = createContext<OrdenValor | null>(null);

/**
 * Adónde pasa «Marcar como hecha» en el orden que se ve. Fuera de
 * OrdenBandeja (una prueba, la galería), `porDefecto`: el del servidor.
 */
export function useSiguienteTrasHecha(porDefecto: string | null): string | null {
  const orden = useContext(OrdenContext);
  return orden ? siguienteTrasHecha(orden.hilos, orden.vista, orden.listaHref) : porDefecto;
}
