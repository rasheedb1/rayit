import type { SignalRow } from "@mc/db/queries/ventas";
import type { Formatter } from "@/lib/format";
import { dealLabel } from "@/lib/negocio";
import { safeHref } from "@/lib/url";
import { pillForFit } from "../_lib/estado";
import { MESSAGES } from "../_lib/messages";
import { countryOptions } from "../_lib/paises";
import { Radar, type HiddenLine, type RejectOptions, type SignalCardData } from "./radar";

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
 * `briefFit` (de listSignals, en SQL) es cómo encaja con «Qué buscas»
 * (VEN-7 r4): la tarjeta marca solo lo que APARTA la señal del brief
 * («Bajo tu mínimo», «Fuera de tus países», «Fuera de lo que buscas»),
 * en Pills neutras que no ocultan nada. La categoría buscada que sí
 * tiene va dentro de la Pill del encaje («82 % · alimentos»): sola, en
 * cada tarjeta de la demo, no distinguía ninguna.
 *
 * `reject` (VEN-7 r4) son los creadores con brief activo cuando quien
 * mira puede cambiar el brief: la tarjeta ofrece «No aceptar esta marca».
 * Null, no la ofrece.
 *
 * Los textos largos (la categoría, la marca) no se recortan aquí: van
 * enteros a una Pill con tope de ancho, que los corta con «…» por CSS y
 * los enseña enteros en su title (hasta la ronda 3, corto() partía
 * cadenas UTF-16 y podía romper un emoji).
 */
export function RadarView({
  signals,
  f,
  currency,
  hidden,
  reject = null,
}: {
  signals: SignalRow[];
  f: Formatter;
  currency: string;
  hidden?: { count: number; showing: boolean };
  reject?: RejectOptions | null;
}) {
  const h = MESSAGES.radar.hidden;
  const bf = MESSAGES.radar.briefFit;
  const cards: SignalCardData[] = signals.map((s) => {
    const fit = pillForFit(s.fitScore, f);
    const categoria = s.briefFit.wantedCategory?.trim() || null;
    return {
      id: s.id,
      companyName: s.companyName,
      headline: s.headlineEs,
      fit: fit
        ? categoria
          ? { ...fit, text: bf.fitWithCategory(fit.text, categoria), label: bf.fitWithCategoryLabel(fit.text, categoria) }
          : fit
        : null,
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
      hiddenReason: s.hiddenBy ? h.reason[s.hiddenBy]((s.hiddenMatch ?? s.companyName ?? "").trim()) : null,
      fitNotes: [
        ...(s.briefFit.belowMinBudget ? [bf.belowMin] : []),
        ...(s.briefFit.countryOutside ? [bf.countryOutside] : []),
        ...(s.briefFit.categoryOutside ? [bf.categoryOutside] : []),
      ],
      // Una señal oculta ya no se acepta desde aquí, y una sin marca no tiene nada que excluir.
      canReject: reject !== null && s.hiddenBy === null && Boolean(s.companyName?.trim()),
      rejectWarning:
        s.openDealCount > 0
          ? MESSAGES.radar.reject.openDeals(f.int(s.openDealCount), s.openDealCount, (s.companyName ?? "").trim())
          : null,
    };
  });
  const line: HiddenLine | null =
    hidden && hidden.count > 0
      ? {
          text: hidden.showing ? h.showing(f.int(hidden.count), hidden.count) : h.line(f.int(hidden.count), hidden.count),
          toggle: hidden.showing ? { href: "/ventas", label: h.hide } : { href: "/ventas?ocultas=1", label: h.show },
          brief: { href: "/ventas/brief", label: h.editBrief },
        }
      : null;
  return <Radar cards={cards} currency={currency} countries={countryOptions(f.locale)} hiddenLine={line} reject={reject} />;
}
