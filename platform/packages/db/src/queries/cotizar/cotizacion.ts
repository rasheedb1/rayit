/**
 * Cotizar · COT-3, la cotización: borrador, envío, aceptación y rechazo desde el panel.
 *
 * Parte de @mc/db/queries/cotizar (la entrada es ../cotizar.ts, que
 * reexporta cada pieza). Las reglas del módulo están en su cabecera.
 */
import {
  calcularTotalesCotizacion, DEFAULT_TAX_RATE, terminosDeModificadores, type Decimal, type PlatformId,
  type TerminosIncluidos,
} from '@mc/core';
import { isUuid, type WorkspaceTx } from '../../client.ts';
import { WORKSPACE_DEFAULTS } from '../cimientos.ts';
import { nuevoSlug } from './enlace.ts';
import { CotizarError, QuoteNotDraft, QuoteNotEditable, QuoteNotFound, QuoteTransitionError, ValidezVencida } from './errores.ts';
import { assertMediaKitDelCreador, registrarActividad, registrarAceptacion, registrarCambioDeMonto } from './interno.ts';
import { DealNotFound, followUpAfterProposal, moveDeal, type MoveDealResult } from '../ventas.ts';
import { getCurrentRateCard } from './tarifario.ts';
import type { PublicQuoteView } from './publico.ts';

// ---------------------------------------------------------------------
// COT-3 · Cotización
// ---------------------------------------------------------------------

export const QUOTE_STATUSES = ['draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export interface QuoteItemRow {
  id: string;
  deliverable: string;
  platformId: PlatformId | null;
  description: string;
  quantity: number;
  unitPrice: Decimal;
  total: Decimal;
  position: number;
}

export interface QuoteListRow {
  id: string;
  number: string;
  slug: string;
  /**
   * El estado de HOY: una enviada o vista cuya validez ya pasó sale
   * 'expired' aunque la marca nunca haya vuelto a abrir el enlace.
   * Lo deriva la consulta (ver SELECT_QUOTE), no la pantalla.
   */
  status: QuoteStatus;
  companyId: string;
  companyName: string;
  dealId: string | null;
  dealName: string | null;
  currency: string;
  total: Decimal;
  validUntil: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  acceptedAt: string | null;
  rejectedAt: string | null;
  expiredAt: string | null;
  viewCount: number;
  createdAt: string;
}

export interface QuoteDetail extends QuoteListRow {
  creatorId: string;
  subtotal: Decimal;
  discount: Decimal;
  tax: Decimal;
  /** La tasa con la que se calculó `tax`, como fracción ('0.19'). null en las que no la guardaron. */
  taxRate: string | null;
  agreedMetrics: string[];
  reportCutsHours: number[];
  usageRightsDays: number | null;
  exclusivityDays: number | null;
  exclusivityScope: string | null;
  paymentTermsDays: number;
  campaignStartsOn: string | null;
  campaignEndsOn: string | null;
  mediaKitId: string | null;
  /** Quién aceptó desde el enlace (nombre y correo que dejó la marca). */
  acceptedByName: string | null;
  acceptedByEmail: string | null;
  items: QuoteItemRow[];
  /** La campaña que nació de esta cotización (CAM-2), si ya existe. */
  campaignId: string | null;
  campaignName: string | null;
  /** true cuando está aceptada y todavía no tiene campaña. */
  campaignPending: boolean;
}

interface RawQuote {
  id: string; number: string; slug: string; status: QuoteStatus;
  company_id: string; company_name: string; deal_id: string | null; deal_name: string | null;
  creator_id: string; currency: string; subtotal: string; discount: string; tax: string; total: string;
  tax_rate: string | null;
  agreed_metrics: string[]; report_cuts_hours: number[];
  usage_rights_days: number | null; exclusivity_days: number | null; exclusivity_scope: string | null;
  payment_terms_days: number; campaign_starts_on: string | null; campaign_ends_on: string | null;
  media_kit_id: string | null;
  valid_until: string | null; sent_at: string | null; viewed_at: string | null; accepted_at: string | null;
  rejected_at: string | null; expired_at: string | null;
  accepted_by_name: string | null; accepted_by_email: string | null;
  view_count: number; created_at: string;
  campaign_id: string | null; campaign_name: string | null;
}

/**
 * La cotización con su estado DE HOY. `vencida` se evalúa en la zona del
 * workspace: «válida hasta el 30» quiere decir hasta el final del 30 en
 * Bogotá, no a las 19:00. La fecha de vencimiento derivada es el
 * principio del día siguiente en esa zona, que es cuando dejó de valer.
 *
 * Es la misma regla que aplica public_quote() (0030) al abrir el enlace,
 * que además la persiste. Aquí solo se lee: un GET del panel no escribe.
 */
const SELECT_QUOTE = `
  SELECT q.id, q.number, q.slug,
         CASE WHEN v.vencida THEN 'expired' ELSE q.status END AS status,
         q.company_id, co.name AS company_name,
         q.deal_id, d.name AS deal_name, q.creator_id, q.currency,
         q.subtotal, q.discount, q.tax, q.total, q.tax_rate,
         q.agreed_metrics, q.report_cuts_hours, q.usage_rights_days, q.exclusivity_days,
         q.exclusivity_scope, q.payment_terms_days, q.media_kit_id,
         to_char(q.campaign_starts_on, 'YYYY-MM-DD') AS campaign_starts_on,
         to_char(q.campaign_ends_on, 'YYYY-MM-DD')   AS campaign_ends_on,
         to_char(q.valid_until, 'YYYY-MM-DD')        AS valid_until,
         q.sent_at, q.viewed_at, q.accepted_at, q.rejected_at,
         CASE WHEN v.vencida THEN coalesce(q.expired_at, (q.valid_until + 1)::timestamp AT TIME ZONE w.timezone)
              ELSE q.expired_at END AS expired_at,
         q.accepted_by_name, q.accepted_by_email,
         q.view_count, q.created_at,
         ca.id AS campaign_id, ca.name AS campaign_name
    FROM quote q
    JOIN workspace w ON w.id = q.workspace_id
    JOIN company co ON co.id = q.company_id
    LEFT JOIN deal d ON d.id = q.deal_id
    LEFT JOIN campaign ca ON ca.quote_id = q.id AND ca.status <> 'cancelled'
    CROSS JOIN LATERAL (
      SELECT q.status IN ('sent', 'viewed') AND q.valid_until IS NOT NULL
             AND q.valid_until < (now() AT TIME ZONE w.timezone)::date AS vencida
    ) v`;

function mapQuote(r: RawQuote): QuoteDetail {
  return {
    id: r.id,
    number: r.number,
    slug: r.slug,
    status: r.status,
    companyId: r.company_id,
    companyName: r.company_name,
    dealId: r.deal_id,
    dealName: r.deal_name,
    creatorId: r.creator_id,
    currency: r.currency.toUpperCase(),
    subtotal: r.subtotal,
    discount: r.discount,
    tax: r.tax,
    taxRate: r.tax_rate === null ? null : normalizarTasa(r.tax_rate),
    total: r.total,
    agreedMetrics: r.agreed_metrics ?? [],
    reportCutsHours: r.report_cuts_hours ?? [],
    usageRightsDays: r.usage_rights_days,
    exclusivityDays: r.exclusivity_days,
    exclusivityScope: r.exclusivity_scope,
    paymentTermsDays: r.payment_terms_days,
    campaignStartsOn: r.campaign_starts_on,
    campaignEndsOn: r.campaign_ends_on,
    mediaKitId: r.media_kit_id,
    validUntil: r.valid_until,
    sentAt: r.sent_at,
    viewedAt: r.viewed_at,
    acceptedAt: r.accepted_at,
    rejectedAt: r.rejected_at,
    expiredAt: r.expired_at,
    acceptedByName: r.accepted_by_name,
    acceptedByEmail: r.accepted_by_email,
    viewCount: r.view_count,
    createdAt: r.created_at,
    items: [],
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    campaignPending: r.status === 'accepted' && r.campaign_id === null,
  };
}

/** '0.190000' → '0.19'. Postgres devuelve numeric(7,6) con sus seis decimales. */
function normalizarTasa(tasa: string): string {
  const [i = '0', f = ''] = tasa.split('.');
  const frac = f.replace(/0+$/, '');
  return frac ? `${i}.${frac}` : i;
}

export async function listQuotes(tx: WorkspaceTx, opts: { status?: readonly QuoteStatus[] } = {}): Promise<QuoteListRow[]> {
  // El filtro va sobre el estado de hoy, no sobre la columna: «vencidas»
  // tiene que traer también las que nadie ha vuelto a abrir.
  const filtrar = opts.status && opts.status.length > 0;
  const { rows } = await tx.query<RawQuote>(
    `SELECT * FROM (${SELECT_QUOTE}) x${filtrar ? ' WHERE x.status = ANY($1::text[])' : ''}
      ORDER BY x.created_at DESC LIMIT 200`,
    filtrar ? [[...opts.status!]] : [],
  );
  return rows.map(mapQuote);
}

/**
 * El estado de una cotización de este workspace, o null si no existe (o
 * no es suya). Una sola fila: el detalle y la edición lo preguntan ANTES
 * de abrir su límite de Suspense, para que un id desconocido responda
 * 404 —y un enviado que se quiere editar, su redirección— antes de que
 * salga nada, y lo demás cargue detrás de un esqueleto (pulido r5).
 */
export async function getQuoteStatus(tx: WorkspaceTx, id: string): Promise<QuoteStatus | null> {
  if (!isUuid(id)) return null;
  const { rows } = await tx.query<{ status: QuoteStatus }>('SELECT status FROM quote WHERE id = $1 LIMIT 1', [id]);
  return rows[0]?.status ?? null;
}

/** Una cotización con sus ítems, o null si no existe (o no es de este workspace). */
export async function getQuote(tx: WorkspaceTx, id: string): Promise<QuoteDetail | null> {
  if (!isUuid(id)) return null;
  const { rows } = await tx.query<RawQuote>(`${SELECT_QUOTE} WHERE q.id = $1`, [id]);
  const row = rows[0];
  if (!row) return null;
  const quote = mapQuote(row);
  quote.items = await listQuoteItems(tx, id);
  return quote;
}

/**
 * Lo mismo que getQuote, pero con la fila de `quote` BLOQUEADA hasta que
 * termine la transacción (SELECT … FOR UPDATE). Toda transición del
 * panel (enviar, aceptar, rechazar, editar el borrador) lee con esta y
 * no con getQuote.
 *
 * Por qué: el enlace público (public_quote_accept, 0030) también toma la
 * fila con FOR UPDATE. Si el panel leyera sin bloquear, el creador
 * podría ver 'sent', la marca aceptar en ese instante, y el UPDATE del
 * panel —que esperaba el bloqueo— escribir 'rejected' encima de una
 * cotización ya aceptada, con el negocio en «Ganado» y la campaña
 * planeada. Con el bloqueo, la segunda en llegar espera, lee el estado
 * que dejó la primera y falla con QuoteTransitionError. Es lo mismo que
 * evita el doble «Enviar» desde dos pestañas (dos filas de historial y
 * dos actividades).
 *
 * El orden de bloqueo es el de public_quote_accept —primero la
 * cotización, después el negocio—, así que el panel y el enlace no se
 * pueden bloquear en cruz.
 */
async function getQuoteForUpdate(tx: WorkspaceTx, id: string): Promise<QuoteDetail | null> {
  if (!isUuid(id)) return null;
  const { rows } = await tx.query<{ id: string }>('SELECT id FROM quote WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) return null;
  return getQuote(tx, id);
}

/**
 * Cambia el estado solo si sigue en uno de `desde`. `set` son las demás
 * columnas, con sus parámetros desde $4. Es la segunda
 * guardia, en la base, además del bloqueo de getQuoteForUpdate: si
 * alguien cambia el flujo y se salta la lectura bloqueada, el UPDATE no
 * pisa un estado que no esperaba.
 */
async function transicionar(
  tx: WorkspaceTx,
  id: string,
  desde: readonly QuoteStatus[],
  hacia: QuoteStatus,
  set: string,
  params: unknown[] = [],
): Promise<void> {
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE quote SET status = $2, ${set} WHERE id = $1 AND status = ANY($3::text[]) RETURNING id`,
    [id, hacia, [...desde], ...params],
  );
  if (rows[0]) return;
  const { rows: real } = await tx.query<{ status: string }>('SELECT status FROM quote WHERE id = $1', [id]);
  if (!real[0]) throw new QuoteNotFound();
  throw new QuoteTransitionError(real[0].status, hacia);
}

async function listQuoteItems(tx: WorkspaceTx, quoteId: string): Promise<QuoteItemRow[]> {
  const { rows } = await tx.query<{
    id: string; deliverable: string; platform_id: PlatformId | null; description: string;
    quantity: number; unit_price: string; total: string; position: number;
  }>(
    `SELECT id, deliverable, platform_id, description, quantity, unit_price, total, position
       FROM quote_item WHERE quote_id = $1 ORDER BY position, id`,
    [quoteId],
  );
  return rows.map((r) => ({
    id: r.id,
    deliverable: r.deliverable,
    platformId: r.platform_id,
    description: r.description,
    quantity: r.quantity,
    unitPrice: r.unit_price,
    total: r.total,
    position: r.position,
  }));
}

/** Los deals que pueden recibir una cotización: abiertos, con su empresa. */
export interface QuotableDeal {
  id: string;
  name: string;
  companyId: string;
  companyName: string;
  stageId: string;
  stageLabel: string;
  amount: Decimal | null;
  currency: string;
}

/**
 * Los negocios ABIERTOS: ni ganados ni perdidos. Cotizar un negocio
 * ganado no lo movía a «Propuesta enviada» ni hacía nada en Ventas al
 * aceptarse, y encabezaba la lista porque se ordenaba por etapa.
 * El orden es el del último movimiento: el negocio que se tocó hoy es
 * el que se está cotizando.
 */
export async function listQuotableDeals(tx: WorkspaceTx): Promise<QuotableDeal[]> {
  const { rows } = await tx.query<{
    id: string; name: string; company_id: string; company_name: string;
    stage_id: string; stage_label: string; amount: string | null; currency: string;
  }>(
    `SELECT p.id, p.name, p.company_id, p.company_name, p.stage_id, p.stage_label, p.amount, p.currency
       FROM deal_pipeline p
       LEFT JOIN LATERAL (SELECT max(h.changed_at) AS ultimo FROM deal_stage_history h WHERE h.deal_id = p.id) h ON true
      WHERE NOT p.is_lost AND NOT p.is_won
      ORDER BY greatest(h.ultimo, p.last_contact_at) DESC NULLS LAST, p.name`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    companyId: r.company_id,
    companyName: r.company_name,
    stageId: r.stage_id,
    stageLabel: r.stage_label,
    amount: r.amount,
    currency: r.currency.toUpperCase(),
  }));
}

const TASA_RE = /^(0(\.\d{1,6})?|1(\.0{1,6})?)$/;

/**
 * La tasa de impuesto con la que arranca una cotización nueva, como
 * fracción. Sale del workspace: `settings.taxRate` si el creador la
 * fijó; si no, el IVA general cuando el workspace es de Colombia (el
 * único valor por defecto que el producto puede tener fijado a un
 * país), y 0 en cualquier otro sitio, donde es mejor que el creador la
 * escriba a que la cotización salga con el IVA de otro país.
 */
export async function getDefaultTaxRate(tx: WorkspaceTx): Promise<string> {
  const { rows } = await tx.query<{ tax_rate: string | null; country: string | null }>(
    "SELECT settings->>'taxRate' AS tax_rate, country FROM workspace WHERE id = $1",
    [tx.workspaceId],
  );
  const fila = rows[0];
  const propia = fila?.tax_rate?.trim();
  if (propia && TASA_RE.test(propia)) return propia;
  return fila?.country?.toUpperCase() === 'CO' ? DEFAULT_TAX_RATE : '0';
}

export interface QuoteItemInput {
  deliverable: string;
  platformId: PlatformId | null;
  description: string;
  quantity: number;
  unitPrice: Decimal;
}

export interface CreateQuoteInput {
  /** Desde un deal: la empresa sale de él. */
  dealId?: string | null;
  companyId?: string;
  creatorId: string;
  items: QuoteItemInput[];
  discount?: Decimal;
  /** Fracción: '0.19'. */
  taxRate?: string;
  validUntil?: string | null;
  agreedMetrics?: string[];
  reportCutsHours?: number[];
  /**
   * Días de derechos de uso y de exclusividad; null es «no aplica». Sin
   * decirlos (undefined), salen de lo que el precio del tarifario ya
   * incluye (terminosIncluidosEnTarifario).
   */
  usageRightsDays?: number | null;
  exclusivityDays?: number | null;
  exclusivityScope?: string | null;
  paymentTermsDays?: number;
  campaignStartsOn?: string | null;
  campaignEndsOn?: string | null;
  mediaKitId?: string | null;
}

/**
 * El año de la numeración, en la zona del workspace. El 31 de diciembre
 * a las 20:00 en Bogotá ya es 1 de enero en UTC: con getUTCFullYear()
 * esa cotización salía numerada con el año siguiente. Lo resuelve la
 * base con la zona guardada en el workspace, la misma expresión que usa
 * SELECT_QUOTE para decidir si una cotización venció.
 */
async function anioDeNumeracion(tx: WorkspaceTx, at: Date | undefined): Promise<number> {
  const { rows } = await tx.query<{ y: number }>(
    `SELECT extract(year FROM coalesce($2::timestamptz, now())
              AT TIME ZONE coalesce(nullif(w.timezone, ''), 'UTC'))::int AS y
       FROM workspace w WHERE w.id = $1`,
    [tx.workspaceId, at ? at.toISOString() : null],
  );
  return Number(rows[0]?.y ?? (at ?? new Date()).getUTCFullYear());
}

/**
 * Numeración COT-AAAA-NNN por workspace, con el año de la zona del
 * workspace (`at` existe para las pruebas: por defecto, ahora).
 *
 * El bloqueo consultivo se toma DENTRO de la transacción de quien llama
 * y se suelta al confirmar: dos creadores del mismo workspace que
 * cotizan a la vez se serializan aquí en vez de chocar contra el
 * UNIQUE (workspace_id, number) de 0008. El UNIQUE sigue siendo la
 * garantía de la base; esto es lo que evita el error.
 */
export async function nextQuoteNumber(tx: WorkspaceTx, opts: { at?: Date } = {}): Promise<string> {
  const year = await anioDeNumeracion(tx, opts.at);
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`quote-number:${tx.workspaceId}:${year}`]);
  const prefijo = `COT-${year}-`;
  const { rows } = await tx.query<{ n: number | null }>(
    `SELECT max(nullif(regexp_replace(substring(number from ${prefijo.length + 1}), '\\D', '', 'g'), '')::int) AS n
       FROM quote WHERE number LIKE $1`,
    [`${prefijo}%`],
  );
  const siguiente = Number(rows[0]?.n ?? 0) + 1;
  return `${prefijo}${String(siguiente).padStart(3, '0')}`;
}

/**
 * Los días de derechos de uso y de exclusividad que ya cobran los
 * entregables de la cotización, según el tarifario vigente del creador:
 * un entregable del tarifario cuyo precio lleva «exclusividad 30 días»
 * trae esos 30 días. Se busca por `deliverable`, que es como la
 * cotización recuerda de qué fila del tarifario salió cada línea.
 */
export async function terminosIncluidosEnTarifario(
  tx: WorkspaceTx,
  creatorId: string,
  items: readonly Pick<QuoteItemInput, 'deliverable'>[],
): Promise<TerminosIncluidos> {
  const tarifario = await getCurrentRateCard(tx, creatorId);
  if (!tarifario) return { usageRightsDays: null, exclusivityDays: null };
  const porEntregable = new Map(tarifario.items.map((i) => [i.deliverable, i.modifierIds]));
  return terminosDeModificadores(items.flatMap((i) => porEntregable.get(i.deliverable) ?? []));
}

/**
 * Los plazos que se guardan. Lo que llega (también null, «no aplica»)
 * es lo que el creador acordó y se respeta; lo que NO llega (undefined)
 * se toma de lo que el precio del tarifario ya incluye. El formulario de
 * la web manda siempre los dos, ya rellenados a la vista al elegir el
 * entregable; quien crea una cotización por código sin decirlos recibe
 * lo que el precio cobra, no un «no aplica» que lo contradice.
 */
async function incluidosSiFaltan(
  tx: WorkspaceTx,
  input: Pick<CreateQuoteInput, 'items' | 'usageRightsDays' | 'exclusivityDays'>,
  creatorId: string,
): Promise<{ usageRightsDays: number | null; exclusivityDays: number | null }> {
  const faltan = input.usageRightsDays === undefined || input.exclusivityDays === undefined;
  const incluidos = faltan ? await terminosIncluidosEnTarifario(tx, creatorId, input.items) : null;
  return {
    usageRightsDays: input.usageRightsDays === undefined ? (incluidos?.usageRightsDays ?? null) : input.usageRightsDays,
    exclusivityDays: input.exclusivityDays === undefined ? (incluidos?.exclusivityDays ?? null) : input.exclusivityDays,
  };
}

function tasaParaGuardar(taxRate: string | undefined): string | null {
  if (!taxRate || taxRate.trim() === '') return null;
  const t = taxRate.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(t) || Number(t) > 1) {
    throw new CotizarError('TasaInvalida', 'El impuesto es un porcentaje entre 0 y 100.');
  }
  return t;
}

/** Crea la cotización en borrador, con sus ítems y sus totales ya calculados por core. */
export async function createQuote(tx: WorkspaceTx, input: CreateQuoteInput): Promise<QuoteDetail> {
  if (!isUuid(input.creatorId)) throw new CotizarError('CreatorNotFound', 'Elige el creador que firma la cotización.');

  let companyId = input.companyId ?? null;
  const dealId = input.dealId ?? null;
  if (dealId) {
    if (!isUuid(dealId)) throw new CotizarError('DealNotFound', 'Ese negocio no existe en este espacio de trabajo.');
    const { rows } = await tx.query<{ company_id: string }>('SELECT company_id FROM deal WHERE id = $1', [dealId]);
    if (!rows[0]) throw new CotizarError('DealNotFound', 'Ese negocio no existe en este espacio de trabajo.');
    companyId = rows[0].company_id;
  }
  if (!companyId || !isUuid(companyId)) {
    throw new CotizarError('CompanyNotFound', 'Elige la marca a la que le cotizas.');
  }
  if (input.items.length === 0) {
    throw new CotizarError('QuoteSinItems', 'Una cotización necesita al menos un entregable.');
  }
  await assertMediaKitDelCreador(tx, input.mediaKitId, input.creatorId);

  const { rows: ws } = await tx.query<{ currency: string }>('SELECT currency FROM workspace WHERE id = $1', [tx.workspaceId]);
  const moneda = (ws[0]?.currency ?? WORKSPACE_DEFAULTS.currency).toUpperCase();
  const taxRate = tasaParaGuardar(input.taxRate);
  const totales = calcularTotalesCotizacion({
    items: input.items.map((i) => ({ quantity: i.quantity, unitPrice: i.unitPrice })),
    discount: input.discount,
    taxRate: taxRate ?? undefined,
    currency: moneda,
  });

  const incluidos = await incluidosSiFaltan(tx, input, input.creatorId);
  const number = await nextQuoteNumber(tx);

  const { rows: creadas } = await tx.query<{ id: string }>(
    `INSERT INTO quote (workspace_id, deal_id, company_id, creator_id, media_kit_id, number, slug, currency,
                        subtotal, discount, tax, total, tax_rate, agreed_metrics, report_cuts_hours,
                        usage_rights_days, exclusivity_days, exclusivity_scope, payment_terms_days,
                        campaign_starts_on, campaign_ends_on, valid_until, status)
     VALUES (current_workspace_id(), $1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10, $11, $12, $13::text[], $14::int[],
             $15, $16, $17, $18, $19::date, $20::date, $21::date, 'draft')
     RETURNING id`,
    [
      dealId, companyId, input.creatorId, input.mediaKitId ?? null, number, nuevoSlug(),
      moneda,
      totales.subtotal, totales.discount, totales.tax, totales.total, taxRate,
      input.agreedMetrics ?? [], input.reportCutsHours ?? [24, 168, 720],
      incluidos.usageRightsDays, incluidos.exclusivityDays, input.exclusivityScope ?? null,
      input.paymentTermsDays ?? 30,
      input.campaignStartsOn ?? null, input.campaignEndsOn ?? null, input.validUntil ?? null,
    ],
  );
  const id = creadas[0]?.id;
  if (!id) throw new CotizarError('QuoteInsertError', 'No se pudo crear la cotización.');

  await insertItems(tx, id, input.items, totales.lineTotals);
  const quote = await getQuote(tx, id);
  if (!quote) throw new CotizarError('QuoteInsertError', 'No se pudo leer la cotización recién creada.');
  return quote;
}

async function insertItems(tx: WorkspaceTx, quoteId: string, items: readonly QuoteItemInput[], lineTotals: readonly Decimal[]): Promise<void> {
  for (const [i, item] of items.entries()) {
    await tx.query(
      `INSERT INTO quote_item (quote_id, deliverable, platform_id, description, quantity, unit_price, total, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [quoteId, item.deliverable, item.platformId, item.description, item.quantity, item.unitPrice, lineTotals[i], i],
    );
  }
}

export interface UpdateQuoteInput extends Omit<CreateQuoteInput, 'creatorId' | 'dealId' | 'companyId'> {
  items: QuoteItemInput[];
}

/**
 * Reescribe un borrador entero: ítems y lo acordado. Una enviada ya no
 * se toca. Corregir un precio no quema otro número COT-AAAA-NNN.
 */
export async function updateQuoteDraft(tx: WorkspaceTx, id: string, input: UpdateQuoteInput): Promise<QuoteDetail> {
  const actual = await getQuoteForUpdate(tx, id);
  if (!actual) throw new QuoteNotFound();
  if (actual.status !== 'draft') throw new QuoteNotEditable(actual.status);
  if (input.items.length === 0) throw new CotizarError('QuoteSinItems', 'Una cotización necesita al menos un entregable.');
  // undefined: el media kit no se toca; null: se quita.
  const mediaKitId = input.mediaKitId === undefined ? actual.mediaKitId : input.mediaKitId;
  await assertMediaKitDelCreador(tx, mediaKitId, actual.creatorId);

  const taxRate = tasaParaGuardar(input.taxRate);
  const totales = calcularTotalesCotizacion({
    items: input.items.map((i) => ({ quantity: i.quantity, unitPrice: i.unitPrice })),
    discount: input.discount,
    taxRate: taxRate ?? undefined,
    currency: actual.currency,
  });
  const incluidos = await incluidosSiFaltan(tx, input, actual.creatorId);

  const { rows: editada } = await tx.query<{ id: string }>(
    `UPDATE quote
        SET subtotal = $2, discount = $3, tax = $4, total = $5, tax_rate = $6,
            agreed_metrics = $7::text[], report_cuts_hours = $8::int[],
            usage_rights_days = $9, exclusivity_days = $10, exclusivity_scope = $11,
            payment_terms_days = $12, campaign_starts_on = $13::date, campaign_ends_on = $14::date,
            valid_until = $15::date, media_kit_id = $16
      WHERE id = $1 AND status = 'draft'
      RETURNING id`,
    [
      id, totales.subtotal, totales.discount, totales.tax, totales.total, taxRate,
      input.agreedMetrics ?? actual.agreedMetrics, input.reportCutsHours ?? actual.reportCutsHours,
      incluidos.usageRightsDays, incluidos.exclusivityDays, input.exclusivityScope ?? null,
      input.paymentTermsDays ?? actual.paymentTermsDays,
      input.campaignStartsOn ?? null, input.campaignEndsOn ?? null, input.validUntil ?? null, mediaKitId ?? null,
    ],
  );
  // Con la fila bloqueada no debería pasar; si pasa, los ítems no se tocan.
  if (!editada[0]) throw new QuoteNotEditable(actual.status);
  await tx.query('DELETE FROM quote_item WHERE quote_id = $1', [id]);
  await insertItems(tx, id, input.items, totales.lineTotals);

  const quote = await getQuote(tx, id);
  if (!quote) throw new QuoteNotFound();
  return quote;
}

/**
 * Borra un borrador. Una cotización enviada ya es un documento que la
 * marca tiene: esa no se borra, se rechaza o vence. Si el borrador era
 * el último número del año, el siguiente lo reutiliza.
 */
export async function deleteQuoteDraft(tx: WorkspaceTx, id: string): Promise<void> {
  const actual = await getQuoteForUpdate(tx, id);
  if (!actual) throw new QuoteNotFound();
  if (actual.status !== 'draft') throw new QuoteNotDraft(actual.status);
  await tx.query("DELETE FROM quote WHERE id = $1 AND status = 'draft'", [id]);
}

/**
 * Lo que la marca verá en el enlace, congelado al enviarlo. Editar la
 * cotización después no cambia un documento ya entregado, y la página
 * pública no necesita leer quote_item, company ni creator_profile en
 * vivo (una política menos por tabla; ver 0030).
 */
export interface QuotePublicSnapshot {
  version: 1;
  number: string;
  currency: string;
  locale: string;
  timezone: string;
  company: { name: string };
  creator: { displayName: string; handle: string | null };
  items: { description: string; platformId: PlatformId | null; quantity: number; unitPrice: Decimal; total: Decimal }[];
  subtotal: Decimal;
  discount: Decimal;
  tax: Decimal;
  /** Fracción. Opcional: los primeros snapshots no la traen. */
  taxRate?: string | null;
  total: Decimal;
  acordado: {
    metrics: string[];
    cutsHours: number[];
    usageRightsDays: number | null;
    exclusivityDays: number | null;
    exclusivityScope: string | null;
    paymentTermsDays: number;
    campaignStartsOn: string | null;
    campaignEndsOn: string | null;
  };
  /** Enlace al media kit que la acompaña, si lo hay. */
  mediaKitSlug: string | null;
}

async function buildQuoteSnapshot(tx: WorkspaceTx, quote: QuoteDetail): Promise<QuotePublicSnapshot> {
  const { rows: creador } = await tx.query<{ display_name: string; handle: string | null }>(
    'SELECT display_name, handle FROM creator_profile WHERE id = $1',
    [quote.creatorId],
  );
  const { rows: kit } = await tx.query<{ slug: string }>(
    'SELECT k.slug FROM quote q JOIN media_kit k ON k.id = q.media_kit_id WHERE q.id = $1',
    [quote.id],
  );
  const { rows: ws } = await tx.query<{ locale: string; timezone: string }>(
    'SELECT locale, timezone FROM workspace WHERE id = $1',
    [tx.workspaceId],
  );
  return {
    version: 1,
    number: quote.number,
    currency: quote.currency,
    locale: ws[0]?.locale ?? WORKSPACE_DEFAULTS.locale,
    timezone: ws[0]?.timezone ?? WORKSPACE_DEFAULTS.timeZone,
    company: { name: quote.companyName },
    creator: { displayName: creador[0]?.display_name ?? '', handle: creador[0]?.handle ?? null },
    items: quote.items.map((i) => ({
      description: i.description,
      platformId: i.platformId,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      total: i.total,
    })),
    subtotal: quote.subtotal,
    discount: quote.discount,
    tax: quote.tax,
    taxRate: quote.taxRate,
    total: quote.total,
    acordado: {
      metrics: quote.agreedMetrics,
      cutsHours: quote.reportCutsHours,
      usageRightsDays: quote.usageRightsDays,
      exclusivityDays: quote.exclusivityDays,
      exclusivityScope: quote.exclusivityScope,
      paymentTermsDays: quote.paymentTermsDays,
      campaignStartsOn: quote.campaignStartsOn,
      campaignEndsOn: quote.campaignEndsOn,
    },
    mediaKitSlug: kit[0]?.slug ?? null,
  };
}

/**
 * La cotización tal como la ve (o la verá) la marca, para la vista
 * previa del panel. NO pasa por public_quote(): el creador mirando su
 * propio documento no es una visita, ni la marca como vista.
 *
 * Enviada: el snapshot congelado, que es lo que la marca tiene. Borrador:
 * el snapshot que se congelaría si se enviara ahora, para revisarlo
 * antes de «Enviar». Lleva además el id del media kit adjunto, que la
 * página pública no recibe.
 */
export async function getQuotePreview(
  tx: WorkspaceTx,
  id: string,
): Promise<(PublicQuoteView & { mediaKitId: string | null }) | null> {
  const quote = await getQuote(tx, id);
  if (!quote) return null;
  let snapshot: QuotePublicSnapshot;
  if (quote.status === 'draft') {
    snapshot = await buildQuoteSnapshot(tx, quote);
  } else {
    const { rows } = await tx.query<{ public_snapshot: QuotePublicSnapshot | null }>(
      'SELECT public_snapshot FROM quote WHERE id = $1',
      [id],
    );
    snapshot = rows[0]?.public_snapshot ?? (await buildQuoteSnapshot(tx, quote));
  }
  return {
    ...snapshot,
    slug: quote.slug,
    status: quote.status,
    validUntil: quote.validUntil,
    sentAt: quote.sentAt,
    viewedAt: quote.viewedAt,
    acceptedAt: quote.acceptedAt,
    acceptedByName: quote.acceptedByName,
    rejectedAt: quote.rejectedAt,
    expiredAt: quote.expiredAt,
    // Solo para el panel: la vista previa enlaza el media kit por su
    // vista previa (que no cuenta visitas), no por el enlace público.
    mediaKitId: quote.mediaKitId,
  };
}

/**
 * Las frases que Cotizar deja escritas en tablas de otros módulos. Las
 * compone la web con su messages.ts (apps/web/app/(app)/cotizar/
 * _lib/textos.ts) y llegan aquí ya en el idioma de la pantalla: este
 * paquete no tiene idioma.
 *
 * Por qué hacen falta frases y no solo códigos: activity.subject es lo
 * que la ficha del negocio en Ventas enseña tal cual, y
 * notification.title_es es NOT NULL desde 0009. Junto a cada frase se
 * guardan el código y los parámetros (activity.metadata.kind,
 * notification.kind + entity_id): quien quiera otra frase u otro idioma
 * la recompone con ellos, que es lo que hace el aviso de la lista de
 * cotizaciones (listAcceptanceNotices).
 */
export interface TextosCotizar {
  /** Asunto de la actividad del negocio al enviar la cotización. */
  actividadEnviada(p: { quoteNumber: string }): string;
  /** Asunto de la actividad del negocio al aceptarla, desde el panel o desde el enlace. */
  actividadAceptada(p: {
    quoteNumber: string;
    signerName: string | null;
    signerEmail: string | null;
    via: 'panel' | 'enlace';
  }): string;
  /**
   * Asunto de la actividad del negocio cuando su monto pasa a ser el de
   * la cotización (al enviarla o al aceptarla). Los montos llegan como
   * string decimal, sin impuesto; la web los formatea.
   */
  actividadMonto(p: {
    quoteNumber: string;
    amountFrom: string | null;
    currencyFrom: string;
    amountTo: string;
    currencyTo: string;
  }): string;
  /**
   * La siguiente acción que deja enviar la cotización en el negocio
   * («Seguimiento a la cotización»). Sale del messages.ts de Ventas, que
   * es quien la enseña en el tablero. Sin ella, FOLLOW_UP_ACTION.
   */
  accionSeguimiento?: string;
  /**
   * Las siguientes acciones que enviar una cotización deja atrás («Enviar
   * pitch», la del radar), también del messages.ts de Ventas. PITCH_ACTION
   * cuenta siempre.
   */
  accionesSuperadas?: readonly string[];
  /** El aviso al creador cuando la marca acepta desde el enlace. */
  avisoAceptada(p: {
    companyName: string;
    quoteNumber: string;
    signerName: string | null;
    signerEmail: string | null;
    campaignName: string | null;
  }): { title: string; body: string };
}

/**
 * Enviar. En el MVP no hay correo: enviar es congelar el documento,
 * dejarlo en 'sent' y entregar el enlace para pegarlo donde ya se está
 * hablando con la marca.
 *
 * Una cotización cuya «válida hasta» ya pasó (en la zona del workspace)
 * no se envía: nacería vencida y la marca abriría un enlace que no
 * acepta. Se corrige la fecha en el borrador y se envía.
 *
 * Efecto en Ventas: el deal pasa a «Propuesta enviada» (si no estaba
 * ya más adelante) por la misma transición que el tablero —moveDeal,
 * deal_move_stage de 0031—, su monto pasa a ser el neto de la
 * cotización, con la actividad que lo cuenta, y si su siguiente acción
 * era el pitch del radar pasa a «Seguimiento a la cotización» a tres
 * días hábiles (followUpAfterProposal): el pitch ya se superó.
 */
export async function sendQuote(tx: WorkspaceTx, id: string, textos: TextosCotizar): Promise<QuoteDetail> {
  const quote = await getQuoteForUpdate(tx, id);
  if (!quote) throw new QuoteNotFound();
  if (quote.status !== 'draft') throw new QuoteTransitionError(quote.status, 'sent');
  if (quote.items.length === 0) throw new CotizarError('QuoteSinItems', 'Una cotización sin entregables no se puede enviar.');
  if (quote.validUntil) {
    const { rows } = await tx.query<{ vencida: boolean }>(
      `SELECT $2::date < (now() AT TIME ZONE coalesce(nullif(w.timezone, ''), 'UTC'))::date AS vencida
         FROM workspace w WHERE w.id = $1`,
      [tx.workspaceId, quote.validUntil],
    );
    if (rows[0]?.vencida) throw new ValidezVencida();
  }

  const snapshot = await buildQuoteSnapshot(tx, quote);
  await transicionar(tx, id, ['draft'], 'sent', 'sent_at = coalesce(sent_at, now()), public_snapshot = $4::jsonb', [
    JSON.stringify(snapshot),
  ]);

  if (quote.dealId) await moverDealAPropuesta(tx, quote.dealId, quote, textos);

  const actualizada = await getQuote(tx, id);
  if (!actualizada) throw new QuoteNotFound();
  return actualizada;
}

async function moverDealAPropuesta(
  tx: WorkspaceTx,
  dealId: string,
  quote: Pick<QuoteDetail, 'id' | 'number'>,
  textos: TextosCotizar,
): Promise<void> {
  // Un deal ganado o perdido no retrocede a «Propuesta enviada», y uno
  // que ya está más adelante (negociación) tampoco: forwardOnly. El
  // monto sí se actualiza mientras el negocio esté abierto.
  const mov = await moverConMontoDeCotizacion(tx, dealId, quote.id, 'propuesta', true);
  if (mov?.moved) {
    await tx.query('UPDATE deal SET last_contact_at = now() WHERE id = $1', [dealId]);
  }
  if (mov) {
    await followUpAfterProposal(tx, dealId, {
      followUpAction: textos.accionSeguimiento,
      supersededActions: textos.accionesSuperadas,
    });
  }
  await registrarActividad(tx, dealId, 'proposal_sent', textos.actividadEnviada({ quoteNumber: quote.number }), {
    kind: 'quote_sent',
    quoteId: quote.id,
    quoteNumber: quote.number,
  });
  if (mov) await registrarCambioDeMonto(tx, dealId, quote, mov, textos);
}

/**
 * Mueve el negocio de la cotización con la transición única de Ventas
 * (moveDeal → deal_move_stage de 0031) y le pone el monto NETO de la
 * cotización: total − impuesto, es decir, el subtotal menos el
 * descuento. Sin impuesto, como el resto del pipeline. La resta la hace
 * Postgres sobre numeric, no JavaScript.
 *
 * Devuelve null si el negocio ya no se ve (borrado o de otro workspace).
 */
async function moverConMontoDeCotizacion(
  tx: WorkspaceTx,
  dealId: string,
  quoteId: string,
  etapa: 'propuesta' | 'ganado',
  forwardOnly: boolean,
): Promise<MoveDealResult | null> {
  const { rows } = await tx.query<{ neto: string; currency: string }>(
    'SELECT (total - tax)::numeric(14,2)::text AS neto, currency::text AS currency FROM quote WHERE id = $1',
    [quoteId],
  );
  const q = rows[0];
  try {
    return await moveDeal(tx, dealId, etapa, {
      forwardOnly,
      amount: q?.neto ?? null,
      currency: q?.currency ?? null,
      logActivity: false,
    });
  } catch (err) {
    if (err instanceof DealNotFound) return null;
    throw err;
  }
}

/**
 * Aceptar desde el panel (la marca dijo que sí por otro canal). Hace lo
 * mismo que la función pública `public_quote_accept` (0030, reescrita
 * en 0031): deja la cotización en 'accepted' y el deal en «Ganado» por
 * la transición única, con el monto neto de la cotización.
 */
export async function acceptQuote(tx: WorkspaceTx, id: string, textos: TextosCotizar): Promise<QuoteDetail> {
  const quote = await getQuoteForUpdate(tx, id);
  if (!quote) throw new QuoteNotFound();
  if (quote.status !== 'sent' && quote.status !== 'viewed') throw new QuoteTransitionError(quote.status, 'accepted');

  await transicionar(tx, id, ['sent', 'viewed'], 'accepted', 'accepted_at = coalesce(accepted_at, now())');
  if (quote.dealId) {
    const mov = await moverConMontoDeCotizacion(tx, quote.dealId, quote.id, 'ganado', false);
    await registrarAceptacion(tx, quote, 'panel', textos);
    if (mov) await registrarCambioDeMonto(tx, quote.dealId, quote, mov, textos);
  }

  const actualizada = await getQuote(tx, id);
  if (!actualizada) throw new QuoteNotFound();
  return actualizada;
}

/**
 * Rechazar desde el panel. Con la fila bloqueada: si la marca aceptó
 * desde el enlace un instante antes, esto falla con
 * QuoteTransitionError('accepted', 'rejected') en vez de dejar una
 * cotización «rechazada» con el negocio ganado.
 */
export async function rejectQuote(tx: WorkspaceTx, id: string): Promise<QuoteDetail> {
  const quote = await getQuoteForUpdate(tx, id);
  if (!quote) throw new QuoteNotFound();
  if (quote.status !== 'sent' && quote.status !== 'viewed') throw new QuoteTransitionError(quote.status, 'rejected');
  await transicionar(tx, id, ['sent', 'viewed'], 'rejected', 'rejected_at = coalesce(rejected_at, now())');
  const actualizada = await getQuote(tx, id);
  if (!actualizada) throw new QuoteNotFound();
  return actualizada;
}
