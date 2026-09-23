/**
 * Tarifas: el rango que se le cobra a una marca por un entregable, y la
 * explicación de cómo salió.
 *
 * Nada de aquí toca la base ni la red, y nada de aquí escribe texto de
 * interfaz: entran números y salen números, con una lista de PASOS
 * tipados que la pantalla traduce con su messages.ts. Es la misma regla
 * de facturacion.ts —el dinero es un string decimal, nunca un number— y
 * la misma razón: el rango que ve el creador mientras edita lo calcula
 * esta función en el navegador, y el que se guarda lo calcula esta
 * función en el servidor.
 *
 * La fórmula, en una línea:
 *
 *     precio = (views ÷ 1000) × CPM × cantidad × (1 + Σ modificadores)
 *
 * Por qué un RANGO y no un precio: el CPM de referencia
 * (niche_cpm_benchmark) es un rango de mercado por nicho, país y red.
 * Un precio único invita a que la marca lo negocie hacia abajo; un
 * rango dice dónde empieza la conversación y dónde termina. Es lo que
 * hacen los tarifarios de Passionfroot y los media kits de Beacons.
 *
 * Por qué los modificadores son un PORCENTAJE que se suma antes de
 * multiplicar: derechos de uso y exclusividad no son entregables
 * aparte, son condiciones sobre el mismo trabajo. Sumar los porcentajes
 * y multiplicar una vez (y no encadenar multiplicaciones) hace que el
 * orden en que se activan no cambie el resultado, que es lo que espera
 * cualquiera que los marque y los desmarque en la pantalla.
 *
 * Decisiones que se ven en la explicación, no en el código:
 *   - Las views son por PIEZA. Un paquete de tres historias multiplica
 *     por cantidad al final, no antes, para que el paso «base» se pueda
 *     leer como «lo que vale una».
 *   - El redondeo es mitad hacia arriba, una sola vez por paso, a la
 *     UNIDAD DE PRECIO de la moneda (`unidadDePrecio`): al peso en COP
 *     y CLP, al centavo en USD o EUR. Un tarifario en pesos con
 *     centavos («COP 7.013.344,50») parece un prototipo; ninguna
 *     referencia (Passionfroot, Stripe Quotes en COP) los muestra.
 *   - No se redondea a cifras «bonitas» (50.000, 100.000): un tarifario
 *     que redondea esconde que cambiar el CPM cambió el precio, y ese
 *     es justo el número que el creador está aprendiendo a mover.
 *
 * Lo que la fórmula del mock trae y esta NO: «× 1,15 por engagement
 * sobre la media» y «× 1,10 por audiencia 25 a 34»
 * (dashboard/creadores-mock.html). Se dejan fuera a propósito:
 *   - No hay en la base una referencia de engagement ni de audiencia por
 *     nicho y país contra la cual decir «sobre la media»
 *     (niche_cpm_benchmark solo trae CPM). Un 1,15 escrito aquí sería un
 *     número sin fuente, y este tarifario promete que cada paso del
 *     «Cómo se calcula» dice de dónde sale.
 *   - El engagement ya está, en parte, dentro de las views medianas: una
 *     pieza que engancha se ve más. Multiplicarlo otra vez lo cuenta dos
 *     veces.
 *   - Si el creador sabe que su audiencia vale más, la herramienta
 *     honesta ya existe: su propio CPM o un precio a mano, que quedan
 *     marcados («CPM propio», «editado») y se ven en la explicación.
 * Cuando exista una referencia de engagement por nicho, entra como un
 * Modificador más, con su paso y su fuente, sin tocar esta fórmula.
 */
import { type PlatformId } from './campanas.ts';
import {
  addDecimal, compareDecimal, fromCents, mulRateHalfUp, normalizeDecimal, subDecimal, toCents,
  type Decimal,
} from './facturacion.ts';

export type { PlatformId };

// ---------------------------------------------------------------------
// Vocabulario
// ---------------------------------------------------------------------

/** De dónde salieron las views promedio de un entregable. */
export type FuenteViews = 'baseline' | 'manual';

/**
 * Los modificadores del MVP, con su porcentaje por defecto. El id es lo
 * que se guarda en rate_card_item.adjustments y en la cotización; la
 * etiqueta en español vive en el messages.ts de la pantalla, porque es
 * texto de interfaz y este paquete no tiene idioma.
 */
export const MODIFICADORES_POR_DEFECTO = [
  { id: 'derechos_uso_30d', pct: '0.35' },
  { id: 'exclusividad_30d', pct: '0.50' },
  { id: 'uso_en_pauta_90d', pct: '0.60' },
  { id: 'entrega_express', pct: '0.25' },
] as const;

export type ModificadorId = (typeof MODIFICADORES_POR_DEFECTO)[number]['id'] | (string & {});

export interface Modificador {
  id: ModificadorId;
  /** Fracción, no porcentaje: '0.35' es +35 %. */
  pct: string;
}

/**
 * Lo que un modificador compromete en «Lo acordado» de la cotización.
 * Derechos de uso y exclusividad no son solo un recargo: son una
 * condición que la marca compra. Si el precio del tarifario ya los lleva
 * y la cotización dice «Exclusividad: no aplica», la marca paga un 50 %
 * por algo que el documento que firma le niega.
 *
 * Los otros dos (pauta pagada y entrega exprés) no tienen campo propio
 * en la cotización: la pantalla los nombra como «incluye», nada más.
 */
export const TERMINOS_DE_MODIFICADOR: Readonly<Record<string, { campo: 'usageRightsDays' | 'exclusivityDays'; dias: number }>> = {
  derechos_uso_30d: { campo: 'usageRightsDays', dias: 30 },
  exclusividad_30d: { campo: 'exclusivityDays', dias: 30 },
};

export interface TerminosIncluidos {
  /** Días de derechos de uso que el precio ya incluye, o null si ninguno. */
  usageRightsDays: number | null;
  /** Días de exclusividad que el precio ya incluye, o null si ninguno. */
  exclusivityDays: number | null;
}

/**
 * Los días de derechos y de exclusividad que un conjunto de modificadores
 * ya cobra. Con varios que tocan el mismo campo, gana el más largo: es lo
 * que la marca pagó.
 */
export function terminosDeModificadores(ids: readonly string[]): TerminosIncluidos {
  const out: TerminosIncluidos = { usageRightsDays: null, exclusivityDays: null };
  for (const id of ids) {
    const t = TERMINOS_DE_MODIFICADOR[id];
    if (!t) continue;
    out[t.campo] = Math.max(out[t.campo] ?? 0, t.dias);
  }
  return out;
}

/**
 * Sube un plazo acordado hasta lo que el precio ya incluye, sin bajarlo
 * nunca: si el creador acordó 60 días de exclusividad, un entregable que
 * incluye 30 no los recorta. null (no acordado) cuenta como 0.
 */
export function plazoConIncluido(acordado: number | null, incluido: number | null): number | null {
  if (incluido === null) return acordado;
  return Math.max(acordado ?? 0, incluido);
}

/**
 * Un entregable del tarifario, tal como entra al cálculo. Las views son
 * por pieza y ya vienen resueltas (línea base o a mano): quién las
 * eligió es cosa de la consulta, no de la fórmula.
 */
export interface EntradaTarifa {
  /** 'tiktok' | 'reel' | 'historias' | 'youtube' | … Es el id del entregable, no el de la red. */
  deliverable: string;
  platformId: PlatformId;
  /** Cuántas piezas incluye (3 historias). Entero ≥ 1. */
  cantidad: number;
  /** Views promedio de UNA pieza. Entero ≥ 0. */
  views: number;
  viewsSource: FuenteViews;
  /** Con cuántos videos se calculó la mediana, si vino de la línea base. */
  viewsSample?: number;
  /** A qué edad se midió la mediana (24, 72, 168, 720). */
  viewsCutHours?: number;
  /** CPM de referencia del nicho, país y red. Decimales, no number. */
  cpmLow: Decimal;
  cpmHigh: Decimal;
  /** 'manual' | 'deals' | 'informe-externo': de dónde salió el CPM. */
  cpmSource: string;
  nicheSlug: string;
  /** ISO-3166 alfa-2, del workspace. */
  country: string;
  /** Los modificadores activos para ESTE entregable. */
  modificadores?: readonly Modificador[];
  /** Descuento del paquete, como fracción ('0.10' es −10 %). */
  descuentoPct?: string;
  /** ISO-4217. Decide la unidad a la que se redondea (`unidadDePrecio`). Sin ella, al centavo. */
  currency?: string;
}

/**
 * Un paso del «Cómo se calcula», al estilo del desglose de comisiones
 * de Stripe: cada línea trae el número y de dónde salió, y la pantalla
 * le pone las palabras.
 */
export type PasoCalculo =
  | { tipo: 'views'; views: number; cantidad: number; fuente: FuenteViews; muestra?: number; corteHoras?: number }
  | { tipo: 'cpm'; cpmLow: Decimal; cpmHigh: Decimal; fuente: string; nicheSlug: string; country: string; platformId: PlatformId }
  | { tipo: 'base'; low: Decimal; high: Decimal }
  | { tipo: 'cantidad'; cantidad: number; low: Decimal; high: Decimal }
  | { tipo: 'modificador'; id: ModificadorId; pct: string; low: Decimal; high: Decimal }
  | { tipo: 'descuento'; pct: string; low: Decimal; high: Decimal }
  | { tipo: 'componente'; deliverable: string; cantidad: number; low: Decimal; high: Decimal }
  | { tipo: 'subtotal'; low: Decimal; high: Decimal }
  | { tipo: 'total'; low: Decimal; high: Decimal };

export interface ItemTarifa {
  deliverable: string;
  platformId: PlatformId;
  cantidad: number;
  views: number;
  viewsSource: FuenteViews;
  cpmLow: Decimal;
  cpmHigh: Decimal;
  /** Suma de los porcentajes aplicados, como fracción ('0.85'). */
  modificadorTotalPct: string;
  priceLow: Decimal;
  priceHigh: Decimal;
  /** El desglose completo, en el orden en que se lee. */
  pasos: PasoCalculo[];
}

export class TarifaError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TarifaError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------
// La fórmula
// ---------------------------------------------------------------------

const FRACCION_RE = /^\d+(\.\d{1,6})?$/;

/**
 * Monedas que en la práctica no se cotizan con centavos, aunque ISO-4217
 * les dé dos decimales (COP) o ninguno (CLP, JPY). Es una tabla y no
 * `Intl…resolvedOptions().maximumFractionDigits` porque Intl dice 2 para
 * el peso colombiano, y nadie le cobra 50 centavos a una marca.
 */
const MONEDAS_SIN_CENTAVOS = new Set(['CLP', 'COP', 'HUF', 'ISK', 'JPY', 'KRW', 'PYG', 'UGX', 'VND', 'XAF', 'XOF']);

/** La unidad mínima de un precio de tarifario: '1' (al peso) o '0.01' (al centavo). */
export function unidadDePrecio(currency: string | undefined): Decimal {
  return currency && MONEDAS_SIN_CENTAVOS.has(currency.trim().toUpperCase()) ? '1.00' : '0.01';
}

/** Redondea un monto ≥ 0 al múltiplo más cercano de `unidad`, mitad hacia arriba. */
export function redondearAUnidad(valor: Decimal, unidad: Decimal): Decimal {
  const u = toCents(unidad);
  if (u <= 1n) return normalizeDecimal(valor);
  const c = toCents(valor);
  if (c < 0n) throw new TarifaError('MontoNegativo', `No se redondea un monto negativo: "${valor}".`);
  return fromCents(((c + u / 2n) / u) * u);
}

/**
 * Por qué un rango escrito a mano no vale, o null si vale.
 *
 *   'vacio'      falta uno de los dos extremos
 *   'no_numero'  alguno no es un decimal (o es negativo)
 *   'invertido'  el bajo es mayor que el alto
 *   'cero'       el alto es cero: un rango «0 – 0» no es una tarifa
 *
 * Es UNA regla para las tres capas —la tabla del tarifario mientras se
 * escribe, la Server Action que guarda y saveRateCard en @mc/db—, así
 * que un rango invertido no puede pasar por ninguna, y el CHECK de la
 * migración 0030 es la última red. El CPM invertido tiene su propio
 * motivo en la pantalla (la fila no se calcula); este es el del precio.
 */
export type RangoInvalido = 'vacio' | 'no_numero' | 'invertido' | 'cero';

const RANGO_RE = /^\d+(\.\d{1,2})?$/;

export function validarRangoPrecio(low: string | null | undefined, high: string | null | undefined): RangoInvalido | null {
  const l = (low ?? '').trim();
  const h = (high ?? '').trim();
  if (l === '' || h === '') return 'vacio';
  if (!RANGO_RE.test(l) || !RANGO_RE.test(h)) return 'no_numero';
  if (compareDecimal(l, h) > 0) return 'invertido';
  if (toCents(h) === 0n) return 'cero';
  return null;
}

/**
 * (views ÷ 1000) × cpm, al centavo y mitad hacia arriba.
 *
 * No se divide primero: `views × cpm` en centavos y luego ÷ 1000 con
 * redondeo, para que 999 views por un CPM de 45.000 den 44.955 y no
 * cero coma algo convertido en ruido.
 */
export function precioPorViews(cpm: Decimal, views: number): Decimal {
  if (!Number.isInteger(views) || views < 0) {
    throw new TarifaError('ViewsInvalidas', `Las views tienen que ser un entero ≥ 0: ${views}.`);
  }
  const cents = toCents(cpm);
  if (cents < 0n) throw new TarifaError('CpmInvalido', `El CPM no puede ser negativo: "${cpm}".`);
  const producto = cents * BigInt(views);
  // División entera con redondeo mitad hacia arriba.
  return fromCents((producto + 500n) / 1000n);
}

/**
 * Suma de fracciones: '0.35' + '0.50' = '0.85'. Seis decimales, como
 * mulRateHalfUp.
 *
 * El tope de 5 (500 %) no es capricho: el error que de verdad ocurre es
 * pasar '35' donde iba '0.35', y sin tope eso multiplica el precio por
 * 36 en silencio.
 */
export const PCT_MAXIMO = 5;

export function sumarPct(pcts: readonly string[]): string {
  let total = 0n;
  for (const p of pcts) {
    const s = p.trim();
    if (!FRACCION_RE.test(s)) throw new TarifaError('PctInvalido', `Porcentaje inválido: "${p}". Se espera una fracción como "0.35".`);
    const [i = '0', f = ''] = s.split('.');
    if (Number(i) > PCT_MAXIMO) {
      throw new TarifaError('PctFueraDeRango', `Porcentaje fuera de rango: "${p}". Es una fracción (0,35 es +35 %), con tope ${PCT_MAXIMO}.`);
    }
    total += BigInt(i) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
  }
  const entero = total / 1_000_000n;
  const frac = (total % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${entero}.${frac}` : `${entero}`;
}

/** Calcula el rango de un entregable y deja el desglose que lo explica. */
export function calcularItem(entrada: EntradaTarifa): ItemTarifa {
  const { cantidad, views, platformId } = entrada;
  if (!Number.isInteger(cantidad) || cantidad < 1) {
    throw new TarifaError('CantidadInvalida', `La cantidad tiene que ser un entero ≥ 1: ${cantidad}.`);
  }
  const cpmLow = normalizeDecimal(entrada.cpmLow);
  const cpmHigh = normalizeDecimal(entrada.cpmHigh);
  if (compareDecimal(cpmLow, cpmHigh) > 0) {
    throw new TarifaError('RangoCpmInvertido', `El CPM bajo (${cpmLow}) no puede ser mayor que el alto (${cpmHigh}).`);
  }

  const pasos: PasoCalculo[] = [
    {
      tipo: 'views',
      views,
      cantidad,
      fuente: entrada.viewsSource,
      ...(entrada.viewsSample === undefined ? {} : { muestra: entrada.viewsSample }),
      ...(entrada.viewsCutHours === undefined ? {} : { corteHoras: entrada.viewsCutHours }),
    },
    {
      tipo: 'cpm',
      cpmLow,
      cpmHigh,
      fuente: entrada.cpmSource,
      nicheSlug: entrada.nicheSlug,
      country: entrada.country,
      platformId,
    },
  ];

  const unidad = unidadDePrecio(entrada.currency);
  const r = (v: Decimal) => redondearAUnidad(v, unidad);

  // 1 · La pieza suelta.
  let low = r(precioPorViews(cpmLow, views));
  let high = r(precioPorViews(cpmHigh, views));
  pasos.push({ tipo: 'base', low, high });

  // 2 · Por cuántas piezas.
  if (cantidad > 1) {
    low = multiplicarPorEntero(low, cantidad);
    high = multiplicarPorEntero(high, cantidad);
    pasos.push({ tipo: 'cantidad', cantidad, low, high });
  }

  // 3 · Los modificadores, todos sobre la misma base: sumar los
  // porcentajes y multiplicar una vez. Cada paso muestra lo que APORTA,
  // que es lo que el creador quiere ver al marcar la casilla.
  const modificadores = entrada.modificadores ?? [];
  const baseLow = low;
  const baseHigh = high;
  for (const m of modificadores) {
    normalizarPct(m.pct); // valida rango y formato antes de multiplicar
    const aporteLow = r(mulRateHalfUp(baseLow, m.pct));
    const aporteHigh = r(mulRateHalfUp(baseHigh, m.pct));
    pasos.push({ tipo: 'modificador', id: m.id, pct: normalizarPct(m.pct), low: aporteLow, high: aporteHigh });
    low = addDecimal(low, aporteLow);
    high = addDecimal(high, aporteHigh);
  }
  const modificadorTotalPct = sumarPct(modificadores.map((m) => m.pct));

  // 4 · El descuento del paquete, al final y sobre el total.
  if (entrada.descuentoPct && entrada.descuentoPct !== '0') {
    if (compareDecimal(normalizarPct(entrada.descuentoPct), '1') > 0) {
      throw new TarifaError('DescuentoInvalido', `Un descuento no puede pasar del 100 %: "${entrada.descuentoPct}".`);
    }
    const descLow = r(mulRateHalfUp(low, entrada.descuentoPct));
    const descHigh = r(mulRateHalfUp(high, entrada.descuentoPct));
    pasos.push({ tipo: 'descuento', pct: normalizarPct(entrada.descuentoPct), low: descLow, high: descHigh });
    low = subDecimal(low, descLow);
    high = subDecimal(high, descHigh);
  }

  pasos.push({ tipo: 'total', low, high });

  return {
    deliverable: entrada.deliverable,
    platformId,
    cantidad,
    views,
    viewsSource: entrada.viewsSource,
    cpmLow,
    cpmHigh,
    modificadorTotalPct,
    priceLow: low,
    priceHigh: high,
    pasos,
  };
}

/** El tarifario completo: un ítem por entregable, en el orden que llegan. */
export function calcularTarifario(entradas: readonly EntradaTarifa[]): ItemTarifa[] {
  return entradas.map(calcularItem);
}

// ---------------------------------------------------------------------
// Paquetes
// ---------------------------------------------------------------------

/** Un entregable dentro de un paquete, con el precio de UNA pieza ya calculado por calcularItem. */
export interface ComponentePaquete {
  deliverable: string;
  /** Cuántas veces entra en el paquete. Entero ≥ 1. */
  cantidad: number;
  priceLow: Decimal;
  priceHigh: Decimal;
}

export interface ItemPaquete {
  priceLow: Decimal;
  priceHigh: Decimal;
  descuentoPct: string;
  pasos: PasoCalculo[];
}

/**
 * Un paquete («1 TikTok + 1 Reel + 3 historias −12 %»): la suma de los
 * rangos de sus entregables, con el descuento al final y sobre el total,
 * igual que el paso de descuento de `calcularItem`.
 *
 * Los precios de cada componente son los que ya salieron de
 * `calcularItem` (o los que el creador fijó a mano): el paquete no
 * vuelve a mirar views ni CPM, y por eso el desglose se lee como «esto
 * cuestan las piezas sueltas, esto te ahorras».
 */
export function calcularPaquete(input: {
  componentes: readonly ComponentePaquete[];
  /** Fracción: '0.12' es −12 %. */
  descuentoPct: string;
  currency?: string;
}): ItemPaquete {
  if (input.componentes.length === 0) {
    throw new TarifaError('PaqueteVacio', 'Un paquete necesita al menos un entregable.');
  }
  const unidad = unidadDePrecio(input.currency);
  const descuentoPct = normalizarPct(input.descuentoPct || '0');
  if (compareDecimal(descuentoPct, '1') > 0) {
    throw new TarifaError('DescuentoInvalido', `Un descuento no puede pasar del 100 %: "${input.descuentoPct}".`);
  }

  const pasos: PasoCalculo[] = [];
  let low = '0.00';
  let high = '0.00';
  for (const c of input.componentes) {
    if (!Number.isInteger(c.cantidad) || c.cantidad < 1) {
      throw new TarifaError('CantidadInvalida', `La cantidad tiene que ser un entero ≥ 1: ${c.cantidad}.`);
    }
    const cLow = multiplicarPorEntero(normalizeDecimal(c.priceLow), c.cantidad);
    const cHigh = multiplicarPorEntero(normalizeDecimal(c.priceHigh), c.cantidad);
    pasos.push({ tipo: 'componente', deliverable: c.deliverable, cantidad: c.cantidad, low: cLow, high: cHigh });
    low = addDecimal(low, cLow);
    high = addDecimal(high, cHigh);
  }
  pasos.push({ tipo: 'subtotal', low, high });

  if (descuentoPct !== '0') {
    const descLow = redondearAUnidad(mulRateHalfUp(low, descuentoPct), unidad);
    const descHigh = redondearAUnidad(mulRateHalfUp(high, descuentoPct), unidad);
    pasos.push({ tipo: 'descuento', pct: descuentoPct, low: descLow, high: descHigh });
    low = subDecimal(low, descLow);
    high = subDecimal(high, descHigh);
  }
  pasos.push({ tipo: 'total', low, high });
  return { priceLow: low, priceHigh: high, descuentoPct, pasos };
}

function multiplicarPorEntero(valor: Decimal, veces: number): Decimal {
  return fromCents(toCents(valor) * BigInt(veces));
}

function normalizarPct(pct: string): string {
  return sumarPct([pct]);
}

// ---------------------------------------------------------------------
// Totales de una cotización
// ---------------------------------------------------------------------

export interface LineaCotizacion {
  /** Entero ≥ 1. */
  quantity: number;
  /** Precio por unidad, decimal. */
  unitPrice: Decimal;
}

export interface TotalesCotizacion {
  subtotal: Decimal;
  discount: Decimal;
  tax: Decimal;
  total: Decimal;
  /** Lo que se guarda en cada quote_item.total, en el mismo orden que entró. */
  lineTotals: Decimal[];
}

/**
 * subtotal = Σ (cantidad × precio) · base = subtotal − descuento ·
 * impuesto = base × tasa · total = base + impuesto.
 *
 * El descuento se resta ANTES del impuesto porque el impuesto se
 * declara sobre lo que se factura, no sobre lo que se pidió. Es la
 * misma cadena que después reproduce la factura (FIN-1), y por eso
 * `total` de la cotización se puede comparar con `total` de la factura
 * sin traducir nada.
 *
 * Con `currency`, el impuesto se redondea a la unidad de precio de la
 * moneda (`unidadDePrecio`): en pesos, 19 % de 5.195.070 son 987.063 y
 * no 987.063,30. Un documento para una marca en COP no lleva centavos.
 */
export function calcularTotalesCotizacion(input: {
  items: readonly LineaCotizacion[];
  discount?: Decimal;
  /** Fracción: '0.19' es 19 %. */
  taxRate?: string;
  /** ISO-4217: decide a qué unidad se redondea el impuesto. Sin ella, al centavo. */
  currency?: string;
}): TotalesCotizacion {
  const lineTotals: Decimal[] = [];
  let subtotalCents = 0n;
  for (const item of input.items) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new TarifaError('CantidadInvalida', `La cantidad de un ítem tiene que ser un entero ≥ 1: ${item.quantity}.`);
    }
    const linea = toCents(item.unitPrice) * BigInt(item.quantity);
    if (linea < 0n) throw new TarifaError('PrecioInvalido', `El precio de un ítem no puede ser negativo: "${item.unitPrice}".`);
    lineTotals.push(fromCents(linea));
    subtotalCents += linea;
  }
  const subtotal = fromCents(subtotalCents);
  const discount = normalizeDecimal(input.discount ?? '0');
  if (toCents(discount) < 0n) throw new TarifaError('DescuentoInvalido', 'El descuento no puede ser negativo.');
  if (compareDecimal(discount, subtotal) > 0) {
    throw new TarifaError('DescuentoMayorQueSubtotal', 'El descuento no puede ser mayor que el subtotal.');
  }
  const base = subDecimal(subtotal, discount);
  const tax = input.taxRate
    ? redondearAUnidad(mulRateHalfUp(base, input.taxRate), unidadDePrecio(input.currency))
    : '0.00';
  return { subtotal, discount, tax, total: addDecimal(base, tax), lineTotals };
}
