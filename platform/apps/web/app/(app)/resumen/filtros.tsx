"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Segmented } from "@/components/ui/segmented";
import { PLATFORM_LABEL } from "@/components/ui/platform-pill";
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
 */
export function Filtros({ filtro }: { filtro: Filtro }) {
  const router = useRouter();
  const [pendiente, empezar] = useTransition();
  const t = MESSAGES.filtros;

  const ir = (siguiente: Filtro) => empezar(() => router.push(hrefDe(siguiente), { scroll: false }));

  return (
    <div className="flex flex-wrap items-center gap-2" aria-busy={pendiente || undefined}>
      <Segmented<`${Period}`>
        label={t.periodo}
        size="sm"
        value={`${filtro.days}`}
        options={PERIODS.map((d) => ({ value: `${d}` as `${Period}`, label: t.dias(d) }))}
        onChange={(v) => ir({ ...filtro, days: Number(v) as Period })}
      />
      <Segmented<string>
        label={t.red}
        size="sm"
        value={filtro.platform ?? TODAS}
        options={[
          { value: TODAS, label: t.todasLasRedes },
          ...PLATFORMS.map((r) => ({ value: r, label: PLATFORM_LABEL[r] })),
        ]}
        onChange={(v) => ir({ ...filtro, platform: v === TODAS ? null : (v as PlatformId) })}
      />
    </div>
  );
}
