"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Segmented } from "@/components/ui/segmented";
import { LIST_FILTERS, LIST_FILTER_KEYS, filterHref, type ListFilterKey } from "./estado";

/**
 * El filtro por estado de la lista. Es cliente (Segmented necesita
 * onChange) y escribe ?estado= en la URL: la página sigue siendo Server
 * Component y lee el filtro de searchParams.
 */
export function StatusFilter({ active }: { active: ListFilterKey }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div aria-busy={pending || undefined}>
      <Segmented<ListFilterKey>
        label="Filtrar campañas por estado"
        size="sm"
        value={active}
        options={LIST_FILTER_KEYS.map((key) => ({ value: key, label: LIST_FILTERS[key].label }))}
        onChange={(key) => startTransition(() => router.push(filterHref(key)))}
      />
    </div>
  );
}
