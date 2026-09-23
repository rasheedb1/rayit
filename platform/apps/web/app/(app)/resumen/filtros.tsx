"use client";

import { useRouter } from "next/navigation";
import { useEffect, useOptimistic, useRef, useTransition } from "react";
import { Segmented } from "@/components/ui/segmented";
import { PLATFORM_LABEL } from "@/components/ui/platform-pill";
import { useFiltroEnCurso } from "./filtro-en-curso";
import { MESSAGES } from "./messages";
import { hrefDe, PERIODS, PLATFORMS, type Filtro, type Period, type PlatformId } from "./_lib/filtro";

const TODAS = "todas";

/**
 * El periodo y la red, arriba a la derecha, como en Vercel Analytics.
 *
 * Cambiarlos navega: el estado vive en la URL y el servidor vuelve a
 * consultar. `useTransition` mantiene la pantalla anterior visible
 * mientras llega la nueva —con aria-busy— en vez de parpadear a
 * esqueleto en cada clic.
 *
 * Lo elegido se ve ELEGIDO en el acto (`useOptimistic`): pintar el
 * valor del servidor dejaba la pastilla anterior marcada hasta que
 * llegaba la respuesta, y con el teclado una segunda flecha —o un
 * Enter— salía de la opción vieja y devolvía al periodo de antes.
 */
export function Filtros({ filtro }: { filtro: Filtro }) {
  const router = useRouter();
  // La transición es la de la página (FiltroEnCurso) cuando la hay: así
  // las cifras de abajo se atenúan mientras llega el filtro nuevo, y no
  // solo este grupo. Suelta —en las pruebas— lleva la suya.
  const propia = useTransition();
  const enCurso = useFiltroEnCurso();
  const pendiente = enCurso?.pendiente ?? propia[0];
  const empezar = enCurso?.empezar ?? propia[1];
  const [actual, fijar] = useOptimistic(filtro);
  const grupo = useRef<HTMLDivElement>(null);
  const t = MESSAGES.filtros;

  const ir = (siguiente: Filtro) =>
    empezar(() => {
      fijar(siguiente);
      router.push(hrefDe(siguiente), { scroll: false });
    });

  // Segmented cambia el valor con las flechas pero deja el foco en la
  // opción de antes. Mientras el kit no lo haga (avisado a Nicolás),
  // el foco sigue a la opción elegida SOLO si ya estaba dentro de ese
  // grupo: con el ratón no se mueve nada que no se haya tocado.
  useEffect(() => {
    const activo = document.activeElement;
    if (!(activo instanceof HTMLElement) || !grupo.current?.contains(activo)) return;
    const elegida = activo.closest('[role="group"]')?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (elegida && elegida !== activo) elegida.focus();
  }, [actual.days, actual.platform]);

  return (
    <div ref={grupo} className="flex flex-wrap items-center gap-2" aria-busy={pendiente || undefined}>
      <Segmented<`${Period}`>
        label={t.periodo}
        size="sm"
        value={`${actual.days}`}
        options={PERIODS.map((d) => ({ value: `${d}` as `${Period}`, label: t.dias(d) }))}
        onChange={(v) => ir({ ...actual, days: Number(v) as Period })}
      />
      <Segmented<string>
        label={t.red}
        size="sm"
        value={actual.platform ?? TODAS}
        options={[
          { value: TODAS, label: t.todasLasRedes },
          ...PLATFORMS.map((r) => ({ value: r, label: PLATFORM_LABEL[r] })),
        ]}
        onChange={(v) => ir({ ...actual, platform: v === TODAS ? null : (v as PlatformId) })}
      />
    </div>
  );
}
