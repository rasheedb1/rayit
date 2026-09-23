/**
 * Recordatorios de cobro (FIN-4): en qué paso está una factura respecto
 * a su vencimiento, y el texto del correo que le corresponde.
 *
 * Todo esto es puro: entra una fecha y un monto como string decimal,
 * sale texto. Nada toca la base ni la red, así que el job del worker y
 * la pantalla pueden usar exactamente la misma redacción y las pruebas
 * corren en milisegundos.
 *
 * Decisiones (detalle en docs/propuestas/FIN-4.md §0):
 *   - Cinco pasos: −7, 0, +7, +21 y +45 días respecto a `due_on`, con
 *     el tono subiendo en cada uno.
 *   - Un paso solo se emite mientras su texto siga siendo cierto. El
 *     paso 1 dice «vence en N días», así que caduca en cuanto la
 *     factura vence; los demás se redactan con los días de mora reales,
 *     no con el número nominal del paso, y por eso no caducan. Eso es
 *     lo que hace que una factura vencida hace 41 días tenga TRES
 *     recordatorios pendientes (pasos 2, 3 y 4) y no cuatro.
 *   - El dinero se formatea desde el texto del decimal, sin pasar por
 *     double, igual que `formatMoney` en la web.
 */
import { compareDecimal, daysBetween, type Decimal } from './facturacion.ts';

// ---------------------------------------------------------------------
// Los pasos
// ---------------------------------------------------------------------

/** 0 es «todavía no toca»; 1..5 son los cinco pasos. */
export type PasoRecordatorio = 0 | 1 | 2 | 3 | 4 | 5;

/** Un paso real, ya sin el 0. */
export type NumeroPaso = 1 | 2 | 3 | 4 | 5;

export type SeveridadRecordatorio = 'info' | 'warning' | 'critical';

export interface DefinicionPaso {
  numero: NumeroPaso;
  /** Días respecto a `due_on`: −7 es una semana antes; +21, tres semanas después. */
  offsetDias: number;
  /** Cómo suena. Es lo único que cambia entre un paso y el siguiente. */
  tono: 'amable' | 'vencimiento' | 'mora_1' | 'mora_2' | 'formal';
  severity: SeveridadRecordatorio;
  /** Para la bandeja y los logs. */
  etiquetaEs: string;
}

/** Los cinco pasos, en orden. */
export const PASOS_RECORDATORIO: readonly DefinicionPaso[] = [
  { numero: 1, offsetDias: -7, tono: 'amable', severity: 'info', etiquetaEs: 'Recordatorio amable' },
  { numero: 2, offsetDias: 0, tono: 'vencimiento', severity: 'info', etiquetaEs: 'Aviso de vencimiento' },
  { numero: 3, offsetDias: 7, tono: 'mora_1', severity: 'warning', etiquetaEs: 'Primer aviso de mora' },
  { numero: 4, offsetDias: 21, tono: 'mora_2', severity: 'warning', etiquetaEs: 'Segundo aviso de mora' },
  { numero: 5, offsetDias: 45, tono: 'formal', severity: 'critical', etiquetaEs: 'Aviso formal de cobro' },
];

/** El paso por su número. Lanza si el número no es uno de los cinco. */
export function definicionPaso(numero: number): DefinicionPaso {
  const paso = PASOS_RECORDATORIO.find((p) => p.numero === numero);
  if (!paso) throw new Error(`No existe el paso de recordatorio ${numero}.`);
  return paso;
}

/**
 * El paso más alto cuyo día ya llegó. `0` cuando faltan más de siete
 * días para el vencimiento. Las fechas son 'YYYY-MM-DD' en UTC.
 *
 *   pasoRecordatorio('2026-08-13', '2026-08-06') → 1   (vence en 7 días)
 *   pasoRecordatorio('2026-08-13', '2026-08-13') → 2   (vence hoy)
 *   pasoRecordatorio('2026-08-13', '2026-09-23') → 4   (41 días de mora)
 */
export function pasoRecordatorio(dueOn: string, hoy: string): PasoRecordatorio {
  const mora = -daysBetween(hoy, dueOn);
  let actual: PasoRecordatorio = 0;
  for (const paso of PASOS_RECORDATORIO) {
    if (paso.offsetDias <= mora) actual = paso.numero;
  }
  return actual;
}

/**
 * ¿El texto de este paso sigue siendo cierto hoy?
 *
 * Solo el paso 1 caduca: habla de una factura que «vence en N días», y
 * eso deja de ser verdad el día del vencimiento. Mandarlo con 41 días
 * de mora sería mentir, así que no se emite nunca tarde.
 */
export function pasoVigente(numero: NumeroPaso, diasHastaVencimiento: number): boolean {
  return numero !== 1 || diasHastaVencimiento >= 1;
}

export interface PasosPendientesInput {
  /** 'YYYY-MM-DD' */
  dueOn: string;
  /** 'YYYY-MM-DD' */
  hoy: string;
  /** Los pasos que ya tienen su recordatorio escrito para esta factura. */
  emitidos?: readonly number[];
}

/**
 * Los pasos que hoy corresponden y todavía no se han escrito, de menor
 * a mayor. Es la lista completa (ponerse al día), no solo el último:
 * el job no envía nada, deja borradores en una bandeja. Cuando exista
 * el envío real (fase 2) se manda solo el último de la lista y los
 * demás quedan como historial.
 */
export function pasosPendientes(input: PasosPendientesInput): DefinicionPaso[] {
  const actual = pasoRecordatorio(input.dueOn, input.hoy);
  if (actual === 0) return [];
  const dias = daysBetween(input.hoy, input.dueOn);
  const emitidos = new Set(input.emitidos ?? []);
  return PASOS_RECORDATORIO.filter(
    (p) => p.numero <= actual && !emitidos.has(p.numero) && pasoVigente(p.numero, dias),
  );
}

// ---------------------------------------------------------------------
// El texto
// ---------------------------------------------------------------------

/**
 * Los datos de pago del workspace. Los llenará FIN-8 (configuración
 * financiera); hoy no existe ninguno, y el texto lo dice en una frase
 * en vez de dejar un hueco mudo.
 */
export interface DatosDePago {
  /** A nombre de quién se consigna. */
  titular?: string | null;
  /** 'Bancolombia' */
  banco?: string | null;
  /** 'Ahorros 123-456789-00' */
  cuenta?: string | null;
  /** NIT o cédula con el que se factura. */
  identificacion?: string | null;
  /** Cualquier instrucción extra: Nequi, PSE, el correo de radicación. */
  nota?: string | null;
}

export interface EntradaRecordatorio {
  paso: NumeroPaso;
  /** 'FV-2026-007' */
  numero: string;
  /** La marca a la que se le cobra. */
  empresa: string;
  /** Nombre de la campaña, si la factura tiene una. */
  campana?: string | null;
  total: Decimal;
  /** total − paid_amount. En una factura parcial, el saldo es lo que se cobra. */
  pendiente: Decimal;
  /** 'YYYY-MM-DD' */
  vencimiento: string;
  /** 'YYYY-MM-DD'. De aquí salen los días: no se pasan aparte para que no puedan contradecirse. */
  hoy: string;
  /** ISO-4217 del workspace. */
  moneda: string;
  /** BCP 47 del workspace ('es-CO'). */
  locale: string;
  /** Quien cobra: el nombre del workspace. */
  nombreCreador: string;
  datosDePago?: DatosDePago | null;
}

export interface Recordatorio {
  asunto: string;
  cuerpo: string;
  severity: SeveridadRecordatorio;
  /** Días de mora (0 o más) o 0 si todavía no vence. Para la bandeja. */
  diasDeMora: number;
}

const numeroCache = new Map<string, Intl.NumberFormat>();
const fechaCache = new Map<string, Intl.DateTimeFormat>();

/** Intl pone espacios duros; el correo se copia y se pega, así que van normales. */
const llano = (s: string): string => s.replace(/[  ]/g, ' ');

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/** El literal numérico que pide Intl v3, comprobado antes de afirmarlo. */
function literal(monto: Decimal): Intl.StringNumericLiteral {
  if (!DECIMAL_RE.test(monto)) throw new Error(`No es un decimal: "${monto}".`);
  return monto as Intl.StringNumericLiteral;
}

/**
 * 'COP 1.100.000' desde el TEXTO del decimal, sin pasar por double.
 * Es la misma regla que `formatMoney(..., { mode: 'full' })` en la web:
 * numeric(14,2) admite montos que un double no representa exacto, y
 * convertirlo para presentarlo deshace lo que la columna protege.
 * Intl.NumberFormat acepta texto desde su versión 3 (Node 20, ES2023).
 */
function dinero(monto: Decimal, moneda: string, locale: string): string {
  const centavos = monto.includes('.') ? monto.slice(monto.indexOf('.') + 1).replace(/0+$/, '') : '';
  const digitos = centavos === '' ? 0 : 2;
  const clave = `${locale}|${digitos}`;
  let f = numeroCache.get(clave);
  if (!f) {
    f = new Intl.NumberFormat(locale, { minimumFractionDigits: digitos, maximumFractionDigits: digitos });
    numeroCache.set(clave, f);
  }
  return `${moneda.toUpperCase()} ${llano(f.format(literal(monto)))}`;
}

/** '13 de agosto de 2026'. Siempre en UTC: una fecha de calendario no tiene hora. */
function fechaLarga(iso: string, locale: string): string {
  let f = fechaCache.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
    fechaCache.set(locale, f);
  }
  return llano(f.format(new Date(`${iso}T00:00:00Z`)));
}

/** '1 día' · '41 días'. */
function dias(n: number): string {
  return n === 1 ? '1 día' : `${n} días`;
}

/**
 * Las líneas de pago que haya. Si no hay ninguna, una frase que explica
 * dónde se configuran: una ausencia se explica, no se deja en blanco.
 */
function bloqueDePago(datos: DatosDePago | null | undefined): string {
  const lineas: string[] = [];
  if (datos?.titular) lineas.push(`A nombre de: ${datos.titular}`);
  if (datos?.identificacion) lineas.push(`NIT o cédula: ${datos.identificacion}`);
  if (datos?.banco) lineas.push(`Banco: ${datos.banco}`);
  if (datos?.cuenta) lineas.push(`Cuenta: ${datos.cuenta}`);
  if (datos?.nota) lineas.push(datos.nota);
  if (lineas.length === 0) {
    return 'Todavía no tienes datos de pago configurados, así que este correo no los incluye: escríbelos a mano antes de enviarlo, o configúralos una sola vez en Finanzas → Configuración (FIN-8) para que salgan solos.';
  }
  return ['Datos para el pago:', ...lineas.map((l) => `  ${l}`)].join('\n');
}

/** El asunto de cada tono, con los hechos de hoy (no con el número nominal del paso). */
function asuntoDe(e: EntradaRecordatorio, diasHasta: number, mora: number): string {
  switch (definicionPaso(e.paso).tono) {
    case 'amable':
      return `Recordatorio: la factura ${e.numero} vence el ${fechaLarga(e.vencimiento, e.locale)}`;
    case 'vencimiento':
      return diasHasta === 0
        ? `La factura ${e.numero} vence hoy`
        : `La factura ${e.numero} venció el ${fechaLarga(e.vencimiento, e.locale)}`;
    case 'mora_1':
      return `Factura ${e.numero} pendiente · ${dias(mora)} de mora`;
    case 'mora_2':
      return `Segundo aviso · factura ${e.numero} con ${dias(mora)} de mora`;
    case 'formal':
      return `Aviso formal de cobro · factura ${e.numero}`;
  }
}

/** La apertura de cada tono: lo único que sube de temperatura. */
function aperturaDe(e: EntradaRecordatorio, diasHasta: number, mora: number): string {
  const pendiente = dinero(e.pendiente, e.moneda, e.locale);
  switch (definicionPaso(e.paso).tono) {
    case 'amable':
      return `Les escribo para recordarles que la factura ${e.numero} vence en ${dias(diasHasta)}, el ${fechaLarga(e.vencimiento, e.locale)}. Si ya está programada para pago, ignoren este mensaje.`;
    case 'vencimiento':
      return diasHasta === 0
        ? `La factura ${e.numero} vence hoy, ${fechaLarga(e.vencimiento, e.locale)}. Quedo atento a la confirmación del pago de ${pendiente}.`
        : `La factura ${e.numero} venció el ${fechaLarga(e.vencimiento, e.locale)} y sigue pendiente de pago por ${pendiente}. Quedo atento a la confirmación.`;
    case 'mora_1':
      return `La factura ${e.numero} lleva ${dias(mora)} de mora. El saldo pendiente es de ${pendiente}. ¿Me confirman en qué fecha quedaría programado el pago?`;
    case 'mora_2':
      return `Este es el segundo aviso por la factura ${e.numero}, que acumula ${dias(mora)} de mora con un saldo de ${pendiente}. Si hay algo del lado de ustedes que esté deteniendo el trámite —una orden de compra, un soporte, un radicado— díganme y lo resuelvo hoy mismo.`;
    case 'formal':
      return `Por medio de este correo les requiero formalmente el pago de la factura ${e.numero}, con ${dias(mora)} de mora y un saldo pendiente de ${pendiente}. Les agradezco indicarme una fecha concreta de pago dentro de los próximos cinco días hábiles; de no recibir respuesta, tendré que suspender los trabajos en curso y pasar el cobro a la vía que corresponda.`;
  }
}

/** El cierre de cada tono. */
function cierreDe(paso: NumeroPaso): string {
  switch (definicionPaso(paso).tono) {
    case 'amable':
    case 'vencimiento':
      return 'Gracias y quedo pendiente,';
    case 'mora_1':
    case 'mora_2':
      return 'Gracias por la gestión,';
    case 'formal':
      return 'Atentamente,';
  }
}

/**
 * El correo de un paso, listo para copiar y pegar: texto plano, sin
 * HTML, con el locale y la moneda del workspace.
 *
 *   const { asunto, cuerpo } = redactarRecordatorio({ paso: 3, ... });
 */
export function redactarRecordatorio(e: EntradaRecordatorio): Recordatorio {
  const { severity } = definicionPaso(e.paso);
  const diasHasta = daysBetween(e.hoy, e.vencimiento);
  const mora = Math.max(0, -diasHasta);

  const montos = [
    `  Factura: ${e.numero}`,
    e.campana ? `  Campaña: ${e.campana}` : null,
    `  ${diasHasta >= 0 ? 'Vence' : 'Venció'}: ${fechaLarga(e.vencimiento, e.locale)}`,
    `  Total de la factura: ${dinero(e.total, e.moneda, e.locale)}`,
    // El saldo solo se nombra aparte cuando hay abonos: repetir la misma
    // cifra dos veces haría dudar de cuál es la que se debe pagar.
    compareDecimal(e.pendiente, e.total) !== 0 ? `  Pendiente por pagar: ${dinero(e.pendiente, e.moneda, e.locale)}` : null,
  ].filter((l): l is string => l !== null);

  const cuerpo = [
    `Hola, equipo de ${e.empresa}:`,
    '',
    aperturaDe(e, diasHasta, mora),
    '',
    ...montos,
    '',
    bloqueDePago(e.datosDePago),
    '',
    cierreDe(e.paso),
    e.nombreCreador,
  ].join('\n');

  return { asunto: asuntoDe(e, diasHasta, mora), cuerpo, severity, diasDeMora: mora };
}
