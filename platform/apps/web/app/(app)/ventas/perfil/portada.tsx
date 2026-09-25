"use client";

import { useEffect, useRef, useState } from "react";
import { PLATFORM_LABEL, type PlatformId } from "@/components/ui/platform-pill";
import { MESSAGES } from "./messages";

/** La caja 9:16 de la portada: la misma con imagen o sin ella, para que la lista no baile. */
const CAJA = "h-[100px] w-14 shrink-0 overflow-hidden rounded-md";

/** El tinte y la franja de cada red (tokens --s-<red> del tema): clases fijas para que Tailwind las vea. */
const TINTE: Record<PlatformId, { fondo: string; franja: string }> = {
  tiktok: { fondo: "bg-s-tiktok/15", franja: "bg-s-tiktok" },
  instagram: { fondo: "bg-s-instagram/15", franja: "bg-s-instagram" },
  facebook: { fondo: "bg-s-facebook/15", franja: "bg-s-facebook" },
  youtube: { fondo: "bg-s-youtube/15", franja: "bg-s-youtube" },
};

/**
 * Lo que va en lugar de una portada que no hay o que ya no carga: el
 * color de la red, su nombre y la duración del video. Dice algo (de qué
 * red es y cuánto dura) en vez de un hueco gris que parece una imagen
 * rota. El color no es el único indicador: el nombre de la red va escrito.
 */
export function Marcador({ platformId, duracion }: { platformId: PlatformId; duracion: string | null }) {
  const red = PLATFORM_LABEL[platformId];
  const tinte = TINTE[platformId];
  return (
    <span
      role="img"
      aria-label={MESSAGES.desempeno.sinPortada(red, duracion)}
      data-marcador={platformId}
      className={`${CAJA} relative flex flex-col justify-end ${tinte.fondo} p-1.5`}
    >
      <span className={`absolute inset-x-0 top-0 h-1 ${tinte.franja}`} aria-hidden="true" />
      <span className="block truncate text-[10px] font-medium leading-3 text-fg-2">{red}</span>
      {duracion && <span className="mt-0.5 block text-[11px] leading-4 font-medium tabular-nums text-fg">{duracion}</span>}
    </span>
  );
}

/**
 * La portada del video, 9:16 como en la red: lo primero que mira una
 * marca en un media kit (Beacons, Passionfroot). Es de cliente por una
 * sola razón: las portadas de TikTok e Instagram son URLs firmadas que
 * caducan, y una que ya no carga cambia al Marcador en vez de quedar
 * como imagen rota. La que falló antes de hidratar (el onError de React
 * aún no estaba) se detecta al montar: completa y sin ancho natural.
 */
export function Portada({
  src, href, alt, platformId, duracion,
}: { src: string | null; href: string | null; alt: string; platformId: PlatformId; duracion: string | null }) {
  const [rota, setRota] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const el = img.current;
    if (el && el.complete && el.naturalWidth === 0 && el.currentSrc) setRota(true);
  }, []);
  const contenido =
    !src || rota ? (
      <Marcador platformId={platformId} duracion={duracion} />
    ) : (
      // Las portadas vienen de las plataformas (dominios que no controlamos):
      // next/image exigiría declararlos (el mismo criterio que Campañas).
      // eslint-disable-next-line @next/next/no-img-element
      <img
        ref={img}
        src={src}
        alt={alt}
        width={56}
        height={100}
        loading="lazy"
        onError={() => setRota(true)}
        className={`${CAJA} bg-hover object-cover`}
      />
    );
  // El título ya enlaza al video: la portada es un atajo para el ratón, fuera del orden del teclado.
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" tabIndex={-1} className="shrink-0">
      {contenido}
    </a>
  ) : (
    contenido
  );
}
