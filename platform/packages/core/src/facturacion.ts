/**
 * Facturación: la lógica pura de una factura.
 *
 * Nada de aquí toca la base ni la red. Entra un string decimal, sale un
 * string decimal. El dinero NUNCA pasa por number: numeric(14,2) en la
 * base, string en TypeScript, BigInt de centavos aquí dentro para
 * operar. Así el total que ve el formulario (calculado en el navegador)
 * es exactamente el que guarda la Server Action (calculado en el
 * servidor): es la misma función.
 *
 * Decisiones (detalle en docs/propuestas/FIN-1.md):
 *   - total = subtotal + IVA. La retención en la fuente se calcula y se
 *     guarda aparte (`withholding`): es lo que la marca retiene al
 *     pagar, no un descuento de la factura. `net` es lo que entra al
 *     banco si la marca retiene.
 *   - Redondeo a dos decimales, mitad hacia arriba (half-up), en cada
 *     multiplicación.
 *   - `overdue` NO se persiste: se deriva de due_on < hoy sobre una
 *     factura sent o partial (igual que la vista receivables). La
 *     máquina de estados lo acepta como estado de lectura y de destino
 *     para que el job de recordatorios (FIN-4) pueda persistirlo si un
 *     día conviene.
 */

// ---------------------------------------------------------------------
// Decimales sobre BigInt (centavos)
// ---------------------------------------------------------------------

/** Un monto como string decimal: "5200000.00". Siempre dos decimales al salir. */
export type Decimal = string;

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/** "1234.5" → 123450n (centavos). Lanza si el string no es un decimal. */
export function toCents(value: string): bigint {
  const s = value.trim();
  if (!DECIMAL_RE.test(s)) {
    throw new Error(`Monto inválido: "${value}". Se espera un decimal como "5200000.00".`);
  }
  const negative = s.startsWith('-');
  const [intPart, fracPart = ''] = (negative ? s.slice(1) : s).split('.');
  // Más de dos decimales: se redondea half-up al centavo.
  const frac2 = (fracPart + '00').slice(0, 2);
  let cents = BigInt(intPart ?? '0') * 100n + BigInt(frac2);
  const rest = fracPart.slice(2);
  if (rest.length > 0 && rest.charCodeAt(0) >= 53 /* '5' */) cents += 1n;
  return negative ? -cents : cents;
}

/** 123450n → "1234.50". */
export function fromCents(cents: bigint): Decimal {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const intPart = abs / 100n;
  const frac = abs % 100n;
  return `${negative ? '-' : ''}${intPart}.${frac.toString().padStart(2, '0')}`;
}

/** Normaliza cualquier decimal válido a dos decimales: "5200000" → "5200000.00". */
export function normalizeDecimal(value: string): Decimal {
  return fromCents(toCents(value));
}

/**
 * Multiplica un monto por una tasa ("0.19", "0.1100") y redondea al
 * centavo, mitad hacia arriba. La tasa admite hasta seis decimales.
 */
export function mulRateHalfUp(amount: Decimal, rate: string): Decimal {
  const cents = toCents(amount);
  const r = rate.trim();
  if (!DECIMAL_RE.test(r) || r.startsWith('-')) {
    throw new Error(`Tasa inválida: "${rate}". Se espera una fracción como "0.19".`);
  }
  const [ri, rf = ''] = r.split('.');
  if (rf.length > 6) throw new Error(`Tasa con demasiados decimales: "${rate}" (máximo seis).`);
  const rateScaled = BigInt(ri ?? '0') * 1_000_000n + BigInt((rf + '000000').slice(0, 6));
  const product = cents * rateScaled; // centavos × 1e6
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const rounded = (abs + 500_000n) / 1_000_000n;
  return fromCents(negative ? -rounded : rounded);
}

export function addDecimal(a: Decimal, b: Decimal): Decimal {
  return fromCents(toCents(a) + toCents(b));
}

export function subDecimal(a: Decimal, b: Decimal): Decimal {
  return fromCents(toCents(a) - toCents(b));
}

/** -1, 0 o 1. */
export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const x = toCents(a);
  const y = toCents(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** "19" → "0.19"; "19,5" → "0.195". Para los campos "IVA %" del formulario. */
export function pctToRate(pct: string): string {
  const s = pct.trim().replace(',', '.');
  if (!DECIMAL_RE.test(s) || s.startsWith('-')) {
    throw new Error(`Porcentaje inválido: "${pct}".`);
  }
  const [i = '0', f = ''] = s.split('.');
  // Mover la coma dos posiciones a la izquierda sin pasar por number.
  const digits = (i + f).replace(/^0+(?=\d)/, '');
  const scale = f.length + 2;
  const padded = digits.padStart(scale + 1, '0');
  const intPart = padded.slice(0, padded.length - scale);
  const fracPart = padded.slice(padded.length - scale).replace(/0+$/, '');
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

/** "0.19" → "19"; "0.115" → "11,5" (para mostrar). */
export function rateToPct(rate: string): string {
  const [i = '0', f = ''] = rate.trim().split('.');
  const digits = i + (f + '00').slice(0, Math.max(2, f.length));
  const scale = Math.max(0, f.length - 2);
  const intPart = digits.slice(0, digits.length - scale).replace(/^0+(?=\d)/, '') || '0';
  const fracPart = digits.slice(digits.length - scale).replace(/0+$/, '');
  return fracPart ? `${intPart},${fracPart}` : intPart;
}

// ---------------------------------------------------------------------
// Totales
// ---------------------------------------------------------------------

/** IVA general en Colombia. */
export const DEFAULT_TAX_RATE = '0.19';
/** Retención en la fuente por servicios (declarantes). Editable por factura. */
export const DEFAULT_WITHHOLDING_RATE = '0.11';

export interface InvoiceTotals {
  subtotal: Decimal;
  tax: Decimal;
  withholding: Decimal;
  /** subtotal + tax: lo que dice la factura. */
  total: Decimal;
  /** total − withholding: lo que entra al banco si la marca retiene. */
  net: Decimal;
}

export function computeInvoiceTotals(input: {
  subtotal: string;
  taxRate?: string;
  withholdingRate?: string;
}): InvoiceTotals {
  const subtotal = normalizeDecimal(input.subtotal);
  if (toCents(subtotal) < 0n) throw new Error('El subtotal no puede ser negativo.');
  const tax = mulRateHalfUp(subtotal, input.taxRate ?? DEFAULT_TAX_RATE);
  const withholding = mulRateHalfUp(subtotal, input.withholdingRate ?? DEFAULT_WITHHOLDING_RATE);
  const total = addDecimal(subtotal, tax);
  return { subtotal, tax, withholding, total, net: subDecimal(total, withholding) };
}

/**
 * Subtotal que produce un total dado (IVA incluido). Se usa al crear la
 * factura desde una campaña, cuyo `amount` es lo acordado con IVA.
 * Busca el subtotal cuyo total redondeado coincide exactamente; si no
 * existe (pasa con algunos montos), devuelve el más cercano por debajo.
 */
export function subtotalFromTotal(total: string, taxRate: string = DEFAULT_TAX_RATE): Decimal {
  const totalCents = toCents(total);
  const [ri, rf = ''] = taxRate.trim().split('.');
  const rateScaled = BigInt(ri ?? '0') * 1_000_000n + BigInt((rf + '000000').slice(0, 6));
  // subtotal ≈ total / (1 + rate), en centavos.
  const guess = (totalCents * 1_000_000n) / (1_000_000n + rateScaled);
  let best = guess;
  for (const delta of [0n, 1n, -1n, 2n, -2n]) {
    const candidate = guess + delta;
    const tax = toCents(mulRateHalfUp(fromCents(candidate), taxRate));
    if (candidate + tax === totalCents) return fromCents(candidate);
    if (candidate + tax < totalCents && candidate > best) best = candidate;
  }
  return fromCents(best);
}

// ---------------------------------------------------------------------
// Máquina de estados
// ---------------------------------------------------------------------

export type InvoiceStatus = 'draft' | 'sent' | 'partial' | 'paid' | 'overdue' | 'void';

export const INVOICE_STATUSES: readonly InvoiceStatus[] = ['draft', 'sent', 'partial', 'paid', 'overdue', 'void'];

export const INVOICE_STATUS_LABEL_ES: Record<InvoiceStatus, string> = {
  draft: 'Borrador',
  sent: 'Enviada',
  partial: 'Pago parcial',
  paid: 'Pagada',
  overdue: 'Vencida',
  void: 'Anulada',
};

/** Transiciones válidas. Cualquier otra lanza InvalidTransition. */
export const INVOICE_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ['sent', 'void'],
  sent: ['partial', 'paid', 'overdue', 'void'],
  partial: ['paid', 'overdue'],
  overdue: ['partial', 'paid'],
  paid: [],
  void: [],
};

export class InvalidTransition extends Error {
  readonly from: InvoiceStatus;
  readonly to: InvoiceStatus;
  constructor(from: InvoiceStatus, to: InvoiceStatus, reason?: string) {
    const base = `No se puede pasar una factura de «${INVOICE_STATUS_LABEL_ES[from]}» a «${INVOICE_STATUS_LABEL_ES[to]}»`;
    super(reason ? `${base}: ${reason}.` : `${base}.`);
    this.name = 'InvalidTransition';
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return INVOICE_TRANSITIONS[from].includes(to);
}

export interface TransitionInput {
  /** Obligatorio para partial y paid. */
  paidAmount?: string;
  /** ISO 8601. Por defecto lo pone quien persiste (now()). */
  paidAt?: string;
}

export interface TransitionResult {
  status: InvoiceStatus;
  paidAmount: Decimal;
  /** true cuando la transición fija paid_at (paid o partial). */
  setsPaidAt: boolean;
}

/**
 * Valida y calcula el resultado de una transición. No muta nada: quien
 * persiste aplica el resultado en la misma transacción que leyó la fila.
 *
 * Reglas: paid exige paid_amount = total; partial exige 0 < paid_amount
 * < total. sent y void no tocan el pago.
 */
export function transitionInvoice(
  invoice: { status: InvoiceStatus; total: string; paidAmount: string },
  to: InvoiceStatus,
  input: TransitionInput = {},
): TransitionResult {
  const from = invoice.status;
  if (!canTransition(from, to)) throw new InvalidTransition(from, to);

  const total = toCents(invoice.total);

  if (to === 'paid') {
    const paid = toCents(input.paidAmount ?? invoice.total);
    if (paid !== total) {
      throw new InvalidTransition(from, to, 'el monto pagado debe ser igual al total de la factura');
    }
    return { status: 'paid', paidAmount: fromCents(paid), setsPaidAt: true };
  }

  if (to === 'partial') {
    if (input.paidAmount === undefined) {
      throw new InvalidTransition(from, to, 'un pago parcial necesita el monto pagado');
    }
    const paid = toCents(input.paidAmount);
    if (paid <= 0n || paid >= total) {
      throw new InvalidTransition(from, to, 'un pago parcial debe ser mayor que cero y menor que el total');
    }
    return { status: 'partial', paidAmount: fromCents(paid), setsPaidAt: true };
  }

  if (to === 'overdue') {
    return { status: 'overdue', paidAmount: normalizeDecimal(invoice.paidAmount), setsPaidAt: false };
  }

  // sent, void
  return { status: to, paidAmount: normalizeDecimal(invoice.paidAmount), setsPaidAt: false };
}

// ---------------------------------------------------------------------
// Estado derivado
// ---------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertIsoDate(value: string, name: string): void {
  if (!ISO_DATE_RE.test(value)) throw new Error(`${name} debe ser una fecha YYYY-MM-DD, no "${value}".`);
}

/**
 * El estado que se muestra. `overdue` se DERIVA: una factura sent o
 * partial cuyo vencimiento ya pasó. Vence hoy no es vencida; venció
 * ayer sí. Las fechas son strings YYYY-MM-DD (UTC): se comparan como
 * texto, que para ISO es correcto y no depende de la zona del proceso.
 */
export function deriveStatus(invoice: { status: InvoiceStatus; dueOn: string }, today: string): InvoiceStatus {
  assertIsoDate(invoice.dueOn, 'dueOn');
  assertIsoDate(today, 'today');
  if ((invoice.status === 'sent' || invoice.status === 'partial') && invoice.dueOn < today) return 'overdue';
  return invoice.status;
}

export type AgingBucket = 'borrador' | 'anulada' | 'pagada' | 'vencida' | 'vence_pronto' | 'al_dia';

/**
 * El mismo criterio que la vista `receivables` (0010), más los dos
 * estados que la vista excluye (draft y void), para que la lista de
 * Finanzas pinte la pastilla con una sola función.
 */
export function agingBucket(invoice: { status: InvoiceStatus; dueOn: string }, today: string): AgingBucket {
  if (invoice.status === 'draft') return 'borrador';
  if (invoice.status === 'void') return 'anulada';
  if (invoice.status === 'paid') return 'pagada';
  assertIsoDate(invoice.dueOn, 'dueOn');
  assertIsoDate(today, 'today');
  if (invoice.dueOn < today) return 'vencida';
  if (daysBetween(today, invoice.dueOn) <= 7) return 'vence_pronto';
  return 'al_dia';
}

/** Días de a a b (b − a), con fechas YYYY-MM-DD en UTC. Negativo si b es anterior. */
export function daysBetween(a: string, b: string): number {
  assertIsoDate(a, 'a');
  assertIsoDate(b, 'b');
  const ms = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const ms2 = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((ms2 - ms) / 86_400_000);
}

/** Suma días a una fecha YYYY-MM-DD (UTC). */
export function addDays(date: string, days: number): string {
  assertIsoDate(date, 'date');
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) + days));
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// Numeración
// ---------------------------------------------------------------------

/**
 * 'FV-2026-004'. Por workspace y año, con al menos tres dígitos; a partir
 * de la 1000 sigue creciendo sin truncar. Es el formato del seed 0003.
 */
export function nextInvoiceNumber(year: number, lastSeq: number): string {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new Error(`Año inválido: ${year}.`);
  if (!Number.isInteger(lastSeq) || lastSeq < 0) throw new Error(`Secuencia inválida: ${lastSeq}.`);
  return `FV-${year}-${String(lastSeq + 1).padStart(3, '0')}`;
}

export const INVOICE_NUMBER_RE = /^FV-(\d{4})-(\d{3,})$/;

/** 'FV-2026-011' → { year: 2026, seq: 11 }; null si no tiene el formato. */
export function parseInvoiceNumber(number: string): { year: number; seq: number } | null {
  const m = INVOICE_NUMBER_RE.exec(number);
  if (!m) return null;
  // Son enteros de un formato controlado, no dinero.
  return { year: parseInt(m[1] ?? '0', 10), seq: parseInt(m[2] ?? '0', 10) };
}
