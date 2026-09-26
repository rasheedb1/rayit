import { CONVERSION_WINDOW_DAYS, type StageConversion } from "@mc/db/queries/conversion";
import type { Formatter } from "@/lib/format";
import { MESSAGES } from "../_lib/messages";

/**
 * La conversión de una etapa ya escrita, lista para cruzar al tablero
 * (que es de cliente): la tasa, sobre cuántos negocios, y la frase
 * completa para el lector de pantalla y el `title`.
 */
export interface ConversionView {
  /** «58 % avanza»; null si ningún negocio pasó todavía por la etapa. */
  rate: string | null;
  /** «de 12 negocios en 90 días», o «Nadie entró en 90 días». */
  basis: string;
  /** La frase entera: «En los últimos 90 días, de los 12 negocios que entraron en «Contactado», 7 llegaron más lejos (58 %).» */
  label: string;
}

/**
 * Lo que dice la fila de una etapa, a partir de getStageConversion. Aquí
 * no se calcula nada: la tasa llega de SQL y solo se formatea con el
 * locale del workspace. Null para las etapas cerradas (Ganado, Perdido),
 * que no tienen a dónde avanzar.
 *
 * La cifra es la de un periodo (VEN-8 r4): los negocios que entraron en
 * la etapa en los últimos CONVERSION_WINDOW_DAYS días, la ventana por
 * defecto de getStageConversion. La frase lo dice («de 10 negocios en
 * 90 días»), para que no se lea como la de toda la historia.
 */
export function conversionView(c: StageConversion | undefined, stageLabel: string, f: Formatter): ConversionView | null {
  const t = MESSAGES.pipeline.conversion;
  if (!c) return null;
  const days = f.int(CONVERSION_WINDOW_DAYS);
  if (c.entered === 0 || c.rate === null) {
    return { rate: null, basis: t.none(days), label: t.labelNone(stageLabel, days) };
  }
  const pct = f.pct(Number(c.rate));
  const entered = f.int(c.entered);
  const advanced = f.int(c.advanced);
  return {
    rate: t.rate(pct),
    basis: t.basis(entered, c.entered, days),
    label: t.label(stageLabel, entered, c.entered, advanced, c.advanced, pct, days),
  };
}

/**
 * La fila discreta de conversión de una columna del pipeline (VEN-8),
 * como la de Pipedrive: qué parte de los negocios que entraron en la
 * etapa llegó más lejos, y sobre cuántos se sostiene esa cifra.
 * «100 % avanza» sobre un negocio no es lo mismo que sobre cuarenta, y
 * por eso el número de negocios va siempre al lado.
 *
 * Va bajo la cabecera de cada columna, junto al monto, y no al pie: al
 * pie quedaba a la altura de la última tarjeta y las tasas no se leían
 * en línea. Se monta en el tablero con una línea (_pipeline/tablero.tsx)
 * y en la lista, en el resumen de encima (_pipeline/vista.tsx). Sin
 * `view` (una etapa cerrada) no pinta nada.
 */
export function StageConversionRow({ view, className = "" }: { view: ConversionView | null; className?: string }) {
  if (!view) return null;
  // `relative` no es decorativo: sin él, el sr-only (absolute) escapa del
  // scroll del tablero y ensancha la página entera a 400 px, igual que en
  // la tarjeta (_pipeline/tablero.tsx).
  return (
    <p
      className={`relative flex items-baseline justify-between gap-2 text-xs text-muted ${className}`}
      title={view.label}
      data-testid="conversion-etapa"
    >
      <span className="sr-only">{view.label}</span>
      <span aria-hidden="true" className="tabular-nums text-ink-2">
        {view.rate ?? view.basis}
      </span>
      {view.rate && (
        <span aria-hidden="true" className="tabular-nums">
          {view.basis}
        </span>
      )}
    </p>
  );
}

/**
 * La conversión en la vista Lista: la misma fila por etapa abierta, en
 * un resumen encima de la tabla, en el orden del embudo. Sin etapas
 * abiertas no pinta nada. Es la misma cifra que el tablero pone bajo
 * cada columna: las dos formas del pipeline no pueden decir cosas
 * distintas.
 */
export function ConversionSummary({
  stages,
  days,
}: {
  stages: { id: string; label: string; conversion: ConversionView | null }[];
  /** La ventana, ya formateada con el locale del workspace («90»). */
  days: string;
}) {
  const t = MESSAGES.pipeline.conversion;
  const abiertas = stages.filter((s) => s.conversion !== null);
  if (abiertas.length === 0) return null;
  return (
    <section aria-label={t.listTitle(days)} className="mb-4">
      <h3 className="mb-2 text-xs font-medium text-muted">{t.listTitle(days)}</h3>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4" data-testid="conversion-resumen">
        {abiertas.map((s) => (
          <li key={s.id} className="min-w-0 rounded-md border border-border px-3 py-2">
            <p className="truncate text-xs font-medium text-ink">{s.label}</p>
            <StageConversionRow view={s.conversion} className="mt-1" />
          </li>
        ))}
      </ul>
    </section>
  );
}
