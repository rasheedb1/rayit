"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Segmented } from "@/components/ui/segmented";
import { PLATFORM_LABEL } from "@/components/ui/platform-pill";
import { MESSAGES } from "./messages";
import { hrefDe, PERIODOS, REDES, type Filtro, type Periodo, type RedId } from "./_lib/filtro";

const TODAS = "todas";

/**
 * El periodo y la red, arriba a la derecha, como en Vercel Analytics.
 *
 * Cambiarlos navega: el estado vive en la URL y el servidor vuelve a
 * consultar. `useTransition` mantiene la pantalla anterior visible
 * mientras llega la nueva —con aria-busy— en vez de parpadear a
 * esqueleto en cada clic.
 */
export function Filtros({ filtro }: { filtro: Filtro }) {
  const router = useRouter();
  const [pendiente, empezar] = useTransition();
  const t = MESSAGES.filtros;

  const ir = (siguiente: Filtro) => empezar(() => router.push(hrefDe(siguiente), { scroll: false }));

  return (
    <div className="flex flex-wrap items-center gap-2" aria-busy={pendiente || undefined}>
      <Segmented<`${Periodo}`>
        label={t.periodo}
        size="sm"
        value={`${filtro.dias}`}
        options={PERIODOS.map((d) => ({ value: `${d}` as `${Periodo}`, label: t.dias(d) }))}
        onChange={(v) => ir({ ...filtro, dias: Number(v) as Periodo })}
      />
      <Segmented<string>
        label={t.red}
        size="sm"
        value={filtro.red ?? TODAS}
        options={[
          { value: TODAS, label: t.todasLasRedes },
          ...REDES.map((r) => ({ value: r, label: PLATFORM_LABEL[r] })),
        ]}
        onChange={(v) => ir({ ...filtro, red: v === TODAS ? null : (v as RedId) })}
      />
    </div>
  );
}
