import Link from "next/link";
import type { CifraVista } from "./cifras";

/**
 * Una cifra del perfil con su origen: subrayada con puntos, al pasar el
 * cursor (o al llegar con el teclado) dice qué es y de dónde sale, y el
 * clic lleva al post, a la campaña o al tarifario. Es la regla del perfil
 * de Stripe Atlas: ningún número sin su fuente.
 *
 * Sin estado ni eventos: vale en el servidor (las secciones) y dentro del
 * componente de cliente de la narrativa. El tooltip es solo CSS y está
 * fuera del flujo (display: none) mientras no se ve, para que a 400 px
 * no abra scroll horizontal.
 *
 * `tipId` lo pone quien la pinta: la misma cifra puede salir en la
 * narrativa y en su sección, y dos tooltips no pueden compartir id.
 */
export function Cifra({ cifra, tipId, grande = false }: { cifra: CifraVista; tipId: string; grande?: boolean }) {
  const texto = grande ? "text-2xl font-semibold tracking-tight" : "font-medium";
  const clase = `tabular-nums ${texto} text-fg underline decoration-dotted decoration-fg-3 underline-offset-4 outline-none hover:decoration-fg focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-accent`;
  return (
    <span className="group relative inline-block">
      {cifra.href && cifra.externo ? (
        <a href={cifra.href} className={clase} aria-describedby={tipId} target="_blank" rel="noopener noreferrer">
          {cifra.valor}
        </a>
      ) : cifra.href ? (
        <Link href={cifra.href} className={clase} aria-describedby={tipId}>
          {cifra.valor}
        </Link>
      ) : (
        <span className={clase} tabIndex={0} aria-describedby={tipId}>
          {cifra.valor}
        </span>
      )}
      <span
        role="tooltip"
        id={tipId}
        className="absolute bottom-full left-0 z-20 mb-1.5 hidden w-60 max-w-[calc(100vw-2rem)] rounded-md bg-tooltip-bg px-2.5 py-2 text-left text-xs font-normal leading-4 tracking-normal text-tooltip-ink shadow-lg group-focus-within:block group-hover:block"
      >
        <span className="block">{cifra.etiqueta}</span>
        <span className="mt-1 block text-tooltip-ink-2">{cifra.origen}</span>
      </span>
    </span>
  );
}
