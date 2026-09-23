import { compareDecimal } from "@mc/core";
import type { Formatter } from "@/lib/format";
import { MESSAGES } from "../messages";

export interface Totales {
  subtotal: string;
  discount: string;
  tax: string;
  total: string;
}

/**
 * Subtotal, descuento, impuesto y total: el mismo bloque en el
 * formulario, en el detalle del panel y en la página que abre la marca.
 * Sin hooks, así que sirve igual en un componente de servidor que en
 * uno de cliente. `totales` null pinta guiones (el formulario a medio
 * escribir). Un descuento de cero no se pinta: «−COP 0» es ruido en un
 * documento para una marca (la factura alojada de Stripe tampoco lo
 * enseña).
 */
export function ResumenTotales({
  totales,
  currency,
  f,
  etiquetaImpuesto,
  destacarTotal = true,
}: {
  totales: Totales | null;
  currency: string;
  f: Pick<Formatter, "money">;
  etiquetaImpuesto: string;
  destacarTotal?: boolean;
}) {
  const t = MESSAGES.publico.cotizacion;
  const dinero = (v: string) => f.money(v, currency, { mode: "full" });
  const sinDescuento = totales !== null && compareDecimal(totales.discount, "0") === 0;
  const filas = [
    { termino: t.subtotal, valor: totales ? dinero(totales.subtotal) : "—" },
    ...(sinDescuento ? [] : [{ termino: t.descuento, valor: totales ? `−${dinero(totales.discount)}` : "—" }]),
    { termino: etiquetaImpuesto, valor: totales ? dinero(totales.tax) : "—" },
  ];
  return (
    <dl className="space-y-1.5 text-sm">
      {filas.map((fila) => (
        <div key={fila.termino} className="flex justify-between gap-3">
          <dt className="text-ink-2">{fila.termino}</dt>
          <dd className="font-mono tabular-nums">{fila.valor}</dd>
        </div>
      ))}
      <div className={`flex justify-between gap-3 border-t border-border pt-2 ${destacarTotal ? "text-base" : ""}`}>
        <dt className="font-medium">{t.total}</dt>
        <dd className="font-mono font-medium tabular-nums">{totales ? dinero(totales.total) : "—"}</dd>
      </div>
    </dl>
  );
}
