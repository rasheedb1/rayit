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
 *   - Toda escritura deja su fila en audit_log con audit() (ACC-2), en la
 *     misma transacción y antes de devolver; test/audit-convencion.test.ts
 *     lo exige.
 */
import {
  addDays,
  agingBucket,
  applyPayment,
  compareDecimal,
  computeInvoiceTotals,
  deriveStatus,
  isPaymentMethod,
  nextInvoiceNumber,
  normalizeDecimal,
  parseInvoiceNumber,
  pctToRate,
  reservePeriod,
  reserveRateFrom,
  subDecimal,
  subtotalFromTotal,
  taxReserveFor,
  transitionInvoice as applyTransition,
  DEFAULT_TAX_RATE,
  DEFAULT_WITHHOLDING_RATE,
  InvoicePaymentConflict,
  type AgingBucket,
  type CashflowInput,
  type FacturaPorCobrar,
  type GastoRecurrente,
  type InvoiceStatus,
  type NegocioGanado,
  type PaymentMethod,
  type TransitionInput,
} from '@mc/core';
import { getWorkspaceSettings } from './cimientos.ts';
import { audit, type AuditAction } from '../audit.ts';
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
  // La bitácora guarda la factura tal como nació: su número, su empresa y
  // sus cifras. Es dinero de ESTA entidad, no de otra.
  await audit(tx, {
    action: 'invoice.created',
    entityType: 'invoice',
    entityId: id,
    before: null,
    after: {
      number: detail.number, companyId: detail.companyId, campaignId: detail.campaignId, quoteId: detail.quoteId,
      currency: detail.currency, subtotal: detail.subtotal, tax: detail.tax, withholding: detail.withholding, total: detail.total,
      issuedOn: detail.issuedOn, dueOn: detail.dueOn, status: detail.status, externalRef: detail.externalRef,
    },
  });
  return detail;
}

/** Qué evento de bitácora es cada estado al que llega una factura (ACC-2). */
const INVOICE_TRANSITION_ACTION: Record<InvoiceStatus, AuditAction> = {
  draft: 'invoice.reopened',
  sent: 'invoice.sent',
  partial: 'invoice.payment_recorded',
  paid: 'invoice.paid',
  overdue: 'invoice.marked_overdue',
  void: 'invoice.voided',
};

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
  await audit(tx, {
    action: INVOICE_TRANSITION_ACTION[result.status],
    entityType: 'invoice',
    entityId: id,
    before: { status: row.status, paidAmount: row.paid_amount },
    after: { status: detail.status, paidAmount: detail.paidAmount, paidAt: detail.paidAt },
  });
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

// ---------------------------------------------------------------------
// Pagos (FIN-2)
// ---------------------------------------------------------------------

/**
 * Las frases que Finanzas deja escritas en tablas de otros módulos.
 * Igual que `TextosCotizar` (queries/cotizar/cotizacion.ts): las compone
 * la web con su messages.ts y llegan aquí ya en el idioma y el formato
 * de la pantalla, porque este paquete no tiene idioma y `formatterFor`
 * vive en la web. `notification.title_es` es NOT NULL desde 0009, así
 * que hace falta una frase, no solo un código; junto a ella se guardan
 * el código y la entidad (`kind` + `entity_id`) para que quien quiera
 * otra frase la recomponga.
 */
export interface TextosFinanzas {
  /** El aviso al creador cuando entra un cobro. */
  avisoPagoRecibido(p: {
    invoiceNumber: string;
    companyName: string;
    amount: string;
    currency: string;
    /** En qué quedó la factura. */
    status: 'partial' | 'paid';
    /** Lo que sigue debiendo. '0.00' si quedó pagada. */
    outstanding: string;
  }): { title: string; body: string };
}

export interface RecordPaymentInput {
  invoiceId: string;
  /** Decimal como string. Mayor que cero y no más que el saldo. */
  amount: string;
  /** El día del cobro, 'YYYY-MM-DD', en la zona del workspace. */
  receivedOn: string;
  method: PaymentMethod;
  /** Lo que dice el extracto del banco. Opcional; no llega a la bitácora. */
  reference?: string | null;
  notes?: string | null;
  /**
   * El `paid_amount` que la pantalla vio al dibujar el formulario. Si
   * cambió, el pago no se registra: o entró otro cobro en medio, o es el
   * mismo formulario enviado dos veces (docs/propuestas/FIN-2.md §0.5).
   */
  expectedPaidAmount: string;
}

export interface PaymentRow {
  id: string;
  amount: string;
  currency: string;
  method: string | null;
  /** Instante ISO en UTC. */
  receivedAt: string;
  /** El día del cobro en la zona del workspace, 'YYYY-MM-DD'. */
  receivedOn: string;
  reference: string | null;
  notes: string | null;
  /** Lo apartado por este cobro, o null si el espacio no aparta impuestos. */
  reserved: string | null;
  /** La tasa con la que se apartó ('0.1100'), o null. */
  reserveRate: string | null;
  /** '2026-Q3', o null. */
  reservePeriod: string | null;
}

export interface InvoicePayments {
  rows: PaymentRow[];
  /** Suma de lo apartado por los cobros de esta factura. '0.00' si no hay nada. */
  reservedTotal: string;
  /** La tasa del último apartado, para escribir «(11 %)». null si no hay ninguno. */
  reserveRate: string | null;
}

export interface RecordPaymentResult {
  invoice: InvoiceDetail;
  payment: PaymentRow;
}

/** Lo que la fila `workspace` aporta a un cobro, leído en la misma transacción. */
interface WorkspacePaymentContext {
  currency: string;
  /** El valor crudo de settings.finanzas.reserva_pct, tal como está en el jsonb. */
  reservaPct: unknown;
  /** La zona del espacio, ya resuelta ('America/Bogota', o 'UTC' si no tiene). */
  timeZone: string;
  /** Hoy en la zona del workspace, 'YYYY-MM-DD'. */
  today: string;
  /**
   * El instante del cobro, ISO en UTC y con precisión de segundo, para
   * las reglas de core. El que se GUARDA lo calcula el propio INSERT con
   * la misma expresión: así conserva los microsegundos de `now()` y dos
   * cobros del mismo segundo siguen teniendo un orden.
   */
  receivedAt: string;
}

/**
 * El instante que se guarda en `payment.received_at`, como expresión SQL.
 *
 * Si el día elegido es HOY en la zona del espacio, el instante es
 * `now()` —el cobro se está registrando ahora—; si es un día pasado, es
 * el comienzo de ese día en su zona. Así ningún `received_at` queda en
 * el futuro (lo que rompería «cobrado este año» y la verificación del
 * seed) y el día que la pantalla enseña es el que la persona eligió.
 *
 * Es una expresión y no un valor calculado en JavaScript porque depende
 * de la zona del espacio, que vive en la base, y porque al escribirla
 * directamente en el INSERT conserva los microsegundos de `now()`: dos
 * cobros del mismo segundo siguen teniendo un orden en la lista.
 *
 * @param fecha  el marcador del día elegido ('$1'), 'YYYY-MM-DD'
 * @param zona   la expresión SQL con la zona ya resuelta
 */
function instanteDelCobro(fecha: string, zona: string): string {
  return `CASE WHEN ${fecha}::date = (now() AT TIME ZONE ${zona})::date
               THEN now()
               ELSE (${fecha}::date)::timestamp AT TIME ZONE ${zona}
          END`;
}

/**
 * Moneda, porcentaje de reserva, hoy y el instante del cobro, todo de la
 * fila `workspace` y en una sola ida a la base.
 *
 * El instante se resuelve aquí y no en JavaScript porque depende de la
 * zona del espacio: si el día elegido es HOY, el instante es `now()` —el
 * cobro se está registrando ahora—; si es un día pasado, es el comienzo
 * de ese día en su zona. Así ningún `received_at` queda en el futuro (lo
 * que rompería «cobrado este año» y la verificación del seed) y el día
 * que la pantalla enseña es el que la persona eligió.
 */
async function readWorkspaceForPayment(tx: WorkspaceTx, receivedOn: string): Promise<WorkspacePaymentContext> {
  const { rows } = await tx.query<{
    currency: string; reserva_pct: unknown; time_zone: string; today: string; received_at: string;
  }>(
    `SELECT w.currency,
            w.settings #> '{finanzas,reserva_pct}' AS reserva_pct,
            coalesce(nullif(w.timezone, ''), 'UTC') AS time_zone,
            to_char((now() AT TIME ZONE coalesce(nullif(w.timezone, ''), 'UTC'))::date, 'YYYY-MM-DD') AS today,
            to_char(${instanteDelCobro('$1', "coalesce(nullif(w.timezone, ''), 'UTC')")} AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS received_at
       FROM workspace w
      WHERE w.id = current_workspace_id()`,
    [receivedOn],
  );
  const r = rows[0];
  if (!r) throw new Error('No se encontró el espacio de trabajo de esta transacción.');
  return {
    currency: r.currency,
    reservaPct: r.reserva_pct,
    timeZone: r.time_zone,
    today: r.today,
    receivedAt: r.received_at,
  };
}

/**
 * Registra un cobro contra una factura, parcial o total, y aparta el
 * porcentaje de impuestos del espacio.
 *
 * Todo ocurre en la transacción de quien llama: la factura se bloquea
 * con FOR UPDATE, se valida con `applyPayment` (@mc/core) y solo entonces
 * se escriben las cuatro filas —cobro, factura, apartado y bitácora— más
 * el aviso. Si algo falla, no queda nada.
 *
 * Aislamiento: la factura se busca sin `workspace_id` porque RLS ya lo
 * fijó; desde otro espacio son cero filas y sale `InvoiceNotFound`, que
 * es también lo que la pantalla convierte en su 404.
 *
 * Idempotencia: `expectedPaidAmount` es el `paid_amount` que la pantalla
 * vio. Si ya no es ese, sale `InvoicePaymentConflict` y no se escribe
 * nada; un doble envío del mismo formulario cae ahí (§0.5 de la
 * propuesta).
 */
export async function recordPayment(
  tx: WorkspaceTx,
  input: RecordPaymentInput,
  textos: TextosFinanzas,
): Promise<RecordPaymentResult> {
  if (!isUuid(input.invoiceId)) throw new InvoiceNotFound(input.invoiceId);
  if (!ISO_DATE_RE.test(input.receivedOn)) throw new Error('La fecha del cobro debe ser YYYY-MM-DD.');
  if (!isPaymentMethod(input.method)) {
    throw new Error(`Método de pago desconocido: "${input.method}".`);
  }

  // 1 · La factura, bloqueada hasta el final de la transacción: dos
  //     cobros concurrentes sobre la misma se serializan aquí.
  const { rows } = await tx.query<{ status: InvoiceStatus; total: string; paid_amount: string; currency: string }>(
    'SELECT status, total::text, paid_amount::text, currency FROM invoice WHERE id = $1 FOR UPDATE',
    [input.invoiceId],
  );
  const row = rows[0];
  if (!row) throw new InvoiceNotFound(input.invoiceId);

  // 2 · El espacio: moneda, porcentaje de reserva, hoy y el instante.
  const ws = await readWorkspaceForPayment(tx, input.receivedOn);

  // 3 · ¿Sigue siendo la factura que vio la pantalla? (§0.5)
  if (compareDecimal(input.expectedPaidAmount, row.paid_amount) !== 0) {
    throw new InvoicePaymentConflict(normalizeDecimal(input.expectedPaidAmount), normalizeDecimal(row.paid_amount));
  }

  // 4 · Las reglas, puras.
  const result = applyPayment(
    { status: row.status, total: row.total, paidAmount: row.paid_amount },
    { amount: input.amount, receivedOn: input.receivedOn, receivedAt: ws.receivedAt, today: ws.today },
  );

  // 5 · El cobro. La moneda es la de la factura: mezclar monedas en una
  //     misma factura rompería los KPI, que suman sin convertir.
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO payment (workspace_id, invoice_id, direction, amount, currency, method, received_at, reference, notes)
     VALUES (current_workspace_id(), $1, 'in', $2, $3, $4, ${instanteDelCobro('$5', '$6')}, $7, $8)
     RETURNING id`,
    [
      input.invoiceId, result.amount, row.currency, input.method, input.receivedOn, ws.timeZone,
      input.reference?.trim() || null, input.notes?.trim() || null,
    ],
  );
  const paymentId = inserted.rows[0]?.id;
  if (!paymentId) throw new Error('No se pudo registrar el pago.');

  // 6 · La factura. `updated_at` lo pone el disparador invoice_updated (0008).
  await tx.query(
    `UPDATE invoice
        SET status = $2,
            paid_amount = $3,
            paid_at = CASE WHEN $4::boolean
                           THEN (SELECT p.received_at FROM payment p WHERE p.id = $5)
                           ELSE paid_at END
      WHERE id = $1`,
    [input.invoiceId, result.status, result.paidAmount, result.paidAt !== null, paymentId],
  );

  // 7 · El apartado, con la tasa de ESTE momento: cuando FIN-8 cambie el
  //     porcentaje, los apartados anteriores no se tocan.
  const rate = reserveRateFrom(ws.reservaPct);
  if (rate !== null) {
    await tx.query(
      `INSERT INTO tax_reserve (workspace_id, payment_id, rate, amount, currency, period, released_at)
       VALUES (current_workspace_id(), $1, $2, $3, $4, $5, NULL)`,
      [paymentId, rate, taxReserveFor(result.amount, rate), row.currency, reservePeriod(input.receivedOn)],
    );
  }

  // 8 · La bitácora y el aviso, sobre lo que quedó escrito de verdad.
  const invoice = await getInvoice(tx, input.invoiceId);
  if (!invoice) throw new InvoiceNotFound(input.invoiceId);
  const payment = await getPayment(tx, paymentId);
  if (!payment) throw new Error('El pago se registró pero no se pudo leer de vuelta.');

  // La bitácora (ACC-2), en esta misma transacción: si la escritura se
  // deshace, la fila se va con ella. `before`/`after` llevan solo lo que
  // cambia de la factura y los datos del cobro que no son de nadie: ni
  // nombres, ni correos, ni la `reference` del banco de la marca.
  await audit(tx, {
    action: 'invoice.payment_recorded',
    entityType: 'invoice',
    entityId: invoice.id,
    before: { status: row.status, paidAmount: normalizeDecimal(row.paid_amount) },
    after: {
      status: invoice.status,
      paidAmount: invoice.paidAmount,
      paidAt: invoice.paidAt,
      payment: { id: payment.id, amount: payment.amount, currency: payment.currency, method: payment.method, receivedAt: payment.receivedAt },
      taxReserve: payment.reserved === null ? null : { amount: payment.reserved, rate: payment.reserveRate, period: payment.reservePeriod },
    },
  });

  // 9 · El aviso al creador. Las frases las pone la web (TextosFinanzas).
  const aviso = textos.avisoPagoRecibido({
    invoiceNumber: invoice.number,
    companyName: invoice.companyName,
    amount: payment.amount,
    currency: payment.currency,
    status: result.status,
    outstanding: invoice.outstanding,
  });
  await tx.query(
    `INSERT INTO notification (workspace_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url)
     VALUES (current_workspace_id(), 'payment_received', 'success', $1, $2, 'invoice', $3, $4)`,
    [aviso.title, aviso.body, invoice.id, `/finanzas/facturas/${invoice.id}`],
  );

  return { invoice, payment };
}

const SELECT_PAYMENT = `
  SELECT p.id, p.amount::text, p.currency, p.method,
         to_char(p.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS received_at,
         to_char(p.received_at AT TIME ZONE coalesce(nullif(w.timezone, ''), 'UTC'), 'YYYY-MM-DD') AS received_on,
         p.reference, p.notes,
         tr.amount::text AS reserved, tr.rate::text AS reserve_rate, tr.period AS reserve_period
    FROM payment p
    JOIN workspace w ON w.id = current_workspace_id()
    LEFT JOIN tax_reserve tr ON tr.payment_id = p.id
`;

interface RawPayment {
  id: string; amount: string; currency: string; method: string | null;
  received_at: string; received_on: string; reference: string | null; notes: string | null;
  reserved: string | null; reserve_rate: string | null; reserve_period: string | null;
}

function toPaymentRow(r: RawPayment): PaymentRow {
  return {
    id: r.id,
    amount: r.amount,
    currency: r.currency,
    method: r.method,
    receivedAt: r.received_at,
    receivedOn: r.received_on,
    reference: r.reference,
    notes: r.notes,
    reserved: r.reserved,
    reserveRate: r.reserve_rate,
    reservePeriod: r.reserve_period,
  };
}

/** Un cobro por su id, con lo que apartó. Null si no es de este workspace. */
export async function getPayment(tx: WorkspaceTx, id: string): Promise<PaymentRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await tx.query<RawPayment>(`${SELECT_PAYMENT} WHERE p.id = $1`, [id]);
  const r = rows[0];
  return r ? toPaymentRow(r) : null;
}

/**
 * Los cobros de una factura, el más reciente primero, y lo que se
 * apartó por ellos. La suma la hace Postgres: ninguna pantalla hace
 * aritmética de dinero.
 */
export async function listPayments(tx: WorkspaceTx, invoiceId: string): Promise<InvoicePayments> {
  if (!isUuid(invoiceId)) return { rows: [], reservedTotal: '0.00', reserveRate: null };
  const { rows } = await tx.query<RawPayment>(
    `${SELECT_PAYMENT} WHERE p.invoice_id = $1 AND p.direction = 'in'
      ORDER BY p.received_at DESC, p.id DESC`,
    [invoiceId],
  );
  const total = await tx.query<{ reserved_total: string; reserve_rate: string | null }>(
    // El total sale con dos decimales como cualquier otro monto (sin el
    // cast, `sum` de cero valores devuelve '0' y no '0.00'). La tasa es
    // la del apartado más reciente, con el id como desempate: dos cobros
    // del mismo día se guardan a la misma hora, y desde FIN-8 dos
    // apartados pueden tener tasas distintas.
    `SELECT coalesce(sum(tr.amount), 0)::numeric(14,2)::text AS reserved_total,
            (SELECT tr2.rate::text
               FROM tax_reserve tr2 JOIN payment p2 ON p2.id = tr2.payment_id
              WHERE p2.invoice_id = $1
              ORDER BY p2.received_at DESC, p2.id DESC LIMIT 1) AS reserve_rate
       FROM tax_reserve tr JOIN payment p ON p.id = tr.payment_id
      WHERE p.invoice_id = $1`,
    [invoiceId],
  );
  const t = total.rows[0];
  return {
    rows: rows.map(toPaymentRow),
    reservedTotal: t?.reserved_total ?? '0.00',
    reserveRate: t?.reserve_rate ?? null,
  };
}

// ---------------------------------------------------------------------
// Flujo de caja proyectado (FIN-6)
// ---------------------------------------------------------------------

/**
 * Lo que `projectCashflow` de `@mc/core` necesita, más el porcentaje de
 * reserva tal cual lo guarda el workspace ('11'), que la pantalla
 * enseña en la nota del gráfico.
 */
export interface CashflowInputs extends CashflowInput {
  /** `settings.finanzas.reserva_pct`, o null si el workspace no lo ha configurado (FIN-8). */
  reservaPct: string | null;
}

interface CashflowRawRow {
  currency: string;
  /** Hoy en la zona del workspace, 'YYYY-MM-DD'. */
  today: string;
  reserva_pct: string | null;
  plazo_dias: string | null;
  facturas: FacturaPorCobrar[];
  negocios: NegocioGanado[];
  gastos: GastoRecurrente[];
}

/** El plazo de pago cuando el workspace no tiene uno: el mismo de `createInvoiceFromCampaign`. */
const PLAZO_DIAS_POR_DEFECTO = 30;

/**
 * Todo lo que el flujo de caja necesita, en UNA consulta y en bruto: la
 * clasificación —qué está vencido, qué ya se facturó, qué no tiene
 * fecha, qué viene en otra moneda— la hace la función pura de core,
 * que se prueba en milisegundos (docs/propuestas/FIN-6.md §0.2.10).
 *
 * Qué trae:
 *   - Facturas que todavía deben plata (`sent`, `partial`, `overdue`,
 *     con `total > paid_amount`). El monto es `total − paid_amount`,
 *     que es lo que FIN-2 mantendrá al registrar pagos.
 *   - Negocios en una etapa con `is_won` —nunca por el literal
 *     'ganado': lo dice la vista `deal_pipeline` y el propio seed—,
 *     con la marca de si ya tienen factura por su campaña o por su
 *     cotización. Una factura anulada o en borrador no cuenta como
 *     facturado: si contara, el monto del negocio se caería de la
 *     proyección mientras la factura está en borrador, porque tampoco
 *     está entre las que deben plata.
 *   - Gastos recurrentes de los últimos 120 días, con su `incurred_on`:
 *     core se queda con los del mes más reciente, porque la misma
 *     suscripción está registrada una vez por mes.
 *
 * `today` sale de la zona del WORKSPACE —`(now() AT TIME ZONE
 * w.timezone)::date`— y no de `CURRENT_DATE`, que es la fecha del
 * servidor de base: a las 02:00 UTC en Bogotá todavía es ayer, y una
 * factura que vence hoy no puede aparecer vencida por eso. La prueba
 * comprueba que ese día coincide con `hoyEnZona()` de `@mc/core`, que
 * es la misma regla escrita en TypeScript.
 *
 * Ningún id que vuelve es `bigserial` (CIM-2 §3): son los uuid de
 * `invoice`, `deal` y `expense`.
 */
/*
 * Quien la llama tiene que haber pasado por
 * requirePermission('finanzas.flujo.ver') (ACC-1): lo hace
 * app/(app)/finanzas/flujo/page.tsx en su primera línea. Aquí no se
 * comprueba porque este paquete no conoce la sesión —su barandilla es
 * la RLS del workspace—, y duplicarlo daría dos sitios donde equivocarse.
 */
export async function getCashflowInputs(tx: WorkspaceTx): Promise<CashflowInputs> {
  const { rows } = await tx.query<CashflowRawRow>(`
    WITH ws AS (
      SELECT w.currency,
             (now() AT TIME ZONE w.timezone)::date            AS hoy,
             w.settings #>> '{finanzas,reserva_pct}' AS reserva_pct,
             w.settings #>> '{finanzas,plazo_dias}'  AS plazo_dias
        FROM workspace w
       WHERE w.id = current_workspace_id()
    ), facturas AS (
      SELECT coalesce(json_agg(json_build_object(
               'id',          i.id,
               'number',      i.number,
               'companyName', co.name,
               'currency',    i.currency,
               'outstanding', (i.total - i.paid_amount)::text,
               'dueOn',       to_char(i.due_on, 'YYYY-MM-DD')
             ) ORDER BY i.due_on, i.number), '[]'::json) AS v
        FROM invoice i
        JOIN company co ON co.id = i.company_id
       WHERE i.status IN ('sent', 'partial', 'overdue')
         AND i.total > i.paid_amount
    ), negocios AS (
      SELECT coalesce(json_agg(json_build_object(
               'id',                d.id,
               'name',              d.name,
               'companyName',       co.name,
               'currency',          d.currency,
               'amount',            d.amount::text,
               'expectedCloseDate', to_char(d.expected_close_date, 'YYYY-MM-DD'),
               'hasInvoice',        EXISTS (
                 -- Ni 'void' ni 'draft': un borrador todavía no le debe
                 -- nada a nadie, y el CTE de arriba tampoco lo trae. Si
                 -- contara como «ya facturado», el monto del negocio
                 -- desaparecería de la proyección entre que se crea la
                 -- factura y se marca enviada, que es el camino normal
                 -- (createInvoice siempre inserta en borrador).
                 SELECT 1 FROM invoice i
                  WHERE i.status NOT IN ('void', 'draft')
                    AND (i.campaign_id IN (SELECT c.id FROM campaign c WHERE c.deal_id = d.id)
                      OR i.quote_id    IN (SELECT q.id FROM quote    q WHERE q.deal_id = d.id))
               )
             ) ORDER BY d.expected_close_date NULLS LAST, d.name), '[]'::json) AS v
        FROM deal d
        JOIN pipeline_stage st ON st.id = d.stage_id
        JOIN company co        ON co.id = d.company_id
       WHERE st.is_won
    ), gastos AS (
      SELECT coalesce(json_agg(json_build_object(
               'id',         e.id,
               'label',      coalesce(nullif(e.description, ''), e.category),
               'currency',   e.currency,
               'amount',     e.amount::text,
               'incurredOn', to_char(e.incurred_on, 'YYYY-MM-DD')
             ) ORDER BY e.incurred_on DESC, e.amount DESC), '[]'::json) AS v
        FROM expense e, ws
       WHERE e.is_recurring
         AND e.incurred_on > ws.hoy - 120
    )
    SELECT ws.currency, to_char(ws.hoy, 'YYYY-MM-DD') AS today, ws.reserva_pct, ws.plazo_dias,
           facturas.v AS facturas, negocios.v AS negocios, gastos.v AS gastos
      FROM ws, facturas, negocios, gastos
  `);

  const r = rows[0];
  // Sin fila no hay workspace que proyectar: es un error de
  // configuración (un DEMO_WORKSPACE_ID viejo), no una lista vacía.
  if (!r) {
    throw new Error(
      `El workspace ${tx.workspaceId} no existe en esta base: el flujo de caja no tiene de dónde salir.`,
    );
  }

  const plazo = Number.parseInt(r.plazo_dias ?? '', 10);
  return {
    today: r.today,
    currency: r.currency.toUpperCase(),
    reservaPct: r.reserva_pct,
    // Sin porcentaje configurado (FIN-8 todavía no existe) no se
    // inventa uno: la reserva es cero y la pantalla lo dice con una
    // frase, que es distinto de apartar el 11 % de nadie.
    reservaRate: r.reserva_pct === null ? '0' : pctToRate(r.reserva_pct),
    plazoDias: Number.isInteger(plazo) && plazo >= 0 ? plazo : PLAZO_DIAS_POR_DEFECTO,
    facturas: r.facturas,
    negocios: r.negocios,
    gastos: r.gastos,
  };
}
