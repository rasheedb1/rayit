import type { StageConversion } from "@mc/db/queries/conversion";
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
  /** «de 12 negocios», o «Sin historia todavía». */
  basis: string;
  /** La frase entera: «De los 12 negocios que entraron en «Contactado», 7 llegaron más lejos (58 %).» */
  label: string;
}

/**
 * Lo que dice la fila de una etapa, a partir de getStageConversion. Aquí
 * no se calcula nada: la tasa llega de SQL y solo se formatea con el
 * locale del workspace. Null para las etapas cerradas (Ganado, Perdido),
 * que no tienen a dónde avanzar.
 */
export function conversionView(c: StageConversion | undefined, stageLabel: string, f: Formatter): ConversionView | null {
  const t = MESSAGES.pipeline.conversion;
  if (!c) return null;
  if (c.entered === 0 || c.rate === null) {
    return { rate: null, basis: t.none, label: t.labelNone(stageLabel) };
  }
  const pct = f.pct(Number(c.rate));
  const entered = f.int(c.entered);
  const advanced = f.int(c.advanced);
  return {
    rate: t.rate(pct),
    basis: t.basis(entered, c.entered),
    label: c.entered === 1 ? t.labelOne(stageLabel, advanced, pct) : t.label(stageLabel, advanced, entered, pct),
  };
}

/**
 * La fila discreta de conversión debajo de una columna del pipeline
 * (VEN-8), como la de Pipedrive: qué parte de los negocios que entraron
 * en la etapa llegó más lejos, y sobre cuántos se sostiene esa cifra.
 * «100 % avanza» sobre un negocio no es lo mismo que sobre cuarenta, y
 * por eso el número de negocios va siempre al lado.
 *
 * Se monta en el tablero con una línea (_pipeline/tablero.tsx). Sin
 * `view` (una etapa cerrada) no pinta nada.
 */
export function StageConversionRow({ view }: { view: ConversionView | null }) {
  if (!view) return null;
  return (
    <p
      className="mt-2 flex items-baseline justify-between gap-2 border-t border-dashed border-border pt-2 text-xs text-muted"
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
