"use client";

import type { SalesClaim } from "@mc/core/outreach/claims";
import { TEMPLATE_VARIABLE_GROUPS, type TemplateVariable } from "@mc/core/outreach/render";
import { PITCH } from "./messages";

const CHIP =
  "inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-left text-xs text-ink " +
  "transition-colors hover:border-axis hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/15";

/**
 * Las fichas insertables del editor: las variables de la lista canónica
 * (render.ts, @mc/core) y las cifras del perfil con su origen. Tocar una
 * la escribe donde está el cursor; el editor decide cómo (insertAt).
 */
export function FichasInsertables({
  claims,
  onVariable,
  onClaim,
}: {
  claims: readonly SalesClaim[];
  onVariable: (v: TemplateVariable) => void;
  onClaim: (c: SalesClaim) => void;
}) {
  const t = PITCH.fichas;
  const variables = Object.values(TEMPLATE_VARIABLE_GROUPS).flat() as TemplateVariable[];
  return (
    <div className="grid gap-5">
      <section aria-labelledby="pitch-cifras">
        <h3 id="pitch-cifras" className="text-sm font-medium text-ink">
          {t.cifras}
        </h3>
        <p className="mb-2 text-xs text-muted">{t.cifrasHelp}</p>
        {claims.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted">{t.sinCifras}</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {claims.map((c) => (
              <li key={c.id} className="min-w-0 max-w-full">
                <button type="button" className={CHIP} onClick={() => onClaim(c)} aria-label={t.insertar(`${c.label}: ${c.display}`)}>
                  <span className="shrink-0 text-muted">{PITCH.origen[c.source]}</span>
                  <span className="min-w-0 truncate">{c.label}</span>
                  <span className="shrink-0 font-medium tabular-nums">{c.display}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="pitch-variables">
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
