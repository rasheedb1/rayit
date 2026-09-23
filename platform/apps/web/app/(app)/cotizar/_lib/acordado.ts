/**
 * «Lo acordado» de una cotización en palabras: las mismas líneas en el
 * detalle del panel, en la vista previa y en la página que abre la
 * marca. Recibe el formateador del workspace (o el del snapshot): aquí
 * no se formatea a mano.
 */
import type { Formatter } from "@/lib/format";
import { MESSAGES, nombreMetrica } from "../messages";

export interface Acordado {
  metrics: readonly string[];
  cutsHours: readonly number[];
  usageRightsDays: number | null;
  exclusivityDays: number | null;
  exclusivityScope: string | null;
  paymentTermsDays: number;
  campaignStartsOn: string | null;
  campaignEndsOn: string | null;
}

export function lineasAcordado(a: Acordado, f: Pick<Formatter, "dateRange">): { termino: string; valor: string }[] {
  const t = MESSAGES.detalle;
  return [
    { termino: t.metricas, valor: a.metrics.length > 0 ? a.metrics.map(nombreMetrica).join(" · ") : t.sinAcordar },
    { termino: t.cortes, valor: a.cutsHours.length > 0 ? a.cutsHours.map((h) => t.horas(h)).join(" · ") : t.sinAcordar },
    { termino: t.derechos, valor: a.usageRightsDays === null ? t.noAplica : t.dias(a.usageRightsDays) },
    {
      termino: t.exclusividad,
      valor:
        a.exclusivityDays === null
          ? t.noAplica
          : `${t.dias(a.exclusivityDays)}${a.exclusivityScope ? ` · ${a.exclusivityScope}` : ""}`,
    },
    { termino: t.pago, valor: t.dias(a.paymentTermsDays) },
    {
      termino: t.ventana,
      valor: a.campaignStartsOn && a.campaignEndsOn ? f.dateRange(a.campaignStartsOn, a.campaignEndsOn) : t.sinAcordar,
    },
  ];
}

/**
 * La etiqueta del impuesto con su tasa: «Impuesto (19 %)», «Impuesto
 * (19,5 %)». Sin tasa guardada (cotizaciones anteriores a 0023), solo
 * «Impuesto».
 */
export function etiquetaImpuesto(taxRate: string | null | undefined, f: Pick<Formatter, "pct">): string {
  const t = MESSAGES.publico.cotizacion;
  if (!taxRate) return t.impuesto;
  const decimales = Math.max(0, (taxRate.split(".")[1]?.length ?? 0) - 2);
  return t.impuestoConTasa(f.pct(Number(taxRate), decimales));
}
