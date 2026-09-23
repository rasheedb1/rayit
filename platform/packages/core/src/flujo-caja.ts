/**
 * Flujo de caja: la lógica pura del dinero que sale y del que entra.
 *
 * FIN-5 trae la primera pieza —la proyección de los gastos
 * recurrentes— y FIN-6 la completa con los cobros esperados y la
 * reserva de impuestos, semana a semana. Nada de aquí toca la base ni
 * la red: entran filas ya leídas y strings decimales, salen strings
 * decimales. El dinero nunca pasa por `number` (ver facturacion.ts).
 *
 * Decisiones (detalle en docs/propuestas/FIN-5.md §0.2):
 *   - Las categorías y las recurrencias son listas CERRADAS aquí, y zod
 *     las valida en el formulario. La columna `expense.category` sigue
 *     siendo texto libre (0008): la lista cierra lo que el formulario
 *     escribe, no lo que la base admite, así que leer nunca valida y
 *     una categoría desconocida se muestra tal cual en vez de romper la
 *     pantalla.
 *   - Un gasto recurrente es una PLANTILLA: la fila se repite el mismo
 *     día de cada mes SIGUIENTE, y no se materializa ninguna fila
 *     futura. El día 31 cae al último día del mes que no lo tiene, y
 *     siempre se cuenta desde la fecha original (31-ene + 2 meses =
 *     31-mar, no 28-feb + 1 mes).
 *   - La misma suscripción registrada en julio, agosto y septiembre son
 *     TRES filas de UNA serie; proyectar las tres triplicaría el gasto.
 *     Como `expense` no tiene columna de serie, la serie se deduce de
 *     (categoría, proveedor, recurrencia, moneda) y se proyecta la fila
 *     más reciente. Ver `seriesDeGastosRecurrentes`.
 */
import { addDays, daysBetween, fromCents, toCents, type Decimal } from './facturacion.ts';
import { isIsoDate } from './campanas.ts';

// ---------------------------------------------------------------------
// Categorías y recurrencias
// ---------------------------------------------------------------------

export type CategoriaGasto = 'edicion' | 'software' | 'equipo' | 'contabilidad' | 'servicios' | 'viajes' | 'otros';

export interface OpcionGasto<T extends string> {
  id: T;
  labelEs: string;
}

/**
 * Las seis del seed 0003 §7 más `otros`. Una lista cerrada sin salida
 * obliga a mentir en el primer gasto que no encaje; `otros` es esa
 * salida, y la descripción dice de qué se trata.
 */
export const CATEGORIAS_GASTO: readonly OpcionGasto<CategoriaGasto>[] = [
  { id: 'edicion', labelEs: 'Edición' },
  { id: 'software', labelEs: 'Software y suscripciones' },
  { id: 'equipo', labelEs: 'Equipo y estudio' },
  { id: 'contabilidad', labelEs: 'Contabilidad' },
  { id: 'servicios', labelEs: 'Servicios' },
  { id: 'viajes', labelEs: 'Viajes' },
  { id: 'otros', labelEs: 'Otros' },
] as const;

export const CATEGORIA_GASTO_IDS: readonly CategoriaGasto[] = CATEGORIAS_GASTO.map((c) => c.id);

/**
 * En el MVP solo hay gastos mensuales: es lo que tiene el seed y lo
 * único que el formulario ofrece. `'weekly'` y `'yearly'` caben en la
 * columna (`expense.recurrence` es texto) y entrarían aquí con su
 * aritmética en `sumarMeses`/`proyectarGastosRecurrentes`; hasta que
 * alguien las pida, una fila con otra recurrencia NO se proyecta y la
 * pantalla lo dice con una frase.
 */
export type Recurrencia = 'monthly';

export const RECURRENCIAS: readonly OpcionGasto<Recurrencia>[] = [{ id: 'monthly', labelEs: 'Cada mes' }] as const;

export const RECURRENCIA_IDS: readonly Recurrencia[] = RECURRENCIAS.map((r) => r.id);

/** La etiqueta en español de una categoría, o el valor crudo si no está en la lista. */
export function labelCategoria(id: string): string {
  return CATEGORIAS_GASTO.find((c) => c.id === id)?.labelEs ?? id;
}

/** La etiqueta en español de una recurrencia, o el valor crudo si no está en la lista. */
export function labelRecurrencia(id: string): string {
  return RECURRENCIAS.find((r) => r.id === id)?.labelEs ?? id;
}

export function esCategoriaGasto(value: string): value is CategoriaGasto {
  return (CATEGORIA_GASTO_IDS as readonly string[]).includes(value);
}

export function esRecurrencia(value: string): value is Recurrencia {
  return (RECURRENCIA_IDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------

function assertIsoDate(value: string, name: string): void {
  if (!isIsoDate(value)) throw new Error(`${name} debe ser una fecha YYYY-MM-DD real, no "${value}".`);
}

/** El lunes de la semana de `iso` (la semana ISO empieza en lunes). */
export function lunesDe(iso: string): string {
  assertIsoDate(iso, 'iso');
  const d = new Date(`${iso}T00:00:00Z`);
  // getUTCDay: 0 domingo … 6 sábado. El lunes está (día + 6) % 7 días atrás.
  return addDays(iso, -((d.getUTCDay() + 6) % 7));
}

/**
 * Suma meses a una fecha 'YYYY-MM-DD' contando SIEMPRE desde ella: si el
 * día no existe en el mes destino, cae al último (31-ene + 1 = 28-feb;
 * 31-ene + 2 = 31-mar). Es el calendario de una domiciliación bancaria.
 */
export function sumarMeses(iso: string, meses: number): string {
  assertIsoDate(iso, 'iso');
  if (!Number.isInteger(meses)) throw new Error(`Los meses deben ser un entero, no ${meses}.`);
  // Son componentes de una fecha de formato controlado, no dinero.
  const year = Number(iso.slice(0, 4));
  const monthIndex = Number(iso.slice(5, 7)) - 1;
  const day = Number(iso.slice(8, 10));
  const total = year * 12 + monthIndex + meses;
  const y = Math.floor(total / 12);
  const m = total - y * 12;
  // Día 0 del mes siguiente = último día del mes destino.
  const ultimoDia = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const d = Math.min(day, ultimoDia);
  return `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Meses completos de calendario entre dos fechas (b − a), ignorando el día. */
function mesesEntre(a: string, b: string): number {
  return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));
}

/** El primer día del mes 'YYYY-MM' o de la fecha 'YYYY-MM-DD'. */
export function primerDiaDelMes(mes: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(mes);
  if (!m) throw new Error(`El mes debe ser YYYY-MM, no "${mes}".`);
  const iso = `${m[1]}-${m[2]}-01`;
  assertIsoDate(iso, 'mes');
  return iso;
}

/** El último día del mes 'YYYY-MM' o de la fecha 'YYYY-MM-DD'. */
export function ultimoDiaDelMes(mes: string): string {
  return addDays(sumarMeses(primerDiaDelMes(mes), 1), -1);
}

// ---------------------------------------------------------------------
// Proyección de gastos recurrentes
// ---------------------------------------------------------------------

/** Lo que la proyección necesita de un gasto. Es un subconjunto de la fila de `expense`. */
export interface GastoRecurrente {
  id: string;
  category: string;
  vendor: string | null;
  description: string | null;
  /** Decimal como string, la moneda va aparte. */
  amount: Decimal;
  currency: string;
  /** 'YYYY-MM-DD': la fecha de la plantilla, no la de la próxima vez. */
  incurredOn: string;
  /** 'monthly' en el MVP; cualquier otra no se proyecta. */
  recurrence: string;
}

export interface OcurrenciaProyectada {
  /** El id de la fila plantilla. La ocurrencia NO existe en la base. */
  expenseId: string;
  /** 'YYYY-MM-DD' */
  date: string;
  amount: Decimal;
  currency: string;
  category: string;
  vendor: string | null;
  description: string | null;
}

export interface SemanaProyectada {
  /** Lunes, 'YYYY-MM-DD'. */
  desde: string;
  /** Domingo, 'YYYY-MM-DD'. */
  hasta: string;
  /** Suma de las ocurrencias de la semana. '0.00' si no hay ninguna. */
  total: Decimal;
  ocurrencias: OcurrenciaProyectada[];
}

export interface ProyeccionGastos {
  /** Lunes de la semana de `desde`. */
  desde: string;
  /** Domingo de la última semana. */
  hasta: string;
  /** La moneda de todos los gastos, o null si no hay ninguno que proyectar. */
  currency: string | null;
  /** Suma de todas las semanas. */
  total: Decimal;
  semanas: SemanaProyectada[];
}

/**
 * Se lanza si las filas que llegan mezclan monedas: sumarlas sin
 * convertir daría una cifra que no significa nada, y convertir necesita
 * una tabla de tasas que el MVP no tiene.
 */
export class GastosEnVariasMonedas extends Error {
  readonly currencies: readonly string[];
  readonly messageEs: string;
  constructor(currencies: readonly string[]) {
    const lista = [...currencies].sort().join(', ');
    super(`La proyección no puede mezclar monedas (${lista}): haría falta una tasa de cambio.`);
    this.name = 'GastosEnVariasMonedas';
    this.currencies = currencies;
    this.messageEs = this.message;
  }
}

/** Cuántas semanas proyecta la tarjeta de Finanzas y el flujo de caja de FIN-6. */
export const SEMANAS_PROYECCION = 8;

/** La clave con la que dos filas son «el mismo gasto de todos los meses». */
function claveDeSerie(g: GastoRecurrente): string {
  return [g.category, g.vendor ?? '', g.recurrence, g.currency.toUpperCase()].join('\u0000');
}

/**
 * De todas las filas recurrentes, UNA por serie: la más reciente.
 *
 * El seed tiene la misma suscripción registrada en julio, agosto y
 * septiembre, las tres con `is_recurring`. Son tres apuntes contables de
 * una sola obligación: proyectar las tres la triplicaría. La serie se
 * deduce de (categoría, proveedor, recurrencia, moneda) —el monto NO
 * entra en la clave: una suscripción que sube de precio sigue siendo la
 * misma, y se proyecta con el último monto— y se conserva la fila de
 * `incurred_on` mayor, con el `id` como desempate para que el resultado
 * no dependa del orden en que llegaron.
 *
 * Límite conocido: dos gastos recurrentes de verdad distintos con el
 * mismo proveedor, categoría y recurrencia se funden en uno. Se
 * resuelve con una columna `series_id` en `expense`, que es de FIN-6.
 */
export function seriesDeGastosRecurrentes(gastos: readonly GastoRecurrente[]): GastoRecurrente[] {
  const porSerie = new Map<string, GastoRecurrente>();
  for (const g of gastos) {
    if (!esRecurrencia(g.recurrence)) continue;
    const clave = claveDeSerie(g);
    const actual = porSerie.get(clave);
    if (!actual || g.incurredOn > actual.incurredOn || (g.incurredOn === actual.incurredOn && g.id > actual.id)) {
      porSerie.set(clave, g);
    }
  }
  return [...porSerie.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Las próximas `semanas` semanas de gastos recurrentes, una fila por
 * semana, empezando el LUNES de la semana de `desde`.
 *
 * Qué se cuenta: cada serie (ver `seriesDeGastosRecurrentes`) repetida
 * el mismo día de cada mes SIGUIENTE a su `incurred_on`. La ocurrencia
 * cero —la fila misma— no entra: ya está registrada, y contarla otra vez
 * la duplicaría cuando FIN-6 sume lo real con lo proyectado. Tampoco
 * entra nada anterior a `desde`: lo que ya pasó no es una proyección,
 * aunque caiga en la misma semana.
 *
 * Una semana sin gastos devuelve `'0.00'`: ahí el cero es verdad. Que no
 * haya NINGUNA serie es otra cosa, y lo dice `currency: null` para que
 * la pantalla lo explique con una frase en vez de pintar ocho ceros.
 *
 * @param gastos  Filas recurrentes del espacio, en UNA sola moneda.
 * @param desde   'YYYY-MM-DD'. Normalmente hoy, según la base.
 * @param semanas Cuántas semanas, 1 a 52. Por defecto ocho.
 */
export function proyectarGastosRecurrentes(
  gastos: readonly GastoRecurrente[],
  desde: string,
  semanas: number = SEMANAS_PROYECCION,
): ProyeccionGastos {
  assertIsoDate(desde, 'desde');
  if (!Number.isInteger(semanas) || semanas < 1 || semanas > 52) {
    throw new Error(`Las semanas de la proyección son un entero de 1 a 52, no ${semanas}.`);
  }

  const monedas = [...new Set(gastos.map((g) => g.currency.toUpperCase()))];
  if (monedas.length > 1) throw new GastosEnVariasMonedas(monedas);

  const series = seriesDeGastosRecurrentes(gastos);
  const inicio = lunesDe(desde);
  // Exclusivo: el lunes siguiente a la última semana.
  const fin = addDays(inicio, semanas * 7);

  const cubos: OcurrenciaProyectada[][] = Array.from({ length: semanas }, () => []);
  for (const serie of series) {
    assertIsoDate(serie.incurredOn, `incurredOn de ${serie.id}`);
    // Arrancar cerca de la ventana en vez de en k = 1: una plantilla de
    // hace tres años no cuesta tres años de iteraciones.
    let k = Math.max(1, mesesEntre(serie.incurredOn, inicio) - 1);
    for (;;) {
      const date = sumarMeses(serie.incurredOn, k);
      if (date >= fin) break;
      if (date >= desde) {
        const i = Math.floor(daysBetween(inicio, date) / 7);
        cubos[i]?.push({
          expenseId: serie.id,
          date,
          amount: serie.amount,
          currency: serie.currency.toUpperCase(),
          category: serie.category,
          vendor: serie.vendor,
          description: serie.description,
        });
      }
      k += 1;
    }
  }

  let totalCents = 0n;
  const semanasProyectadas: SemanaProyectada[] = cubos.map((ocurrencias, i) => {
    ocurrencias.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.expenseId < b.expenseId ? -1 : 1));
    const cents = ocurrencias.reduce((acc, o) => acc + toCents(o.amount), 0n);
    totalCents += cents;
    const semanaDesde = addDays(inicio, i * 7);
    return { desde: semanaDesde, hasta: addDays(semanaDesde, 6), total: fromCents(cents), ocurrencias };
  });

  return {
    desde: inicio,
    hasta: addDays(fin, -1),
    // Sin ninguna serie no hay moneda que declarar: la pantalla lo
    // explica con una frase en vez de pintar ocho ceros.
    currency: series.length > 0 ? (series[0]?.currency.toUpperCase() ?? null) : null,
    total: fromCents(totalCents),
    semanas: semanasProyectadas,
  };
}
