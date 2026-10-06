/**
 * «Lo que importa esta semana» (RES-3). Dueño: Rasheed.
 *
 * El bloque de arriba de /resumen. Lee `notification` (0009): no hay
 * tabla nueva de «cosas importantes», hay cinco productores que ya
 * escriben avisos y esta consulta los junta, uno por cosa, en el orden
 * en que hay que atenderlos:
 *
 *   fuente       kind / entity_type                    lo escribe                       lleva a
 *   ----------   -----------------------------------   ------------------------------   ---------------
 *   connection   connection_error · social_connection  oauth.refresh y los recolectores Conexiones
 *                                                      (needs_reauth y, desde RES-3, la
 *                                                      cuenta que ya no se puede leer)
 *   channel      connection_error ·                    canales.keepalive y el webhook   Ventas › Canales
 *                outreach_channel_account              de Unipile (VEN-9): el correo o
 *                                                      el LinkedIn que frena las
 *                                                      secuencias
 *   invoice      invoice_overdue · invoice             finance.reminders (FIN-4)        Finanzas
 *   deal         deal_due, deal_overdue · deal         sales.follow_ups (VEN-4)         Ventas
 *   outlier      outlier, breakout · post              compute.post_score (CON-6)       el video
 *
 * Reglas de lectura, todas en SQL y ninguna en la pantalla:
 *
 *   1 · UNA fila por cosa: el aviso MÁS RECIENTE de cada video, cuenta,
 *       factura o negocio. Si el video pasó de outlier a breakout se ve
 *       el breakout; si la factura recibió el recordatorio de +21
 *       después del de +7, el de +21. El «Entendido» se mira DESPUÉS de
 *       elegir el más reciente: entender el breakout no resucita el
 *       outlier. El índice notification_entity_recent_idx (0078) sirve
 *       justo esta elección; sin ventana de tiempo a propósito: una
 *       factura con el último recordatorio (+45) de hace cinco meses
 *       sigue vencida, y recortar por fecha la escondería.
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
 *   4 · Leído es de la persona: notification_ack (0078), donde vale el
 *       último gesto (Entendido o Deshacer). No se toca
 *       `notification.read_at`, que en FIN-4 quiere decir «ya lo mandé».
 *       Un aviso con read_at o dismissed_at ya se atendió en su módulo y
 *       tampoco sale. Por eso el bloque vacío NO afirma que no haya
 *       cobros vencidos: dice que no hay nada nuevo que atender.
 *   5 · Permisos y alcance. Qué FUENTES se piden lo decide quien llama
 *       con los permisos de la sesión (`weeklySourcesFor`: sin
 *       finanzas.factura.ver no hay fila de factura), y el «Entendido»
 *       solo vale sobre esas mismas fuentes. El ALCANCE de ACC-6 lo pone
 *       cada rama con scopeFilter(), igual que el módulo dueño de la
 *       fila: quien ve solo lo de Laura no ve el cobro de Sofía.
 *
 * Las cifras que enseña la fila (el múltiplo, lo pendiente, los días de
 * mora) salen calculadas de aquí; la pantalla solo las formatea.
 */
import { can, PERMISO_MINIMO, videoName, type AgeCut, type Permiso } from '@mc/core';
import { isUuid, type WorkspaceTx } from '../client.ts';
import { scopeFilter } from '../scope.ts';
import type { NOTIFICATION_KINDS } from '../schema/cimientos.ts';
import type { PlatformId } from './resumen-constantes.ts';

type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

// ---------------------------------------------------------------------
// Fuentes y permisos
// ---------------------------------------------------------------------

/** Las cinco fuentes, en el orden en que se atienden cuando pesan lo mismo. */
export const WEEKLY_SOURCES = ['connection', 'channel', 'invoice', 'deal', 'outlier'] as const;
export type WeeklySource = (typeof WEEKLY_SOURCES)[number];

/**
 * El permiso que abre cada fuente: el mínimo del módulo al que lleva la
 * fila (PERMISO_MINIMO de ACC-5). Enseñar una fila que lleva a un 404 es
 * peor que no enseñarla, y la factura de alguien que no puede ver
 * Finanzas es justo lo que ACC quiere esconder.
 */
export const WEEKLY_SOURCE_PERMISSION: Readonly<Record<WeeklySource, Permiso>> = {
  connection: PERMISO_MINIMO.conexiones,
  channel: PERMISO_MINIMO.ventas,
  invoice: PERMISO_MINIMO.finanzas,
  deal: PERMISO_MINIMO.ventas,
  outlier: PERMISO_MINIMO.resumen,
};

/** Las fuentes que estos permisos pueden ver, en el orden de WEEKLY_SOURCES. */
export function weeklySourcesFor(permisos: ReadonlySet<Permiso>): WeeklySource[] {
  return WEEKLY_SOURCES.filter((s) => can(permisos, WEEKLY_SOURCE_PERMISSION[s]));
}

/**
 * Qué avisos lee cada fuente: su `entity_type` y sus `kind`. Dos fuentes
 * comparten kind (connection_error de una cuenta social y de una cuenta
 * de envío): lo que las separa es la cosa a la que apunta el aviso.
 */
const AVISOS = {
  connection: { entityType: 'social_connection', kinds: ['connection_error'] },
  channel: { entityType: 'outreach_channel_account', kinds: ['connection_error'] },
  invoice: { entityType: 'invoice', kinds: ['invoice_overdue'] },
  deal: { entityType: 'deal', kinds: ['deal_due', 'deal_overdue'] },
  outlier: { entityType: 'post', kinds: ['outlier', 'breakout'] },
} as const satisfies Record<WeeklySource, { entityType: string; kinds: readonly NotificationKind[] }>;

/** Los `kind` que lee una fuente. */
export type WeeklyKind<S extends WeeklySource = WeeklySource> = (typeof AVISOS)[S]['kinds'][number];

/** Todos los kinds del bloque. */
export const WEEKLY_KINDS: readonly WeeklyKind[] = [...new Set(WEEKLY_SOURCES.flatMap((s): readonly WeeklyKind[] => AVISOS[s].kinds))];

/** Cuántos días cuenta un video destacado como «de esta semana». */
export const OUTLIER_WINDOW_DAYS = 7;

/**
 * Cuántas filas lee el bloque como mucho. Se pide una más para saber si
 * hay más de las que se enseñan (`more`), sin contarlas todas.
 */
export const MAX_HIGHLIGHTS = 20;

// ---------------------------------------------------------------------
// Lo que devuelve
// ---------------------------------------------------------------------

export type HighlightSeverity = 'critical' | 'warning' | 'info' | 'success';

interface HighlightBase<S extends WeeklySource> {
  source: S;
  /** El id del aviso (notification.id): es lo que marca «Entendido». */
  id: string;
  kind: WeeklyKind<S>;
  severity: HighlightSeverity;
  /** El título y el cuerpo que escribió el productor, en el idioma del espacio cuando se escribió. */
  storedTitle: string;
  storedBody: string | null;
  /** action_url del aviso tal cual: la pantalla decide si lo usa (ver apps/web …/resumen/_lib/semana.ts). */
  actionUrl: string | null;
  /** Cuándo se escribió el aviso, ISO 8601 en UTC. */
  createdAt: string;
}

export interface OutlierHighlight extends HighlightBase<'outlier'> {
  tier: 'outlier' | 'breakout';
  postId: string;
  platformId: PlatformId;
  /**
   * El nombre del video para la frase: su título o, si no tiene (Instagram
   * nunca lo trae), su texto, recortado como en el aviso de CON-6
   * (@mc/core videoName). null = no hay ninguno: la pantalla lo dice sin
   * comillas («Tu video de Instagram»).
   */
  postTitle: string | null;
  postUrl: string | null;
  /** post_score.views_vs_median de hoy, como texto decimal; null = «todavía no sabemos» (CON-6 §2), nunca cero. */
  viewsVsMedian: string | null;
  /** El corte en horas al que se midió ese múltiplo. */
  ageHoursCut: AgeCut | null;
}

export type BrokenConnectionStatus = 'needs_reauth' | 'error' | 'expired' | 'revoked';

export interface ConnectionHighlight extends HighlightBase<'connection'> {
  connectionId: string;
  platformId: PlatformId;
  /** El @ de la cuenta tal como lo guarda Conexiones (sin «@»). */
  handle: string | null;
  status: BrokenConnectionStatus;
  /** social_connection.status_detail: la razón en palabras del producto. */
  detail: string | null;
}

export type BrokenChannelStatus = 'needs_reconnect' | 'error';

export interface ChannelHighlight extends HighlightBase<'channel'> {
  accountId: string;
  /** outreach_channel_account.channel: email, linkedin, instagram_dm, whatsapp. */
  channel: string;
  /** El nombre de la cuenta (el correo, o el nombre que trae Unipile). */
  displayName: string | null;
  status: BrokenChannelStatus;
}

export interface InvoiceHighlight extends HighlightBase<'invoice'> {
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

export interface DealHighlight extends HighlightBase<'deal'> {
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

export type WeeklyHighlight = OutlierHighlight | ConnectionHighlight | ChannelHighlight | InvoiceHighlight | DealHighlight;

/** Lo que lee el bloque: hasta MAX_HIGHLIGHTS filas, y si quedaron más fuera. */
export interface WeeklyHighlights {
  rows: WeeklyHighlight[];
  more: boolean;
}

// ---------------------------------------------------------------------
// SQL común a las ramas
// ---------------------------------------------------------------------

/** El aviso es de esta persona: va a todo el espacio, o a ella. Sin persona (modo demo), todo. */
const PARA_MI = `(n.user_id IS NULL OR current_user_id() IS NULL OR n.user_id = current_user_id())`;

/** El último gesto de esta persona sobre el aviso `idExpr` (0078): 'ack', 'undo' o NULL si nunca tocó. */
const ultimoGesto = (idExpr: string) => `(SELECT a.action FROM notification_ack a
   WHERE a.workspace_id = current_workspace_id() AND a.notification_id = ${idExpr}
     AND a.user_id IS NOT DISTINCT FROM current_user_id()
   ORDER BY a.created_at DESC, a.id DESC LIMIT 1)`;

/** Sin atender: ni descartado ni atendido en su módulo, ni entendido por esta persona. */
const SIN_ATENDER = `n.dismissed_at IS NULL AND n.read_at IS NULL AND ${ultimoGesto('n.id')} IS DISTINCT FROM 'ack'`;

/**
 * El aviso más reciente de cada cosa (regla 1), de los que son de esta
 * persona. $1 son los kinds de la fuente. El «Entendido» se mira fuera,
 * después de elegir. El orden de DISTINCT ON es el del índice
 * notification_entity_recent_idx (0078).
 */
function ultimoPorEntidad(source: WeeklySource): string {
  return `ultimo AS (
    SELECT DISTINCT ON (n.entity_id)
           n.id, n.kind, n.severity, n.title_es, n.body_es, n.action_url, n.created_at,
           n.entity_id, n.read_at, n.dismissed_at
      FROM notification n
     WHERE n.workspace_id = current_workspace_id()
       AND n.entity_type = '${AVISOS[source].entityType}' AND n.entity_id IS NOT NULL
       AND n.kind = ANY($1::text[]) AND ${PARA_MI}
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

/**
 * La cuenta de envío `a`: su creadora y nada más. Una sin creadora (del
 * espacio) no es de nadie y se oculta a quien tenga alcance de creador,
 * como manda scopeFilter: abrir por defecto sería una política que no se
 * ve.
 */
const SCOPE_CHANNEL = scopeFilter({ creator: 'a.creator_id', company: null, campaign: null });

/** La factura `i` con su campaña `ca` (como SCOPE_INVOICE de queries/finanzas.ts). */
const SCOPE_INVOICE = scopeFilter({ creator: 'ca.creator_id', company: 'i.company_id', campaign: 'i.campaign_id' });

/** El negocio `d`: su creadora, su marca y las campañas que salieron de él (como SCOPE_DEAL de queries/finanzas.ts). */
const SCOPE_DEAL = scopeFilter({
  creator: 'd.creator_id',
  company: 'd.company_id',
  campaign: { any: 'SELECT c3.id FROM campaign c3 WHERE c3.deal_id = d.id' },
});

interface AvisoRaw<S extends WeeklySource> {
  id: string;
  kind: WeeklyKind<S>;
  severity: HighlightSeverity;
  title_es: string;
  body_es: string | null;
  action_url: string | null;
  created_at: string;
}

function base<S extends WeeklySource>(source: S, r: AvisoRaw<S>): HighlightBase<S> {
  return {
    source,
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
// Las cinco ramas
// ---------------------------------------------------------------------

interface OutlierRaw extends AvisoRaw<'outlier'> {
  post_id: string;
  platform_id: PlatformId;
  post_title: string | null;
  post_caption: string | null;
  post_url: string | null;
  views_vs_median: string | null;
  age_hours_cut: AgeCut | null;
}

async function outliers(tx: WorkspaceTx, limit: number): Promise<OutlierHighlight[]> {
  const { rows } = await tx.query<OutlierRaw>(
    `WITH ${ultimoPorEntidad('outlier')}
     SELECT ${COLUMNAS_AVISO},
            p.id AS post_id, p.platform_id, p.title AS post_title, p.caption AS post_caption,
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
    [AVISOS.outlier.kinds, OUTLIER_WINDOW_DAYS, limit],
  );
  return rows.map((r) => ({
    ...base('outlier', r),
    tier: r.kind === 'breakout' ? ('breakout' as const) : ('outlier' as const),
    postId: r.post_id,
    platformId: r.platform_id,
    // El mismo nombre que el aviso de CON-6: título, o el texto del video si no hay.
    postTitle: videoName(r.post_title, r.post_caption),
    postUrl: r.post_url,
    viewsVsMedian: r.views_vs_median,
    ageHoursCut: r.age_hours_cut,
  }));
}

interface ConnectionRaw extends AvisoRaw<'connection'> {
  connection_id: string;
  platform_id: PlatformId;
  handle: string | null;
  status: BrokenConnectionStatus;
  detail: string | null;
}

async function connections(tx: WorkspaceTx, limit: number): Promise<ConnectionHighlight[]> {
  const { rows } = await tx.query<ConnectionRaw>(
    `WITH ${ultimoPorEntidad('connection')}
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
    [AVISOS.connection.kinds, limit],
  );
  return rows.map((r) => ({
    ...base('connection', r),
    connectionId: r.connection_id,
    platformId: r.platform_id,
    handle: r.handle,
    status: r.status,
    detail: r.detail,
  }));
}

interface ChannelRaw extends AvisoRaw<'channel'> {
  account_id: string;
  channel: string;
  display_name: string | null;
  status: BrokenChannelStatus;
}

/**
 * La cuenta de envío (correo, LinkedIn…) sigue caída: needs_reconnect o
 * error, como la pinta Ventas › Canales. El aviso de «volvió» (severity
 * success, markChannelAccountOk) es el más reciente cuando la cuenta se
 * recuperó, y la cuenta ya está 'connected': no sale.
 */
async function channels(tx: WorkspaceTx, limit: number): Promise<ChannelHighlight[]> {
  const { rows } = await tx.query<ChannelRaw>(
    `WITH ${ultimoPorEntidad('channel')}
     SELECT ${COLUMNAS_AVISO},
            a.id AS account_id, a.channel, a.display_name, a.status
       FROM ultimo n
       JOIN outreach_channel_account a ON a.id = n.entity_id
      WHERE ${SIN_ATENDER}
        AND n.severity <> 'success'
        AND a.status IN ('needs_reconnect', 'error')
        AND ${SCOPE_CHANNEL}
      ORDER BY n.created_at DESC
      LIMIT $2`,
    [AVISOS.channel.kinds, limit],
  );
  return rows.map((r) => ({
    ...base('channel', r),
    accountId: r.account_id,
    channel: r.channel,
    displayName: r.display_name,
    status: r.status,
  }));
}

interface InvoiceRaw extends AvisoRaw<'invoice'> {
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
    [AVISOS.invoice.kinds, limit],
  );
  return rows.map((r) => ({
    ...base('invoice', r),
    invoiceId: r.invoice_id,
    invoiceNumber: r.number,
    companyName: r.company_name,
    currency: r.currency,
    outstanding: r.outstanding,
    dueOn: r.due_on,
    daysOverdue: r.days_overdue,
  }));
}

interface DealRaw extends AvisoRaw<'deal'> {
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
    [AVISOS.deal.kinds, limit],
  );
  return rows.map((r) => ({
    ...base('deal', r),
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
// Lectura, «Entendido» y «Deshacer»
// ---------------------------------------------------------------------

const RAMAS: { readonly [S in WeeklySource]: (tx: WorkspaceTx, limit: number) => Promise<Extract<WeeklyHighlight, { source: S }>[]> } = {
  connection: connections,
  channel: channels,
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

/** Solo las fuentes de la lista, en su orden: lo que llegue de fuera no elige SQL. */
const pedidas = (sources: readonly WeeklySource[]) => WEEKLY_SOURCES.filter((s) => sources.includes(s));

/**
 * Lo que importa esta semana para la persona de la transacción, de las
 * fuentes pedidas (las que sus permisos ven: `weeklySourcesFor`), en
 * orden de urgencia y como mucho MAX_HIGHLIGHTS filas. `more` dice si
 * quedaron filas fuera: cada rama pide una de más.
 */
export async function listWeeklyHighlights(tx: WorkspaceTx, sources: readonly WeeklySource[]): Promise<WeeklyHighlights> {
  const filas: WeeklyHighlight[] = [];
  for (const s of pedidas(sources)) filas.push(...(await RAMAS[s](tx, MAX_HIGHLIGHTS + 1)));
  filas.sort(compareHighlights);
  return { rows: filas.slice(0, MAX_HIGHLIGHTS), more: filas.length > MAX_HIGHLIGHTS };
}

/**
 * El gesto de la persona de la transacción sobre un aviso del bloque
 * (notification_ack, 0078). Solo vale para los avisos de las fuentes que
 * esa persona puede ver —el mismo `sources` con el que se leyó— y para
 * los que son de ella (PARA_MI): quien no ve Finanzas no marca una
 * factura aunque conozca el id. Escribe solo si cambia algo (el último
 * gesto no era ya ese), así repetir el clic no deja otra fila.
 * Devuelve false si el aviso no existe en este espacio, no es de esas
 * fuentes o no es de ella.
 */
async function gesto(tx: WorkspaceTx, notificationId: string, sources: readonly WeeklySource[], action: 'ack' | 'undo'): Promise<boolean> {
  if (!isUuid(notificationId)) return false;
  const fuentes = pedidas(sources);
  if (fuentes.length === 0) return false;
  const { rows } = await tx.query<{ ok: boolean }>(
    `WITH aviso AS (
       SELECT n.id FROM notification n
        WHERE n.id = $1 AND ${PARA_MI}
          AND (n.entity_type, n.kind) IN (SELECT * FROM unnest($2::text[], $3::text[]))
     ), nueva AS (
       INSERT INTO notification_ack (workspace_id, notification_id, user_id, action)
       SELECT current_workspace_id(), aviso.id, current_user_id(), $4
         FROM aviso
        WHERE coalesce(${ultimoGesto('aviso.id')}, 'undo') <> $4
       RETURNING id
     )
     SELECT EXISTS (SELECT 1 FROM aviso) AS ok`,
    [
      notificationId,
      fuentes.flatMap((s) => AVISOS[s].kinds.map(() => AVISOS[s].entityType)),
      fuentes.flatMap((s): readonly string[] => AVISOS[s].kinds),
      action,
    ],
  );
  return rows[0]?.ok === true;
}

/** «Entendido»: el aviso sale de la lista de esta persona. Ver `gesto`. */
export function acknowledgeHighlight(tx: WorkspaceTx, notificationId: string, sources: readonly WeeklySource[]): Promise<boolean> {
  return gesto(tx, notificationId, sources, 'ack');
}

/** «Deshacer»: el aviso vuelve a su lista, si sigue siendo cierto. Ver `gesto`. */
export function unacknowledgeHighlight(tx: WorkspaceTx, notificationId: string, sources: readonly WeeklySource[]): Promise<boolean> {
  return gesto(tx, notificationId, sources, 'undo');
}
