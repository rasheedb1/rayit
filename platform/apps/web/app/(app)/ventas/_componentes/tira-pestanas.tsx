"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * El contenedor de la tira de pestañas de Ventas. En una sola línea: en
 * un teléfono (400 px) las cinco no caben, y partidas dejaban «Canales»
 * sola debajo de «Radar». Aquí la tira se desplaza por dentro y, al
 * cargar, la pestaña activa se trae a la vista (block «nearest»: la
 * página no salta en vertical).
 */
export function TiraPestanas({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const activa = ref.current?.querySelector<HTMLElement>('[aria-current="page"]');
    // jsdom no implementa scrollIntoView: sin él, la tira se queda donde está.
    activa?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, []);
  return (
    <nav ref={ref} aria-label={label} className="mb-6 flex flex-nowrap gap-1 overflow-x-auto border-b border-border pb-px sm:gap-1.5">
      {children}
    </nav>
  );
}
