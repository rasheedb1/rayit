"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

/**
 * El «Reintentar» de una frontera de error, que de verdad reintenta.
 *
 * En Next 15, `reset()` solo vuelve a renderizar el segmento EN EL
 * CLIENTE con el payload RSC que ya tiene. Cuando el error vino de un
 * Server Component —que es el caso de estas fronteras: la base caída,
 * un DEMO_WORKSPACE_ID que no corresponde a ninguna fila—, ese payload
 * es el del error, así que el botón no pedía nada al servidor (medido
 * por CDP: cero peticiones) y la pantalla seguía en error aunque la base
 * ya hubiera vuelto.
 *
 * `router.refresh()` pide al servidor el árbol de nuevo, y `reset()`
 * dentro de la misma transición limpia el estado de error cuando llega.
 * Mientras tanto `pendiente` es true, para que el botón no se pulse dos
 * veces.
 */
export function useReintentar(reset: () => void): { reintentar: () => void; pendiente: boolean } {
  const router = useRouter();
  const [pendiente, empezar] = useTransition();
  const reintentar = () =>
    empezar(() => {
      router.refresh();
      reset();
    });
  return { reintentar, pendiente };
}

/**
 * ¿Se le enseña a quien mira la pista de despliegue (los nombres de las
 * variables del servidor)?
 *
 * En desarrollo, sí. En las vistas previas de Vercel también, que es
 * donde mira quien despliega: pero ahí NODE_ENV vale «production» porque
 * se fija al compilar, y la ronda 2 la escondía justo donde servía. Lo
 * que distingue una vista previa de producción es NEXT_PUBLIC_VERCEL_ENV,
 * que Vercel expone al compilar ('production', 'preview' o
 * 'development'). Fuera de Vercel no existe: `next start` en local con
 * NODE_ENV=production se comporta como producción.
 *
 * Las dos lecturas son `process.env.X` literales a propósito: Next solo
 * sustituye en el bundle del cliente los accesos escritos así.
 */
export function mostrarPistaDeDespliegue(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  const vercel = process.env.NEXT_PUBLIC_VERCEL_ENV;
  return vercel !== undefined && vercel !== "" && vercel !== "production";
}
