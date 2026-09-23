/**
 * Ingresos de plataformas (FIN-7): la aritmética pura de lo que pagan
 * AdSense, Creator Rewards y los bonos, y de cómo se proyecta.
 *
 * POR QUÉ ESTÁ EN SU PROPIO ARCHIVO Y NO EN flujo-caja.ts
 * ------------------------------------------------------
 * `flujo-caja.ts` es de FIN-6 (`projectCashflow`: cobros esperados,
 * gastos recurrentes y reserva de impuestos por semana). Esto es la
 * entrada de «otros ingresos» a esa proyección, y es lo único de FIN-7
 * que es aritmética. Separarlos deja un único dueño por archivo y una
 * costura explícita: FIN-6 llama a `proyeccionDePlataformas()` y reparte
 * su `estimado` con `semanalDeMensual()`, que ya tiene.
 *
 * Nada de aquí toca la base ni la red, y el dinero NUNCA pasa por
 * `number`: entra string decimal, sale string decimal, y por dentro son
 * BigInt de centavos (`toCents`/`fromCents` de facturacion.ts).
 *
 * Los meses son strings 'YYYY-MM' y se comparan y se recorren como
 * strings, sin `Date`: un `new Date('2026-09')` se interpreta en UTC o
 * en la zona local según el motor, y un mes que cambia de sitio por la
 * zona horaria es un ingreso contado en el mes equivocado.
 */
import { fromCents, toCents, type Decimal } from './facturacion.ts';

/** Un mes 'YYYY-MM'. */
export type Mes = string;

const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const FECHA_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * Cuántos meses cerrados mira el promedio de «otros ingresos».
 *
 * Tres es lo que pide FIN-7: suficiente para que un mes flojo no mande
 * y corto para que un canal que está creciendo no arrastre cifras de
 * hace medio año. No es un número mágico suelto: se exporta, la
 * pantalla lo escribe en su frase («promedio de los últimos 3 meses») y
 * `proyeccionDePlataformas` lo devuelve en `ventana`.
 */
export const VENTANA_PROMEDIO_MESES = 3;

/** Un mes con su total ya sumado, en UNA sola moneda. */
export interface MesConIngreso {
  mes: Mes;
  /** Total del mes, string decimal. Nunca negativo en la práctica, pero no se asume. */
  monto: Decimal;
}

/**
 * 'YYYY-MM-DD' → 'YYYY-MM': el mes al que pertenece un periodo, por su
 * día de inicio. Lanza si la fecha no es una fecha ISO de solo día.
 *
 * El nombre lleva «DelPeriodo» y no es un `mesDe` a secas porque el
 * barril de @mc/core aplana todos los módulos en un solo espacio de
 * nombres, y `flujo-caja.ts` (FIN-6) tiene su propio `mesDe` para los
 * gastos.
 */
export function mesDelPeriodo(fechaIso: string): Mes {
  const s = fechaIso.trim();
  if (!FECHA_RE.test(s)) {
    throw new Error(`Fecha inválida: "${fechaIso}". Se espera 'YYYY-MM-DD'.`);
  }
  return s.slice(0, 7);
}

/** El mes `n` meses antes (o después, con n negativo). `mesDesplazado('2026-01', -1)` → '2025-12'. */
export function mesDesplazado(mes: Mes, n: number): Mes {
  if (!MES_RE.test(mes.trim())) {
    throw new Error(`Mes inválido: "${mes}". Se espera 'YYYY-MM'.`);
  }
  const [a, m] = mes.trim().split('-');
  // Meses absolutos desde el año 0: así el desplazamiento es una suma y
  // no hay que pensar en el cambio de año.
  const total = Number(a) * 12 + (Number(m) - 1) + n;
  const anio = Math.floor(total / 12);
  const indice = total - anio * 12;
  return `${String(anio).padStart(4, '0')}-${String(indice + 1).padStart(2, '0')}`;
}

/**
 * El último mes CERRADO visto desde `hoy`: el anterior al de hoy.
 *
 * El mes en curso no entra en el promedio porque está a medias: el día
 * 3 de octubre, «lo que va de octubre» son dos días, y meterlo en la
 * media hundiría el estimado justo al empezar el mes.
 */
export function ultimoMesCerrado(hoyIso: string): Mes {
  return mesDesplazado(mesDelPeriodo(hoyIso), -1);
}

const DIAS_POR_MES = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** El último día de ese mes, con la regla bisiesta completa y sin `Date`. */
export function ultimoDiaDelMes(anio: number, mes: number): number {
  if (mes < 1 || mes > 12) throw new Error(`Mes inválido: ${mes}. Se espera un número entre 1 y 12.`);
  if (mes !== 2) return DIAS_POR_MES[mes - 1]!;
  return (anio % 4 === 0 && anio % 100 !== 0) || anio % 400 === 0 ? 29 : 28;
}

/**
 * ¿Ese periodo es un mes entero? Lo es cuando empieza el día 1 y termina
 * el último del mismo mes. La lista de ingresos lo usa para decidir si
 * hace falta enseñar el periodo exacto: en un pago mensual —que es la
 * norma— el mes ya lo dice todo, y repetirlo ocupa una columna que a
 * 390 px se come la cifra.
 */
export function esMesEntero(periodStart: string, periodEnd: string): boolean {
  const mes = mesDelPeriodo(periodStart);
  if (mesDelPeriodo(periodEnd) !== mes) return false;
  const ultimo = ultimoDiaDelMes(+mes.slice(0, 4), +mes.slice(5, 7));
  return periodStart.endsWith('-01') && periodEnd.endsWith(`-${String(ultimo).padStart(2, '0')}`);
}

/** Los `meses` meses consecutivos que terminan en `hasta`, del más viejo al más nuevo. */
export function ventanaDeMeses(hasta: Mes, meses: number): Mes[] {
  if (!Number.isInteger(meses) || meses < 1) {
    throw new Error(`Ventana inválida: ${meses}. Se espera un entero mayor que cero.`);
  }
  return Array.from({ length: meses }, (_, i) => mesDesplazado(hasta, i - (meses - 1)));
}

/** División de centavos con redondeo mitad hacia arriba. `divisor` > 0. */
function dividirCentavos(total: bigint, divisor: number): bigint {
  const d = BigInt(divisor);
  const negativo = total < 0n;
  const abs = negativo ? -total : total;
  const redondeado = (abs * 2n + d) / (d * 2n);
  return negativo ? -redondeado : redondeado;
}

export interface PromedioMensual {
  /** El promedio, o null si la ventana no tiene NI UN mes con datos. Nunca "0". */
  estimado: Decimal | null;
  /** Cuántos meses de la ventana traían un total. */
  mesesConDatos: number;
  /** Entre cuántos meses se dividió (ver la nota de `promedioMensual`). */
  mesesPromediados: number;
  /** El primer mes que entró en la división, o null si no entró ninguno. */
  desde: Mes | null;
  /** El último mes de la ventana: el último mes cerrado. */
  hasta: Mes;
  /** Lo que sumaron los meses con datos, o null si no había ninguno. */
  total: Decimal | null;
}

/**
 * El promedio mensual de una serie, sobre los últimos `ventana` meses
 * CERRADOS.
 *
 * Dos decisiones que no son obvias, las dos en docs/propuestas/FIN-7.md §0.5:
 *
 *   1. **Sin ningún mes con datos, el resultado es `null`, no "0.00"**.
 *      Un espacio que todavía no ha cargado nada no gana cero al mes:
 *      no lo sabemos, y la pantalla tiene que decir eso con una frase.
 *   2. **Un mes SIN pago dentro de la ventana cuenta como cero, pero
 *      solo a partir del primer mes con datos.** Un pago de plataforma
 *      es mensual y completo: si AdSense no pagó en agosto, agosto fue
 *      cero de verdad, y promediar solo los meses buenos inflaría el
 *      estimado. Pero los meses ANTERIORES al primer dato no son ceros,
 *      son meses de los que no hay medición —el creador acababa de
 *      empezar a cargar—, y dividir entre ellos hundiría el estimado sin
 *      motivo. Por eso la división empieza en `desde` y no en el inicio
 *      de la ventana, y `mesesPromediados` deja ver entre cuántos se
 *      dividió.
 *
 * Los meses repetidos en la entrada se suman; los de fuera de la
 * ventana se ignoran.
 */
export function promedioMensual(
  meses: readonly MesConIngreso[],
  opts: { hoy: string; ventana?: number },
): PromedioMensual {
  const ventana = opts.ventana ?? VENTANA_PROMEDIO_MESES;
  const hasta = ultimoMesCerrado(opts.hoy);
  const dentro = new Set(ventanaDeMeses(hasta, ventana));

  const porMes = new Map<Mes, bigint>();
  for (const fila of meses) {
    if (!dentro.has(fila.mes)) continue;
    porMes.set(fila.mes, (porMes.get(fila.mes) ?? 0n) + toCents(fila.monto));
  }
  if (porMes.size === 0) {
    return { estimado: null, mesesConDatos: 0, mesesPromediados: 0, desde: null, hasta, total: null };
  }

  const desde = [...porMes.keys()].sort()[0]!;
  // Del primer mes con datos hasta el final de la ventana, ambos
  // incluidos: los meses sin pago de ese tramo cuentan como cero.
  const mesesPromediados = ventanaDeMeses(hasta, ventana).filter((m) => m >= desde).length;
  let total = 0n;
  for (const centavos of porMes.values()) total += centavos;

  return {
    estimado: fromCents(dividirCentavos(total, mesesPromediados)),
    mesesConDatos: porMes.size,
    mesesPromediados,
    desde,
    hasta,
    total: fromCents(total),
  };
}

/**
 * La entrada de los ingresos de plataformas al flujo de caja.
 *
 * Devuelve DATOS, no frases: `base` es un código y la pantalla lo
 * traduce con su messages.ts («estimado por promedio de los últimos 3
 * meses»). @mc/core no escribe texto de interfaz, igual que @mc/db.
 */
export interface ProyeccionDePlataformas extends PromedioMensual {
  /** La moneda de la serie: la del espacio. Los pagos en otra no entran. */
  currency: string;
  /** De dónde sale la cifra. Hoy solo hay una base; `source: 'api'` (fase 2) no la cambia. */
  base: 'promedio_meses';
  /** Cuántos meses cerrados se miraron. */
  ventana: number;
}

/**
 * Lo que FIN-6 pondrá en la fila «ingresos de plataformas (estimado)».
 *
 *   const p = proyeccionDePlataformas(meses, { hoy, currency: ws.currency });
 *   p.estimado === null  // → la fila dice que todavía no hay con qué estimar
 */
export function proyeccionDePlataformas(
  meses: readonly MesConIngreso[],
  opts: { hoy: string; currency: string; ventana?: number },
): ProyeccionDePlataformas {
  const ventana = opts.ventana ?? VENTANA_PROMEDIO_MESES;
  return {
    ...promedioMensual(meses, { hoy: opts.hoy, ventana }),
    currency: opts.currency,
    base: 'promedio_meses',
    ventana,
  };
}
