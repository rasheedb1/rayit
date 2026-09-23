import type { InvoiceListRow, ReceivableBucket, ReceivableRow } from "@mc/db/queries/finanzas";
import type { PillKind } from "@/components/ui/pill";
import { MESSAGES } from "./messages";

/**
 * La pastilla de una factura, con el criterio de la vista receivables:
 * al_dia → good, vence_pronto → warn, vencida → bad, pagada → neutral.
 * Borradores y anuladas también en neutral. El texto lleva los días
 * cuando venció, como en el mock ("Vencida hace 41 días").
 *
 * Los textos son los mismos que los de la pantalla de cobro
 * (MESSAGES.cobros.pill): las dos vistas del módulo hablan de la misma
 * factura y no pueden llamarla de dos maneras. `daysToDue` es el número
 * de días que faltan, así que la mora es su negativo.
 */
export function pillForInvoice(row: Pick<InvoiceListRow, "bucket" | "daysToDue" | "status">): { kind: PillKind; text: string } {
  const t = MESSAGES.cobros.pill;
  const parcial = row.status === "partial" ? t.partial : "";
  switch (row.bucket) {
    case "vencida":
      return { kind: "bad", text: `${parcial}${t.overdue(-row.daysToDue)}` };
    case "vence_pronto":
      return { kind: "warn", text: `${parcial}${t.dueSoon(-row.daysToDue)}` };
    case "al_dia":
      return { kind: "good", text: `${parcial}${t.onTime}` };
    case "pagada":
      return { kind: "neutral", text: t.paid };
    case "borrador":
      return { kind: "neutral", text: "Borrador" };
    case "anulada":
      return { kind: "neutral", text: "Anulada" };
  }
}

/**
 * La pastilla de una fila de cuentas por cobrar. Es la misma que la de
 * la factura, con la mora de la vista (`daysOverdue`, positivo cuando ya
 * venció) en vez de los días que faltan.
 */
export function pillForReceivable(row: Pick<ReceivableRow, "bucket" | "daysOverdue" | "status">): { kind: PillKind; text: string } {
  return pillForInvoice({ bucket: row.bucket, daysToDue: -row.daysOverdue, status: row.status });
}

// ---------------------------------------------------------------------
// FIN-3 · el filtro de la pantalla de cobro (?bucket=)
// ---------------------------------------------------------------------

/**
 * Las opciones del Segmented de /finanzas. La primera —«Por cobrar»— es
 * la de por defecto y NO lleva parámetro en la URL: es la pantalla de
 * cobro entera, lo que suma el KPI de arriba. `bucket: null` es lo que
 * `listReceivables` entiende por «todo lo que sigue abierto».
 *
 * Los borradores y las anuladas no están aquí porque la vista
 * `receivables` los excluye: para eso está /finanzas/facturas.
 */
export const RECEIVABLE_FILTERS = {
  por_cobrar: { label: "Por cobrar", bucket: null },
  vencida: { label: "Vencidas", bucket: "vencida" },
  vence_pronto: { label: "Vence pronto", bucket: "vence_pronto" },
  al_dia: { label: "Al día", bucket: "al_dia" },
  pagada: { label: "Cobradas", bucket: "pagada" },
} as const satisfies Record<string, { label: string; bucket: ReceivableBucket | null }>;

export type ReceivableFilterKey = keyof typeof RECEIVABLE_FILTERS;

export const RECEIVABLE_FILTER_KEYS = Object.keys(RECEIVABLE_FILTERS) as ReceivableFilterKey[];

/** La llave que trae la URL, o la de por defecto si no es ninguna de las nuestras. */
export function receivableFilterKey(value: string | undefined): ReceivableFilterKey {
  return value && value in RECEIVABLE_FILTERS ? (value as ReceivableFilterKey) : "por_cobrar";
}

/**
 * La URL de un filtro, conservando la búsqueda. El filtro vive en la
 * URL para que se pueda compartir («mírate esto», con las vencidas ya
 * seleccionadas) y para que el botón de atrás lo deshaga.
 */
export function receivableHref(key: ReceivableFilterKey, q?: string | null): string {
  const sp = new URLSearchParams();
  if (key !== "por_cobrar") sp.set("bucket", key);
  if (q) sp.set("q", q);
  const qs = sp.toString();
  return qs ? `/finanzas?${qs}` : "/finanzas";
}

// ---------------------------------------------------------------------
// FIN-1 · el filtro del archivo de facturas (?estado=)
// ---------------------------------------------------------------------

/** Filtros de la lista: la llave va en ?estado= y se traduce a estados persistidos. */
export const LIST_FILTERS = {
  todas: { label: "Todas", statuses: undefined },
  por_cobrar: { label: "Por cobrar", statuses: ["sent", "partial", "overdue"] },
  pagadas: { label: "Pagadas", statuses: ["paid"] },
  borradores: { label: "Borradores", statuses: ["draft"] },
  anuladas: { label: "Anuladas", statuses: ["void"] },
} as const;

export type ListFilterKey = keyof typeof LIST_FILTERS;

export function filterKey(value: string | undefined): ListFilterKey {
  return value && value in LIST_FILTERS ? (value as ListFilterKey) : "todas";
}

/** La URL de un filtro del archivo. */
export function invoiceFilterHref(key: ListFilterKey): string {
  return key === "todas" ? "/finanzas/facturas" : `/finanzas/facturas?estado=${key}`;
}
