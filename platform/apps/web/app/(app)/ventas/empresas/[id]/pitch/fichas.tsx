"use client";

import { useMemo, useState } from "react";
import type { SalesClaim } from "@mc/core/outreach/claims";
import { TEMPLATE_VARIABLE_GROUPS, type TemplateVariable } from "@mc/core/outreach/render";
import { Field, Input } from "@/components/ui/field";
import { PITCH } from "./messages";

const CHIP =
  "inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-left text-xs text-ink " +
  "transition-colors hover:border-axis hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/15";

export type ClaimGroup = keyof typeof PITCH.fichas.grupos;
const ORDER = Object.keys(PITCH.fichas.grupos) as ClaimGroup[];
/**
 * Abiertos de entrada: solo lo propio de ESTA marca (las campañas con ella
 * y la señal del negocio), que son pocas fichas. Las medianas y lo demás,
 * plegados: la biblioteca no empuja el resto del editor hacia abajo.
 */
const OPEN_BY_DEFAULT: readonly ClaimGroup[] = ["campaign_brand", "signal"];

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

/** El grupo de una cifra: por su origen, y las campañas con la marca a la que se escribe, aparte y primero. */
export function claimGroupOf(c: SalesClaim, companyName: string): ClaimGroup {
  if (c.source === "campaign_result") {
    return (c.entities ?? []).some((e) => fold(e) === fold(companyName)) ? "campaign_brand" : "campaign_result";
  }
  return c.source;
}

/** Las cifras agrupadas en el orden del editor, filtradas por lo que se busca (etiqueta, cifra o grupo). */
export function groupClaims(claims: readonly SalesClaim[], companyName: string, query: string): Array<{ group: ClaimGroup; claims: SalesClaim[] }> {
  const q = fold(query.trim());
  const groups = new Map<ClaimGroup, SalesClaim[]>();
  for (const c of claims) {
    const g = claimGroupOf(c, companyName);
    if (q && !fold(`${c.label} ${c.display} ${PITCH.fichas.grupos[g]}`).includes(q)) continue;
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  return ORDER.filter((g) => groups.has(g)).map((g) => ({ group: g, claims: groups.get(g)! }));
}

/**
 * Las fichas insertables del editor: las cifras del creador que firma,
 * agrupadas por su origen en secciones plegables (abiertas de entrada solo
 * las campañas con esta marca y la señal del negocio), con un filtro de
 * texto; y las variables de la lista canónica (render.ts, @mc/core).
 * Tocar una la escribe donde está el cursor; el editor decide cómo
 * (cuerpo.tsx). Como el compositor de Superhuman: lo que se cita está a un
 * toque, sin bajar mil píxeles.
 */
export function FichasInsertables({
  claims,
  companyName,
  onVariable,
  onClaim,
}: {
  claims: readonly SalesClaim[];
  companyName: string;
  onVariable: (v: TemplateVariable) => void;
  onClaim: (c: SalesClaim) => void;
}) {
  const t = PITCH.fichas;
  const [query, setQuery] = useState("");
  const groups = useMemo(() => groupClaims(claims, companyName, query), [claims, companyName, query]);
  const variables = Object.values(TEMPLATE_VARIABLE_GROUPS).flat() as TemplateVariable[];
  const searching = query.trim() !== "";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <section aria-labelledby="pitch-cifras" className="min-w-0">
        <h3 id="pitch-cifras" className="text-sm font-medium text-ink">
          {t.cifras}
        </h3>
        <p className="mb-2 text-xs text-muted">{t.cifrasHelp}</p>
        {claims.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted">{t.sinCifras}</p>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
            <Field label={t.buscar} htmlFor="pitch-buscar-cifra">
              <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.buscarPlaceholder} autoComplete="off" />
            </Field>
            {groups.length === 0 && <p className="text-xs text-muted">{t.sinResultados}</p>}
            {groups.map(({ group, claims: items }) => (
              <details
                key={`${group}:${searching}`}
                open={searching || OPEN_BY_DEFAULT.includes(group)}
                className="min-w-0 rounded-md border border-border"
              >
                <summary className="flex cursor-pointer items-baseline justify-between gap-2 px-3 py-2 text-xs font-medium text-ink">
                  <span className="min-w-0 truncate">{t.grupos[group]}</span>
                  <span className="shrink-0 font-normal tabular-nums text-muted">{t.cuantas(items.length)}</span>
                </summary>
                <ul className="flex flex-wrap gap-1.5 px-3 pb-3">
                  {items.map((c) => (
                    <li key={c.id} className="min-w-0 max-w-full">
                      <button type="button" className={CHIP} onClick={() => onClaim(c)} aria-label={t.insertar(`${c.label}: ${c.display}`)}>
                        <span className="min-w-0 truncate">{c.label}</span>
                        <span className="shrink-0 font-medium tabular-nums">{c.display}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        )}
      </section>
      <section aria-labelledby="pitch-variables" className="min-w-0">
        <h3 id="pitch-variables" className="text-sm font-medium text-ink">
          {t.variables}
        </h3>
        <p className="mb-2 text-xs text-muted">{t.variablesHelp}</p>
        <ul className="flex flex-wrap gap-1.5">
          {variables.map((v) => (
            <li key={v}>
              <button type="button" className={CHIP} onClick={() => onVariable(v)} aria-label={t.insertar(PITCH.variables[v])}>
                {PITCH.variables[v]}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
