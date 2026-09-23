/**
 * De la fila de la base al modelo que ve la pantalla, y de la proyección
 * de @mc/core a las barras del gráfico.
 *
 * Vive aparte porque el panel de la tabla y el formulario son
 * componentes de CLIENTE: el formateador del espacio (Intl, con su
 * locale y su zona) no cruza la frontera servidor → cliente, así que
 * aquí se formatea en el servidor y lo que viaja son strings. Es la misma
 * razón por la que `chart-utils` formatea por nombre.
 *
 * Nada de esto hace aritmética de dinero: los totales vienen del GROUP
 * BY de la consulta y la proyección, de la función pura de core.
 */
import { labelCategoria, labelRecurrencia, sumarMeses, type ProyeccionGastos } from "@mc/core";
import type { ExpenseCategoryTotal, ExpenseRow } from "@mc/db/queries/finanzas";
import { parseDecimal, type Formatter } from "@/lib/format";

/** El mes anterior y el siguiente de 'YYYY-MM', para los dos enlaces de la cabecera. */
export function mesesVecinos(mes: string): { anterior: string; siguiente: string } {
  const primero = `${mes}-01`;
  return { anterior: sumarMeses(primero, -1).slice(0, 7), siguiente: sumarMeses(primero, 1).slice(0, 7) };
}

/** Lo que el formulario necesita para volver a llenarse con el gasto que corrige. */
export interface GastoCrudo {
  category: string;
  vendor: string;
  description: string;
  /** Decimal como string; "" si no hubiera. */
  amount: string;
  incurredOn: string;
  isRecurring: boolean;
  recurrence: string;
  receiptUrl: string;
}

export interface GastoVista {
  id: string;
  /** Lo que se lee en grande: la descripción, o el proveedor, o la categoría. */
  concepto: string;
  /** Sin descripción ni proveedor: el concepto es un relleno y se pinta apagado. */
  conceptoEsRelleno: boolean;
  /** El proveedor, o la frase que explica que no hay. */
  proveedor: string;
  sinProveedor: boolean;
  categoria: string;
  fecha: string;
  monto: string;
  recurrente: boolean;
  /** "Cada mes", o null si es puntual. */
  recurrencia: string | null;
  deducible: boolean;
  receiptUrl: string | null;
  crudo: GastoCrudo;
}

/** Una fila de la tabla, ya formateada con el formateador del espacio. */
export function gastoVista(r: ExpenseRow, f: Formatter, textos: { sinProveedor: string; sinDescripcion: string }): GastoVista {
  const descripcion = r.description?.trim() ?? "";
  const proveedor = r.vendor?.trim() ?? "";
  const categoria = labelCategoria(r.category);
  // El concepto no se queda nunca en blanco ni en un guion: si no hay
  // descripción ni proveedor, la categoría dice al menos de qué es.
  const concepto = descripcion || proveedor || categoria;
  return {
    id: r.id,
    concepto,
    conceptoEsRelleno: descripcion === "" && proveedor === "",
    proveedor: proveedor || textos.sinProveedor,
    sinProveedor: proveedor === "",
    categoria,
    fecha: f.date(r.incurredOn),
    monto: f.money(r.amount, r.currency, { mode: "full" }),
    recurrente: r.isRecurring,
    recurrencia: r.isRecurring && r.recurrence ? labelRecurrencia(r.recurrence) : null,
    deducible: r.deductible,
    receiptUrl: r.receiptUrl,
    crudo: {
      category: r.category,
      vendor: proveedor,
      description: descripcion,
      amount: r.amount,
      incurredOn: r.incurredOn,
      isRecurring: r.isRecurring,
      recurrence: r.recurrence ?? "",
      receiptUrl: r.receiptUrl ?? "",
    },
  };
}

export interface CategoriaVista {
  category: string;
  label: string;
  total: string;
  count: number;
}

/** El desglose del GROUP BY, con la etiqueta en español y el monto formateado. */
export function categoriasVista(filas: readonly ExpenseCategoryTotal[], currency: string, f: Formatter): CategoriaVista[] {
  return filas.map((c) => ({
    category: c.category,
    label: labelCategoria(c.category),
    total: f.money(c.total, currency, { mode: "full" }),
    count: c.count,
  }));
}

export interface BarrasProyeccion {
  /** La categoría entera: lo que dice el tooltip y la tabla ("21–27/9"). */
  cats: string[];
  /** Lo corto que cabe bajo la barra a 400 px ("21/9"). */
  axisLabels: string[];
  data: number[];
}

/**
 * Las ocho barras. El gráfico dibuja con números, así que aquí —y solo
 * aquí— el decimal pasa por `parseDecimal`: es presentación, y el total
 * que se escribe en la nota sigue saliendo del string de core.
 */
export function barrasProyeccion(p: ProyeccionGastos, f: Formatter): BarrasProyeccion {
  return {
    cats: p.semanas.map((s) => f.dayMonthRange(s.desde, s.hasta)),
    axisLabels: p.semanas.map((s) => f.dayMonth(s.desde)),
    data: p.semanas.map((s) => parseDecimal(s.total)),
  };
}
