import type { InvoiceListRow } from "@mc/db";
import type { PillKind } from "@/components/ui/pill";

/**
 * La pastilla de una factura, con el criterio de la vista receivables:
 * al_dia → good, vence_pronto → warn, vencida → bad, pagada → neutral.
 * Borradores y anuladas también en neutral. El texto lleva los días
 * cuando venció, como en el mock ("Vencida 41 días").
 */
export function pillForInvoice(row: Pick<InvoiceListRow, "bucket" | "daysToDue" | "status">): { kind: PillKind; text: string } {
  const parcial = row.status === "partial" ? "Pago parcial · " : "";
  switch (row.bucket) {
    case "vencida":
      return { kind: "bad", text: `${parcial}Vencida ${-row.daysToDue} días` };
    case "vence_pronto":
      return { kind: "warn", text: `${parcial}Vence pronto` };
    case "al_dia":
      return { kind: "good", text: `${parcial}Al día` };
    case "pagada":
      return { kind: "neutral", text: "Pagada" };
    case "borrador":
      return { kind: "neutral", text: "Borrador" };
    case "anulada":
      return { kind: "neutral", text: "Anulada" };
  }
}

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
