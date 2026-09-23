/**
 * Flujo de caja proyectado: ocho semanas hacia adelante, por semana.
 *
 * Una sola función pura —`projectCashflow`— recibe lo que una sola
 * consulta (`getCashflowInputs`, en `@mc/db/queries/finanzas`) saca de
 * la base y devuelve las semanas ya calculadas. La pantalla solo pinta:
 * ni suma, ni reparte, ni decide qué entra y qué no.
 *
 * Nada de aquí toca la base ni la red, y **ninguna cifra pasa por
 * `number`**: dinero como string decimal, BigInt de centavos para
 * operar (`toCents`/`fromCents`/`mulRateHalfUp` de `facturacion.ts`), y
 * fechas como `'YYYY-MM-DD'` puras, que se comparan como texto.
 *
 * Decisiones (detalle y alternativas descartadas en
 * docs/propuestas/FIN-6.md §0.2):
 *   - La semana empieza el LUNES. `hoy` llega ya resuelto en la zona
 *     del workspace (`hoyEnZona`), no es la fecha del servidor de base.
 *   - Una factura VENCIDA no entra en ninguna semana: la proyección es
 *     un piso, y plata con mora no tiene fecha. Sale en `excluidos`,
 *     que la pantalla explica con una frase.
 *   - Un negocio ganado suma solo si NO tiene factura (ni por su
 *     campaña ni por su cotización): si no, se contaría dos veces. Sin
 *     `expected_close_date`, fuera y contado.
 *   - La reserva de impuestos se calcula sobre los cobros de la
 *     semana. La retención en la fuente NO se descuenta además: es un
 *     anticipo del mismo impuesto que la reserva aparta.
 *   - Los gastos recurrentes se proyectan como ritmo mensual repartido
 *     por semana (mensual × 12 / 52), tomando el mes CERRADO más
 *     reciente; sumarlos todos contaría la misma suscripción una vez
 *     por mes, y tomar el mes en curso la contaría a medias mientras se
 *     va registrando.
 *   - Lo que no venga en la moneda del workspace queda fuera: no hay
 *     conversión en el MVP.
 */
import { addDays, daysBetween, fromCents, mulRateHalfUp, toCents, type Decimal } from './facturacion.ts';

// ---------------------------------------------------------------------
// Entradas: lo que la consulta trae en bruto, sin clasificar
// ---------------------------------------------------------------------

/** Una factura que todavía debe plata (ni pagada ni anulada ni borrador). */
export interface FacturaPorCobrar {
  id: string;
  number: string;
  companyName: string;
  /** ISO-4217. */
  currency: string;
  /** `total − paid_amount`, decimal. Lo que la marca todavía debe. */
  outstanding: Decimal;
  /** 'YYYY-MM-DD'. */
  dueOn: string;
}

/** Un negocio en una etapa con `is_won`. */
export interface NegocioGanado {
  id: string;
  name: string;
  companyName: string;
  currency: string;
  /** `deal.amount`; puede faltar en un ganado viejo. */
  amount: Decimal | null;
  /** 'YYYY-MM-DD' o null. */
  expectedCloseDate: string | null;
  /** true si ya hay una factura colgando de su campaña o su cotización. */
  hasInvoice: boolean;
}

/** Un gasto marcado como recurrente. */
export interface GastoRecurrente {
  id: string;
  /** Lo que se enseña: la descripción, o la categoría si no hay. */
  label: string;
  currency: string;
  amount: Decimal;
  /** 'YYYY-MM-DD': cuándo se incurrió. Decide a qué mes pertenece. */
  incurredOn: string;
}

export interface CashflowInput {
  /** Hoy en la zona del workspace, 'YYYY-MM-DD'. */
  today: string;
  /** La moneda del workspace: lo que venga en otra queda fuera. */
  currency: string;
  /** `settings.finanzas.reserva_pct` como fracción: '0.11'. */
  reservaRate: string;
  /** `settings.finanzas.plazo_dias`: cuándo se cobra un negocio ganado. */
  plazoDias: number;
  facturas: readonly FacturaPorCobrar[];
  negocios: readonly NegocioGanado[];
  gastos: readonly GastoRecurrente[];
  /** Cuántas semanas hacia adelante. Por defecto, ocho. */
  semanas?: number;
}

// ---------------------------------------------------------------------
// Salidas
// ---------------------------------------------------------------------

/** Una línea del detalle de una semana: de dónde sale su cobro. */
export interface CobroDeLaSemana {
  kind: 'factura' | 'negocio';
  id: string;
  /** 'FV-2026-010' o el nombre del negocio. */
  label: string;
  companyName: string;
  amount: Decimal;
  /** 'YYYY-MM-DD': el día en que se espera. */
  esperadoEl: string;
}

export interface SemanaFlujo {
  /** Lunes de la semana, 'YYYY-MM-DD'. */
  inicio: string;
  /** Domingo de la semana, 'YYYY-MM-DD'. */
  fin: string;
  cobros: Decimal;
  gastos: Decimal;
  impuestos: Decimal;
  /** cobros − gastos − impuestos. */
  neto: Decimal;
  /** Suma de los netos desde la primera semana hasta esta. */
  acumulado: Decimal;
  /** Qué facturas y qué negocios componen `cobros`. */
  detalle: CobroDeLaSemana[];
}

/** Un grupo de cosas que quedaron fuera, con su cuenta y su suma. */
export interface Excluido {
  count: number;
  amount: Decimal;
}

export interface Excluidos {
  /** Facturas con `due_on` anterior a hoy. */
  vencidas: Excluido;
  /** Negocios ganados que ya tienen factura: contarlos sería duplicar. */
  yaFacturados: Excluido;
  /** Negocios ganados sin `expected_close_date`. */
  sinFecha: Excluido;
  /** Negocios ganados con fecha pero sin `amount`: no hay cifra que proyectar. */
  sinMonto: Excluido;
  /** Cobros que caen antes o después de las ocho semanas. */
  fueraDeVentana: Excluido;
  /** Lo que venía en otra moneda, con la lista de monedas encontradas. */
  otraMoneda: Excluido & { monedas: string[] };
}

export interface Cashflow {
  semanas: SemanaFlujo[];
  excluidos: Excluidos;
  /** El acumulado de la última semana: el KPI «Caja proyectada». */
  proyectado: Decimal;
  /** La semana con el acumulado más bajo (el fondo de caja), o null. */
  semanaMasAjustada: SemanaFlujo | null;
  /** El mes del que sale el ritmo ('2026-08'), o null si no hay gastos. */
  gastoMes: string | null;
  /** Suma de los recurrentes de ese mes, en la moneda del workspace. */
  gastoMensual: Decimal;
  /** `gastoMensual × 12 / 52`: lo que se resta cada semana. */
  gastoSemanal: Decimal;
  /** La tasa usada para la reserva, tal cual entró ('0.11'). */
  reservaRate: string;
  /** true si no hay ni un cobro ni un gasto que proyectar. */
  vacio: boolean;
}

// ---------------------------------------------------------------------
// Calendario: aritmética sobre 'YYYY-MM-DD', sin husos
// ---------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertFecha(value: string, name: string): void {
  if (!ISO_DATE_RE.test(value)) {
    throw new Error(`${name} tiene que ser una fecha 'YYYY-MM-DD': "${value}".`);
  }
}

/**
 * El lunes de la semana de `fecha`. `Date.UTC` sobre una fecha sin hora
 * es aritmética de calendario pura: no interviene ninguna zona.
 */
export function lunesDeLaSemana(fecha: string): string {
  assertFecha(fecha, 'fecha');
  const dow = new Date(Date.UTC(+fecha.slice(0, 4), +fecha.slice(5, 7) - 1, +fecha.slice(8, 10))).getUTCDay();
  // getUTCDay: domingo = 0. El lunes está a (dow + 6) % 7 días atrás.
  return addDays(fecha, -((dow + 6) % 7));
}

/** El mes de una fecha: '2026-09'. */
function mesDe(fecha: string): string {
  assertFecha(fecha, 'incurredOn');
  return fecha.slice(0, 7);
}

/**
 * Reparte un monto mensual en una semana: `mensual × 12 / 52`, en
 * centavos y con redondeo mitad hacia arriba. 3 700 000,00 →
 * 853 846,15.
 */
export function semanalDeMensual(mensual: Decimal): Decimal {
  const doceMeses = toCents(mensual) * 12n;
  const negativo = doceMeses < 0n;
  const abs = negativo ? -doceMeses : doceMeses;
  const redondeado = (abs + 26n) / 52n;
  return fromCents(negativo ? -redondeado : redondeado);
}

// ---------------------------------------------------------------------
// Acumuladores
// ---------------------------------------------------------------------

const CERO: Decimal = '0.00';

class Suma {
  count = 0;
  private cents = 0n;
  add(amount: Decimal | null): void {
    this.count += 1;
    if (amount !== null) this.cents += toCents(amount);
  }
  get value(): Excluido {
    return { count: this.count, amount: fromCents(this.cents) };
  }
}

// ---------------------------------------------------------------------
// La función
// ---------------------------------------------------------------------

export const SEMANAS_POR_DEFECTO = 8;

/**
 * Proyecta el flujo de caja de las próximas semanas.
 *
 * Todo lo que decide qué entra y qué no vive aquí, para que se pueda
 * probar en milisegundos: la consulta solo trae filas en bruto.
 */
export function projectCashflow(input: CashflowInput): Cashflow {
  assertFecha(input.today, 'today');
  const semanas = input.semanas ?? SEMANAS_POR_DEFECTO;
  if (!Number.isInteger(semanas) || semanas < 1 || semanas > 52) {
    throw new Error(`El número de semanas tiene que ser un entero entre 1 y 52: ${semanas}.`);
  }
  const moneda = input.currency.toUpperCase();

  const inicio = lunesDeLaSemana(input.today);
  const fin = addDays(inicio, semanas * 7); // exclusivo
  const inicios = Array.from({ length: semanas }, (_, i) => addDays(inicio, i * 7));

  const vencidas = new Suma();
  const yaFacturados = new Suma();
  const sinFecha = new Suma();
  const sinMonto = new Suma();
  const fueraDeVentana = new Suma();
  const otraMoneda = new Suma();
  const monedas = new Set<string>();

  // Un cubo por semana; el índice sale de los días desde el lunes 1.
  const cobrosPorSemana: CobroDeLaSemana[][] = inicios.map(() => []);
  const indiceDe = (fecha: string): number => Math.floor(daysBetween(inicio, fecha) / 7);

  const colocar = (cobro: CobroDeLaSemana): void => {
    if (cobro.esperadoEl < inicio || cobro.esperadoEl >= fin) {
      fueraDeVentana.add(cobro.amount);
      return;
    }
    cobrosPorSemana[indiceDe(cobro.esperadoEl)]!.push(cobro);
  };

  // --- Facturas -------------------------------------------------------
  for (const f of input.facturas) {
    if (f.currency.toUpperCase() !== moneda) {
      monedas.add(f.currency.toUpperCase());
      otraMoneda.add(f.outstanding);
      continue;
    }
    assertFecha(f.dueOn, 'dueOn');
    if (f.dueOn < input.today) {
      // Vencida: se espera, pero no se promete. Fuera de las semanas y
      // explicada aparte (docs/propuestas/FIN-6.md §0.2.2).
      vencidas.add(f.outstanding);
      continue;
    }
    colocar({
      kind: 'factura',
      id: f.id,
      label: f.number,
      companyName: f.companyName,
      amount: f.outstanding,
      esperadoEl: f.dueOn,
    });
  }

  // --- Negocios ganados sin factura -----------------------------------
  for (const n of input.negocios) {
    if (n.hasInvoice) {
      yaFacturados.add(n.amount);
      continue;
    }
    if (n.currency.toUpperCase() !== moneda) {
      monedas.add(n.currency.toUpperCase());
      otraMoneda.add(n.amount);
      continue;
    }
    if (n.expectedCloseDate === null) {
      sinFecha.add(n.amount);
      continue;
    }
    if (n.amount === null) {
      // Tiene fecha, pero no hay cifra que proyectar. Es otra cosa que
      // «sin fecha», y la pantalla lo dice con otra frase: si no, se
      // leía «Sin fecha de cierre: 1 negocio por COP 0».
      sinMonto.add(null);
      continue;
    }
    assertFecha(n.expectedCloseDate, 'expectedCloseDate');
    colocar({
      kind: 'negocio',
      id: n.id,
      label: n.name,
      companyName: n.companyName,
      amount: n.amount,
      esperadoEl: addDays(n.expectedCloseDate, input.plazoDias),
    });
  }

  // --- Gastos recurrentes ---------------------------------------------
  // UN solo mes manda, y todo lo de gastos se mide en él: el ritmo y lo
  // que se deja fuera por moneda. Es el mes CERRADO más reciente, no el
  // más reciente a secas: el seed (y FIN-5) registran la misma
  // suscripción una vez por mes, así que sumarlas todas la contaría
  // cuatro veces, y el mes en curso está a medio registrar —el día 3 de
  // octubre, con una de cinco suscripciones anotada, el ritmo se
  // hundiría de 3,7 M a 0,38 M y la proyección mentiría en más de 6 M—.
  // Si no hay ningún mes cerrado en la ventana (un espacio recién
  // abierto), se usa el mes en curso, que es lo único que hay.
  const mesEnCurso = input.today.slice(0, 7);
  const meses = new Set<string>();
  for (const g of input.gastos) meses.add(mesDe(g.incurredOn));
  const cerrados = [...meses].filter((m) => m < mesEnCurso).sort();
  const gastoMes = cerrados[cerrados.length - 1] ?? (meses.has(mesEnCurso) ? mesEnCurso : null);

  let mensualCents = 0n;
  for (const g of input.gastos) {
    if (mesDe(g.incurredOn) !== gastoMes) continue;
    if (g.currency.toUpperCase() !== moneda) {
      monedas.add(g.currency.toUpperCase());
      otraMoneda.add(g.amount);
      continue;
    }
    mensualCents += toCents(g.amount);
  }
  const gastoMensual = fromCents(mensualCents);
  const gastoSemanal = semanalDeMensual(gastoMensual);

  // --- Las semanas ----------------------------------------------------
  let acumuladoCents = 0n;
  const filas: SemanaFlujo[] = inicios.map((inicioSemana, i) => {
    const detalle = cobrosPorSemana[i]!;
    const cobrosCents = detalle.reduce((acc, c) => acc + toCents(c.amount), 0n);
    const cobros = fromCents(cobrosCents);
    const impuestos = cobrosCents === 0n ? CERO : mulRateHalfUp(cobros, input.reservaRate);
    const netoCents = cobrosCents - toCents(gastoSemanal) - toCents(impuestos);
    acumuladoCents += netoCents;
    return {
      inicio: inicioSemana,
      fin: addDays(inicioSemana, 6),
      cobros,
      gastos: gastoSemanal,
      impuestos,
      neto: fromCents(netoCents),
      acumulado: fromCents(acumuladoCents),
      detalle,
    };
  });

  const hayCobros = filas.some((s) => toCents(s.cobros) !== 0n);
  const vacio = !hayCobros && mensualCents === 0n;

  // La semana más ajustada es el fondo de caja: el acumulado más bajo.
  // Con empate gana la primera, que es la que hay que resolver antes.
  let masAjustada: SemanaFlujo | null = null;
  for (const s of filas) {
    if (masAjustada === null || toCents(s.acumulado) < toCents(masAjustada.acumulado)) masAjustada = s;
  }

  return {
    semanas: filas,
    excluidos: {
      vencidas: vencidas.value,
      yaFacturados: yaFacturados.value,
      sinFecha: sinFecha.value,
      sinMonto: sinMonto.value,
      fueraDeVentana: fueraDeVentana.value,
      otraMoneda: { ...otraMoneda.value, monedas: [...monedas].sort() },
    },
    proyectado: filas[filas.length - 1]?.acumulado ?? CERO,
    semanaMasAjustada: vacio ? null : masAjustada,
    gastoMes,
    gastoMensual,
    gastoSemanal,
    reservaRate: input.reservaRate,
    vacio,
  };
}
