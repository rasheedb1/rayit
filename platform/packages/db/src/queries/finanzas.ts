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
  computeInvoiceTotals,
  deriveStatus,
  nextInvoiceNumber,
  parseInvoiceNumber,
  normalizeDecimal,
  pctToRate,
  proyeccionDePlataformas,
  subDecimal,
  subtotalFromTotal,
  toCents,
  transitionInvoice as applyTransition,
  DEFAULT_TAX_RATE,
  DEFAULT_WITHHOLDING_RATE,
  type AgingBucket,
  type CashflowInput,
  type FacturaPorCobrar,
  type GastoRecurrente,
  type InvoiceStatus,
  type NegocioGanado,
  type ProyeccionDePlataformas,
  type TransitionInput,
} from '@mc/core';
import { PAYOUT_SOURCES } from '../schema/finanzas.ts';
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
  /**
   * De dónde sale `otrosIngresosMensual` (FIN-7): cuántos meses cerrados
   * se promediaron y cuáles. La pantalla lo escribe en la nota del
   * gráfico, porque una cifra estimada sin su fuente no se puede
   * comprobar.
   */
  otrosIngresos: ProyeccionDePlataformas;
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
  plataformas: { mes: string; monto: string }[];
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
    ), plataformas AS (
      -- Los ingresos de plataformas por mes (FIN-7), solo en la moneda
      -- del espacio y de los últimos doce meses: quien promedia es
      -- proyeccionDePlataformas, que sabe cuáles están cerrados y que
      -- sin ninguno el estimado es null y no cero. Aquí no se rellenan
      -- los meses vacíos: un mes sin fila no viaja como "0".
      SELECT coalesce(json_agg(json_build_object('mes', m.mes, 'monto', m.monto) ORDER BY m.mes DESC), '[]'::json) AS v
        FROM (
          SELECT to_char(p.period_start, 'YYYY-MM') AS mes, sum(p.amount)::text AS monto
            FROM platform_payout p, ws
           WHERE p.currency = ws.currency
             AND p.period_start >= (date_trunc('month', ws.hoy) - interval '12 months')::date
           GROUP BY 1
        ) m
    )
    SELECT ws.currency, to_char(ws.hoy, 'YYYY-MM-DD') AS today, ws.reserva_pct, ws.plazo_dias,
           facturas.v AS facturas, negocios.v AS negocios, gastos.v AS gastos,
           plataformas.v AS plataformas
      FROM ws, facturas, negocios, gastos, plataformas
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
  const currency = r.currency.toUpperCase();
  // El estimado de los ingresos de plataformas lo calcula @mc/core, con
  // el día del WORKSPACE (ws.hoy), que es el mismo con el que se
  // reparten las semanas: dos relojes distintos dejarían el promedio y
  // la proyección hablando de meses distintos.
  const otrosIngresos = proyeccionDePlataformas(r.plataformas, { hoy: r.today, currency });
  return {
    today: r.today,
    currency,
    reservaPct: r.reserva_pct,
    // Sin porcentaje configurado (FIN-8 todavía no existe) no se
    // inventa uno: la reserva es cero y la pantalla lo dice con una
    // frase, que es distinto de apartar el 11 % de nadie.
    reservaRate: r.reserva_pct === null ? '0' : pctToRate(r.reserva_pct),
    plazoDias: Number.isInteger(plazo) && plazo >= 0 ? plazo : PLAZO_DIAS_POR_DEFECTO,
    facturas: r.facturas,
    negocios: r.negocios,
    gastos: r.gastos,
    otrosIngresos,
    otrosIngresosMensual: otrosIngresos.estimado,
  };
}

// ---------------------------------------------------------------------
// FIN-7 · Ingresos de plataformas (platform_payout)
// ---------------------------------------------------------------------

/**
 * Lo que paga una plataforma por un periodo: AdSense, Creator Rewards,
 * bonos. La tabla es de 0008 y el UNIQUE natural, de 0036.
 *
 * El mes de un pago es el de su `period_start`. Un periodo que cruza el
 * cambio de mes (solo puede llegar por el formato genérico, donde la
 * persona escribe inicio y fin) cuenta entero en el mes en que empieza:
 * repartirlo por días sería inventar una distribución que el archivo no
 * dice.
 */
export interface PlatformPayoutRow {
  id: string;
  platformId: string;
  platformName: string;
  creatorId: string | null;
  creatorName: string | null;
  /** 'YYYY-MM-DD'. */
  periodStart: string;
  periodEnd: string;
  /** 'YYYY-MM' del period_start. */
  month: string;
  amount: string;
  currency: string;
  source: PayoutSource;
  /** ISO en UTC. */
  createdAt: string;
}

/** 'api' | 'csv_import' | 'manual'. La lista es la del esquema (0008), no una copia. */
export type PayoutSource = (typeof PAYOUT_SOURCES)[number];

export interface ListPlatformPayoutsResult {
  rows: PlatformPayoutRow[];
}

export interface PlatformPayoutInput {
  platformId: string;
  creatorId?: string | null;
  /** 'YYYY-MM-DD'. */
  periodStart: string;
  periodEnd: string;
  amount: string;
  currency: string;
  source: PayoutSource;
}

/**
 * Lo que la persona puede arreglar en su archivo o en su formulario: una
 * red que no existe, un periodo al revés, otra moneda. Se distingue por
 * su clase para que la pantalla enseñe SU frase y no la de Postgres: un
 * «numeric field overflow» no le dice nada a nadie y puede filtrar la
 * forma de una consulta.
 */
export class PlatformPayoutInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformPayoutInputError';
  }
}

/** Un pago que no se escribió porque su periodo ya existe con OTRO monto. */
export interface ConflictingPayout {
  platformId: string;
  /** El nombre del catálogo («YouTube»), para la frase: un id no es un texto de interfaz. */
  platformName: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  /** Lo que trae el archivo. */
  amount: string;
  /** Lo que ya está guardado. */
  existingAmount: string;
}

export interface ImportPlatformPayoutsResult {
  /** Filas nuevas que quedaron escritas. */
  inserted: number;
  /** Filas idénticas a una que ya estaba: el UNIQUE de 0034 las descartó. */
  duplicated: number;
  /** Mismo periodo y misma red, monto distinto: no se escriben ni se pisan. */
  conflicting: ConflictingPayout[];
}

/**
 * Las redes del catálogo (0002), para el selector de «Agregar a mano» y
 * para validar la columna de plataforma de un CSV.
 *
 * Se lee DENTRO de la transacción del workspace y no por
 * `withCatalogs`: `platform` es un catálogo global sin RLS (está en
 * EXCEPCIONES_SIN_AISLAMIENTO con su motivo) y mc_app solo tiene SELECT,
 * así que leerlo aquí no abre nada y le ahorra a la pantalla una
 * conexión más. La web no tiene un `CatalogDb` a mano: `@/lib/db` solo
 * expone `withWorkspace`, y ese es el punto.
 */
export async function listPayoutPlatforms(tx: WorkspaceTx): Promise<{ id: string; name: string }[]> {
  const { rows } = await tx.query<{ id: string; name: string }>('SELECT id, name FROM platform ORDER BY name');
  return rows;
}

/**
 * Hoy en la zona del ESPACIO, 'YYYY-MM-DD'.
 *
 * No `CURRENT_DATE`, que es la fecha del servidor de base: a las 02:00
 * UTC en Bogotá todavía es ayer, y con esa fecha un periodo que acaba de
 * cerrar parecería abierto. Es la misma regla que `getCashflowInputs`
 * (FIN-6), escrita una vez.
 */
export async function getWorkspaceToday(tx: WorkspaceTx): Promise<string> {
  const { rows } = await tx.query<{ hoy: string }>(
    `SELECT to_char((now() AT TIME ZONE w.timezone)::date, 'YYYY-MM-DD') AS hoy
       FROM workspace w WHERE w.id = current_workspace_id()`,
  );
  const hoy = rows[0]?.hoy;
  if (!hoy) throw new Error(`El workspace ${tx.workspaceId} no existe en esta base.`);
  return hoy;
}

/** Los ids del catálogo. Se lee una vez por importación, no una por fila. */
async function knownPlatformIds(tx: WorkspaceTx): Promise<Set<string>> {
  return new Set((await listPayoutPlatforms(tx)).map((p) => p.id));
}

/**
 * Valida un lote contra el catálogo, la moneda del workspace y el
 * formato de las fechas. Lanza con una frase que nombra la fila: un
 * error que dice «fila 4» se arregla en el archivo; uno que dice
 * «violates check constraint» se lleva a soporte.
 */
function assertPayoutShape(input: PlatformPayoutInput, platforms: Set<string>, wsCurrency: string, where: string): void {
  if (!platforms.has(input.platformId)) {
    throw new PlatformPayoutInputError(`${where}: «${input.platformId}» no es una red conocida.`);
  }
  if (!ISO_DATE_RE.test(input.periodStart) || !ISO_DATE_RE.test(input.periodEnd)) {
    throw new PlatformPayoutInputError(`${where}: las fechas del periodo deben ser YYYY-MM-DD.`);
  }
  if (input.periodEnd < input.periodStart) {
    throw new PlatformPayoutInputError(`${where}: el fin del periodo no puede ser anterior a su inicio.`);
  }
  if (input.currency.toUpperCase() !== wsCurrency) {
    throw new PlatformPayoutInputError(
      `${where}: los ingresos de plataformas van en la moneda del espacio (${wsCurrency}); recibió ${input.currency.toUpperCase()}.`,
    );
  }
  if (!(PAYOUT_SOURCES as readonly string[]).includes(input.source)) {
    throw new PlatformPayoutInputError(`${where}: origen desconocido «${input.source}».`);
  }
}

const SELECT_PAYOUT = `
  SELECT p.id,
         p.platform_id,
         pl.name AS platform_name,
         p.creator_id,
         cp.display_name AS creator_name,
         to_char(p.period_start, 'YYYY-MM-DD') AS period_start,
         to_char(p.period_end, 'YYYY-MM-DD') AS period_end,
         to_char(p.period_start, 'YYYY-MM') AS month,
         p.amount::text,
         p.currency,
         p.source,
         p.created_at
  FROM platform_payout p
  JOIN platform pl ON pl.id = p.platform_id
  LEFT JOIN creator_profile cp ON cp.id = p.creator_id`;

interface RawPayout {
  id: string;
  platform_id: string;
  platform_name: string;
  creator_id: string | null;
  creator_name: string | null;
  period_start: string;
  period_end: string;
  month: string;
  amount: string;
  currency: string;
  source: PayoutSource;
  created_at: Date | string;
}

function toPayoutRow(r: RawPayout): PlatformPayoutRow {
  return {
    id: r.id,
    platformId: r.platform_id,
    platformName: r.platform_name,
    creatorId: r.creator_id,
    creatorName: r.creator_name,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    month: r.month,
    amount: r.amount,
    currency: r.currency,
    source: r.source,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/**
 * Los ingresos de plataformas del workspace, del periodo más reciente al
 * más viejo. RLS filtra: desde otro workspace, cero filas.
 *
 * Los totales POR MES no salen de aquí: los pide quien los necesita, con
 * `getPlatformPayoutMonths` (el promedio) o `getPlatformPayoutKpis` (las
 * cifras de cabecera). Llegó a devolverlos siempre, con un `GROUP BY`
 * sin límite que ninguna pantalla leía.
 */
export async function listPlatformPayouts(
  tx: WorkspaceTx,
  params: { limit?: number } = {},
): Promise<ListPlatformPayoutsResult> {
  const limit = Math.min(500, Math.max(1, params.limit ?? 200));
  const { rows } = await tx.query<RawPayout>(
    `${SELECT_PAYOUT} ORDER BY p.period_start DESC, pl.name, p.created_at DESC LIMIT $1`,
    [limit],
  );
  return { rows: rows.map(toPayoutRow) };
}

/**
 * Los totales por mes en la moneda del workspace, listos para
 * `proyeccionDePlataformas` de @mc/core.
 *
 * Devuelve `{ mes, monto }` —el contrato de `MesConIngreso`— y NO
 * rellena los meses vacíos: un mes sin fila no viaja como "0". Quién
 * cuenta como cero y quién como «sin medir» lo decide la función de
 * core, que es donde está probado.
 */
export async function getPlatformPayoutMonths(
  tx: WorkspaceTx,
  params: { months?: number } = {},
): Promise<{ mes: string; monto: string }[]> {
  const months = Math.min(36, Math.max(1, params.months ?? 12));
  const { currency } = await getWorkspaceSettings(tx);
  // El día sale de la zona del ESPACIO y no de CURRENT_DATE, que es la
  // del servidor de base: a las 02:00 UTC en Bogotá todavía es ayer, y
  // un pago del mes pasado no puede caerse de la ventana por eso. Es la
  // misma regla que getCashflowInputs (FIN-6).
  const { rows } = await tx.query<{ mes: string; monto: string }>(
    `WITH ws AS (
       SELECT (now() AT TIME ZONE w.timezone)::date AS hoy
         FROM workspace w WHERE w.id = current_workspace_id()
     )
     SELECT to_char(p.period_start, 'YYYY-MM') AS mes, sum(p.amount)::text AS monto
     FROM platform_payout p, ws
     WHERE p.currency = $1
       AND p.period_start >= (date_trunc('month', ws.hoy) - make_interval(months => $2))::date
     GROUP BY 1
     ORDER BY 1 DESC`,
    [currency, months],
  );
  return rows;
}

export interface PlatformPayoutKpis {
  /** Lo que llevan pagado las plataformas en el año en curso, en la moneda del espacio. */
  ytd: string;
  /** Cuántos pagos lo componen. */
  ytdPayouts: number;
  /** El total del último mes CERRADO, o null si ese mes no tiene ninguna fila. Nunca "0". */
  lastMonth: string | null;
  /** 'YYYY-MM' de ese mes cerrado. */
  lastMonthLabel: string;
  currency: string;
  /**
   * 'YYYY-MM-DD' de hoy en la zona del ESPACIO (no `CURRENT_DATE`, que
   * es la del servidor): la ventana del promedio se calcula con este
   * día, igual que el flujo de caja de FIN-6.
   */
  today: string;
}

/** Las cifras de cabecera de /finanzas/ingresos. Las suma la base; la pantalla no hace aritmética. */
export async function getPlatformPayoutKpis(tx: WorkspaceTx): Promise<PlatformPayoutKpis> {
  const { currency } = await getWorkspaceSettings(tx);
  const { rows } = await tx.query<{
    ytd: string; ytd_payouts: string; last_month: string | null; last_month_label: string; today: string;
  }>(
    `WITH ws AS (
       SELECT (now() AT TIME ZONE w.timezone)::date AS hoy
         FROM workspace w WHERE w.id = current_workspace_id()
     ), ultimo AS (
       SELECT (date_trunc('month', ws.hoy) - interval '1 month')::date AS inicio,
              date_trunc('month', ws.hoy)::date AS mes_en_curso,
              date_trunc('year', ws.hoy)::date AS anio,
              (date_trunc('year', ws.hoy) + interval '1 year')::date AS anio_siguiente,
              ws.hoy
         FROM ws
     )
     -- Con tope por arriba: sin él, un pago fechado por error en el año
     -- que viene se sumaba a «Recibido en <este año>». El de abajo ya lo
     -- tenía; este no, y eran la misma cifra mal contada.
     SELECT coalesce((SELECT sum(p.amount) FROM platform_payout p, ultimo
                       WHERE p.currency = $1
                         AND p.period_start >= ultimo.anio
                         AND p.period_start < ultimo.anio_siguiente), 0)::text AS ytd,
            (SELECT count(*) FROM platform_payout p, ultimo
              WHERE p.currency = $1
                AND p.period_start >= ultimo.anio
                AND p.period_start < ultimo.anio_siguiente)::text AS ytd_payouts,
            -- Sin coalesce a propósito: sum() de cero filas es NULL, que
            -- es justo lo que queremos. Un mes sin pago no vale cero.
            (SELECT sum(p.amount)::text FROM platform_payout p, ultimo
              WHERE p.currency = $1
                AND p.period_start >= ultimo.inicio
                AND p.period_start < ultimo.mes_en_curso) AS last_month,
            to_char(ultimo.inicio, 'YYYY-MM') AS last_month_label,
            to_char(ultimo.hoy, 'YYYY-MM-DD') AS today
     FROM ultimo`,
    [currency],
  );
  const r = rows[0];
  return {
    ytd: r?.ytd ?? '0',
    ytdPayouts: Number(r?.ytd_payouts ?? '0'),
    lastMonth: r?.last_month ?? null,
    lastMonthLabel: r?.last_month_label ?? '',
    currency,
    today: r?.today ?? '',
  };
}

/**
 * Escribe un lote de pagos, UNA sola vez cada uno.
 *
 * La idempotencia la pone el UNIQUE natural de 0036 y el `ON CONFLICT DO
 * NOTHING`, no una lectura previa: deduplicar comparando en TypeScript
 * es una condición de carrera con dos pestañas abiertas, y la
 * idempotencia de una cifra de dinero no puede depender de que nadie
 * pulse dos veces.
 *
 * Antes de escribir se aparta un caso que el UNIQUE no ve: un archivo
 * CORREGIDO, con el mismo periodo y la misma red pero otro monto. Como
 * el monto entra en la clave, ese pago se escribiría como una fila
 * NUEVA y el mes valdría el doble, en silencio. Sale en `conflicting` y
 * no se escribe ni se pisa: corregir un monto ya cargado es otra
 * historia (docs/propuestas/FIN-7.md §0.7), y sobrescribir dinero sin
 * pedir permiso no es una opción.
 */
export async function importPlatformPayouts(
  tx: WorkspaceTx,
  inputs: readonly PlatformPayoutInput[],
): Promise<ImportPlatformPayoutsResult> {
  if (inputs.length === 0) return { inserted: 0, duplicated: 0, conflicting: [] };

  // Una detrás de otra, NO con Promise.all: las dos corren sobre la
  // MISMA transacción, que es una sola conexión. Lanzarlas a la vez
  // encola la segunda detrás de la primera en el cliente de PGlite y la
  // prueba se quedaba colgada hasta el timeout, sin decir por qué.
  const platforms = await knownPlatformIds(tx);
  const { currency: wsCurrency } = await getWorkspaceSettings(tx);
  inputs.forEach((input, i) => assertPayoutShape(input, platforms, wsCurrency, `Fila ${i + 1}`));

  // Qué periodos de este lote ya existen, y con qué monto. Una sola
  // consulta para todo el lote, no una por fila.
  const existentes = await tx.query<{
    platform_id: string; platform_name: string; creator_id: string | null; period_start: string; period_end: string;
    currency: string; amount: string;
  }>(
    `SELECT p.platform_id,
            pl.name AS platform_name,
            p.creator_id,
            to_char(p.period_start, 'YYYY-MM-DD') AS period_start,
            to_char(p.period_end, 'YYYY-MM-DD') AS period_end,
            p.currency,
            p.amount::text
     FROM platform_payout p
     JOIN platform pl ON pl.id = p.platform_id
     WHERE (p.platform_id, coalesce(p.creator_id, $1::uuid), p.period_start, p.period_end, p.currency)
           IN (SELECT platform_id, coalesce(creator_id, $1::uuid), period_start, period_end, currency
               FROM unnest($2::text[], $3::uuid[], $4::date[], $5::date[], $6::text[])
                 AS l(platform_id, creator_id, period_start, period_end, currency))`,
    [
      SIN_CREADOR,
      inputs.map((i) => i.platformId),
      inputs.map((i) => i.creatorId ?? SIN_CREADOR),
      inputs.map((i) => i.periodStart),
      inputs.map((i) => i.periodEnd),
      inputs.map((i) => i.currency.toUpperCase()),
    ],
  );
  const guardado = new Map(
    existentes.rows.map((r) => [
      clavePeriodo(r.platform_id, r.creator_id, r.period_start, r.period_end, r.currency),
      { amount: r.amount, name: r.platform_name },
    ]),
  );

  const conflicting: ConflictingPayout[] = [];
  const escribibles: PlatformPayoutInput[] = [];
  for (const input of inputs) {
    const currency = input.currency.toUpperCase();
    const existente = guardado.get(
      clavePeriodo(input.platformId, input.creatorId ?? null, input.periodStart, input.periodEnd, currency),
    );
    if (existente !== undefined && toCents(existente.amount) !== toCents(input.amount)) {
      conflicting.push({
        platformId: input.platformId,
        platformName: existente.name,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        currency,
        amount: normalizeDecimal(input.amount),
        existingAmount: existente.amount,
      });
      continue;
    }
    escribibles.push(input);
  }
  if (escribibles.length === 0) return { inserted: 0, duplicated: 0, conflicting };

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO platform_payout (workspace_id, creator_id, platform_id, period_start, period_end, amount, currency, source)
     SELECT current_workspace_id(), l.creator_id, l.platform_id, l.period_start, l.period_end, l.amount, l.currency, l.source
     FROM unnest($1::text[], $2::uuid[], $3::date[], $4::date[], $5::numeric[], $6::text[], $7::text[])
       AS l(platform_id, creator_id, period_start, period_end, amount, currency, source)
     -- CON objetivo, y con el objetivo ESCRITO: un \`ON CONFLICT DO
     -- NOTHING\` a secas no falla cuando el índice no existe, se limita a
     -- no deduplicar. Sobre una base sin 0036 eso es lo peor de los dos
     -- mundos: reimportar el mismo CSV duplicaría el dinero y la
     -- pantalla diría «listo». Nombrando las columnas, Postgres exige un
     -- índice único que las cubra y, si no lo hay, lanza 42P10 con un
     -- mensaje que dice exactamente qué falta aplicar.
     ON CONFLICT (workspace_id, platform_id, coalesce(creator_id, $8::uuid), period_start, period_end, currency, amount)
       DO NOTHING
     RETURNING id`,
    [
      escribibles.map((i) => i.platformId),
      escribibles.map((i) => i.creatorId ?? null),
      escribibles.map((i) => i.periodStart),
      escribibles.map((i) => i.periodEnd),
      escribibles.map((i) => i.amount),
      escribibles.map((i) => i.currency.toUpperCase()),
      escribibles.map((i) => i.source),
      SIN_CREADOR,
    ],
  );
  // La bitácora. Qué hecho es lo dice la columna `source`, que es el
  // dato, no un parámetro nuevo: un pago escrito a mano es
  // 'platform_payout.created' y nombra su fila; un lote de CSV es
  // 'platform_payout.imported' y va sin entityId, porque el hecho son n
  // pagos y ninguno es «el» pago (audit.ts: «null si el hecho no tiene
  // una»). En el `after` van conteos y el rango de periodos, nunca las
  // filas: el dinero de cada pago ya está en su fila.
  // Si el UNIQUE lo descartó TODO no se escribió nada, y lo que no se
  // escribe no es un hecho del negocio: subir dos veces el mismo archivo
  // no deja dos filas en la bitácora.
  if (rows.length === 0) return { inserted: 0, duplicated: escribibles.length, conflicting };
  const aMano = escribibles.every((i) => i.source === 'manual');
  const periodos = escribibles.map((i) => i.periodStart).sort();
  await audit(tx, {
    action: aMano ? 'platform_payout.created' : 'platform_payout.imported',
    entityType: 'platform_payout',
    entityId: aMano && rows.length === 1 ? (rows[0]?.id ?? null) : null,
    before: null,
    after: {
      source: aMano ? 'manual' : 'csv_import',
      currency: wsCurrency,
      platforms: [...new Set(escribibles.map((i) => i.platformId))].sort(),
      from: periodos[0] ?? null,
      to: periodos[periodos.length - 1] ?? null,
      inserted: rows.length,
      duplicated: escribibles.length - rows.length,
      conflicting: conflicting.length,
    },
  });
  return { inserted: rows.length, duplicated: escribibles.length - rows.length, conflicting };
}

/** El uuid con el que `coalesce` normaliza «sin creador» en el UNIQUE de 0036. */
const SIN_CREADOR = '00000000-0000-0000-0000-000000000000';

function clavePeriodo(
  platformId: string,
  creatorId: string | null,
  periodStart: string,
  periodEnd: string,
  currency: string,
): string {
  return [platformId, creatorId ?? SIN_CREADOR, periodStart, periodEnd, currency].join('|');
}

export interface CreatePlatformPayoutResult {
  payout: PlatformPayoutRow | null;
  /** Ya existía una fila idéntica: no se escribió nada. */
  duplicated: boolean;
  /** Mismo periodo y misma red, otro monto. No se escribió nada. */
  conflicting: ConflictingPayout | null;
}

/**
 * «Agregar a mano»: un solo pago, con las mismas tres salidas que el
 * import (escrito / ya estaba / choca con otro monto), para que la
 * pantalla no tenga que distinguir de dónde vino.
 */
export async function createPlatformPayout(
  tx: WorkspaceTx,
  input: PlatformPayoutInput,
): Promise<CreatePlatformPayoutResult> {
  const r = await importPlatformPayouts(tx, [input]);
  if (r.conflicting[0]) return { payout: null, duplicated: false, conflicting: r.conflicting[0] };
  const { rows } = await tx.query<RawPayout>(
    `${SELECT_PAYOUT}
     WHERE p.platform_id = $1
       AND coalesce(p.creator_id, $2::uuid) = coalesce($3::uuid, $2::uuid)
       AND p.period_start = $4::date AND p.period_end = $5::date
       AND p.currency = $6 AND p.amount = $7::numeric
     LIMIT 1`,
    [
      input.platformId, SIN_CREADOR, input.creatorId ?? null,
      input.periodStart, input.periodEnd, input.currency.toUpperCase(), input.amount,
    ],
  );
  const fila = rows[0];
  return {
    payout: fila ? toPayoutRow(fila) : null,
    duplicated: r.inserted === 0,
    conflicting: null,
  };
}
