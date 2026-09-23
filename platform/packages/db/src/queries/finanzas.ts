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
 *   - Alcance (ACC-6): toda lectura y escritura compone scopeFilter()
 *     (../scope.ts). Una factura se acota por su marca, su campaña y, a
 *     través de la campaña, su creadora: una factura sin campaña no es
 *     de ninguna creadora y no la ve quien tenga alcance por creador.
 *     Los pagos y la reserva de impuestos llegan por su factura. Las
 *     marcas (company_link) por las campañas que tienen con la creadora
 *     o la campaña del alcance. test/alcance-finanzas.test.ts recorre
 *     TODAS las funciones exportadas de este archivo.
 */
import {
  addDays,
  agingBucket,
  computeInvoiceTotals,
  deriveStatus,
  nextInvoiceNumber,
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
import { assertScopeAllows, scopeFilter } from '../scope.ts';

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
// Alcance (ACC-6)
// ---------------------------------------------------------------------

/** La factura `i` con su campaña `ca` (LEFT JOIN): la creadora llega por la campaña. */
const SCOPE_INVOICE = scopeFilter({ creator: 'ca.creator_id', company: 'i.company_id', campaign: 'i.campaign_id' });

/** La fila `r` de la vista receivables (no expone la creadora: se busca en su campaña). */
const SCOPE_RECEIVABLE = scopeFilter({
  creator: '(SELECT c.creator_id FROM campaign c WHERE c.id = r.campaign_id)',
  company: 'r.company_id',
  campaign: 'r.campaign_id',
});

/** El pago `p`, por su factura. Un pago sin factura no cae en ningún alcance. */
const SCOPE_PAYMENT = scopeFilter({
  creator: '(SELECT c.creator_id FROM invoice i JOIN campaign c ON c.id = i.campaign_id WHERE i.id = p.invoice_id)',
  company: '(SELECT i.company_id FROM invoice i WHERE i.id = p.invoice_id)',
  campaign: '(SELECT i.campaign_id FROM invoice i WHERE i.id = p.invoice_id)',
});

/** La reserva `t`, por su pago → su factura. */
const SCOPE_TAX_RESERVE = scopeFilter({
  creator: '(SELECT c.creator_id FROM payment p JOIN invoice i ON i.id = p.invoice_id JOIN campaign c ON c.id = i.campaign_id WHERE p.id = t.payment_id)',
  company: '(SELECT i.company_id FROM payment p JOIN invoice i ON i.id = p.invoice_id WHERE p.id = t.payment_id)',
  campaign: '(SELECT i.campaign_id FROM payment p JOIN invoice i ON i.id = p.invoice_id WHERE p.id = t.payment_id)',
});

/** La campaña `ca`: su creadora, su marca y ella misma. */
const SCOPE_CAMPAIGN = scopeFilter({ creator: 'ca.creator_id', company: 'ca.company_id', campaign: 'ca.id' });

/**
 * La marca vinculada `l` (company_link). Es la única derivación que va
 * del padre al hijo: con alcance por creadora o por campaña, la marca
 * se ve si tiene una campaña de esa creadora o esa campaña. Ocultarlas
 * todas dejaría sin marca a la factura de una campaña que sí se ve;
 * enseñarlas todas es lo que AGE-4 quiere acotar.
 */
const SCOPE_COMPANY_LINK = scopeFilter({
  creator: { any: 'SELECT c.creator_id FROM campaign c WHERE c.company_id = l.company_id' },
  company: 'l.company_id',
  campaign: { any: 'SELECT c.id FROM campaign c WHERE c.company_id = l.company_id' },
});

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
  const where: string[] = [SCOPE_INVOICE];
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
    WHERE ${where.join(' AND ')}
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
  const { rows } = await tx.query<RawRow>(`${SELECT_INVOICE} WHERE i.id = $1 AND ${SCOPE_INVOICE}`, [id]);
  const r = rows[0];
  return r ? toDetail(r) : null;
}

/** Empresas vinculadas al workspace (company_link tiene RLS; company no), dentro del alcance. */
export async function listCompanies(tx: WorkspaceTx): Promise<CompanyOption[]> {
  const { rows } = await tx.query<CompanyOption>(`
    SELECT c.id, c.name
    FROM company_link l
    JOIN company c ON c.id = l.company_id
    WHERE ${SCOPE_COMPANY_LINK}
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
    WHERE ca.status <> 'cancelled' AND ${SCOPE_CAMPAIGN}
    ORDER BY ca.starts_on DESC NULLS LAST, ca.name
  `);
  return rows.map((r) => ({
    id: r.id, name: r.name, status: r.status, companyId: r.company_id, companyName: r.company_name,
    amount: r.amount, currency: r.currency, quoteId: r.quote_id,
  }));
}

/** Los cuatro KPIs de Finanzas, desde la vista receivables, payment y tax_reserve, dentro del alcance. */
export async function getReceivablesKpis(tx: WorkspaceTx): Promise<ReceivablesKpis> {
  const { rows } = await tx.query<{
    outstanding: string; open_count: number; overdue: string; overdue_count: number; max_days_overdue: number;
    collected_ytd: string; collected_prev: string; delta_permille: number | null; tax_reserved: string; tax_rate: string | null;
  }>(`
    WITH scoped_receivables AS (
      SELECT r.* FROM receivables r WHERE ${SCOPE_RECEIVABLE}
    ), ytd AS (
      SELECT coalesce(sum(p.amount), 0) AS v FROM payment p
      WHERE p.direction = 'in' AND p.received_at >= date_trunc('year', CURRENT_DATE) AND ${SCOPE_PAYMENT}
    ), prev AS (
      SELECT coalesce(sum(p.amount), 0) AS v FROM payment p
      WHERE p.direction = 'in'
        AND p.received_at >= date_trunc('year', CURRENT_DATE) - interval '1 year'
        AND p.received_at < (CURRENT_DATE - interval '1 year') + interval '1 day'
        AND ${SCOPE_PAYMENT}
    )
    SELECT
      (SELECT coalesce(sum(outstanding), 0)::text FROM scoped_receivables WHERE status <> 'paid') AS outstanding,
      (SELECT count(*)::int FROM scoped_receivables WHERE status <> 'paid') AS open_count,
      (SELECT coalesce(sum(outstanding), 0)::text FROM scoped_receivables WHERE aging_bucket = 'vencida') AS overdue,
      (SELECT count(*)::int FROM scoped_receivables WHERE aging_bucket = 'vencida') AS overdue_count,
      (SELECT coalesce(max(days_overdue), 0)::int FROM scoped_receivables WHERE aging_bucket = 'vencida') AS max_days_overdue,
      (SELECT v::text FROM ytd) AS collected_ytd,
      (SELECT v::text FROM prev) AS collected_prev,
      (SELECT CASE WHEN prev.v > 0 THEN round((ytd.v / prev.v - 1) * 1000)::int END FROM ytd, prev) AS delta_permille,
      (SELECT coalesce(sum(t.amount), 0)::text FROM tax_reserve t WHERE t.released_at IS NULL AND ${SCOPE_TAX_RESERVE}) AS tax_reserved,
      (SELECT max(t.rate)::text FROM tax_reserve t WHERE t.released_at IS NULL AND ${SCOPE_TAX_RESERVE}) AS tax_rate
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
  // invoice.company_id no lo garantiza, company_link (con RLS) sí. Y
  // dentro del alcance de quien factura.
  const link = await tx.query(`SELECT 1 FROM company_link l WHERE l.company_id = $1 AND ${SCOPE_COMPANY_LINK}`, [input.companyId]);
  if (link.rows.length === 0) throw new Error('La empresa no existe en este workspace.');

  let creatorId: string | null = null;
  if (input.campaignId) {
    const camp = await tx.query<{ creator_id: string | null }>(
      `SELECT ca.creator_id FROM campaign ca WHERE ca.id = $1 AND ${SCOPE_CAMPAIGN}`,
      [input.campaignId],
    );
    if (camp.rows.length === 0) throw new Error('La campaña no existe en este workspace.');
    creatorId = camp.rows[0]?.creator_id ?? null;
  }
  // La cotización que se enlaza también tiene que caer en el alcance: si
  // no, la factura nombraría (y la ficha devolvería) una cotización ajena.
  if (input.quoteId) {
    const quote = await tx.query(
      `SELECT 1 FROM quote q WHERE q.id = $1 AND ${scopeFilter({
        creator: 'q.creator_id',
        company: 'q.company_id',
        campaign: { any: 'SELECT c.id FROM campaign c WHERE c.quote_id = q.id' },
      })}`,
      [input.quoteId],
    );
    if (quote.rows.length === 0) throw new Error('La cotización no existe en este workspace.');
  }
  // La factura que se va a crear tiene que caer en el alcance de quien
  // la crea, o nunca podría verla: sin campaña, no es de ninguna
  // creadora; bajo alcance por campaña, tiene que ser de una de ellas.
  await assertScopeAllows(tx, { creator: creatorId, company: input.companyId, campaign: input.campaignId ?? null });

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
    `SELECT i.status, i.total::text, i.paid_amount::text
     FROM invoice i LEFT JOIN campaign ca ON ca.id = i.campaign_id
     WHERE i.id = $1 AND ${SCOPE_INVOICE}
     FOR UPDATE OF i`,
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
    WHERE ca.id = $1 AND ${SCOPE_CAMPAIGN}
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
