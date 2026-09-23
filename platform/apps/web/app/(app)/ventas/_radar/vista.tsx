import type { SignalRow } from "@mc/db/queries/ventas";
import type { Formatter } from "@/lib/format";
import { pillForFit } from "../_lib/estado";
import { Radar, type SignalCardData } from "./radar";

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
 */
export function RadarView({ signals, f, currency }: { signals: SignalRow[]; f: Formatter; currency: string }) {
  const cards: SignalCardData[] = signals.map((s) => ({
    id: s.id,
    companyName: s.companyName,
    headline: s.headlineEs,
    fit: pillForFit(s.fitScore, f),
    sourceLabel: s.sourceLabel,
    detectedText: f.date(s.detectedAt),
    budgetText: s.budgetEstimate ? f.money(s.budgetEstimate, s.budgetCurrency ?? undefined, { mode: "compact" }) : null,
    evidenceUrl: s.evidenceUrl,
    viaCsv: s.via === "csv",
  }));
  return <Radar cards={cards} currency={currency} />;
}
