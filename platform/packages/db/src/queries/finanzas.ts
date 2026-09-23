/**
 * Consultas del módulo Finanzas (FIN-1: facturas).
 *
 * Reglas:
 *   - Toda función recibe un WorkspaceTx: una transacción con el
 *     workspace ya fijado. Ninguna recibe workspace_id suelto. Las
 *     lecturas las filtra RLS; los INSERT usan current_workspace_id().
 *   - El dinero entra y sale como string decimal. Postgres devuelve
 *     numeric como texto y aquí no se convierte a number nunca.
 *   - Las fechas date se devuelven como 'YYYY-MM-DD' (to_char) para no
 *     depender de la zona horaria del driver.
 *   - `overdue` no se persiste: se deriva (packages/core deriveStatus) y
 *     la vista receivables ya lo hace con aging_bucket.
 */
import {
  addDays,
  agingBucket,
  compareDecimal,
  computeInvoiceTotals,
  deriveStatus,
  esCategoriaGasto,
  esRecurrencia,
  isIsoDate,
  nextInvoiceNumber,
  normalizeDecimal,
  parseInvoiceNumber,
  subDecimal,
  subtotalFromTotal,
  transitionInvoice as applyTransition,
  DEFAULT_TAX_RATE,
  DEFAULT_WITHHOLDING_RATE,
  type AgingBucket,
  type InvoiceStatus,
  type TransitionInput,
} from '@mc/core';
import { getWorkspaceSettings } from './cimientos.ts';
import { isUuid, type WorkspaceTx } from '../client.ts';

// ---------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------

export interface InvoiceListRow {
  id: string;
  number: string;
  /** El persistido. */
  status: InvoiceStatus;
  /** Con overdue derivado de due_on < hoy. */
  derivedStatus: InvoiceStatus;
  bucket: AgingBucket;
  companyId: string;
  companyName: string;
  campaignId: string | null;
  campaignName: string | null;
  currency: string;
  total: string;
  paidAmount: string;
  outstanding: string;
  issuedOn: string;
  dueOn: string;
  /** due_on − hoy. Negativo si ya venció. */
  daysToDue: number;
}

export interface InvoiceDetail extends InvoiceListRow {
  subtotal: string;
  tax: string;
  withholding: string;
  /** total − withholding. */
  net: string;
  quoteId: string | null;
  externalRef: string | null;
  paidAt: string | null;
  remindersSent: number;
  lastReminderAt: string | null;
  createdAt: string;
  updatedAt: string;
  campaignStatus: string | null;
}

export interface ListInvoicesParams {
  status?: InvoiceStatus | readonly InvoiceStatus[];
  companyId?: string;
  /** 1..200. Por defecto 50. */
  limit?: number;
  cursor?: string | null;
}

export interface ListInvoicesResult {
  rows: InvoiceListRow[];
  nextCursor: string | null;
}

export interface CreateInvoiceInput {
  companyId: string;
  campaignId?: string | null;
  quoteId?: string | null;
  subtotal: string;
  taxRate?: string;
  withholdingRate?: string;
  /** YYYY-MM-DD */
  issuedOn: string;
  /** YYYY-MM-DD, ≥ issuedOn */
  dueOn: string;
  externalRef?: string | null;
  /** ISO-4217. Por defecto, la del workspace (workspace.currency). */
  currency?: string;
}

export interface CompanyOption {
  id: string;
  name: string;
}

export interface CampaignOption {
  id: string;
  name: string;
  status: string;
  companyId: string;
  companyName: string;
  amount: string | null;
  currency: string;
  quoteId: string | null;
}

export interface ReceivablesKpis {
  outstanding: string;
  openCount: number;
  overdue: string;
  overdueCount: number;
  maxDaysOverdue: number;
  collectedYtd: string;
  collectedPrevYtd: string;
  /** collectedYtd / collectedPrevYtd − 1; null si no hay base. Es una razón, no dinero. */
  collectedDelta: number | null;
  taxReserved: string;
  taxRate: string | null;
}

export class InvoiceNotFound extends Error {
  constructor(id: string) {
    super(`La factura ${id} no existe en este workspace.`);
    this.name = 'InvoiceNotFound';
  }
}

// ---------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------

interface RawRow {
  id: string;
  number: string;
  status: InvoiceStatus;
  company_id: string;
  company_name: string;
  campaign_id: string | null;
  campaign_name: string | null;
  campaign_status: string | null;
  quote_id: string | null;
  currency: string;
  subtotal: string;
  tax: string;
  withholding: string;
  total: string;
  paid_amount: string;
  outstanding: string;
  issued_on: string;
  due_on: string;
  today: string;
  days_to_due: number;
  external_ref: string | null;
  paid_at: string | null;
  reminders_sent: number;
  last_reminder_at: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_INVOICE = `
  SELECT i.id, i.number, i.status, i.company_id, co.name AS company_name,
         i.campaign_id, ca.name AS campaign_name, ca.status AS campaign_status, i.quote_id,
         i.currency, i.subtotal::text, i.tax::text, i.withholding::text, i.total::text,
         i.paid_amount::text, (i.total - i.paid_amount)::text AS outstanding,
         to_char(i.issued_on, 'YYYY-MM-DD') AS issued_on,
         to_char(i.due_on, 'YYYY-MM-DD') AS due_on,
         to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today,
         (i.due_on - CURRENT_DATE)::int AS days_to_due,
         i.external_ref,
         to_char(i.paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS paid_at,
         i.reminders_sent,
         to_char(i.last_reminder_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_reminder_at,
         to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
         to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
  FROM invoice i
  JOIN company co ON co.id = i.company_id
  LEFT JOIN campaign ca ON ca.id = i.campaign_id
`;

function toListRow(r: RawRow): InvoiceListRow {
  const inv = { status: r.status, dueOn: r.due_on };
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    derivedStatus: deriveStatus(inv, r.today),
    bucket: agingBucket(inv, r.today),
    companyId: r.company_id,
    companyName: r.company_name,
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    currency: r.currency,
    total: r.total,
    paidAmount: r.paid_amount,
    outstanding: r.outstanding,
    issuedOn: r.issued_on,
    dueOn: r.due_on,
    daysToDue: r.days_to_due,
  };
}

function toDetail(r: RawRow): InvoiceDetail {
  return {
    ...toListRow(r),
    subtotal: r.subtotal,
    tax: r.tax,
    withholding: r.withholding,
    net: subDecimal(r.total, r.withholding),
    quoteId: r.quote_id,
    externalRef: r.external_ref,
    paidAt: r.paid_at,
    remindersSent: r.reminders_sent,
    lastReminderAt: r.last_reminder_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    campaignStatus: r.campaign_status,
  };
}

function encodeCursor(row: InvoiceListRow): string {
  return Buffer.from(`${row.issuedOn}|${row.number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { issuedOn: string; number: string } {
  const [issuedOn, number] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!issuedOn || !number || !/^\d{4}-\d{2}-\d{2}$/.test(issuedOn)) {
    throw new Error('El cursor de paginación no es válido.');
  }
  return { issuedOn, number };
}

/**
 * Lista de facturas del workspace, más recientes primero. Incluye los
 * borradores (que la vista receivables excluye) y calcula el estado
 * derivado y la pastilla de mora con las mismas reglas que la vista.
 */
export async function listInvoices(tx: WorkspaceTx, params: ListInvoicesParams = {}): Promise<ListInvoicesResult> {
  const limit = Math.min(200, Math.max(1, params.limit ?? 50));
  const where: string[] = [];
  const values: unknown[] = [];

  if (params.status) {
    const statuses = Array.isArray(params.status) ? params.status : [params.status];
    values.push(statuses);
    where.push(`i.status = ANY($${values.length}::text[])`);
  }
  if (params.companyId) {
    values.push(params.companyId);
    where.push(`i.company_id = $${values.length}`);
  }
  if (params.cursor) {
    const c = decodeCursor(params.cursor);
    values.push(c.issuedOn, c.number);
    where.push(`(i.issued_on, i.number) < ($${values.length - 1}::date, $${values.length})`);
  }
  values.push(limit + 1);

  const sql = `${SELECT_INVOICE}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY i.issued_on DESC, i.number DESC
    LIMIT $${values.length}`;
  const { rows } = await tx.query<RawRow>(sql, values);
  const page = rows.slice(0, limit).map(toListRow);
  const last = page[page.length - 1];
  return { rows: page, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}

/**
 * Una factura del workspace por su id, o null. El id llega de la ruta:
 * si no es un UUID no se consulta (Postgres devolvería 22P02, que la
 * pantalla convertiría en 500 en vez de en su 404).
 */
export async function getInvoice(tx: WorkspaceTx, id: string): Promise<InvoiceDetail | null> {
  if (!isUuid(id)) return null;
  const { rows } = await tx.query<RawRow>(`${SELECT_INVOICE} WHERE i.id = $1`, [id]);
  const r = rows[0];
  return r ? toDetail(r) : null;
}

/** Empresas vinculadas al workspace (company_link tiene RLS; company no). */
export async function listCompanies(tx: WorkspaceTx): Promise<CompanyOption[]> {
  const { rows } = await tx.query<CompanyOption>(`
    SELECT c.id, c.name
    FROM company_link l
    JOIN company c ON c.id = l.company_id
    ORDER BY c.name
  `);
  return rows;
}

/** Campañas facturables del workspace, para "Desde una campaña". */
export async function listCampaignsForInvoice(tx: WorkspaceTx): Promise<CampaignOption[]> {
  const { rows } = await tx.query<{
    id: string; name: string; status: string; company_id: string; company_name: string;
    amount: string | null; currency: string; quote_id: string | null;
  }>(`
    SELECT ca.id, ca.name, ca.status, ca.company_id, co.name AS company_name,
           ca.amount::text, ca.currency, ca.quote_id
    FROM campaign ca
    JOIN company co ON co.id = ca.company_id
    WHERE ca.status <> 'cancelled'
    ORDER BY ca.starts_on DESC NULLS LAST, ca.name
  `);
  return rows.map((r) => ({
    id: r.id, name: r.name, status: r.status, companyId: r.company_id, companyName: r.company_name,
    amount: r.amount, currency: r.currency, quoteId: r.quote_id,
  }));
}

/** Los cuatro KPIs de Finanzas, desde la vista receivables, payment y tax_reserve. */
export async function getReceivablesKpis(tx: WorkspaceTx): Promise<ReceivablesKpis> {
  const { rows } = await tx.query<{
    outstanding: string; open_count: number; overdue: string; overdue_count: number; max_days_overdue: number;
    collected_ytd: string; collected_prev: string; delta_permille: number | null; tax_reserved: string; tax_rate: string | null;
  }>(`
    WITH ytd AS (
      SELECT coalesce(sum(amount), 0) AS v FROM payment
      WHERE direction = 'in' AND received_at >= date_trunc('year', CURRENT_DATE)
    ), prev AS (
      SELECT coalesce(sum(amount), 0) AS v FROM payment
      WHERE direction = 'in'
        AND received_at >= date_trunc('year', CURRENT_DATE) - interval '1 year'
        AND received_at < (CURRENT_DATE - interval '1 year') + interval '1 day'
    )
    SELECT
      (SELECT coalesce(sum(outstanding), 0)::text FROM receivables WHERE status <> 'paid') AS outstanding,
      (SELECT count(*)::int FROM receivables WHERE status <> 'paid') AS open_count,
      (SELECT coalesce(sum(outstanding), 0)::text FROM receivables WHERE aging_bucket = 'vencida') AS overdue,
      (SELECT count(*)::int FROM receivables WHERE aging_bucket = 'vencida') AS overdue_count,
      (SELECT coalesce(max(days_overdue), 0)::int FROM receivables WHERE aging_bucket = 'vencida') AS max_days_overdue,
      (SELECT v::text FROM ytd) AS collected_ytd,
      (SELECT v::text FROM prev) AS collected_prev,
      (SELECT CASE WHEN prev.v > 0 THEN round((ytd.v / prev.v - 1) * 1000)::int END FROM ytd, prev) AS delta_permille,
      (SELECT coalesce(sum(amount), 0)::text FROM tax_reserve WHERE released_at IS NULL) AS tax_reserved,
      (SELECT max(rate)::text FROM tax_reserve WHERE released_at IS NULL) AS tax_rate
  `);
  const r = rows[0];
  if (!r) throw new Error('La consulta de KPIs no devolvió filas.');
  return {
    outstanding: r.outstanding,
    openCount: r.open_count,
    overdue: r.overdue,
    overdueCount: r.overdue_count,
    maxDaysOverdue: r.max_days_overdue,
    collectedYtd: r.collected_ytd,
    collectedPrevYtd: r.collected_prev,
    collectedDelta: r.delta_permille === null ? null : r.delta_permille / 1000,
    taxReserved: r.tax_reserved,
    taxRate: r.tax_rate,
  };
}

// ---------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Crea una factura en borrador con el siguiente número del workspace y
 * del año de emisión. La secuencia se protege con un advisory lock por
 * (workspace, año) dentro de la transacción: dos creaciones concurrentes
 * se serializan, no chocan en UNIQUE (workspace_id, number) ni saltan
 * números.
 */
export async function createInvoice(tx: WorkspaceTx, input: CreateInvoiceInput): Promise<InvoiceDetail> {
  if (!ISO_DATE_RE.test(input.issuedOn)) throw new Error('La fecha de emisión debe ser YYYY-MM-DD.');
  if (!ISO_DATE_RE.test(input.dueOn)) throw new Error('La fecha de vencimiento debe ser YYYY-MM-DD.');
  if (input.dueOn < input.issuedOn) throw new Error('El vencimiento no puede ser anterior a la emisión.');
  // La moneda por defecto es la del workspace, no 'COP': el producto se
  // vende fuera de Colombia y workspace.currency existe desde 0001.
  // Una factura en otra moneda que la del workspace mezclaría cifras que
  // los KPI de /finanzas suman sin convertir, así que se rechaza con un
  // mensaje que dice cuál es la del workspace.
  const { currency: wsCurrency } = await getWorkspaceSettings(tx);
  const currency = (input.currency ?? wsCurrency).toUpperCase();
  if (currency !== wsCurrency) {
    throw new Error(`Las facturas van en la moneda del workspace (${wsCurrency}); recibió ${currency}.`);
  }

  const totals = computeInvoiceTotals({
    subtotal: input.subtotal,
    taxRate: input.taxRate ?? DEFAULT_TAX_RATE,
    withholdingRate: input.withholdingRate ?? DEFAULT_WITHHOLDING_RATE,
  });

  // La empresa tiene que estar vinculada a ESTE workspace: la FK de
  // invoice.company_id no lo garantiza, company_link (con RLS) sí.
  const link = await tx.query('SELECT 1 FROM company_link WHERE company_id = $1', [input.companyId]);
  if (link.rows.length === 0) throw new Error('La empresa no existe en este workspace.');

  if (input.campaignId) {
    const camp = await tx.query('SELECT 1 FROM campaign WHERE id = $1', [input.campaignId]);
    if (camp.rows.length === 0) throw new Error('La campaña no existe en este workspace.');
  }

  // Es un entero de un formato controlado (YYYY), no dinero.
  const year = parseInt(input.issuedOn.slice(0, 4), 10);
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`invoice-number:${tx.workspaceId}:${year}`]);
  const last = await tx.query<{ number: string }>(
    `SELECT number FROM invoice
     WHERE number ~ $1
     ORDER BY length(number) DESC, number DESC
     LIMIT 1`,
    [`^FV-${year}-\\d+$`],
  );
  const lastSeq = last.rows[0] ? (parseInvoiceNumber(last.rows[0].number)?.seq ?? 0) : 0;
  const number = nextInvoiceNumber(year, lastSeq);

  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO invoice (workspace_id, company_id, campaign_id, quote_id, number, currency,
                          subtotal, tax, withholding, total, issued_on, due_on, status, external_ref)
     VALUES (current_workspace_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11::date, 'draft', $12)
     RETURNING id`,
    [
      input.companyId, input.campaignId ?? null, input.quoteId ?? null, number, currency,
      totals.subtotal, totals.tax, totals.withholding, totals.total, input.issuedOn, input.dueOn,
      input.externalRef?.trim() || null,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error('No se pudo crear la factura.');
  const detail = await getInvoice(tx, id);
  if (!detail) throw new InvoiceNotFound(id);
  return detail;
}

/**
 * Cambia el estado validando con la máquina de estados de core. Lee la
 * fila con FOR UPDATE en la misma transacción: si la validación falla,
 * no se escribe nada.
 */
export async function transitionInvoice(
  tx: WorkspaceTx,
  id: string,
  to: InvoiceStatus,
  input: TransitionInput = {},
): Promise<InvoiceDetail> {
  const { rows } = await tx.query<{ status: InvoiceStatus; total: string; paid_amount: string }>(
    'SELECT status, total::text, paid_amount::text FROM invoice WHERE id = $1 FOR UPDATE',
    [id],
  );
  const row = rows[0];
  if (!row) throw new InvoiceNotFound(id);

  const result = applyTransition({ status: row.status, total: row.total, paidAmount: row.paid_amount }, to, input);

  await tx.query(
    `UPDATE invoice
     SET status = $2,
         paid_amount = $3,
         paid_at = CASE WHEN $4::boolean THEN coalesce($5::timestamptz, now()) ELSE paid_at END
     WHERE id = $1`,
    [id, result.status, result.paidAmount, result.setsPaidAt, input.paidAt ?? null],
  );
  const detail = await getInvoice(tx, id);
  if (!detail) throw new InvoiceNotFound(id);
  return detail;
}

export interface FromCampaignOverrides {
  issuedOn?: string;
  dueOn?: string;
  taxRate?: string;
  withholdingRate?: string;
  externalRef?: string | null;
}

/**
 * Prellena y crea (en borrador) la factura de una campaña: empresa,
 * campaign_id, quote_id si la campaña salió de una cotización, y el
 * monto acordado (con IVA incluido) descompuesto en subtotal + IVA.
 * Vence a los días de plazo de la cotización, o a 30.
 */
export async function createInvoiceFromCampaign(
  tx: WorkspaceTx,
  campaignId: string,
  overrides: FromCampaignOverrides = {},
): Promise<InvoiceDetail> {
  const { rows } = await tx.query<{
    id: string; name: string; company_id: string; quote_id: string | null; amount: string | null; currency: string;
    payment_terms_days: number | null; today: string;
  }>(`
    SELECT ca.id, ca.name, ca.company_id, ca.quote_id, ca.amount::text, ca.currency,
           q.payment_terms_days, to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today
    FROM campaign ca
    LEFT JOIN quote q ON q.id = ca.quote_id
    WHERE ca.id = $1
  `, [campaignId]);
  const camp = rows[0];
  if (!camp) throw new Error('La campaña no existe en este workspace.');
  if (!camp.amount) throw new Error(`La campaña «${camp.name}» no tiene monto acordado: escríbelo a mano.`);

  const taxRate = overrides.taxRate ?? DEFAULT_TAX_RATE;
  const issuedOn = overrides.issuedOn ?? camp.today;
  const dueOn = overrides.dueOn ?? addDays(issuedOn, camp.payment_terms_days ?? 30);

  return createInvoice(tx, {
    companyId: camp.company_id,
    campaignId: camp.id,
    quoteId: camp.quote_id,
    subtotal: subtotalFromTotal(camp.amount, taxRate),
    taxRate,
    withholdingRate: overrides.withholdingRate ?? DEFAULT_WITHHOLDING_RATE,
    issuedOn,
    dueOn,
    externalRef: overrides.externalRef ?? null,
    currency: camp.currency,
  });
}

// =====================================================================
// Gastos (FIN-5)
// ---------------------------------------------------------------------
// `expense` existe desde 0008 con su índice (workspace_id, incurred_on
// DESC), que es exactamente el de la lista por mes: FIN-5 no trae
// migración.
//
// Reglas propias de esta sección:
//   - Al ESCRIBIR, la categoría y la recurrencia son las listas cerradas
//     de @mc/core; al LEER no se valida nada (la columna es texto libre
//     y una fila importada con otra categoría tiene que verse, no
//     tumbar la pantalla).
//   - Los totales del mes y el desglose por categoría salen de un GROUP
//     BY, nunca de la pantalla, y solo suman las filas en la moneda del
//     espacio: las demás se cuentan y se dicen.
//   - No hay borrado. Corregir un gasto es editarlo, y la edición deja
//     bitácora con before/after (decisión 7 de docs/propuestas/FIN-5.md).
// =====================================================================

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Enlace de recibo: http(s) absoluto. Ni `javascript:` ni una ruta relativa. */
const HTTP_URL_RE = /^https?:\/\/[^\s<>"]+$/i;

export interface ExpenseRow {
  id: string;
  /** Texto libre en la base; una de CATEGORIAS_GASTO en lo que escribe la app. */
  category: string;
  vendor: string | null;
  description: string | null;
  /** Decimal como string. La moneda va aparte. */
  amount: string;
  currency: string;
  /** 'YYYY-MM-DD' */
  incurredOn: string;
  isRecurring: boolean;
  /** 'monthly' en el MVP; null si no es recurrente. */
  recurrence: string | null;
  receiptUrl: string | null;
  deductible: boolean;
  /** ISO 8601 en UTC. */
  createdAt: string;
}

export interface ExpenseCategoryTotal {
  category: string;
  total: string;
  count: number;
}

export interface ExpenseMonth {
  /** 'YYYY-MM': el mes que se está mirando. */
  month: string;
  /** Primer día del mes, 'YYYY-MM-DD'. */
  from: string;
  /** Último día del mes, 'YYYY-MM-DD'. */
  to: string;
  /** CURRENT_DATE, para saber si el mes es el de hoy. */
  today: string;
  /** La del espacio: es la de los totales. */
  currency: string;
  rows: ExpenseRow[];
  totals: {
    /** Todo lo del mes en la moneda del espacio. */
    total: string;
    /** Lo recurrente (is_recurring). */
    recurring: string;
    /** Lo deducible. */
    deductible: string;
    count: number;
    recurringCount: number;
    deductibleCount: number;
  };
  byCategory: ExpenseCategoryTotal[];
  /** Gastos del mes en otra moneda: se cuentan, no se suman. */
  otherCurrencyCount: number;
}

export interface RecurringExpenses {
  /** Las filas recurrentes del espacio, en su moneda. Van a proyectarGastosRecurrentes. */
  rows: ExpenseRow[];
  today: string;
  currency: string;
  otherCurrencyCount: number;
}

export interface CreateExpenseInput {
  /** Una de CATEGORIA_GASTO_IDS. */
  category: string;
  vendor?: string | null;
  description?: string | null;
  /** Decimal como string, mayor que cero. */
  amount: string;
  /** 'YYYY-MM-DD' */
  incurredOn: string;
  isRecurring: boolean;
  /** Obligatoria si isRecurring; se ignora si no. */
  recurrence?: string | null;
  /** http(s) absoluto, o nada. */
  receiptUrl?: string | null;
  deductible: boolean;
  /** ISO-4217. Por defecto, la del espacio; tiene que ser la del espacio. */
  currency?: string;
}

export type UpdateExpenseInput = CreateExpenseInput;

export class ExpenseNotFound extends Error {
  readonly messageEs: string;
  constructor(id: string) {
    super(`El gasto ${id} no existe en este espacio.`);
    this.name = 'ExpenseNotFound';
    this.messageEs = this.message;
  }
}

/** Un dato del gasto que no cumple su regla. El mensaje se muestra tal cual. */
export class InvalidExpenseError extends Error {
  readonly field: string | null;
  readonly messageEs: string;
  constructor(message: string, field: string | null = null) {
    super(message);
    this.name = 'InvalidExpenseError';
    this.field = field;
    this.messageEs = message;
  }
}

const SELECT_EXPENSE = `
  SELECT e.id, e.category, e.vendor, e.description, e.amount::text, e.currency,
         to_char(e.incurred_on, 'YYYY-MM-DD') AS incurred_on,
         e.is_recurring, e.recurrence, e.receipt_url, e.deductible,
         to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
  FROM expense e
`;

interface RawExpense {
  id: string;
  category: string;
  vendor: string | null;
  description: string | null;
  amount: string;
  currency: string;
  incurred_on: string;
  is_recurring: boolean;
  recurrence: string | null;
  receipt_url: string | null;
  deductible: boolean;
  created_at: string;
}

function toExpense(r: RawExpense): ExpenseRow {
  return {
    id: r.id,
    category: r.category,
    vendor: r.vendor,
    description: r.description,
    amount: r.amount,
    currency: r.currency,
    incurredOn: r.incurred_on,
    isRecurring: r.is_recurring,
    recurrence: r.recurrence,
    receiptUrl: r.receipt_url,
    deductible: r.deductible,
    createdAt: r.created_at,
  };
}

/**
 * Deja la fila de bitácora del gasto en la MISMA transacción de la
 * escritura: si la escritura hace rollback, la anotación se va con ella.
 *
 * TODO(ACC-2): esto es `audit(tx, { action, entityType, entityId, before,
 * after })` de packages/db/src/audit.ts, que todavía no está en `main`
 * (rama nicolas/ACC-2-bitacora-obligatoria). El INSERT es el mismo, letra
 * por letra, y ACC-2 tendrá que agregar 'expense.created' y
 * 'expense.updated' a AUDIT_ACTIONS. Cuando entre, se borra este helper.
 *
 * El workspace y el actor los pone la BASE (current_workspace_id(),
 * current_user_id()): nada que venga por parámetro puede cambiarlos. El
 * `id` de audit_log no se devuelve (bigserial, contador global; CIM-2 §3).
 */
async function anotarGasto(
  tx: WorkspaceTx,
  action: 'expense.created' | 'expense.updated',
  expenseId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, before, after)
     VALUES (current_workspace_id(), current_user_id(),
             CASE WHEN current_user_id() IS NULL THEN 'system' ELSE 'user' END,
             $1, 'expense', $2::uuid, $3::jsonb, $4::jsonb)`,
    [action, expenseId, before === null ? null : JSON.stringify(before), JSON.stringify(after)],
  );
}

/**
 * Lo que la bitácora guarda de un gasto. Campo por campo, nunca
 * `...row`: el recibo va como un booleano porque un enlace de Drive es
 * una credencial de ese archivo para quien lo tenga, y una credencial no
 * entra en audit_log (regla de secretos del repositorio).
 */
function gastoParaBitacora(e: ExpenseRow): Record<string, unknown> {
  return {
    category: e.category,
    vendor: e.vendor,
    description: e.description,
    amount: e.amount,
    currency: e.currency,
    incurredOn: e.incurredOn,
    isRecurring: e.isRecurring,
    recurrence: e.recurrence,
    deductible: e.deductible,
    receipt: e.receiptUrl !== null,
  };
}

/** Un gasto del espacio por su id, o null. Un id que no es UUID no se consulta (22P02 → 500). */
export async function getExpense(tx: WorkspaceTx, id: string): Promise<ExpenseRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await tx.query<RawExpense>(`${SELECT_EXPENSE} WHERE e.id = $1`, [id]);
  const r = rows[0];
  return r ? toExpense(r) : null;
}

/**
 * Los gastos de un mes ('YYYY-MM'), con el total, el recurrente, el
 * deducible y el desglose por categoría, todo desde SQL. Sin `month`, o
 * con uno mal formado, el mes de CURRENT_DATE: un parámetro de la URL no
 * puede convertirse en un 500.
 */
export async function getExpenseMonth(tx: WorkspaceTx, month?: string | null): Promise<ExpenseMonth> {
  const { currency } = await getWorkspaceSettings(tx);
  const hoy = await tx.query<{ today: string }>(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today`);
  const today = hoy.rows[0]?.today;
  if (!today) throw new Error('La base no devolvió la fecha de hoy.');
  const mes = month && MONTH_RE.test(month) ? month : today.slice(0, 7);
  const primero = `${mes}-01`;

  const filas = await tx.query<RawExpense>(
    `${SELECT_EXPENSE}
     WHERE e.incurred_on >= $1::date AND e.incurred_on < ($1::date + interval '1 month')
     ORDER BY e.incurred_on DESC, e.created_at DESC, e.id`,
    [primero],
  );

  const agregados = await tx.query<{
    from_on: string; to_on: string; total: string; recurring: string; deductible: string;
    count: number; recurring_count: number; deductible_count: number; other_currency_count: number;
  }>(
    `WITH mes AS (
       SELECT $1::date AS d1, ($1::date + interval '1 month')::date AS d2
     ), g AS (
       SELECT e.amount, e.currency, e.is_recurring, e.deductible
       FROM expense e, mes
       WHERE e.incurred_on >= mes.d1 AND e.incurred_on < mes.d2
     )
     SELECT to_char((SELECT d1 FROM mes), 'YYYY-MM-DD') AS from_on,
            to_char((SELECT d2 FROM mes) - 1, 'YYYY-MM-DD') AS to_on,
            -- ::numeric(14,2) antes de ::text: sin él un mes vacío devuelve
            -- '0' y el dinero pierde sus dos decimales a mitad de camino.
            (SELECT coalesce(sum(amount), 0)::numeric(14,2)::text FROM g WHERE currency = $2) AS total,
            (SELECT coalesce(sum(amount), 0)::numeric(14,2)::text FROM g WHERE currency = $2 AND is_recurring) AS recurring,
            (SELECT coalesce(sum(amount), 0)::numeric(14,2)::text FROM g WHERE currency = $2 AND deductible) AS deductible,
            (SELECT count(*)::int FROM g WHERE currency = $2) AS count,
            (SELECT count(*)::int FROM g WHERE currency = $2 AND is_recurring) AS recurring_count,
            (SELECT count(*)::int FROM g WHERE currency = $2 AND deductible) AS deductible_count,
            (SELECT count(*)::int FROM g WHERE currency <> $2) AS other_currency_count`,
    [primero, currency],
  );
  const a = agregados.rows[0];
  if (!a) throw new Error('La consulta de totales del mes no devolvió filas.');

  const porCategoria = await tx.query<{ category: string; total: string; count: number }>(
    `SELECT e.category, sum(e.amount)::numeric(14,2)::text AS total, count(*)::int AS count
     FROM expense e
     WHERE e.incurred_on >= $1::date AND e.incurred_on < ($1::date + interval '1 month')
       AND e.currency = $2
     GROUP BY e.category
     ORDER BY sum(e.amount) DESC, e.category`,
    [primero, currency],
  );

  return {
    month: mes,
    from: a.from_on,
    to: a.to_on,
    today,
    currency,
    rows: filas.rows.map(toExpense),
    totals: {
      total: a.total,
      recurring: a.recurring,
      deductible: a.deductible,
      count: a.count,
      recurringCount: a.recurring_count,
      deductibleCount: a.deductible_count,
    },
    byCategory: porCategoria.rows,
    otherCurrencyCount: a.other_currency_count,
  };
}

/**
 * Las plantillas recurrentes del espacio, en su moneda, para
 * `proyectarGastosRecurrentes` de @mc/core. Devuelve TODAS las filas
 * recurrentes: quién es la plantilla de cada serie lo decide core, que es
 * donde está probado (y donde FIN-6 lo vuelve a necesitar).
 */
export async function listRecurringExpenses(tx: WorkspaceTx): Promise<RecurringExpenses> {
  const { currency } = await getWorkspaceSettings(tx);
  const cabecera = await tx.query<{ today: string; other_currency_count: number }>(
    `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today,
            (SELECT count(*)::int FROM expense
             WHERE is_recurring AND recurrence IS NOT NULL AND currency <> $1) AS other_currency_count`,
    [currency],
  );
  const c = cabecera.rows[0];
  if (!c) throw new Error('La consulta de gastos recurrentes no devolvió filas.');
  const { rows } = await tx.query<RawExpense>(
    `${SELECT_EXPENSE}
     WHERE e.is_recurring AND e.recurrence IS NOT NULL AND e.currency = $1
     ORDER BY e.incurred_on DESC, e.id`,
    [currency],
  );
  return { rows: rows.map(toExpense), today: c.today, currency, otherCurrencyCount: c.other_currency_count };
}

/** Normaliza y valida lo que llega, para crear y para editar con las mismas reglas. */
async function validarGasto(tx: WorkspaceTx, input: CreateExpenseInput): Promise<{
  category: string; vendor: string | null; description: string | null; amount: string; currency: string;
  incurredOn: string; isRecurring: boolean; recurrence: string | null; receiptUrl: string | null; deductible: boolean;
}> {
  if (!esCategoriaGasto(input.category)) {
    throw new InvalidExpenseError(`La categoría «${input.category}» no está en la lista de gastos.`, 'category');
  }
  if (!isIsoDate(input.incurredOn)) {
    throw new InvalidExpenseError('La fecha del gasto debe ser YYYY-MM-DD.', 'incurredOn');
  }
  let amount: string;
  try {
    amount = normalizeDecimal(input.amount);
  } catch {
    throw new InvalidExpenseError('El monto del gasto no es un decimal válido.', 'amount');
  }
  if (compareDecimal(amount, '0.00') <= 0) {
    throw new InvalidExpenseError('El monto del gasto tiene que ser mayor que cero.', 'amount');
  }
  // Misma regla que las facturas: un gasto en otra moneda mezclaría
  // cifras que los KPI del mes suman sin convertir.
  const { currency: wsCurrency } = await getWorkspaceSettings(tx);
  const currency = (input.currency ?? wsCurrency).toUpperCase();
  if (currency !== wsCurrency) {
    throw new InvalidExpenseError(`Los gastos van en la moneda del espacio (${wsCurrency}); recibió ${currency}.`, 'currency');
  }
  let recurrence: string | null = null;
  if (input.isRecurring) {
    const r = input.recurrence ?? '';
    if (!esRecurrencia(r)) {
      throw new InvalidExpenseError('Un gasto recurrente necesita cada cuánto se repite.', 'recurrence');
    }
    recurrence = r;
  }
  const receiptUrl = input.receiptUrl?.trim() || null;
  if (receiptUrl !== null && !HTTP_URL_RE.test(receiptUrl)) {
    throw new InvalidExpenseError('El enlace del recibo tiene que empezar por http:// o https://.', 'receiptUrl');
  }
  return {
    category: input.category,
    vendor: input.vendor?.trim() || null,
    description: input.description?.trim() || null,
    amount,
    currency,
    incurredOn: input.incurredOn,
    isRecurring: input.isRecurring,
    recurrence,
    receiptUrl,
    deductible: input.deductible,
  };
}

/** Registra un gasto y deja su línea de bitácora en la misma transacción. */
export async function createExpense(tx: WorkspaceTx, input: CreateExpenseInput): Promise<ExpenseRow> {
  const v = await validarGasto(tx, input);
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO expense (workspace_id, category, vendor, description, amount, currency,
                          incurred_on, is_recurring, recurrence, receipt_url, deductible)
     VALUES (current_workspace_id(), $1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10)
     RETURNING id`,
    [v.category, v.vendor, v.description, v.amount, v.currency, v.incurredOn, v.isRecurring, v.recurrence, v.receiptUrl, v.deductible],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error('No se pudo registrar el gasto.');
  const gasto = await getExpense(tx, id);
  if (!gasto) throw new ExpenseNotFound(id);
  await anotarGasto(tx, 'expense.created', id, null, gastoParaBitacora(gasto));
  return gasto;
}

/**
 * Corrige un gasto. Deja bitácora con SOLO los campos que cambian, en
 * `before` y en `after`. Si nada cambia no escribe nada —ni la fila ni la
 * bitácora—: guardar dos veces el mismo formulario no deja dos líneas.
 */
export async function updateExpense(tx: WorkspaceTx, id: string, input: UpdateExpenseInput): Promise<ExpenseRow> {
  if (!isUuid(id)) throw new ExpenseNotFound(id);
  // FOR UPDATE en la misma transacción: si la validación falla, no se
  // escribe nada, y nadie más mueve la fila mientras se compara.
  const actual = await tx.query<RawExpense>(`${SELECT_EXPENSE} WHERE e.id = $1 FOR UPDATE OF e`, [id]);
  const antes = actual.rows[0] ? toExpense(actual.rows[0]) : null;
  if (!antes) throw new ExpenseNotFound(id);

  const v = await validarGasto(tx, input);
  await tx.query(
    `UPDATE expense
     SET category = $2, vendor = $3, description = $4, amount = $5, currency = $6,
         incurred_on = $7::date, is_recurring = $8, recurrence = $9, receipt_url = $10, deductible = $11
     WHERE id = $1`,
    [id, v.category, v.vendor, v.description, v.amount, v.currency, v.incurredOn, v.isRecurring, v.recurrence, v.receiptUrl, v.deductible],
  );
  const despues = await getExpense(tx, id);
  if (!despues) throw new ExpenseNotFound(id);

  const a = gastoParaBitacora(antes);
  const b = gastoParaBitacora(despues);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const clave of Object.keys(b)) {
    if (a[clave] !== b[clave]) {
      before[clave] = a[clave];
      after[clave] = b[clave];
    }
  }
  if (Object.keys(after).length > 0) await anotarGasto(tx, 'expense.updated', id, before, after);
  return despues;
}
