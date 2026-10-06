/**
 * «Lo que importa esta semana» (RES-3). Dueño: Rasheed.
 *
 * El bloque de arriba de /resumen. Lee `notification` (0009): no hay
 * tabla nueva de «cosas importantes», hay cuatro productores que ya
 * escriben avisos y esta consulta los junta, uno por cosa, en el orden
 * en que hay que atenderlos:
 *
 *   fuente       kind                        lo escribe                         lleva a
 *   ----------   -------------------------   --------------------------------   ----------
 *   connection   connection_error            oauth.refresh y el recolector      Conexiones
 *                                            (needs_reauth y, desde RES-3, la
 *                                            cuenta que ya no se puede leer)
 *   invoice      invoice_overdue             finance.reminders (FIN-4)          Finanzas
 *   deal         deal_due, deal_overdue      sales.follow_ups (VEN-4)           Ventas
 *   outlier      outlier, breakout           compute.post_score (CON-6)         Resumen
 *
 * Reglas de lectura, todas en SQL y ninguna en la pantalla:
 *
 *   1 · UNA fila por cosa: el aviso MÁS RECIENTE de cada video, cuenta,
 *       factura o negocio. Si el video pasó de outlier a breakout se ve
 *       el breakout; si la factura recibió el recordatorio de +7 después
 *       del de 0, el de +7. El «Entendido» se mira DESPUÉS de elegir el
 *       más reciente: entender el breakout no resucita el outlier.
 *   2 · Solo lo que SIGUE siendo cierto. El aviso es de cuándo se
 *       escribió; la fila se enseña si la cosa todavía importa hoy:
 *       la cuenta sigue caída, la factura sigue abierta y vencida en la
 *       zona del espacio, el negocio sigue abierto con la acción vencida
 *       o para hoy (y el aviso es de ESE compromiso, no de uno que se
 *       movió). Un video destacado importa la semana en que se avisó:
 *       siete días desde el aviso.
 *   3 · Lo que es de la persona. Un aviso con user_id es de esa persona
 *       (VEN-4 se lo manda al responsable del negocio); sin user_id es de
 *       todo el espacio. Sin persona —el modo demo— se ve todo.
 *   4 · Leído es de la persona: notification_ack (0078). No se toca
 *       `notification.read_at`, que en FIN-4 quiere decir «ya lo mandé».
 *       Un aviso con read_at o dismissed_at ya se atendió en su módulo y
 *       tampoco sale.
 *   5 · Permisos y alcance. Qué FUENTES se piden lo decide quien llama
 *       con los permisos de la sesión (`weeklySourcesFor`: sin
 *       finanzas.factura.ver no hay fila de factura). El ALCANCE de ACC-6
 *       lo pone cada rama con scopeFilter(), igual que el módulo dueño de
 *       la fila: quien ve solo lo de Laura no ve el cobro de Sofía.
 *
 * Las cifras que enseña la fila (el múltiplo, lo pendiente, los días de
 * mora) salen calculadas de aquí; la pantalla solo las formatea.
 */
import { can, PERMISO_MINIMO, type Permiso } from '@mc/core';
import { isUuid, type WorkspaceTx } from '../client.ts';
import { scopeFilter } from '../scope.ts';
import type { PlatformId } from './resumen-constantes.ts';

// ---------------------------------------------------------------------
// Fuentes y permisos
// ---------------------------------------------------------------------

/** Las cuatro fuentes, en el orden en que se atienden cuando pesan lo mismo. */
export const WEEKLY_SOURCES = ['connection', 'invoice', 'deal', 'outlier'] as const;
export type WeeklySource = (typeof WEEKLY_SOURCES)[number];

/**
 * El permiso que abre cada fuente: el mínimo del módulo al que lleva la
 * fila (PERMISO_MINIMO de ACC-5). Enseñar una fila que lleva a un 404 es
 * peor que no enseñarla, y la factura de alguien que no puede ver
 * Finanzas es justo lo que ACC quiere esconder.
 */
export const WEEKLY_SOURCE_PERMISSION: Readonly<Record<WeeklySource, Permiso>> = {
  connection: PERMISO_MINIMO.conexiones,
  invoice: PERMISO_MINIMO.finanzas,
  deal: PERMISO_MINIMO.ventas,
  outlier: PERMISO_MINIMO.resumen,
};

/** Las fuentes que estos permisos pueden ver, en el orden de WEEKLY_SOURCES. */
export function weeklySourcesFor(permisos: ReadonlySet<Permiso>): WeeklySource[] {
  return WEEKLY_SOURCES.filter((s) => can(permisos, WEEKLY_SOURCE_PERMISSION[s]));
}

/** Los `kind` de notification que lee cada fuente. */
const KINDS: Readonly<Record<WeeklySource, readonly string[]>> = {
  connection: ['connection_error'],
  invoice: ['invoice_overdue'],
  deal: ['deal_due', 'deal_overdue'],
  outlier: ['outlier', 'breakout'],
};

/** Todos los kinds del bloque: lo único que «Entendido» puede marcar. */
export const WEEKLY_KINDS: readonly string[] = WEEKLY_SOURCES.flatMap((s) => KINDS[s]);

/** Cuántos días cuenta un video destacado como «de esta semana». */
export const OUTLIER_WINDOW_DAYS = 7;

/** Cuántas filas enseña el bloque como mucho. */
export const MAX_HIGHLIGHTS = 20;

// ---------------------------------------------------------------------
// Lo que devuelve
// ---------------------------------------------------------------------

export type HighlightSeverity = 'critical' | 'warning' | 'info' | 'success';

interface HighlightBase {
  /** El id del aviso (notification.id): es lo que marca «Entendido». */
  id: string;
  kind: string;
  severity: HighlightSeverity;
  /** El título y el cuerpo que escribió el productor, en el idioma del espacio cuando se escribió. */
  storedTitle: string;
  storedBody: string | null;
  /** action_url del aviso tal cual: la pantalla decide si lo usa (ver apps/web …/resumen/_lib/semana.ts). */
  actionUrl: string | null;
  /** Cuándo se escribió el aviso, ISO 8601 en UTC. */
  createdAt: string;
}

export interface OutlierHighlight extends HighlightBase {
  source: 'outlier';
  tier: 'outlier' | 'breakout';
  postId: string;
  platformId: PlatformId;
  postTitle: string | null;
  postUrl: string | null;
  /** post_score.views_vs_median de hoy, como texto decimal; null = «todavía no sabemos» (CON-6 §2), nunca cero. */
  viewsVsMedian: string | null;
  /** El corte en horas al que se midió ese múltiplo (24, 72, 168, 720). */
  ageHoursCut: number | null;
}

export type BrokenConnectionStatus = 'needs_reauth' | 'error' | 'expired' | 'revoked';

export interface ConnectionHighlight extends HighlightBase {
  source: 'connection';
  connectionId: string;
  platformId: PlatformId;
  handle: string | null;
  status: BrokenConnectionStatus;
  /** social_connection.status_detail: la razón en palabras del producto. */
  detail: string | null;
}

export interface InvoiceHighlight extends HighlightBase {
  source: 'invoice';
  invoiceId: string;
  invoiceNumber: string;
  companyName: string;
  currency: string;
  /** total − pagado, decimal en texto. */
  outstanding: string;
  /** 'YYYY-MM-DD'. */
  dueOn: string;
  /** Días de mora HOY en la zona del espacio (≥ 1). */
  daysOverdue: number;
}

export interface DealHighlight extends HighlightBase {
  source: 'deal';
  dealId: string;
  dealName: string;
  companyId: string;
  companyName: string;
  nextAction: string;
  /** El vencimiento de la acción, ISO 8601 en UTC. */
  dueAt: string;
  /** deal_pipeline.due_state de HOY: 'vencido' o 'hoy'. */
  dueState: 'vencido' | 'hoy';
  /** Días desde el vencimiento en la zona del espacio (0 = hoy). */
  daysOverdue: number;
}

export type WeeklyHighlight = OutlierHighlight | ConnectionHighlight | InvoiceHighlight | DealHighlight;

// ---------------------------------------------------------------------
// SQL común a las cuatro ramas
// ---------------------------------------------------------------------

/** El aviso es de esta persona: va a todo el espacio, o a ella. Sin persona (modo demo), todo. */
const PARA_MI = `(n.user_id IS NULL OR current_user_id() IS NULL OR n.user_id = current_user_id())`;

/** Sin atender: ni descartado ni atendido en su módulo, ni entendido por esta persona (0078). */
const SIN_ATENDER = `n.dismissed_at IS NULL AND n.read_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM notification_ack a
                   WHERE a.notification_id = n.id AND a.user_id IS NOT DISTINCT FROM current_user_id())`;

/**
 * El aviso más reciente de cada cosa (regla 1), de los que son de esta
 * persona. $1 son los kinds de la fuente. El «Entendido» se mira fuera,
 * después de elegir.
 */
function ultimoPorEntidad(entityType: 'post' | 'social_connection' | 'invoice' | 'deal'): string {
  return `ultimo AS (
    SELECT DISTINCT ON (n.entity_id)
           n.id, n.kind, n.severity, n.title_es, n.body_es, n.action_url, n.created_at,
           n.entity_id, n.read_at, n.dismissed_at
      FROM notification n
     WHERE n.kind = ANY($1::text[]) AND n.entity_type = '${entityType}' AND n.entity_id IS NOT NULL AND ${PARA_MI}
     ORDER BY n.entity_id, n.created_at DESC, n.id DESC
  )`;
}

/** Las columnas del aviso que llevan todas las ramas. */
const COLUMNAS_AVISO = `n.id, n.kind, n.severity, n.title_es, n.body_es, n.action_url,
       to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at`;

/** La zona del espacio `w`, como la cuentan deal_pipeline (0043) y sales.follow_ups. */
const ZONA = `coalesce(nullif(w.timezone, ''), 'UTC')`;

// Alcance (ACC-6), con las mismas anclas que el módulo dueño de cada fila.

/** Un post `p`: por su creadora, y por marca y campaña a través de campaign_post (como scopePost de queries/campanas.ts). */
const SCOPE_POST = scopeFilter({
  creator: 'p.creator_id',
  company: { any: 'SELECT c2.company_id FROM campaign_post cp2 JOIN campaign c2 ON c2.id = cp2.campaign_id WHERE cp2.post_id = p.id' },
  campaign: { any: 'SELECT cp2.campaign_id FROM campaign_post cp2 WHERE cp2.post_id = p.id' },
});

/** La cuenta `c`: solo tiene creadora (como SCOPE_CONNECTION de queries/conexiones.ts). */
const SCOPE_CONNECTION = scopeFilter({ creator: 'c.creator_id', company: null, campaign: null });

/** La factura `i` con su campaña `ca` (como SCOPE_INVOICE de queries/finanzas.ts). */
const SCOPE_INVOICE = scopeFilter({ creator: 'ca.creator_id', company: 'i.company_id', campaign: 'i.campaign_id' });

/** El negocio `d`: su creadora, su marca y las campañas que salieron de él (como SCOPE_DEAL de queries/finanzas.ts). */
const SCOPE_DEAL = scopeFilter({
  creator: 'd.creator_id',
  company: 'd.company_id',
  campaign: { any: 'SELECT c3.id FROM campaign c3 WHERE c3.deal_id = d.id' },
});

interface AvisoRaw {
  id: string;
  kind: string;
  severity: HighlightSeverity;
  title_es: string;
  body_es: string | null;
  action_url: string | null;
  created_at: string;
}

function base(r: AvisoRaw): HighlightBase {
  return {
    id: r.id,
    kind: r.kind,
    severity: r.severity,
    storedTitle: r.title_es,
    storedBody: r.body_es,
    actionUrl: r.action_url,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------
// Las cuatro ramas
// ---------------------------------------------------------------------

interface OutlierRaw extends AvisoRaw {
  post_id: string;
  platform_id: PlatformId;
  post_title: string | null;
  post_url: string | null;
  views_vs_median: string | null;
  age_hours_cut: number | null;
}

async function outliers(tx: WorkspaceTx, limit: number): Promise<OutlierHighlight[]> {
  const { rows } = await tx.query<OutlierRaw>(
    `WITH ${ultimoPorEntidad('post')}
     SELECT ${COLUMNAS_AVISO},
            p.id AS post_id, p.platform_id, nullif(btrim(coalesce(p.title, '')), '') AS post_title,
            coalesce(p.permalink, p.url) AS post_url,
            ps.views_vs_median::text AS views_vs_median, ps.age_hours_cut
       FROM ultimo n
       JOIN post p ON p.id = n.entity_id
       LEFT JOIN post_score ps ON ps.post_id = p.id
      WHERE ${SIN_ATENDER}
        AND NOT p.deleted_on_platform
        AND n.created_at >= now() - make_interval(days => $2::int)
        AND ${SCOPE_POST}
      ORDER BY n.created_at DESC
      LIMIT $3`,
    [KINDS.outlier, OUTLIER_WINDOW_DAYS, limit],
  );
  return rows.map((r) => ({
    ...base(r),
    source: 'outlier' as const,
    tier: r.kind === 'breakout' ? ('breakout' as const) : ('outlier' as const),
    postId: r.post_id,
    platformId: r.platform_id,
    postTitle: r.post_title,
    postUrl: r.post_url,
    viewsVsMedian: r.views_vs_median,
    ageHoursCut: r.age_hours_cut,
  }));
}

interface ConnectionRaw extends AvisoRaw {
  connection_id: string;
  platform_id: PlatformId;
  handle: string | null;
  status: BrokenConnectionStatus;
  detail: string | null;
}

async function connections(tx: WorkspaceTx, limit: number): Promise<ConnectionHighlight[]> {
  const { rows } = await tx.query<ConnectionRaw>(
    `WITH ${ultimoPorEntidad('social_connection')}
     SELECT ${COLUMNAS_AVISO},
            c.id AS connection_id, c.platform_id, c.handle, c.status, c.status_detail AS detail
       FROM ultimo n
       JOIN social_connection c ON c.id = n.entity_id
      WHERE ${SIN_ATENDER}
        AND c.deleted_at IS NULL
        AND c.status IN ('needs_reauth', 'error', 'expired', 'revoked')
        AND ${SCOPE_CONNECTION}
      ORDER BY n.created_at DESC
      LIMIT $2`,
    [KINDS.connection, limit],
  );
  return rows.map((r) => ({
    ...base(r),
    source: 'connection' as const,
    connectionId: r.connection_id,
    platformId: r.platform_id,
    handle: r.handle,
    status: r.status,
    detail: r.detail,
  }));
}

interface InvoiceRaw extends AvisoRaw {
  invoice_id: string;
  number: string;
  company_name: string;
  currency: string;
  outstanding: string;
  due_on: string;
  days_overdue: number;
}

/**
 * La factura sigue abierta (sent o partial) y vencida HOY en la zona del
 * espacio, como cuenta Finanzas la mora (listReminders). El recordatorio
 * del paso −7 o del 0 de una factura que ya venció cuenta: es el último
 * que hay y la factura está vencida.
 */
async function invoices(tx: WorkspaceTx, limit: number): Promise<InvoiceHighlight[]> {
  const { rows } = await tx.query<InvoiceRaw>(
    `WITH ${ultimoPorEntidad('invoice')}
     SELECT ${COLUMNAS_AVISO},
            i.id AS invoice_id, i.number, co.name AS company_name, i.currency,
            (i.total - i.paid_amount)::text AS outstanding,
            to_char(i.due_on, 'YYYY-MM-DD') AS due_on,
            ((now() AT TIME ZONE ${ZONA})::date - i.due_on)::int AS days_overdue
       FROM ultimo n
       JOIN invoice i   ON i.id = n.entity_id
       JOIN company co  ON co.id = i.company_id
       JOIN workspace w ON w.id = i.workspace_id
       LEFT JOIN campaign ca ON ca.id = i.campaign_id
      WHERE ${SIN_ATENDER}
        AND i.status IN ('sent', 'partial')
        AND i.due_on < (now() AT TIME ZONE ${ZONA})::date
        AND ${SCOPE_INVOICE}
      ORDER BY i.due_on, i.number
      LIMIT $2`,
    [KINDS.invoice, limit],
  );
  return rows.map((r) => ({
    ...base(r),
    source: 'invoice' as const,
    invoiceId: r.invoice_id,
    invoiceNumber: r.number,
    companyName: r.company_name,
    currency: r.currency,
    outstanding: r.outstanding,
    dueOn: r.due_on,
    daysOverdue: r.days_overdue,
  }));
}

interface DealRaw extends AvisoRaw {
  deal_id: string;
  deal_name: string;
  company_id: string;
  company_name: string;
  next_action: string;
  due_at: string;
  due_state: 'vencido' | 'hoy';
  days_overdue: number;
}

/**
 * El negocio sigue abierto, con acción escrita, vencida o para hoy
 * (deal_pipeline.due_state, 0043), y el aviso es de ESTE compromiso:
 * nació el día del vencimiento o después, como lo cuenta
 * sales.follow_ups. Si alguien movió la fecha a la semana que viene, el
 * negocio queda «futuro» y sale del bloque; si la movió a otro día ya
 * pasado, el aviso viejo no vale y el job escribe uno nuevo.
 */
async function deals(tx: WorkspaceTx, limit: number): Promise<DealHighlight[]> {
  const { rows } = await tx.query<DealRaw>(
    `WITH ${ultimoPorEntidad('deal')}
     SELECT ${COLUMNAS_AVISO},
            d.id AS deal_id, d.name AS deal_name, d.company_id, d.company_name, btrim(d.next_action) AS next_action,
            to_char(d.next_action_due AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS due_at,
            d.due_state,
            ((now() AT TIME ZONE ${ZONA})::date - (d.next_action_due AT TIME ZONE ${ZONA})::date)::int AS days_overdue
       FROM ultimo n
       JOIN deal_pipeline d ON d.id = n.entity_id
       JOIN workspace w     ON w.id = d.workspace_id
      WHERE ${SIN_ATENDER}
        AND NOT d.is_won AND NOT d.is_lost
        AND nullif(btrim(d.next_action), '') IS NOT NULL
        AND d.due_state IN ('vencido', 'hoy')
        AND n.created_at >= (date_trunc('day', d.next_action_due AT TIME ZONE ${ZONA}) AT TIME ZONE ${ZONA})
        AND ${SCOPE_DEAL}
      ORDER BY d.next_action_due, d.name
      LIMIT $2`,
    [KINDS.deal, limit],
  );
  return rows.map((r) => ({
    ...base(r),
    source: 'deal' as const,
    dealId: r.deal_id,
    dealName: r.deal_name,
    companyId: r.company_id,
    companyName: r.company_name,
    nextAction: r.next_action,
    dueAt: r.due_at,
    dueState: r.due_state,
    daysOverdue: r.days_overdue,
  }));
}

// ---------------------------------------------------------------------
// Lectura y «Entendido»
// ---------------------------------------------------------------------

const RAMAS: Readonly<Record<WeeklySource, (tx: WorkspaceTx, limit: number) => Promise<WeeklyHighlight[]>>> = {
  connection: connections,
  invoice: invoices,
  deal: deals,
  outlier: outliers,
};

const SEVERITY_RANK: Readonly<Record<HighlightSeverity, number>> = { critical: 0, warning: 1, info: 2, success: 3 };

/**
 * El orden por urgencia: primero lo crítico (una cuenta que dejó de
 * leerse, el último recordatorio de un cobro), luego lo que ya venció,
 * luego lo de hoy y al final las buenas noticias (un video que se
 * disparó). A igual severidad, en el orden de WEEKLY_SOURCES; dentro de
 * la misma fuente, lo más reciente primero.
 */
export function compareHighlights(a: WeeklyHighlight, b: WeeklyHighlight): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    WEEKLY_SOURCES.indexOf(a.source) - WEEKLY_SOURCES.indexOf(b.source) ||
    b.createdAt.localeCompare(a.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Lo que importa esta semana para la persona de la transacción, de las
 * fuentes pedidas (las que sus permisos ven: `weeklySourcesFor`), en
 * orden de urgencia y como mucho MAX_HIGHLIGHTS filas. Una fuente que no
 * es de la lista se ignora: lo que llegue de fuera no elige SQL.
 */
export async function listWeeklyHighlights(tx: WorkspaceTx, sources: readonly WeeklySource[]): Promise<WeeklyHighlight[]> {
  const pedidas = WEEKLY_SOURCES.filter((s) => sources.includes(s));
  const filas: WeeklyHighlight[] = [];
  for (const s of pedidas) filas.push(...(await RAMAS[s](tx, MAX_HIGHLIGHTS)));
  return filas.sort(compareHighlights).slice(0, MAX_HIGHLIGHTS);
}

/**
 * «Entendido»: la persona de la transacción ya vio este aviso
 * (notification_ack, 0078). Solo vale para los avisos del bloque y para
 * los que son de ella (PARA_MI). Idempotente: repetir el clic no escribe
 * otra fila. Devuelve false si el aviso no existe en este espacio, no es
 * del bloque o no es de ella.
 */
export async function acknowledgeHighlight(tx: WorkspaceTx, notificationId: string): Promise<boolean> {
  if (!isUuid(notificationId)) return false;
  const { rows } = await tx.query<{ ok: boolean }>(
    `WITH aviso AS (
       SELECT n.id FROM notification n
        WHERE n.id = $1 AND n.kind = ANY($2::text[]) AND ${PARA_MI}
     ), nueva AS (
       INSERT INTO notification_ack (workspace_id, notification_id, user_id)
       SELECT current_workspace_id(), aviso.id, current_user_id() FROM aviso
       ON CONFLICT DO NOTHING
       RETURNING id
     )
     SELECT EXISTS (SELECT 1 FROM aviso) AS ok`,
    [notificationId, WEEKLY_KINDS],
  );
  return rows[0]?.ok === true;
}
