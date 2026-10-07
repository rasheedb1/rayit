/**
 * Ventas · el pipeline (VEN-3): el tablero, los KPI, los totales por
 * etapa, mover un negocio y las etapas. Dueño: Rasheed.
 */
import { isUuid, type WorkspaceTx } from '../../client.ts';
import { LOST_REASONS } from '../../schema/ventas.ts';
import { briefVerdictSql } from '../brief.ts';
import { WORKSPACE_DEFAULTS } from '../cimientos.ts';
import { DealLocked, DealNotFound, type LostReason, type PipelineDealRow, type Relationship, type SalesKpis, VentasError } from './comun.ts';
import { type PipelineRowSql, toPipelineRow } from './interno.ts';
import { WORKSPACE_TZ } from './radar.ts';

/** Los dos filtros de seguimiento del pipeline (VEN-4): ver listPipeline. */
export const PIPELINE_SEGUIMIENTOS = ['sin_accion', 'para_hoy'] as const;

export type PipelineSeguimiento = (typeof PIPELINE_SEGUIMIENTOS)[number];

/**
 * Los deals del workspace por etapa y, dentro de cada una, por fecha de
 * siguiente acción. Sale de la vista deal_pipeline, que ya resuelve
 * probabilidad, monto ponderado y estado del seguimiento; se le añaden
 * los días en la etapa actual (del historial) y el responsable.
 *
 * Trae también lo que el editor de la siguiente acción necesita (VEN-4):
 * el día y la hora del vencimiento en la zona del espacio, y quién la
 * hace. Así el tablero, la lista y la ficha leen la siguiente acción de
 * esta única consulta y no de una segunda lectura de deal_pipeline.
 *
 * Los filtros van en SQL, no en la pantalla (VEN-4/VEN-5):
 *   - `companyId`: solo los negocios de una empresa (la ficha no lee el
 *     pipeline entero para quedarse con tres).
 *   - `seguimiento`: 'sin_accion' deja los abiertos sin siguiente acción
 *     con texto y fecha; 'para_hoy', los abiertos con acción vencida o
 *     que vence hoy. Son los dos enlaces del bloque «Para hoy» y cuentan
 *     igual que sus cifras (listDueToday).
 */
export async function listPipeline(
  tx: WorkspaceTx,
  opts: { companyId?: string; seguimiento?: PipelineSeguimiento | null } = {},
): Promise<PipelineDealRow[]> {
  if (opts.companyId !== undefined && !isUuid(opts.companyId)) return [];
  const seguimiento = opts.seguimiento && PIPELINE_SEGUIMIENTOS.includes(opts.seguimiento) ? opts.seguimiento : null;
  const { rows } = await tx.query<PipelineRowSql>(
    `SELECT p.id, p.company_id, p.company_name, p.name, p.stage_id, p.stage_label, p.stage_position,
            p.amount::text AS amount, p.currency::text AS currency, p.probability::text AS probability,
            p.weighted_amount::text AS weighted_amount, p.next_action,
            to_char(p.next_action_due AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS next_action_due,
            to_char(p.next_action_due AT TIME ZONE w.tz, 'YYYY-MM-DD') AS next_action_due_date,
            to_char(p.next_action_due AT TIME ZONE w.tz, 'HH24:MI') AS next_action_due_time,
            d.next_action_user_id, coalesce(nullif(btrim(nu.name), ''), nu.email::text) AS next_action_user_name,
            p.due_state,
            to_char(p.last_contact_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_contact_at,
            ((now() AT TIME ZONE w.tz)::date - (p.last_contact_at AT TIME ZONE w.tz)::date) AS last_contact_days,
            p.expected_close_date::text AS expected_close_date, p.is_won, p.is_lost,
            d.owner_user_id, u.name AS owner_name, d.lost_reason, d.creator_id, cp.display_name AS creator_name,
            round(extract(epoch FROM now() - COALESCE(h.changed_at, d.created_at)) / 86400.0)::int AS days_in_stage
     FROM deal_pipeline p
     JOIN deal d ON d.id = p.id
     CROSS JOIN ${WORKSPACE_TZ} w
     LEFT JOIN app_user u ON u.id = d.owner_user_id
     LEFT JOIN creator_profile cp ON cp.id = d.creator_id
     LEFT JOIN app_user nu ON nu.id = d.next_action_user_id
     LEFT JOIN LATERAL (
       SELECT changed_at FROM deal_stage_history
       WHERE deal_id = p.id AND to_stage_id = p.stage_id
       ORDER BY changed_at DESC LIMIT 1
     ) h ON true
     WHERE ($1::uuid IS NULL OR p.company_id = $1::uuid)
       AND ($2::text IS NULL
            OR ($2 = 'sin_accion' AND NOT p.is_won AND NOT p.is_lost
                AND (nullif(btrim(p.next_action), '') IS NULL OR p.next_action_due IS NULL))
            OR ($2 = 'para_hoy' AND NOT p.is_won AND NOT p.is_lost
                AND nullif(btrim(p.next_action), '') IS NOT NULL AND p.due_state IN ('vencido', 'hoy')))
     ORDER BY p.stage_position ASC, p.next_action_due ASC NULLS LAST, p.name ASC`,
    [opts.companyId ?? null, seguimiento],
  );
  return rows.map(toPipelineRow);
}

/** Un deal del workspace por su id, o null si no existe (o no es suyo, o el id es imposible). */
export async function getPipelineDeal(tx: WorkspaceTx, dealId: string): Promise<PipelineDealRow | null> {
  if (!isUuid(dealId)) return null;
  const all = await listPipeline(tx);
  return all.find((d) => d.id === dealId) ?? null;
}

/**
 * Los cuatro números de arriba del módulo, todos en SQL y todos en la
 * moneda del workspace. Ninguna pantalla los suma: si mañana hace falta
 * otro, se añade aquí.
 *
 * «Ganado en el trimestre» usa won_at, no la etapa: un deal movido a
 * «Ganado» y luego reabierto no debe contar dos veces. El trimestre se
 * corta en la zona del workspace, no en UTC.
 */
export async function getSalesKpis(tx: WorkspaceTx): Promise<SalesKpis> {
  const { rows } = await tx.query<{
    pending_signals: string; open_deals: string; open_amount: string; weighted_amount: string;
    won_quarter: string; won_quarter_count: string; won_quarter_no_amount: string; no_next_action: string; overdue: string;
    currency: string;
  }>(
    `WITH w AS ${WORKSPACE_TZ},
          -- El trimestre empieza a medianoche EN LA ZONA DEL WORKSPACE: en
          -- Bogotá, un negocio ganado el 30 de septiembre a las 20:00 es
          -- del tercer trimestre, aunque en UTC ya sea 1 de octubre.
          desde AS (SELECT coalesce((SELECT date_trunc('quarter', now() AT TIME ZONE w.tz) AT TIME ZONE w.tz FROM w),
                                    date_trunc('quarter', now())) AS inicio)
     SELECT
       (SELECT count(*) FROM signal s
         WHERE s.status = 'pending' AND ${briefVerdictSql('s')} IS NULL)::text            AS pending_signals,
       (SELECT count(*) FROM deal_pipeline WHERE NOT is_won AND NOT is_lost)::text        AS open_deals,
       (SELECT COALESCE(sum(amount), 0) FROM deal_pipeline
         WHERE NOT is_won AND NOT is_lost)::text                                          AS open_amount,
       (SELECT COALESCE(sum(weighted_amount), 0) FROM deal_pipeline
         WHERE NOT is_won AND NOT is_lost)::text                                          AS weighted_amount,
       (SELECT COALESCE(sum(amount), 0) FROM deal, desde
         WHERE won_at >= desde.inicio)::text                                              AS won_quarter,
       (SELECT count(*) FROM deal, desde WHERE won_at >= desde.inicio)::text              AS won_quarter_count,
       (SELECT count(*) FROM deal, desde
         WHERE won_at >= desde.inicio AND amount IS NULL)::text                           AS won_quarter_no_amount,
       (SELECT count(*) FROM deal_pipeline
         WHERE NOT is_won AND NOT is_lost AND next_action IS NULL)::text                  AS no_next_action,
       (SELECT count(*) FROM deal_pipeline
         WHERE NOT is_won AND NOT is_lost AND due_state = 'vencido')::text                AS overdue,
       (SELECT currency::text FROM workspace WHERE id = current_workspace_id())           AS currency`,
  );
  const r = rows[0];
  return {
    pendingSignals: Number(r?.pending_signals ?? 0),
    openDeals: Number(r?.open_deals ?? 0),
    openAmount: r?.open_amount ?? '0',
    weightedAmount: r?.weighted_amount ?? '0',
    wonQuarter: r?.won_quarter ?? '0',
    wonQuarterCount: Number(r?.won_quarter_count ?? 0),
    wonQuarterNoAmountCount: Number(r?.won_quarter_no_amount ?? 0),
    noNextActionCount: Number(r?.no_next_action ?? 0),
    overdueCount: Number(r?.overdue ?? 0),
    currency: r?.currency ?? WORKSPACE_DEFAULTS.currency,
  };
}

export interface StageTotal {
  stageId: string;
  labelEs: string;
  position: number;
  isWon: boolean;
  isLost: boolean;
  /** Probabilidad por defecto de la etapa, 0..1 como string decimal. */
  defaultProbability: string;
  dealCount: number;
  /** Suma de los montos de la columna, string decimal. */
  amount: string;
  /** Suma ponderada de la columna, string decimal. */
  weightedAmount: string;
}

/**
 * Cada etapa con lo que lleva encima: cuántos negocios y cuánto suman.
 *
 * Existe porque el tablero muestra el monto en la cabecera de cada
 * columna (como Pipedrive) y sumarlo en React sería aritmética de
 * métricas en la pantalla, que es justo lo que el repositorio no
 * permite. Devuelve TODAS las etapas, también las vacías: una columna
 * sin negocios sigue siendo una columna del tablero.
 */
export async function getStageTotals(tx: WorkspaceTx): Promise<StageTotal[]> {
  const { rows } = await tx.query<{
    id: string; label_es: string; position: number; is_won: boolean; is_lost: boolean;
    default_probability: string; deal_count: string; amount: string; weighted_amount: string;
  }>(
    `SELECT st.id, st.label_es, st.position, st.is_won, st.is_lost,
            st.default_probability::text                      AS default_probability,
            count(p.id)::text                                 AS deal_count,
            COALESCE(sum(p.amount), 0)::text                  AS amount,
            COALESCE(sum(p.weighted_amount), 0)::text         AS weighted_amount
     FROM pipeline_stage st
     LEFT JOIN deal_pipeline p ON p.stage_id = st.id
     GROUP BY st.id, st.label_es, st.position, st.is_won, st.is_lost, st.default_probability
     ORDER BY st.position ASC`,
  );
  return rows.map((r) => ({
    stageId: r.id,
    labelEs: r.label_es,
    position: r.position,
    isWon: r.is_won,
    isLost: r.is_lost,
    defaultProbability: r.default_probability,
    dealCount: Number(r.deal_count),
    amount: r.amount,
    weightedAmount: r.weighted_amount,
  }));
}

export interface MoveDealResult {
  dealId: string;
  fromStageId: string;
  toStageId: string;
  /** Se movió. False si ya estaba en esa etapa o si `forwardOnly` lo dejó donde estaba. */
  moved: boolean;
  /** Días que pasó en la etapa que deja, con dos decimales. Null si no se movió. */
  daysInStage: string | null;
  isWon: boolean;
  isLost: boolean;
  /** El monto cambió por `opts.amount` (una cotización). */
  amountChanged: boolean;
  amountFrom: string | null;
  currencyFrom: string;
  amountTo: string | null;
  currencyTo: string;
  /**
   * La marca pasó a «Cliente» porque el negocio se ganó (ver
   * promoteCompanyOnWin). False si ya lo era, o si no se ganó.
   */
  companyPromoted: boolean;
  /**
   * Las cotizaciones enviadas o vistas que se cerraron ('rejected')
   * porque el negocio se perdió (0031): la marca ya no puede aceptarlas
   * desde el enlace. Vacío en cualquier otra transición.
   */
  closedQuotes: { id: string; number: string }[];
}

/** La frase de la actividad «se cerró la cotización al perder el negocio», si la pantalla no da otra (respaldo, como PITCH_ACTION). */
export const quoteClosedOnLossActivity = (quoteNumber: string): string => `${quoteNumber} se cerró al perder el negocio`;

export interface MoveDealOptions {
  /** No retroceder: si ya está en esa etapa o más adelante, o cerrado, no se mueve. */
  forwardOnly?: boolean;
  /**
   * El monto que acuerda una cotización (string decimal, sin impuesto),
   * o el que se escribe en el tablero al ganar un negocio que no tenía.
   *
   * Ganar pide monto: un negocio que llega a una etapa ganada sin monto
   * (ni el suyo ni este) no se mueve (AmountRequired) y nada queda
   * escrito. Si no, «N cerrados» sube y «Ganado este trimestre» no, y
   * las dos cifras dejan de cuadrar sin explicación (pulido r7).
   */
  amount?: string | null;
  currency?: string | null;
  /**
   * Dejar la actividad «Etapa → Etapa» (por defecto, sí). Cotizar la
   * apaga porque deja la suya, con el número de la cotización.
   */
  logActivity?: boolean;
  /**
   * Por qué se pierde. OBLIGATORIO al pasar a una etapa perdida: sin él
   * la transición no se hace (LostReasonRequired) y nada queda escrito.
   * Se ignora en cualquier otra etapa.
   */
  lostReason?: LostReason | null;
  /**
   * La frase de la actividad que cuenta cada cotización cerrada al
   * perder el negocio, en el idioma de la pantalla. Por defecto,
   * quoteClosedOnLossActivity.
   */
  quoteClosedActivity?: (quoteNumber: string) => string;
}

interface MoveStageJson {
  status: 'not_found' | 'invalid_stage' | 'locked' | 'moved' | 'unchanged';
  reason?: 'campaign' | 'quote';
  fromStageId?: string;
  toStageId?: string;
  daysInStage?: string | null;
  isWon?: boolean;
  isLost?: boolean;
  amountChanged?: boolean;
  amountFrom?: string | null;
  currencyFrom?: string;
  amountTo?: string | null;
  currencyTo?: string;
  closedQuotes?: { id: string; number: string }[];
}

/**
 * Mueve un negocio de etapa. Es la ÚNICA transición: la usan el
 * tablero, Cotizar al enviar y aceptar, y (en SQL) la aceptación desde
 * el enlace público. Las reglas viven en la función deal_move_stage de
 * la migración 0031 —historial con los días en la etapa que deja,
 * won_at/lost_at según la de llegada, lost_reason solo en «Perdido»,
 * probabilidad de vuelta a la de la etapa— para que no haya tres
 * copias que diverjan.
 *
 * Es idempotente: mover a la etapa en la que ya está no escribe
 * historial ni cambia fechas. Perder un negocio cierra sus cotizaciones
 * enviadas o vistas (`closedQuotes`), para que la marca no lo gane
 * después desde el enlace por encima del motivo de pérdida. Sacar de «Ganado» un negocio con campaña
 * viva o con la cotización firmada lanza DealLocked: la cotización y
 * la campaña dirían otra cosa.
 *
 * El id de la etapa puede ser uno global legible ('propuesta') o el
 * uuid al azar de una etapa privada del workspace (0026 §2); una etapa
 * que no existe o que es de otro workspace es InvalidStage.
 */
export async function moveDeal(
  tx: WorkspaceTx,
  dealId: string,
  toStageId: string,
  opts: MoveDealOptions = {},
): Promise<MoveDealResult> {
  if (!isUuid(dealId)) throw new DealNotFound();
  if (!toStageId || toStageId.length > 64) throw new VentasError('InvalidStage');
  const amount = opts.amount?.trim() || null;
  if (amount !== null && !/^\d{1,12}(\.\d{1,2})?$/.test(amount)) throw new VentasError('InvalidAmount');
  const lostReason = opts.lostReason ?? null;
  if (lostReason !== null && !LOST_REASONS.includes(lostReason)) throw new VentasError('InvalidReason');

  const { rows } = await tx.query<{ r: MoveStageJson }>(
    'SELECT deal_move_stage($1::uuid, $2::text, $3::boolean, $4::numeric, $5::text) AS r',
    [dealId, toStageId, opts.forwardOnly ?? false, amount, opts.currency ?? null],
  );
  const r = rows[0]?.r;
  if (!r || r.status === 'not_found') throw new DealNotFound();
  if (r.status === 'invalid_stage') throw new VentasError('InvalidStage');
  if (r.status === 'locked') throw new DealLocked(r.reason === 'quote' ? 'quote' : 'campaign');

  // Ganar sin monto: se lanza antes de escribir nada más, y la
  // transacción entera (el paso de etapa incluido) se deshace.
  if (r.status === 'moved' && r.isWon && (r.amountTo ?? null) === null) throw new VentasError('AmountRequired');

  const result: MoveDealResult = {
    dealId,
    fromStageId: r.fromStageId ?? '',
    toStageId: r.toStageId ?? '',
    moved: r.status === 'moved',
    daysInStage: r.daysInStage ?? null,
    isWon: r.isWon ?? false,
    isLost: r.isLost ?? false,
    amountChanged: r.amountChanged ?? false,
    amountFrom: r.amountFrom ?? null,
    currencyFrom: r.currencyFrom ?? '',
    amountTo: r.amountTo ?? null,
    currencyTo: r.currencyTo ?? '',
    companyPromoted: false,
    closedQuotes: r.closedQuotes ?? [],
  };

  // Perder un negocio pide su motivo: es el dato con el que el pipeline
  // aprende dónde se caen las ventas, y la columna existía vacía. Se
  // escribe en la misma transacción que el paso de etapa; sin motivo se
  // lanza y la transacción entera (el paso incluido) se deshace.
  // deal_move_stage conserva lost_reason al entrar en «Perdido» y lo
  // borra al salir, así que aquí solo hace falta escribirlo.
  if (result.moved && result.isLost) {
    if (lostReason === null) throw new VentasError('LostReasonRequired');
    await tx.query('UPDATE deal SET lost_reason = $2 WHERE id = $1', [dealId, lostReason]);
    // Las cotizaciones que deal_move_stage cerró al perderlo: cada una
    // deja su línea en la historia del negocio, con el motivo.
    const frase = opts.quoteClosedActivity ?? quoteClosedOnLossActivity;
    for (const q of result.closedQuotes) {
      await tx.query(
        `INSERT INTO activity (workspace_id, company_id, deal_id, user_id, kind, subject, metadata)
         SELECT current_workspace_id(), d.company_id, d.id, current_user_id(), 'note', $2,
                jsonb_build_object('kind', 'quote_closed_on_loss', 'quoteId', $3::text, 'quoteNumber', $4::text,
                                   'lost_reason', $5::text)
           FROM deal d WHERE d.id = $1`,
        [dealId, frase(q.number), q.id, q.number, lostReason],
      );
    }
  }

  // Ganar un negocio hace cliente a la marca, en la misma transacción:
  // el tablero, Cotizar al aceptar y (en completePublicAcceptance) el
  // enlace público pasan por aquí o llaman a lo mismo.
  if (result.moved && result.isWon) {
    result.companyPromoted = await promoteCompanyOnWin(tx, dealId);
  }

  if (result.moved && (opts.logActivity ?? true)) {
    await tx.query(
      `INSERT INTO activity (workspace_id, company_id, deal_id, user_id, kind, subject, metadata)
       SELECT current_workspace_id(), d.company_id, d.id, current_user_id(), 'stage_change',
              (SELECT label_es FROM pipeline_stage WHERE id = $2) || ' → ' ||
              (SELECT label_es FROM pipeline_stage WHERE id = $3),
              jsonb_strip_nulls(jsonb_build_object('from', $2::text, 'to', $3::text, 'days_in_stage', $4::numeric,
                                                   'lost_reason', $5::text))
       FROM deal d WHERE d.id = $1`,
      [dealId, result.fromStageId, result.toStageId, result.daysInStage, result.isLost ? lostReason : null],
    );
  }
  return result;
}

/**
 * Las relaciones que un negocio ganado sube a «Cliente». Nunca baja una:
 * «Cliente» se queda, y «Bloqueada» es una decisión de la persona que un
 * negocio no deshace. «Cliente anterior» sí sube: si vuelve a comprar,
 * vuelve a ser cliente.
 */
const PROMOTE_ON_WIN: readonly Relationship[] = ['prospect', 'contacted', 'past_client'];

/**
 * Un negocio ganado hace cliente a su marca en este workspace.
 *
 * La relación la escribía solo la persona, y no seguía al pipeline:
 * Olla Fácil quedaba «Prospecto» y «Sin negocios abiertos» justo después
 * de ganarla. Se puede llamar siempre: solo actúa si el negocio está en
 * una etapa ganada y la relación es una de PROMOTE_ON_WIN. Devuelve si
 * cambió algo.
 */
export async function promoteCompanyOnWin(tx: WorkspaceTx, dealId: string): Promise<boolean> {
  if (!isUuid(dealId)) return false;
  const { rows } = await tx.query<{ company_id: string }>(
    `UPDATE company_link cl
        SET relationship = 'client', updated_at = now()
       FROM deal d
       JOIN pipeline_stage st ON st.id = d.stage_id
      WHERE d.id = $1
        AND st.is_won
        AND cl.company_id = d.company_id
        AND cl.workspace_id = d.workspace_id
        AND cl.relationship = ANY($2::text[])
      RETURNING cl.company_id`,
    [dealId, PROMOTE_ON_WIN],
  );
  return rows.length > 0;
}

/** Las etapas, en orden, para pintar las columnas del tablero. */
export async function listStages(tx: WorkspaceTx): Promise<{ id: string; labelEs: string; position: number; isWon: boolean; isLost: boolean; defaultProbability: string }[]> {
  const { rows } = await tx.query<{
    id: string; label_es: string; position: number; is_won: boolean; is_lost: boolean; default_probability: string;
  }>(
    `SELECT id, label_es, position, is_won, is_lost, default_probability::text AS default_probability
     FROM pipeline_stage ORDER BY position ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    labelEs: r.label_es,
    position: r.position,
    isWon: r.is_won,
    isLost: r.is_lost,
    defaultProbability: r.default_probability,
  }));
}
