"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Field, Input, Select } from "@/components/ui/field";
import { MESSAGES } from "../_lib/messages";
import { RELATIONSHIP_OPTIONS } from "../_lib/estado";

/** Espera tras la última tecla antes de cambiar la URL. */
const DEBOUNCE_MS = 250;

/**
 * La búsqueda de empresas. Vive en la URL (`?q=` y `?rel=`) para que
 * una búsqueda se pueda compartir y el botón de atrás la deshaga; la
 * consulta la hace la página, en el servidor.
 *
 * Busca desde el tercer carácter (MIN_SEARCH en la capa de datos):
 * con una o dos letras no filtra y lo dice. Si la URL todavía traía una
 * búsqueda más larga (se borró de «nan» a «na»), la quita: la lista
 * vuelve a ser la entera y nunca queda filtrada por un texto que ya no
 * está en la caja (pulido r6).
 */
export function Buscador({ minSearch }: { minSearch: number }) {
  const t = MESSAGES.empresas;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function navigate(next: { q?: string; rel?: string }) {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    const qs = sp.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  }

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function onChange(value: string) {
    setQ(value);
    if (timer.current) clearTimeout(timer.current);
    const trimmed = value.trim();
    // Con 1 o 2 letras no se busca. Si la URL filtraba por un texto más
    // largo que ya se borró, se vuelve a la lista entera; si no, nada.
    const next = trimmed.length >= minSearch ? trimmed : "";
    if (next === (params.get("q") ?? "")) return;
    timer.current = setTimeout(() => navigate({ q: next }), DEBOUNCE_MS);
  }

  const short = q.trim().length > 0 && q.trim().length < minSearch;

  // items-start y no items-end: la ayuda («Desde el tercer carácter»)
  // alarga solo la columna de la búsqueda, y alineada por el fondo la
  // fila bajaba el select unos 22 px. Por arriba, las dos etiquetas y los
  // dos controles quedan a la misma altura con ayuda o sin ella.
  return (
    <div role="search" className="flex flex-wrap items-start gap-3" aria-busy={pending || undefined}>
      <Field label={t.search} help={short ? t.shortSearch(minSearch) : t.searchHelp} htmlFor="empresas-q" className="min-w-0 flex-1 basis-64">
        <Input type="search" value={q} onChange={(e) => onChange(e.target.value)} autoComplete="off" placeholder={MESSAGES.empresas.searchPlaceholder} />
      </Field>
      <Field label={t.relationshipFilter} htmlFor="empresas-rel" className="w-44">
        <Select
          value={params.get("rel") ?? ""}
          onChange={(e) => navigate({ rel: e.target.value })}
          placeholder={t.allRelationships}
          options={RELATIONSHIP_OPTIONS}
        />
      </Field>
    </div>
  );
}
