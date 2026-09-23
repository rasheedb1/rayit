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
 * estado borraba la búsqueda escrita y al revés. Y hay dos trampas que
 * esa frase sola no evita, las dos por el temporizador de la búsqueda:
 *
 *  1. Escribir y pulsar un estado antes de los 250 ms. El temporizador
 *     ya estaba en marcha con la URL de ANTES del clic, y al disparar
 *     reconstruía la URL sin `?bucket=`. Por eso elegir un estado
 *     cancela el temporizador y se lleva consigo lo que haya escrito.
 *  2. La URL cambia por fuera (el botón de atrás, «Quitar la búsqueda»,
 *     el KPI de «Vencido»). El componente no se desmonta al navegar
 *     dentro del mismo segmento, así que la caja se quedaba con un
 *     texto que ya no filtraba nada. Se vuelve a sincronizar con la URL
 *     salvo cuando el cambio lo mandó este mismo componente.
 */
export function Filtros({ active, minSearch }: { active: ReceivableFilterKey; minSearch: number }) {
  const t = MESSAGES.cobros.filters;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const urlQ = params.get("q") ?? "";

  const [q, setQ] = useState(urlQ);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Lo último que mandó este componente a la URL. */
  const enviado = useRef(urlQ);
  /** La ruta y la query de ahora, para que el temporizador no use las de hace 250 ms. */
  const actual = useRef({ pathname, search: params.toString() });

  useEffect(() => {
    actual.current = { pathname, search: params.toString() };
  });

  // La URL cambió por fuera: la caja vuelve a decir lo que filtra.
  useEffect(() => {
    if (urlQ === enviado.current) return;
    enviado.current = urlQ;
    setQ(urlQ);
  }, [urlQ]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function cancelar() {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }

  function navigate(next: Record<string, string>) {
    const sp = new URLSearchParams(actual.current.search);
    for (const [k, v] of Object.entries(next)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    if ("q" in next) enviado.current = next.q ?? "";
    const qs = sp.toString();
    const destino = qs ? `${actual.current.pathname}?${qs}` : actual.current.pathname;
    startTransition(() => router.replace(destino, { scroll: false }));
  }

  /** Lo escrito, listo para la URL: "" si todavía no llega al mínimo. */
  const terminoDe = (value: string) => {
    const trimmed = value.trim();
    return trimmed.length >= minSearch ? trimmed : "";
  };

  // Con menos de `minSearch` letras no se busca (es el mismo mínimo que
  // aplica @mc/db). Si la URL filtraba por un texto más largo que ya se
  // borró, se vuelve a la lista entera; si no, no se toca la URL.
  function onSearch(value: string) {
    setQ(value);
    cancelar();
    const next = terminoDe(value);
    if (next === (params.get("q") ?? "")) return;
    timer.current = setTimeout(() => navigate({ q: next }), DEBOUNCE_MS);
  }

  function onBucket(key: ReceivableFilterKey) {
    // Se lleva lo escrito: si había un temporizador pendiente, esta
    // navegación lo sustituye en vez de pelearse con él.
    cancelar();
    navigate({ bucket: key === "por_cobrar" ? "" : key, q: terminoDe(q) });
  }

  const short = q.trim().length > 0 && q.trim().length < minSearch;

  return (
    <div className="mb-3 flex flex-wrap items-start gap-3" aria-busy={pending || undefined}>
      <Segmented<ReceivableFilterKey>
        label={t.label}
        size="sm"
        value={active}
        options={RECEIVABLE_FILTER_KEYS.map((key) => ({ value: key, label: RECEIVABLE_FILTERS[key].label }))}
        onChange={onBucket}
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
