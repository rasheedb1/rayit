/**
 * Consultas del módulo Finanzas (FIN-1: facturas; FIN-4: recordatorios).
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
  esCategoriaGasto,
  esRecurrencia,
  isIsoDate,
  isPaymentMethod,
  nextInvoiceNumber,
  normalizeDecimal,
  parseInvoiceNumber,
  pctToRate,
  proyeccionDePlataformas,
  reservePeriod,
  reserveRateFrom,
  subDecimal,
  subtotalFromTotal,
  taxReserveFor,
  toCents,
  transitionInvoice as applyTransition,
  definicionPaso,
  pasoDeUrl,
  financeSettingsToJson,
  parseFinanceSettings,
  InvoicePaymentConflict,
  type AgingBucket,
  type CashflowInput,
  type FacturaPorCobrar,
  type GastoRecurrente,
  type FinanceSettings,
  type InvoiceStatus,
  type NegocioGanado,
  type NumeroPaso,
  type PaymentMethod,
  type ProyeccionDePlataformas,
  type SeveridadRecordatorio,
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

/** Una fila de la bandeja de recordatorios (FIN-4). */
export interface ReminderRow {
  /** El id de la notificación, no el de la factura. */
  id: string;
  /** 1..5: el paso, leído del action_url. */
  paso: NumeroPaso;
  /** 'Primer aviso de mora'. */
  etiquetaEs: string;
  severity: SeveridadRecordatorio;
  /** El asunto del correo, listo para pegar. */
  asunto: string;
  /** El cuerpo del correo, texto plano. */
  cuerpo: string;
  actionUrl: string;
  invoiceId: string;
  invoiceNumber: string;
  companyName: string;
  currency: string;
  /** Saldo pendiente de la factura, string decimal. */
  outstanding: string;
  dueOn: string;
  /** Días de mora hoy; 0 o negativo si todavía no vence. */
  daysOverdue: number;
  createdAt: string;
  /** Cuándo se marcó como enviado; null si sigue pendiente. */
  sentAt: string | null;
}

export interface ListRemindersParams {
  /**
   * Solo los que quedan por mandar: sin marcar Y de una factura que
   * todavía se cobra (`sent` o `partial`). Cuando la factura se paga o
   * se anula, sus borradores dejan de ser trabajo pendiente; siguen
   * visibles en la ficha de la factura, que es su historial.
   */
  pendingOnly?: boolean;
  /** Solo los de esta factura. */
  invoiceId?: string;
  /** 1..{@link MAX_REMINDERS}. Por defecto 50. */
  limit?: number;
}

/** El tope duro de una página de la bandeja. Quien lo alcanza sabe que hay más. */
export const MAX_REMINDERS = 200;
/**
 * Los cuatro estados de mora que devuelve la vista `receivables`
 * (0010). No están `borrador` ni `anulada` de `AgingBucket`: la vista
 * excluye draft y void a propósito, porque una factura que no se ha
 * enviado no es algo que nadie te deba.
 */
export const RECEIVABLE_BUCKETS = ['vencida', 'vence_pronto', 'al_dia', 'pagada'] as const;
export type ReceivableBucket = (typeof RECEIVABLE_BUCKETS)[number];

/** Una fila de cuentas por cobrar: la vista `receivables` más el nombre de la campaña. */
export interface ReceivableRow {
  id: string;
  number: string;
  /** El persistido: sent, partial o paid (la vista excluye draft y void). */
  status: InvoiceStatus;
  bucket: ReceivableBucket;
  companyId: string;
  companyName: string;
  campaignId: string | null;
  campaignName: string | null;
  currency: string;
  total: string;
  paidAmount: string;
  /** total − paid_amount. Es lo que se cobra, no lo que se facturó. */
  outstanding: string;
  dueOn: string;
  /** CURRENT_DATE − due_on. Negativo mientras no venza; 41 es «vencida hace 41 días». */
  daysOverdue: number;
}

export interface ListReceivablesParams {
  /**
   * Un `aging_bucket` concreto. Sin él —lo normal en la pantalla de
   * cobro— devuelve TODO lo que sigue abierto (`status <> 'paid'`), que
   * es lo que suma el KPI «Por cobrar».
   */
  bucket?: ReceivableBucket | null;
  /** Empresa o número de factura. Se ignora con menos de RECEIVABLES_MIN_SEARCH caracteres. */
  q?: string | null;
  /** 1..200. Por defecto 50. */
  limit?: number;
  cursor?: string | null;
}

export interface ListReceivablesResult {
  rows: ReceivableRow[];
  nextCursor: string | null;
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
// FIN-3 · Cuentas por cobrar
// ---------------------------------------------------------------------

/** Desde cuántos caracteres filtra el buscador de cobros. El mismo criterio que Ventas. */
export const RECEIVABLES_MIN_SEARCH = 3;

/**
 * El texto del buscador, listo para la consulta, o null si no llega al
 * mínimo. Es la misma regla que `searchTerm` de queries/ventas.ts y se
 * repite a propósito: son dos módulos con dueños distintos y un cambio
 * de criterio en uno no debe mover el del otro sin que nadie lo vea.
 *
 * Lleva el prefijo del módulo porque este archivo SÍ se reexporta desde
 * la raíz de @mc/db (src/index.ts) y `searchTerm` a secas chocaría con
 * el de Ventas el día que también se reexporte (TS2308).
 */
export function receivablesSearchTerm(raw: string | undefined | null): string | null {
  const q = (raw ?? '').trim();
  return q.length >= RECEIVABLES_MIN_SEARCH ? q : null;
}

/** El texto del usuario con los comodines de LIKE escapados: un `%` suelto no devuelve todo. */
const ESCAPE_LIKE = `replace(replace(replace($2, '\\', '\\\\'), '%', '\\%'), '_', '\\_')`;

/**
 * El orden de cobro, en SQL y en un solo sitio: primero lo vencido,
 * después lo que vence pronto, después lo que está al día y al final lo
 * cobrado. Dentro de cada grupo, `due_on` ascendente —lo que venció
 * hace más tiempo va arriba— y el número descendente para desempatar.
 *
 * `due_on ASC` es exactamente `days_overdue DESC` (days_overdue es
 * CURRENT_DATE − due_on), pero `due_on` no cambia al pasar la
 * medianoche: por eso el cursor se ancla a él y no al número de días,
 * y una página pedida a las 23:59 y la siguiente a las 00:01 no se
 * saltan ni repiten una fila.
 */
const URGENCY_RANK = `CASE v.aging_bucket
        WHEN 'vencida' THEN 0
        WHEN 'vence_pronto' THEN 1
        WHEN 'al_dia' THEN 2
        ELSE 3
      END`;

interface RawReceivable {
  id: string;
  number: string;
  status: InvoiceStatus;
  aging_bucket: ReceivableBucket;
  company_id: string;
  company_name: string;
  campaign_id: string | null;
  campaign_name: string | null;
  currency: string;
  total: string;
  paid_amount: string;
  outstanding: string;
  due_on: string;
  days_overdue: number;
  rank: number;
}

function toReceivableRow(r: RawReceivable): ReceivableRow {
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    bucket: r.aging_bucket,
    companyId: r.company_id,
    companyName: r.company_name,
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    currency: r.currency,
    total: r.total,
    paidAmount: r.paid_amount,
    outstanding: r.outstanding,
    dueOn: r.due_on,
    // El único sitio donde un entero de la vista deja de ser texto.
    daysOverdue: r.days_overdue,
  };
}

function encodeReceivableCursor(r: RawReceivable): string {
  return Buffer.from(`${r.rank}|${r.due_on}|${r.number}`, 'utf8').toString('base64url');
}

function decodeReceivableCursor(cursor: string): { rank: number; dueOn: string; number: string } {
  const [rank, dueOn, number] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!rank || !dueOn || !number || !/^[0-3]$/.test(rank) || !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) {
    throw new Error('El cursor de paginación no es válido.');
  }
  return { rank: Number(rank), dueOn, number };
}

/**
 * Cuentas por cobrar del workspace, ordenadas por urgencia de cobro
 * (URGENCY_RANK). Lee la vista `receivables` (0010), que ya excluye
 * borradores y anuladas y ya clasifica la mora; lo único que se le suma
 * es el nombre de la campaña, que la vista no trae.
 *
 * Sin `bucket` devuelve todo lo que sigue abierto (`status <> 'paid'`),
 * que es lo que suma el KPI «Por cobrar»; con `bucket` devuelve ese
 * grupo, `'pagada'` incluida.
 *
 * Ninguna cifra se calcula en la pantalla: `outstanding` y
 * `days_overdue` salen de la vista, el dinero viaja como texto y el
 * único número que se convierte es `days_overdue`, aquí.
 */
export async function listReceivables(
  tx: WorkspaceTx,
  params: ListReceivablesParams = {},
): Promise<ListReceivablesResult> {
  const limit = Math.min(200, Math.max(1, params.limit ?? 50));
  const bucket = params.bucket && RECEIVABLE_BUCKETS.includes(params.bucket) ? params.bucket : null;
  const q = receivablesSearchTerm(params.q);
  const values: unknown[] = [bucket, q];
  const where: string[] = [
    // Sin bucket, lo abierto; con bucket, ese grupo (aging_bucket = 'pagada' ⟺ status = 'paid').
    `CASE WHEN $1::text IS NULL THEN v.status <> 'paid' ELSE v.aging_bucket = $1 END`,
    `($2::text IS NULL OR v.company_name ILIKE '%' || ${ESCAPE_LIKE} || '%'
                       OR v.number       ILIKE '%' || ${ESCAPE_LIKE} || '%')`,
  ];

  if (params.cursor) {
    const c = decodeReceivableCursor(params.cursor);
    values.push(c.rank, c.dueOn, c.number);
    const [r, d, n] = [values.length - 2, values.length - 1, values.length];
    // El mismo orden, escrito como desigualdad: el número va DESC, así
    // que no cabe en una comparación de tuplas y se dice a mano.
    where.push(`(${URGENCY_RANK} > $${r}::int
                 OR (${URGENCY_RANK} = $${r}::int
                     AND (v.due_on > $${d}::date
                          OR (v.due_on = $${d}::date AND v.number < $${n}))))`);
  }
  values.push(limit + 1);

  const { rows } = await tx.query<RawReceivable>(
    `
    SELECT v.id, v.number, v.status, v.aging_bucket,
           v.company_id, v.company_name,
           v.campaign_id, ca.name AS campaign_name,
           v.currency, v.total::text, v.paid_amount::text, v.outstanding::text,
           to_char(v.due_on, 'YYYY-MM-DD') AS due_on,
           v.days_overdue::int AS days_overdue,
           ${URGENCY_RANK} AS rank
    FROM receivables v
    LEFT JOIN campaign ca ON ca.id = v.campaign_id
    WHERE ${where.join('\n      AND ')}
    ORDER BY rank, v.due_on ASC, v.number DESC
    LIMIT $${values.length}
    `,
    values,
  );

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page.map(toReceivableRow),
    nextCursor: rows.length > limit && last ? encodeReceivableCursor(last) : null,
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

  // Los porcentajes por defecto son los CONFIGURADOS (FIN-8), no las
  // constantes de core: DEFAULT_TAX_RATE y DEFAULT_WITHHOLDING_RATE
  // siguen existiendo como el valor de fábrica de un workspace nuevo, y
  // es parseFinanceSettings quien los pone. Quien llama puede seguir
  // pasando los suyos —el formulario lo hace, campo a campo—.
  const finanzas = input.taxRate === undefined || input.withholdingRate === undefined
    ? await getFinanceSettings(tx)
    : null;
  const totals = computeInvoiceTotals({
    subtotal: input.subtotal,
    taxRate: input.taxRate ?? pctToRate(finanzas!.ivaPct),
    withholdingRate: input.withholdingRate ?? pctToRate(finanzas!.retencionPct),
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

  // La configuración manda también aquí: es el camino del botón
  // «Facturar» de Campañas (CAM-1), y una factura creada desde una
  // campaña no puede nacer con otros porcentajes que una escrita a mano.
  // El plazo de la cotización, si lo hay, gana al del workspace: es lo
  // que se le prometió a ESA marca.
  const finanzas = await getFinanceSettings(tx);
  const taxRate = overrides.taxRate ?? pctToRate(finanzas.ivaPct);
  const issuedOn = overrides.issuedOn ?? camp.today;
  const dueOn = overrides.dueOn ?? addDays(issuedOn, camp.payment_terms_days ?? finanzas.plazoDias);

  return createInvoice(tx, {
    companyId: camp.company_id,
    campaignId: camp.id,
    quoteId: camp.quote_id,
    subtotal: subtotalFromTotal(camp.amount, taxRate),
    taxRate,
    withholdingRate: overrides.withholdingRate ?? pctToRate(finanzas.retencionPct),
    issuedOn,
    dueOn,
    externalRef: overrides.externalRef ?? null,
    currency: camp.currency,
  });
}

// ---------------------------------------------------------------------
// Configuración financiera del workspace (FIN-8)
// ---------------------------------------------------------------------

/**
 * El bloque `settings.finanzas` tal como entra a la bitácora: igual que
 * el guardado salvo la cuenta bancaria, que queda en sus cuatro últimos
 * caracteres («••••8901»). Basta para ver que cambió y a cuál; el número
 * entero ya está en la fila del workspace y no hace falta copiarlo.
 */
export function bloqueParaBitacora(bloque: Record<string, unknown>): Record<string, unknown> {
  const cuenta = bloque.cuenta;
  if (typeof cuenta !== 'string' || cuenta.length === 0) return bloque;
  const digitos = cuenta.replace(/[^0-9A-Za-z]/g, '');
  return { ...bloque, cuenta: `••••${digitos.slice(-4)}` };
}

/** Lo que devuelve un guardado: el bloque que quedó, su moneda y lo que hay que advertir. */
export interface FinanceSettingsSaved {
  settings: FinanceSettings;
  /** La moneda que quedó en workspace.currency, en mayúsculas. */
  currency: string;
  /**
   * La que había ANTES, en mayúsculas. Igual a `currency` si no cambió.
   *
   * Va aquí porque el aviso de abajo tiene que nombrar la moneda en la
   * que están las facturas, no la nueva. Sin este dato, la pantalla que
   * se repinta después de guardar ya tiene la moneda nueva en sus props
   * y decía «tienes 17 facturas vivas en MXN» de unas que están en COP.
   * Lo encontró la verificación en dev, no una prueba.
   */
  previousCurrency: string;
  /**
   * Cuántas facturas quedaron en una moneda distinta de la del
   * workspace POR ESTE CAMBIO. Cambiar la moneda NO convierte nada
   * (FIN-8 §0.3 F), y los KPI de /finanzas suman sin convertir: la
   * pantalla lo dice.
   *
   * Es 0 cuando la moneda no cambió, aunque haya facturas viejas en
   * otra. El aviso que alimenta dice «cambiar la moneda no las
   * convierte», así que sacarlo en un guardado que solo tocó el IVA
   * sería ruido, y encima lo etiqueta con previousCurrency —que ahí es
   * la moneda propia—, o sea que nombraría la moneda en la que esas
   * facturas NO están.
   */
  invoicesInOtherCurrency: number;
}

/** Se lanza si el UPDATE no tocó ninguna fila: la política de 0024 no está en esa base. */
export class WorkspaceNotWritable extends Error {
  constructor(workspaceId: string) {
    super(
      `No se pudo guardar la configuración del workspace ${workspaceId}: el UPDATE no tocó ninguna fila. ` +
        'Falta la política workspace_update o el GRANT UPDATE (settings, currency) de la migración 0024 §7.6 ' +
        'en esta base. Corre: make db.migrate',
    );
    this.name = 'WorkspaceNotWritable';
  }
}

/**
 * El bloque `settings.finanzas` del workspace de la transacción, ya
 * tipado y con los valores por defecto puestos (core:
 * parseFinanceSettings).
 *
 * ES LA ÚNICA PUERTA. FIN-1 (la cabecera y los porcentajes de una
 * factura nueva), FIN-2 (la tasa que estampa cada `tax_reserve`), FIN-4
 * (el correo de cobro) y FIN-6 leen de aquí; ninguno vuelve a escribir
 * `19` ni `'0.11'` a mano. Hasta FIN-8, `settings.finanzas` lo escribían
 * los seeds 0002 y 0003 y no lo leía nadie.
 *
 * El filtro es `id = current_workspace_id()` y no `tx.workspaceId`, por
 * el mismo motivo que `getWorkspace` (queries/cimientos.ts): desde 0028
 * una transacción con identidad ve además los espacios de su persona, y
 * sin filtro `limit 1` podía devolver el bloque del vecino.
 */
export async function getFinanceSettings(tx: WorkspaceTx): Promise<FinanceSettings> {
  const { rows } = await tx.query<{ finanzas: unknown }>(
    "SELECT settings->'finanzas' AS finanzas FROM workspace WHERE id = current_workspace_id()",
  );
  if (rows.length === 0) {
    throw new Error(
      `El workspace ${tx.workspaceId} no existe en esta base o la RLS no lo deja ver. ` +
        'Revisa que la base tenga el seed aplicado.',
    );
  }
  // Sin bloque (un workspace nuevo, que nace con settings '{}') salen
  // los valores por defecto. No es un error: es un workspace sin
  // configurar, y la pantalla lo dice con una frase.
  return parseFinanceSettings(rows[0]?.finanzas);
}

/**
 * Guarda el bloque `finanzas` y, si viene, la moneda del workspace.
 *
 * El UPDATE es un MERGE POR LLAVE —`settings = settings || $1::jsonb`—,
 * no un reemplazo del jsonb entero. `||` en jsonb es superficial:
 * reemplaza la llave `finanzas` completa y deja intactas las hermanas.
 * Hoy la hermana que hay es `taxRate`, que escribe y lee Cotizar
 * (queries/cotizar/cotizacion.ts, getDefaultTaxRate). Escribir
 * `settings` entero desde JavaScript haría que una pantalla de Finanzas
 * borrara lo que guardó Cotizar en la petición de al lado.
 *
 * Los privilegios ya están: 0024 §7.6 concede a mc_app
 * `UPDATE (name, slug, country, currency, timezone, locale,
 * niche_slugs, settings, updated_at)` y la política `workspace_update`
 * aísla la fila. `plan`, `kind` y `deleted_at` NO están en esa lista, a
 * propósito, y esta función no los nombra.
 *
 * Cambiar la moneda no convierte nada. Se permite (un workspace mal
 * configurado tiene que poder corregirse) y se devuelve cuántas
 * facturas quedaron en otra, para que la pantalla lo advierta.
 */
export async function updateFinanceSettings(
  tx: WorkspaceTx,
  input: { settings: FinanceSettings; currency?: string },
): Promise<FinanceSettingsSaved> {
  const currency = input.currency?.trim().toUpperCase();
  if (currency !== undefined && !/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`La moneda debe ser un código ISO-4217 de tres letras, no "${input.currency}".`);
  }

  // El antes, para la bitácora y para saber si la moneda cambió de
  // verdad. Va con FOR UPDATE: entre leerlo y escribirlo no se cuela
  // otro guardado que se pierda sin que nadie se entere.
  const antes = await tx.query<{ finanzas: unknown; currency: string }>(
    `SELECT settings->'finanzas' AS finanzas, currency
     FROM workspace WHERE id = current_workspace_id() FOR UPDATE`,
  );
  const previo = antes.rows[0];
  if (!previo) throw new WorkspaceNotWritable(tx.workspaceId);
  const previas = parseFinanceSettings(previo.finanzas);
  const monedaPrevia = previo.currency.toUpperCase();

  const bloque = financeSettingsToJson(input.settings);
  // `RETURNING id` y no rowCount: tx.query devuelve solo `rows`
  // (client.ts, QueryResult). El id del workspace es un uuid, no un
  // bigserial, así que devolverlo no rompe la regla de CIM-2 §3.
  const actualizado = await tx.query<{ id: string }>(
    `UPDATE workspace
     SET settings = settings || $1::jsonb,
         currency = coalesce($2, currency)
     WHERE id = current_workspace_id()
     RETURNING id`,
    [JSON.stringify({ finanzas: bloque }), currency ?? null],
  );
  if (actualizado.rows.length === 0) throw new WorkspaceNotWritable(tx.workspaceId);

  // La bitácora (ACC-2), en la MISMA transacción: si el UPDATE hace
  // rollback, la fila se va con él. before/after llevan el bloque y la
  // moneda, con dos cuidados: el correo lo quita sanitizeForAudit (la
  // llave contiene «correo») y la cuenta bancaria viaja enmascarada
  // (bloqueParaBitacora). Que alguien cambie la cuenta a la que pagan
  // las marcas es justo lo que la bitácora tiene que dejar ver, pero no
  // hace falta el número entero para verlo.
  await audit(tx, {
    action: 'workspace.settings_updated',
    entityType: 'workspace',
    entityId: tx.workspaceId,
    before: { finanzas: bloqueParaBitacora(financeSettingsToJson(previas)), currency: monedaPrevia },
    after: { finanzas: bloqueParaBitacora(bloque), currency: currency ?? monedaPrevia },
  });

  const monedaFinal = currency ?? monedaPrevia;
  // Solo se cuenta si la moneda cambió: ver el JSDoc de
  // invoicesInOtherCurrency. Y de paso es una consulta menos en el
  // guardado normal, que es el que pasa siempre.
  const cambio = monedaFinal !== monedaPrevia;
  const otras = cambio ? await countInvoicesInOtherCurrency(tx, monedaFinal) : 0;

  return {
    settings: parseFinanceSettings(bloque),
    currency: monedaFinal,
    previousCurrency: monedaPrevia,
    invoicesInOtherCurrency: otras,
  };
}

/**
 * Cuántas facturas vivas hay en una moneda distinta de la indicada. Es
 * el número que el guardado devuelve DESPUÉS de cambiar la moneda: las
 * que se quedaron atrás. Las anuladas no cuentan: ya no suman en ningún
 * KPI.
 */
export async function countInvoicesInOtherCurrency(tx: WorkspaceTx, currency: string): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM invoice WHERE upper(currency) <> $1 AND status <> 'void'",
    [currency.trim().toUpperCase()],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Cuántas facturas vivas hay EN esa moneda. Es lo que la pantalla de
 * configuración pregunta al pintar: son las que se quedarían atrás si
 * alguien cambia la moneda del workspace, y decirlo antes es la mitad
 * del punto de la advertencia.
 */
export async function countLiveInvoicesInCurrency(tx: WorkspaceTx, currency: string): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM invoice WHERE upper(currency) = $1 AND status <> 'void'",
    [currency.trim().toUpperCase()],
  );
  return rows[0]?.n ?? 0;
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
               'incurredOn', to_char(e.incurred_on, 'YYYY-MM-DD'),
               -- La serie (FIN-5): la misma obligación registrada otro
               -- mes. La descripción no sirve, porque lleva el mes.
               'serie',      lower(e.category) || '|' || lower(coalesce(e.vendor, ''))
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

/** El uuid con el que `coalesce` normaliza «sin creador» en el UNIQUE de 0036. */
const SIN_CREADOR = '00000000-0000-0000-0000-000000000000';

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
     -- CON objetivo, y con el objetivo ESCRITO: un ON CONFLICT DO
     -- NOTHING a secas no falla cuando el índice no existe, se limita a
     -- no deduplicar. Sobre una base sin 0036 eso es lo peor de los dos
     -- mundos: reimportar el mismo CSV duplicaría el dinero y la
     -- pantalla diría «listo». Nombrando las columnas, Postgres exige un
     -- índice único que las cubra y, si no lo hay, lanza 42P10 con un
     -- mensaje que dice exactamente qué falta aplicar.
     --
     -- El uuid va LITERAL y no como $n: Postgres infiere el índice
     -- comparando la expresión del ON CONFLICT con la del índice, y un
     -- parámetro no es la misma expresión que la constante de 0036. Es
     -- una constante nuestra (SIN_CREADOR), no un dato de nadie, así que
     -- interpolarla no abre nada; la comprobación de que son la misma la
     -- hace la prueba que borra el índice y espera 42P10.
     ON CONFLICT (workspace_id, platform_id, coalesce(creator_id, '${SIN_CREADOR}'::uuid), period_start, period_end, currency, amount)
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

// ---------------------------------------------------------------------
// Recordatorios de cobro (FIN-4)
// ---------------------------------------------------------------------

interface ReminderRaw {
  id: string;
  /** La columna admite 'success' además de los tres tonos de un recordatorio. */
  severity: string;
  title_es: string;
  body_es: string | null;
  action_url: string | null;
  created_at: string;
  read_at: string | null;
  invoice_id: string;
  number: string;
  company_name: string;
  currency: string;
  outstanding: string;
  due_on: string;
  days_overdue: number;
}

/**
 * La bandeja de recordatorios del workspace. Son filas de
 * `notification` de tipo `invoice_overdue` que escribió el job
 * `finance.reminders`: el título es el asunto del correo y el cuerpo,
 * el correo entero, ya redactado por @mc/core con la moneda y el locale
 * del workspace. La pantalla no calcula nada.
 *
 * `dismissed_at` descarta la fila para siempre; `read_at` es «lo
 * mandé», que es lo que hace el botón de la bandeja. Un recordatorio
 * sin paso legible en su `action_url` no es de FIN-4 y se ignora.
 *
 * `days_overdue` se calcula en la zona del WORKSPACE, no con
 * `CURRENT_DATE` (que es el día del servidor, UTC), igual que
 * `getCashflowInputs`: con `CURRENT_DATE`, en Bogotá pasadas las 19:00
 * la pastilla diría «1 día de mora» al lado de un cuerpo que dice
 * «vence hoy». La mora es la de HOY, no la del día en que se redactó el
 * texto: por eso la tarjeta enseña también cuándo se escribió.
 */
export async function listReminders(tx: WorkspaceTx, params: ListRemindersParams = {}): Promise<ReminderRow[]> {
  if (params.invoiceId !== undefined && !isUuid(params.invoiceId)) return [];
  const limit = Math.min(MAX_REMINDERS, Math.max(1, params.limit ?? 50));
  const { rows } = await tx.query<ReminderRaw>(
    `SELECT n.id, n.severity, n.title_es, n.body_es, n.action_url,
            to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
            to_char(n.read_at    AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS read_at,
            i.id AS invoice_id, i.number, co.name AS company_name, i.currency,
            (i.total - i.paid_amount)::text AS outstanding,
            to_char(i.due_on, 'YYYY-MM-DD') AS due_on,
            (((now() AT TIME ZONE w.timezone)::date) - i.due_on)::int AS days_overdue
       FROM notification n
       JOIN invoice i   ON i.id = n.entity_id
       JOIN company co  ON co.id = i.company_id
       JOIN workspace w ON w.id = i.workspace_id
      WHERE n.kind = 'invoice_overdue' AND n.entity_type = 'invoice' AND n.dismissed_at IS NULL
        AND ($1::boolean IS NOT TRUE OR (n.read_at IS NULL AND i.status IN ('sent', 'partial')))
        AND ($2::uuid IS NULL OR n.entity_id = $2)
      ORDER BY CASE n.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
               i.due_on, i.number, n.created_at
      LIMIT $3`,
    [params.pendingOnly ?? false, params.invoiceId ?? null, limit],
  );
  const out: ReminderRow[] = [];
  for (const r of rows) {
    const paso = pasoDeUrl(r.action_url);
    if (paso === null || r.action_url === null) continue;
    out.push({
      id: r.id,
      paso,
      etiquetaEs: definicionPaso(paso).etiquetaEs,
      // La columna es más ancha que los tres tonos de FIN-4: lo que no
      // sea de un recordatorio se lee como el más suave, para que una
      // fila rara no deje la pastilla sin color ni nombre.
      severity: r.severity === 'critical' || r.severity === 'warning' ? r.severity : 'info',
      asunto: r.title_es,
      cuerpo: r.body_es ?? '',
      actionUrl: r.action_url,
      invoiceId: r.invoice_id,
      invoiceNumber: r.number,
      companyName: r.company_name,
      currency: r.currency,
      outstanding: r.outstanding,
      dueOn: r.due_on,
      daysOverdue: r.days_overdue,
      createdAt: r.created_at,
      sentAt: r.read_at,
    });
  }
  return out;
}

/**
 * «Marcar como enviado»: sella `read_at`. Devuelve false si el id no es
 * de este workspace (RLS no lo deja ver), no es un recordatorio, o ya
 * estaba marcado — con eso la acción es idempotente y repetir el clic
 * no mueve la fecha.
 */
export async function markReminderSent(tx: WorkspaceTx, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE notification SET read_at = now()
      WHERE id = $1 AND kind = 'invoice_overdue' AND entity_type = 'invoice' AND read_at IS NULL
      RETURNING id`,
    [id],
  );
  return rows.length > 0;
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
  // La bitácora (ACC-2), en la MISMA transacción: si la escritura hace
  // rollback, la anotación se va con ella.
  await audit(tx, { action: 'expense.created', entityType: 'expense', entityId: id, before: null, after: gastoParaBitacora(gasto) });
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
  if (Object.keys(after).length > 0) {
    await audit(tx, { action: 'expense.updated', entityType: 'expense', entityId: id, before, after });
  }
  return despues;
}
