"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Field, Input } from "@/components/ui/field";
import { Segmented } from "@/components/ui/segmented";
import {
  RECEIVABLE_FILTERS,
  RECEIVABLE_FILTER_KEYS,
  type ReceivableFilterKey,
} from "../_lib/estado";
import { MESSAGES } from "../_lib/messages";

/** Espera tras la última tecla antes de cambiar la URL. */
const DEBOUNCE_MS = 250;

/**
 * El filtro por estado de cobro y la búsqueda de /finanzas.
 *
 * Es cliente —`Segmented` necesita `onChange`— pero no consulta nada:
 * escribe `?bucket=` y `?q=` en la URL y la página, que sigue siendo un
 * Server Component, los lee de `searchParams` y hace la consulta en el
 * servidor. El filtro vive en la URL para que se pueda compartir
 * («mírate las vencidas») y para que el botón de atrás lo deshaga.
 *
 * Los dos controles comparten un solo `navigate`: sin eso, elegir un
 * estado borraba la búsqueda escrita y al revés.
 */
export function Filtros({ active, minSearch }: { active: ReceivableFilterKey; minSearch: number }) {
  const t = MESSAGES.cobros.filters;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function navigate(next: Record<string, string>) {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    const qs = sp.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  }

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // Con menos de `minSearch` letras no se busca (es el mismo mínimo que
  // aplica @mc/db). Si la URL filtraba por un texto más largo que ya se
  // borró, se vuelve a la lista entera; si no, no se toca la URL.
  function onSearch(value: string) {
    setQ(value);
    if (timer.current) clearTimeout(timer.current);
    const trimmed = value.trim();
    const next = trimmed.length >= minSearch ? trimmed : "";
    if (next === (params.get("q") ?? "")) return;
    timer.current = setTimeout(() => navigate({ q: next }), DEBOUNCE_MS);
  }

  const short = q.trim().length > 0 && q.trim().length < minSearch;

  return (
    <div className="mb-3 flex flex-wrap items-start gap-3" aria-busy={pending || undefined}>
      <Segmented<ReceivableFilterKey>
        label={t.label}
        size="sm"
        value={active}
        options={RECEIVABLE_FILTER_KEYS.map((key) => ({ value: key, label: RECEIVABLE_FILTERS[key].label }))}
        onChange={(key) => navigate({ bucket: key === "por_cobrar" ? "" : key })}
      />
      {/* Crece hasta un tope: sin él, en escritorio la caja se estiraba
          hasta el borde y pesaba más que el filtro, que es lo principal. */}
      <div role="search" className="min-w-0 max-w-sm flex-1 basis-56">
        <Field label={t.search} help={short ? t.shortSearch(minSearch) : t.searchHelp} htmlFor="cobros-q">
          <Input
            type="search"
            value={q}
            onChange={(e) => onSearch(e.target.value)}
            autoComplete="off"
            placeholder={t.searchPlaceholder}
          />
        </Field>
      </div>
    </div>
  );
}
