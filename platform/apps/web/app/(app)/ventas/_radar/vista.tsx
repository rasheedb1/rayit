import type { SignalRow } from "@mc/db/queries/ventas";
import type { Formatter } from "@/lib/format";
import { dealLabel } from "@/lib/negocio";
import { safeHref } from "@/lib/url";
import { pillForFit } from "../_lib/estado";
import { MESSAGES } from "../_lib/messages";
import { countryOptions } from "../_lib/paises";
import { Radar, type HiddenLine, type SignalCardData } from "./radar";

/**
 * La bandeja del radar: las señales por revisar, de mayor a menor
 * encaje, que es el orden en que conviene mirarlas.
 *
 * Cada señal es una tarjeta y no una fila de tabla porque lo que se
 * decide aquí no es «cuál ordeno por monto» sino «esta sí, esta no»:
 * hace falta ver el titular entero, de dónde salió y la evidencia antes
 * de aceptar. Es la bandeja de Attio y de Folk, no un listado.
 *
 * Este componente es de servidor y solo prepara los datos: formatea
 * fechas y montos con el formateador del workspace y se los pasa ya
 * hechos a la bandeja, que es de cliente porque acepta y descarta.
 *
 * `hidden` son las pendientes que el brief activo deja fuera (VEN-7):
 * cuántas y si se están viendo (?ocultas=1). La bandeja lo dice en una
 * línea bajo el título; sin ninguna oculta, no dice nada. Vistas, cada
 * una dice qué regla la dejó fuera («Tu brief no acepta «harinas»») y
 * van al final, en su grupo.
 *
 * `briefFit` (de listSignals, en SQL) es cómo encaja con «Qué buscas»:
 * se pinta como Pill neutral y no oculta nada.
 */
/**
 * Una categoría o una marca dentro de una Pill, que no parte línea: a
 * 400 px una de 60 caracteres empujaría la tarjeta más allá del ancho.
 */
function corto(texto: string, max = 28): string {
  const limpio = texto.trim();
  return limpio.length > max ? `${limpio.slice(0, max - 1).trimEnd()}…` : limpio;
}

export function RadarView({
  signals,
  f,
  currency,
  hidden,
}: {
  signals: SignalRow[];
  f: Formatter;
  currency: string;
  hidden?: { count: number; showing: boolean };
}) {
  const h = MESSAGES.radar.hidden;
  const cards: SignalCardData[] = signals.map((s) => ({
    id: s.id,
    companyName: s.companyName,
    headline: s.headlineEs,
    fit: pillForFit(s.fitScore, f),
    sourceLabel: s.sourceLabel,
    detectedText: f.date(s.detectedAt),
    budgetText: s.budgetEstimate ? f.money(s.budgetEstimate, s.budgetCurrency ?? undefined, { mode: "short" }) : null,
    // Solo http(s): la columna es text libre y la llenarán los conectores del radar.
    evidenceUrl: safeHref(s.evidenceUrl),
    viaCsv: s.via === "csv",
    // La marca ya está en el CRM: su ficha y, si lo hay, el negocio abierto
    // al que se sumará la señal (el mismo que elige acceptSignal).
    crm:
      s.companyLinked && s.companyId
        ? {
            companyHref: `/ventas/empresas/${s.companyId}`,
            joinsDeal: s.openDealId !== null,
            dealName: s.openDealId !== null ? dealLabel(s.companyName, s.openDealName) : null,
          }
        : null,
    hiddenReason: s.hiddenBy ? h.reason[s.hiddenBy](corto(s.hiddenMatch ?? s.companyName ?? "")) : null,
    fitNotes: [
      ...(s.briefFit.wantedCategory ? [MESSAGES.radar.briefFit.wanted(corto(s.briefFit.wantedCategory))] : []),
      ...(s.briefFit.belowMinBudget ? [MESSAGES.radar.briefFit.belowMin] : []),
      ...(s.briefFit.countryOutside ? [MESSAGES.radar.briefFit.countryOutside] : []),
    ],
  }));
  const line: HiddenLine | null =
    hidden && hidden.count > 0
      ? {
          text: hidden.showing ? h.showing(f.int(hidden.count), hidden.count) : h.line(f.int(hidden.count), hidden.count),
          toggle: hidden.showing ? { href: "/ventas", label: h.hide } : { href: "/ventas?ocultas=1", label: h.show },
          brief: { href: "/ventas/brief", label: h.editBrief },
        }
      : null;
  return <Radar cards={cards} currency={currency} countries={countryOptions(f.locale)} hiddenLine={line} />;
}
