"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * El contenedor de la tira de pestañas de Ventas. En una sola línea: en
 * un teléfono (400 px) no caben todas, y partidas dejaban «Canales»
 * sola debajo de «Radar». Aquí la tira se desplaza por dentro y, al
 * cargar, la pestaña activa se trae a la vista (block «nearest»: la
 * página no salta en vertical).
 *
 * Que hay más pestañas lo dice un degradado en el borde por el que
 * siguen (a la derecha, y a la izquierda si ya se desplazó): sin él, a
 * 400 px la tira se cortaba en «Aprobaciones» y parecía que no había
 * nada más. Es decorativo (aria-hidden): un lector de pantalla recorre
 * todos los enlaces igual.
 */
export function TiraPestanas({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [mas, setMas] = useState<{ antes: boolean; despues: boolean }>({ antes: false, despues: false });

  useEffect(() => {
    const nav = ref.current;
    if (!nav) return;
    const activa = nav.querySelector<HTMLElement>('[aria-current="page"]');
    // jsdom no implementa scrollIntoView: sin él, la tira se queda donde está.
    activa?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    const medir = () => {
      // Un píxel de holgura: el redondeo de scrollLeft deja a veces 0,5 px sin recorrer.
      const antes = nav.scrollLeft > 1;
      const despues = nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1;
      setMas((m) => (m.antes === antes && m.despues === despues ? m : { antes, despues }));
    };
    medir();
    nav.addEventListener("scroll", medir, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(medir);
    ro?.observe(nav);
    return () => {
      nav.removeEventListener("scroll", medir);
      ro?.disconnect();
    };
  }, []);

  return (
    <div className="relative mb-6">
      <nav ref={ref} aria-label={label} className="flex flex-nowrap gap-1 overflow-x-auto border-b border-border pb-px sm:gap-1.5">
        {children}
      </nav>
      {mas.antes ? (
        <span
          aria-hidden="true"
          data-mas="antes"
          className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-linear-to-r from-bg to-transparent"
        />
      ) : null}
      {mas.despues ? (
        <span
          aria-hidden="true"
          data-mas="despues"
          className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-l from-bg to-transparent"
        />
      ) : null}
    </div>
  );
}
