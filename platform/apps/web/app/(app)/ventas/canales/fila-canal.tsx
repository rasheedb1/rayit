"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Aviso } from "../../_lib/aviso";

/**
 * La fila de un canal, del lado del cliente: el sitio donde se anuncia lo
 * que pasó con una de sus cuentas cuando el control que lo hizo ya no
 * está.
 *
 * Desconectar borra la sub-sección de la cuenta (su «Límites y cuenta» y
 * su botón): la fila pasa a «Sin conectar». Sin esto, la persona no
 * recibía confirmación y el foco caía en el cuerpo de la página. Aquí:
 *
 *   · el resultado sale en una región aria-live que vive en la fila y
 *     sobrevive al refresco del servidor (este componente no se desmonta:
 *     solo cambian sus hijos);
 *   · el foco va al título de la fila (tabIndex -1, `headingId`), así
 *     quien usa teclado o lector de pantalla sigue en el mismo canal.
 *
 * Los controles de dentro llaman a `useAvisoDeFila()` con la frase.
 */
type Announce = (message: { notice?: string; message?: string }) => void;

const AvisoDeFila = createContext<Announce>(() => {});

export function useAvisoDeFila(): Announce {
  return useContext(AvisoDeFila);
}

export function FilaCanal({ headingId, children }: { headingId: string; children: ReactNode }) {
  const [said, setSaid] = useState<{ notice?: string; message?: string; n: number } | null>(null);
  const announce = useCallback<Announce>((m) => setSaid((prev) => ({ ...m, n: (prev?.n ?? 0) + 1 })), []);
  useEffect(() => {
    if (said) document.getElementById(headingId)?.focus();
  }, [said, headingId]);
  return (
    <li className="flex flex-col gap-3 px-4 py-3">
      <AvisoDeFila.Provider value={announce}>{children}</AvisoDeFila.Provider>
      <div aria-live="polite" aria-atomic="true" data-aviso-de-fila={headingId} className="empty:hidden">
        {said && <Aviso key={said.n} message={said.message} notice={said.notice} size="xs" />}
      </div>
    </li>
  );
}
