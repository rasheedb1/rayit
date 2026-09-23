/**
 * El precio que una cotización PROPONE al elegir un entregable del
 * tarifario (pulido r6).
 *
 * El rango del tarifario ya sale a tres cifras (`redondearParaNegociar`
 * de @mc/core), pero un tarifario guardado antes de ese redondeo trae
 * sus rangos al peso («COP 3.419.735»), y la marca leería una línea por
 * 3.419.735 como un número calculado, no como un precio. Aquí se aplica
 * la misma función a lo guardado: con un tarifario nuevo no cambia nada
 * (redondear lo redondeado lo deja igual) y con uno viejo la cotización
 * dice lo mismo que el tarifario, que siempre se recalcula en pantalla.
 *
 * Un precio que el creador escribió a mano (`overridden`) se respeta tal
 * cual: lo decidió él, y redondearlo sería cambiarle el número.
 */
import { redondearParaNegociar, type Decimal } from "@mc/core";
import type { RateCardItem } from "@mc/db/queries/cotizar";

type Tarifa = Pick<RateCardItem, "priceLow" | "priceHigh" | "overridden">;

/** El rango con el que se propone el entregable, o null si el tarifario no le dio uno. */
export function rangoPropuesto(tarifa: Tarifa | undefined): { low: Decimal; high: Decimal } | null {
  if (!tarifa?.priceLow || !tarifa.priceHigh) return null;
  if (tarifa.overridden) return { low: tarifa.priceLow, high: tarifa.priceHigh };
  try {
    return { low: redondearParaNegociar(tarifa.priceLow), high: redondearParaNegociar(tarifa.priceHigh) };
  } catch {
    return { low: tarifa.priceLow, high: tarifa.priceHigh };
  }
}

/** El precio por unidad con el que arranca la línea: el extremo bajo del rango propuesto. */
export function precioPropuesto(tarifa: Tarifa | undefined): Decimal {
  return rangoPropuesto(tarifa)?.low ?? "0";
}
