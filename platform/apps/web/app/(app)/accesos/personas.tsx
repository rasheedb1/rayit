"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MESSAGES } from "./_lib/messages";

/** Lo mínimo de una persona para saber quién salió de la lista. */
export interface PersonaVisible {
  id: string;
  nombre: string;
}

/**
 * La sección «Personas» con lo que pasa cuando alguien sale de ella.
 *
 * Al quitar a una persona, su fila —y con ella el botón que tenía el
 * foco— desaparece cuando la página se repinta, y el foco caería en
 * <body>: quien usa teclado o lector de pantalla volvería al principio.
 * Aquí, si la lista se acorta y el foco se perdió, va al título de la
 * sección, y una región aria-live dice «Se quitó a X del espacio».
 *
 * Solo mueve el foco si se perdió: si la persona ya está en otro sitio
 * (otra pestaña, otro control), no se lo quita.
 */
export function AvisoDeBajas({ personas, titulo, children }: { personas: PersonaVisible[]; titulo: ReactNode; children: ReactNode }) {
  const tituloRef = useRef<HTMLDivElement>(null);
  const antes = useRef(personas);
  const [aviso, setAviso] = useState("");

  useEffect(() => {
    const previas = antes.current;
    antes.current = personas;
    const siguen = new Set(personas.map((p) => p.id));
    const salio = previas.find((p) => !siguen.has(p.id));
    if (!salio) return;
    setAviso(MESSAGES.miembros.quitado(salio.nombre));
    const activo = document.activeElement;
    if (!activo || activo === document.body || !activo.isConnected) tituloRef.current?.focus();
  }, [personas]);

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
