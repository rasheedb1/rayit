"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Lo mínimo de una fila para saber cuál salió de la lista y qué decir.
 * `aviso` llega ya escrito desde el servidor (MESSAGES de Equipo): una
 * función no cruza la frontera servidor→cliente.
 */
export interface FilaVisible {
  id: string;
  /** Lo que se anuncia si esta fila sale: «Se quitó a Laura del espacio.» */
  aviso: string;
}

/**
 * Una sección de Equipo (Personas, Invitaciones pendientes) con lo que
 * pasa cuando una fila sale de ella.
 *
 * Al quitar a una persona o revocar una invitación, su fila —y con ella
 * el botón que tenía el foco— desaparece cuando la página se repinta, y
 * el foco caería en <body>: quien usa teclado o lector de pantalla
 * volvería al principio de la página. Aquí, si la lista se acorta y el
 * foco se perdió, va al título de la sección, y una región aria-live
 * dice el aviso de la fila que salió.
 *
 * Solo mueve el foco si se perdió: si la persona ya está en otro sitio
 * (otra pestaña, otro control, el enlace nuevo de «Nuevo enlace»), no se
 * lo quita. El `id` es lo que hace a la fila la misma: en las
 * invitaciones es el correo, porque «Nuevo enlace» cambia el id de la
 * invitación y no es una salida.
 */
export function AvisoDeSalidas({ filas, titulo, children }: { filas: FilaVisible[]; titulo: ReactNode; children: ReactNode }) {
  const tituloRef = useRef<HTMLDivElement>(null);
  const antes = useRef(filas);
  const [aviso, setAviso] = useState("");

  useEffect(() => {
    const previas = antes.current;
    antes.current = filas;
    const siguen = new Set(filas.map((f) => f.id));
    const salio = previas.find((f) => !siguen.has(f.id));
    if (!salio) return;
    setAviso(salio.aviso);
    const activo = document.activeElement;
    if (!activo || activo === document.body || !activo.isConnected) tituloRef.current?.focus();
  }, [filas]);

  return (
    <>
      <div ref={tituloRef} tabIndex={-1} className="rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ink">
        {titulo}
      </div>
      <p aria-live="polite" className="sr-only">
        {aviso}
      </p>
      {children}
    </>
  );
}
