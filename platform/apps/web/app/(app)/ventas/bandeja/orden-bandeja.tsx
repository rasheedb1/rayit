"use client";

import { useContext, useMemo, useState, type ReactNode } from "react";
import { AtajosBandeja } from "./acciones";
import { ListaHilos } from "./lista";
import type { VistaBandeja } from "./messages";
import { mismoOrden, ordenarHilos, ordenEstable } from "./orden";
import { OrdenContext } from "./orden-contexto";
import type { HiloVista } from "./vista";

/**
 * La lista de la bandeja en un orden que no se mueve mientras dura la
 * visita (pulido r6, VEN-14). El servidor manda los sin leer arriba; al
 * abrir uno, MarcarLeido lo marca y refresca, y el hilo bajaba a su sitio
 * por fecha: j y k, que cuentan desde el abierto, se saltaban a los demás
 * sin leer. Aquí se guarda el orden del primer render (las claves) y solo
 * se vuelve al del servidor al cambiar de vista o al recargar la página
 * (ordenEstable). La lista, el teclado y «Marcar como hecha» leen este
 * mismo orden, así que la siguiente es la que se veía debajo.
 *
 * El estado se ajusta durante el render cuando cambian las props (el
 * patrón de React para «estado derivado de una prop»), sin efectos: el
 * primer pintado ya sale en el orden bueno.
 */
export function OrdenBandeja({
  hilos, vista, listaHref, children,
}: { hilos: HiloVista[]; vista: VistaBandeja; listaHref: string; children: ReactNode }) {
  const claves = hilos.map((h) => h.key);
  const [orden, setOrden] = useState(() => ({ vista, claves }));
  const siguiente = orden.vista === vista ? ordenEstable(orden.claves, claves) : claves;
  if (orden.vista !== vista || !mismoOrden(siguiente, orden.claves)) setOrden({ vista, claves: siguiente });
  const clave = siguiente.join("|");
  const valor = useMemo(
    () => ({ hilos: ordenarHilos(hilos, clave ? clave.split("|") : []), vista, listaHref }),
    [hilos, clave, vista, listaHref],
  );
  return <OrdenContext.Provider value={valor}>{children}</OrdenContext.Provider>;
}

/** El teclado y la lista, en el orden de OrdenBandeja. */
export function ListaEnOrden({ activoSoloEscritorio, puedeOperar }: { activoSoloEscritorio: boolean; puedeOperar: boolean }) {
  const orden = useContext(OrdenContext);
  const hilos = orden?.hilos ?? [];
  return (
    <>
      <AtajosBandeja
        hrefs={hilos.map((h) => h.href)}
        activo={hilos.findIndex((h) => h.activo)}
        activoSoloEscritorio={activoSoloEscritorio}
        listaHref={orden?.listaHref ?? ""}
        puedeOperar={puedeOperar}
      />
      {hilos.length > 0 ? <ListaHilos hilos={hilos} /> : null}
    </>
  );
}
