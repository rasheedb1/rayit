/**
 * Gastos (FIN-5): las listas cerradas que el formulario escribe y la
 * aritmética de meses que la pantalla necesita para moverse entre meses.
 *
 * La PROYECCIÓN de los recurrentes no vive aquí: es `proyectarGastos`,
 * en flujo-caja.ts, la misma que usa el flujo de caja (FIN-6). Al
 * integrar el módulo se borró el proyector propio de FIN-5, que fechaba
 * cada ocurrencia, para que la vista de gastos y /finanzas/flujo no
 * pudieran decir dos cifras distintas de la misma semana.
 *
 * Decisiones (detalle en docs/propuestas/FIN-5.md §0.2):
 *   - Las categorías y las recurrencias son listas CERRADAS aquí, y zod
 *     las valida en el formulario. La columna `expense.category` sigue
 *     siendo texto libre (0008): la lista cierra lo que el formulario
 *     escribe, no lo que la base admite, así que leer nunca valida y
 *     una categoría desconocida se muestra tal cual en vez de romper la
 *     pantalla.
 */
import { isIsoDate } from './campanas.ts';

// ---------------------------------------------------------------------
// Categorías y recurrencias
// ---------------------------------------------------------------------

export interface OpcionGasto<T extends string> {
  id: T;
  labelEs: string;
}

/**
 * Las seis del seed 0003 §7 más `otros`. Una lista cerrada sin salida
 * obliga a mentir en el primer gasto que no encaje; `otros` es esa
 * salida, y la descripción dice de qué se trata.
 *
 * Es una tupla no vacía (`as const`) para que entre a `z.enum` en el
 * formulario sin forzar el tipo, como PLATFORMS en Resumen.
 */
export const CATEGORIA_GASTO_IDS = ['edicion', 'software', 'equipo', 'contabilidad', 'servicios', 'viajes', 'otros'] as const;

export type CategoriaGasto = (typeof CATEGORIA_GASTO_IDS)[number];

/** Record, no array de pares: si mañana falta una etiqueta, no compila. */
const CATEGORIA_GASTO_LABEL: Record<CategoriaGasto, string> = {
  edicion: 'Edición',
  software: 'Software y suscripciones',
  equipo: 'Equipo y estudio',
  contabilidad: 'Contabilidad',
  servicios: 'Servicios',
  viajes: 'Viajes',
  otros: 'Otros',
};

export const CATEGORIAS_GASTO: readonly OpcionGasto<CategoriaGasto>[] = CATEGORIA_GASTO_IDS.map((id) => ({
  id,
  labelEs: CATEGORIA_GASTO_LABEL[id],
}));

/**
 * En el MVP solo hay gastos mensuales: es lo que tiene el seed y lo
 * único que el formulario ofrece. `'weekly'` y `'yearly'` caben en la
 * columna (`expense.recurrence` es texto) y entrarían aquí con su
 * aritmética en `proyectarGastos` (flujo-caja.ts); hasta que
 * alguien las pida, una fila con otra recurrencia NO se proyecta y la
 * pantalla lo dice con una frase.
 */
export const RECURRENCIA_IDS = ['monthly'] as const;

export type Recurrencia = (typeof RECURRENCIA_IDS)[number];

const RECURRENCIA_LABEL: Record<Recurrencia, string> = { monthly: 'Cada mes' };

export const RECURRENCIAS: readonly OpcionGasto<Recurrencia>[] = RECURRENCIA_IDS.map((id) => ({
  id,
  labelEs: RECURRENCIA_LABEL[id],
}));

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
// Meses
// ---------------------------------------------------------------------

function assertIsoDate(value: string, name: string): void {
  if (!isIsoDate(value)) throw new Error(`${name} debe ser una fecha YYYY-MM-DD real, no "${value}".`);
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
