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
 *       outlier. El índice notification_entity_recent_idx (0081) sirve
 *       justo esta elección; sin ventana de tiempo a propósito: una
 *       factura con el último recordatorio (+45) de hace cinco meses
 *       sigue vencida, y recortar por fecha la escondería. Los videos
 *       sí llevan su ventana dentro de la elección (regla 2): ahí no
 *       cambia el resultado y el índice corta por fecha.
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
 *   4 · Leído es de la persona: notification_ack (0081), donde vale el
 *       último gesto (Entendido o Deshacer). Sin sesión (el modo demo)
 *       no hay persona y no se escribe en la base: quien llama pasa
 *       `hidden`, los avisos que ESE visitante entendió (su cookie). No
 *       se toca `notification.read_at`, que en FIN-4 quiere decir «ya lo
 *       mandé». Un aviso con dismissed_at no sale; con read_at tampoco,
 *       SALVO la factura: mandar el recordatorio no cobra la factura, y
 *       mientras siga abierta y vencida la fila sigue, con otro texto
 *       (`reminderSentAt`). Solo el «Entendido» de la persona la quita.
 *   4b · Urgencia ANTES del corte: cada rama ordena por severidad y
 *       luego por lo más reciente (el mismo orden que compareHighlights)
 *       antes de su LIMIT. Con 30 cuentas rotas, la crítica más vieja no
 *       se queda fuera por veinte avisos recientes de menos peso.
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
  /** creator_profile.display_name de la creadora del video (ver WeeklyHighlights.severalCreators). */
  creatorName: string;
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
  /** creator_profile.display_name de la creadora de la cuenta (ver WeeklyHighlights.severalCreators). */
  creatorName: string;
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
  /**
   * Cuándo se marcó como enviado en Finanzas el recordatorio de este
   * aviso (notification.read_at, FIN-4), ISO 8601 en UTC; null si sigue
   * por mandar. Mandarlo no cobra la factura: la fila sigue y cambia el
   * texto («Recordatorio enviado el … · sigue sin pagar»).
   */
  reminderSentAt: string | null;
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
  /**
   * El espacio tiene más de una creadora (una agencia): la fila de una
   * cuenta o de un video tiene que decir de quién es, y «tu mediana» ya
   * no es de nadie. Se cuentan las del ESPACIO y no las del alcance de la
   * persona: quien solo ve lo de Laura en una agencia sigue en una
   * agencia, y el número no dice cuáles son las otras.
   */
  severalCreators: boolean;
}

// ---------------------------------------------------------------------
// SQL común a las ramas
// ---------------------------------------------------------------------

/** El aviso es de esta persona: va a todo el espacio, o a ella. Sin persona (modo demo), todo. */
const PARA_MI = `(n.user_id IS NULL OR current_user_id() IS NULL OR n.user_id = current_user_id())`;

/**
 * El último gesto de esta persona sobre el aviso `idExpr` (0081): 'ack',
 * 'undo' o NULL si nunca tocó. Sin persona (modo demo) siempre NULL: la
 * tabla no guarda gestos sin persona.
 */
const ultimoGesto = (idExpr: string) => `(SELECT a.action FROM notification_ack a
   WHERE a.workspace_id = current_workspace_id() AND a.notification_id = ${idExpr}
     AND a.user_id = current_user_id()
   ORDER BY a.created_at DESC, a.id DESC LIMIT 1)`;

/**
 * Sin atender (regla 4): ni descartado, ni entendido por esta persona,
 * ni entre los que quien visita sin sesión ya entendió (`ocultas`, el
 * parámetro uuid[]). `leidoQuita`: si un aviso con read_at también sale.
 * Sí en todas las ramas menos la factura, donde read_at es «recordatorio
 * enviado» y la factura sigue sin pagar.
 */
function sinAtender(ocultas: string, leidoQuita = true): string {
  return [
    'n.dismissed_at IS NULL',
    ...(leidoQuita ? ['n.read_at IS NULL'] : []),
    `${ultimoGesto('n.id')} IS DISTINCT FROM 'ack'`,
    `NOT (n.id = ANY(${ocultas}::uuid[]))`,
  ].join(' AND ');
}

/**
 * El orden de cada rama ANTES de su LIMIT (regla 4b): urgencia, lo más
 * reciente, el id. Es el de compareHighlights dentro de una fuente, así
 * que lo que corta SQL es lo que la pantalla habría enseñado primero.
 * `severidad` es la expresión de la severidad de la fila.
 */
const orden = (severidad = 'n.severity') =>
  `ORDER BY CASE ${severidad} WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 WHEN 'info' THEN 2 ELSE 3 END, n.created_at DESC, n.id`;

/**
 * El aviso más reciente de cada cosa (regla 1), de los que son de esta
 * persona. $1 son los kinds de la fuente. El «Entendido» se mira fuera,
 * después de elegir. El orden de DISTINCT ON es el del índice
 * notification_entity_recent_idx (0081).
 *
 * `extra` es una condición más sobre el aviso, DENTRO de la elección:
 * solo vale para una que no cambie cuál es el más reciente de lo que
 * queda. La ventana de los videos es así (si el último aviso de un video
 * es de antes de la ventana, todos los anteriores también), y ponerla
 * aquí deja que el índice corte por fecha en vez de recorrer cada aviso
 * de video que el espacio tuvo nunca. Una constante de este archivo,
 * nunca algo de fuera.
 */
function ultimoPorEntidad(source: WeeklySource, extra = ''): string {
  return `ultimo AS (
    SELECT DISTINCT ON (n.entity_id)
           n.id, n.kind, n.severity, n.title_es, n.body_es, n.action_url, n.created_at,
           n.entity_id, n.read_at, n.dismissed_at
      FROM notification n
     WHERE n.workspace_id = current_workspace_id()
       AND n.entity_type = '${AVISOS[source].entityType}' AND n.entity_id IS NOT NULL
       AND n.kind = ANY($1::text[]) AND ${PARA_MI}${extra ? `\n       ${extra}` : ''}
     ORDER BY n.entity_id, n.created_at DESC, n.id DESC
  )`;
}

/**
 * Las columnas del aviso que llevan todas las ramas. created_at con
 * microsegundos: compareHighlights lo compara como texto y tiene que
 * desempatar igual que el ORDER BY de la rama.
 */
const columnasAviso = (severidad = 'n.severity') => `n.id, n.kind, ${severidad} AS severity, n.title_es, n.body_es, n.action_url,
       to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`;

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
  creator_name: string;
  post_url: string | null;
  views_vs_median: string | null;
  age_hours_cut: AgeCut | null;
}

/**
 * La ventana de un video destacado (regla 2), con $2 = OUTLIER_WINDOW_DAYS.
 * Va dentro de ultimoPorEntidad: ver su `extra`.
 */
const DENTRO_DE_LA_VENTANA = 'AND n.created_at >= now() - make_interval(days => $2::int)';

async function outliers(tx: WorkspaceTx, limit: number, ocultas: readonly string[]): Promise<OutlierHighlight[]> {
  const { rows } = await tx.query<OutlierRaw>(
    `WITH ${ultimoPorEntidad('outlier', DENTRO_DE_LA_VENTANA)}
     SELECT ${columnasAviso()},
            p.id AS post_id, p.platform_id, p.title AS post_title, p.caption AS post_caption,
            coalesce(p.permalink, p.url) AS post_url, cr.display_name AS creator_name,
            ps.views_vs_median::text AS views_vs_median, ps.age_hours_cut
       FROM ultimo n
       JOIN post p ON p.id = n.entity_id
       JOIN creator_profile cr ON cr.id = p.creator_id
       LEFT JOIN post_score ps ON ps.post_id = p.id
      WHERE ${sinAtender('$4')}
        AND NOT p.deleted_on_platform
        AND ${SCOPE_POST}
      ${orden()}
      LIMIT $3`,
    [AVISOS.outlier.kinds, OUTLIER_WINDOW_DAYS, limit, ocultas],
  );
  return rows.map((r) => ({
    ...base('outlier', r),
    tier: r.kind === 'breakout' ? ('breakout' as const) : ('outlier' as const),
    postId: r.post_id,
    platformId: r.platform_id,
    // El mismo nombre que el aviso de CON-6: título, o el texto del video si no hay.
    postTitle: videoName(r.post_title, r.post_caption),
    postUrl: r.post_url,
    creatorName: r.creator_name,
    viewsVsMedian: r.views_vs_median,
    ageHoursCut: r.age_hours_cut,
  }));
}

interface ConnectionRaw extends AvisoRaw<'connection'> {
  connection_id: string;
  platform_id: PlatformId;
  handle: string | null;
  creator_name: string;
  status: BrokenConnectionStatus;
  detail: string | null;
}

async function connections(tx: WorkspaceTx, limit: number, ocultas: readonly string[]): Promise<ConnectionHighlight[]> {
  const { rows } = await tx.query<ConnectionRaw>(
    `WITH ${ultimoPorEntidad('connection')}
     SELECT ${columnasAviso()},
            c.id AS connection_id, c.platform_id, c.handle, cr.display_name AS creator_name,
            c.status, c.status_detail AS detail
       FROM ultimo n
       JOIN social_connection c ON c.id = n.entity_id
       JOIN creator_profile cr ON cr.id = c.creator_id
      WHERE ${sinAtender('$3')}
        AND c.deleted_at IS NULL
        AND c.status IN ('needs_reauth', 'error', 'expired', 'revoked')
        AND ${SCOPE_CONNECTION}
      ${orden()}
      LIMIT $2`,
    [AVISOS.connection.kinds, limit, ocultas],
  );
  return rows.map((r) => ({
    ...base('connection', r),
    connectionId: r.connection_id,
    platformId: r.platform_id,
    handle: r.handle,
    creatorName: r.creator_name,
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
async function channels(tx: WorkspaceTx, limit: number, ocultas: readonly string[]): Promise<ChannelHighlight[]> {
  const { rows } = await tx.query<ChannelRaw>(
    `WITH ${ultimoPorEntidad('channel')}
     SELECT ${columnasAviso()},
            a.id AS account_id, a.channel, a.display_name, a.status
       FROM ultimo n
       JOIN outreach_channel_account a ON a.id = n.entity_id
      WHERE ${sinAtender('$3')}
        AND n.severity <> 'success'
        AND a.status IN ('needs_reconnect', 'error')
        AND ${SCOPE_CHANNEL}
      ${orden()}
      LIMIT $2`,
    [AVISOS.channel.kinds, limit, ocultas],
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
  reminder_sent_at: string | null;
}

/**
 * La severidad de la fila de una factura: la del recordatorio, y como
 * mínimo 'warning'. Una factura del bloque está vencida HOY, aunque su
 * último aviso sea el del paso −7 o el 0 (info) o ya se haya mandado.
 */
const SEVERIDAD_FACTURA = `CASE WHEN n.severity = 'critical' THEN 'critical' ELSE 'warning' END`;

/**
 * La factura sigue abierta (sent o partial) y vencida HOY en la zona del
 * espacio, como cuenta Finanzas la mora (listReminders). El recordatorio
 * del paso −7 o del 0 de una factura que ya venció cuenta: es el último
 * que hay y la factura está vencida. Un recordatorio ya mandado
 * (read_at) NO la saca (regla 4): entre el paso 4 (+21) y el 5 (+45)
 * pasan 24 días sin aviso nuevo, y un «todo en orden» con un cobro de 40
 * días sin pagar sería mentira. La mora se cuenta en la zona del espacio;
 * la vista receivables (0010) la cuenta en UTC (FIN-9).
 */
async function invoices(tx: WorkspaceTx, limit: number, ocultas: readonly string[]): Promise<InvoiceHighlight[]> {
  const { rows } = await tx.query<InvoiceRaw>(
    `WITH ${ultimoPorEntidad('invoice')}
     SELECT ${columnasAviso(SEVERIDAD_FACTURA)},
            i.id AS invoice_id, i.number, co.name AS company_name, i.currency,
            (i.total - i.paid_amount)::text AS outstanding,
            to_char(i.due_on, 'YYYY-MM-DD') AS due_on,
            ((now() AT TIME ZONE ${ZONA})::date - i.due_on)::int AS days_overdue,
            to_char(n.read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reminder_sent_at
       FROM ultimo n
       JOIN invoice i   ON i.id = n.entity_id
       JOIN company co  ON co.id = i.company_id
       JOIN workspace w ON w.id = i.workspace_id
       LEFT JOIN campaign ca ON ca.id = i.campaign_id
      WHERE ${sinAtender('$3', false)}
        AND i.status IN ('sent', 'partial')
        AND i.due_on < (now() AT TIME ZONE ${ZONA})::date
        AND ${SCOPE_INVOICE}
      ${orden(SEVERIDAD_FACTURA)}
      LIMIT $2`,
    [AVISOS.invoice.kinds, limit, ocultas],
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
    reminderSentAt: r.reminder_sent_at,
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
async function deals(tx: WorkspaceTx, limit: number, ocultas: readonly string[]): Promise<DealHighlight[]> {
  const { rows } = await tx.query<DealRaw>(
    `WITH ${ultimoPorEntidad('deal')}
     SELECT ${columnasAviso()},
            d.id AS deal_id, d.name AS deal_name, d.company_id, d.company_name, btrim(d.next_action) AS next_action,
            to_char(d.next_action_due AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS due_at,
            d.due_state,
            ((now() AT TIME ZONE ${ZONA})::date - (d.next_action_due AT TIME ZONE ${ZONA})::date)::int AS days_overdue
       FROM ultimo n
       JOIN deal_pipeline d ON d.id = n.entity_id
       JOIN workspace w     ON w.id = d.workspace_id
      WHERE ${sinAtender('$3')}
        AND NOT d.is_won AND NOT d.is_lost
        AND nullif(btrim(d.next_action), '') IS NOT NULL
        AND d.due_state IN ('vencido', 'hoy')
        AND n.created_at >= (date_trunc('day', d.next_action_due AT TIME ZONE ${ZONA}) AT TIME ZONE ${ZONA})
        AND ${SCOPE_DEAL}
      ${orden()}
      LIMIT $2`,
    [AVISOS.deal.kinds, limit, ocultas],
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

type Rama<S extends WeeklySource> = (tx: WorkspaceTx, limit: number, ocultas: readonly string[]) => Promise<Extract<WeeklyHighlight, { source: S }>[]>;

const RAMAS: { readonly [S in WeeklySource]: Rama<S> } = {
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
 * la misma fuente, lo más reciente primero. Dentro de una fuente es el
 * mismo orden con el que cada rama corta en SQL (`orden`, regla 4b).
 */
export function compareHighlights(a: WeeklyHighlight, b: WeeklyHighlight): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    WEEKLY_SOURCES.indexOf(a.source) - WEEKLY_SOURCES.indexOf(b.source) ||
    b.createdAt.localeCompare(a.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

/** Más de una creadora en el espacio (ver WeeklyHighlights.severalCreators). */
async function severalCreators(tx: WorkspaceTx): Promise<boolean> {
  const { rows } = await tx.query<{ varias: boolean }>(
    `SELECT count(*) > 1 AS varias
       FROM (SELECT 1 FROM creator_profile
              WHERE workspace_id = current_workspace_id() AND deleted_at IS NULL
              LIMIT 2) x`,
  );
  return rows[0]?.varias === true;
}

/** Solo las fuentes de la lista, en su orden: lo que llegue de fuera no elige SQL. */
const pedidas = (sources: readonly WeeklySource[]) => WEEKLY_SOURCES.filter((s) => sources.includes(s));

/** Cuántos ids ocultos se aceptan como mucho: los de una cookie, que llega del navegador. */
export const MAX_HIDDEN = 50;

export interface WeeklyHighlightsOptions {
  /**
   * Los avisos que quien visita SIN sesión (modo demo) ya entendió: los
   * de su cookie (apps/web …/resumen/_lib/entendidos.ts). Sin sesión no
   * hay persona y notification_ack no guarda nada (0081), así que el
   * «Entendido» de un visitante no le vacía el bloque a los demás. Lo
   * que no sea un uuid se ignora, y se toman como mucho MAX_HIDDEN.
   */
  hidden?: readonly string[];
}

/**
 * Lo que importa esta semana para la persona de la transacción, de las
 * fuentes pedidas (las que sus permisos ven: `weeklySourcesFor`), en
 * orden de urgencia y como mucho MAX_HIGHLIGHTS filas. `more` dice si
 * quedaron filas fuera: cada rama pide una de más.
 */
export async function listWeeklyHighlights(
  tx: WorkspaceTx,
  sources: readonly WeeklySource[],
  options: WeeklyHighlightsOptions = {},
): Promise<WeeklyHighlights> {
  const ocultas = (options.hidden ?? []).filter(isUuid).slice(0, MAX_HIDDEN);
  const filas: WeeklyHighlight[] = [];
  for (const s of pedidas(sources)) filas.push(...(await RAMAS[s](tx, MAX_HIGHLIGHTS + 1, ocultas)));
  filas.sort(compareHighlights);
  return {
    rows: filas.slice(0, MAX_HIGHLIGHTS),
    more: filas.length > MAX_HIGHLIGHTS,
    severalCreators: filas.some((f) => f.source === 'connection' || f.source === 'outlier') && (await severalCreators(tx)),
  };
}

/**
 * La cosa del aviso `n` sigue en el alcance de la persona (ACC-6), con el
 * MISMO SCOPE_* de la rama que la enseña. Sin esto, quien solo ve lo de
 * Laura podía mandar el id de un aviso de Sofía al «Entendido», recibir
 * true y saber así que existe.
 */
const COSA_EN_ALCANCE: { readonly [S in WeeklySource]: string } = {
  connection: `EXISTS (SELECT 1 FROM social_connection c WHERE c.id = n.entity_id AND ${SCOPE_CONNECTION})`,
  channel: `EXISTS (SELECT 1 FROM outreach_channel_account a WHERE a.id = n.entity_id AND ${SCOPE_CHANNEL})`,
  invoice: `EXISTS (SELECT 1 FROM invoice i LEFT JOIN campaign ca ON ca.id = i.campaign_id
                     WHERE i.id = n.entity_id AND ${SCOPE_INVOICE})`,
  deal: `EXISTS (SELECT 1 FROM deal_pipeline d WHERE d.id = n.entity_id AND ${SCOPE_DEAL})`,
  outlier: `EXISTS (SELECT 1 FROM post p WHERE p.id = n.entity_id AND ${SCOPE_POST})`,
};

/**
 * El aviso `$1`, si es del bloque para la persona de la transacción: de
 * este espacio (RLS), de ella (PARA_MI), de una de las fuentes pedidas
 * —por su cosa y su kind— y con la cosa dentro de su alcance. Las
 * fuentes ya pasaron por `pedidas` (la lista fija de WEEKLY_SOURCES), y
 * sus entity_type y kinds son constantes de este archivo: nada de lo que
 * se interpola viene de fuera.
 */
function avisoDelBloque(fuentes: readonly WeeklySource[]): string {
  const porFuente = fuentes.map((s) => {
    const kinds = AVISOS[s].kinds.map((k) => `'${k}'`).join(', ');
    return `(n.entity_type = '${AVISOS[s].entityType}' AND n.kind IN (${kinds}) AND ${COSA_EN_ALCANCE[s]})`;
  });
  return `SELECT n.id FROM notification n
        WHERE n.id = $1 AND ${PARA_MI}
          AND (${porFuente.join('\n            OR ')})`;
}

/**
 * ¿Es este aviso del bloque para quien pregunta, con estas fuentes? Lo
 * usa el «Entendido» sin sesión (modo demo), que no escribe en la base:
 * antes de guardar el id en la cookie del visitante se comprueba que es
 * un aviso que ese visitante ve, igual que `gesto` antes de escribir.
 */
export async function isWeeklyHighlight(tx: WorkspaceTx, notificationId: string, sources: readonly WeeklySource[]): Promise<boolean> {
  if (!isUuid(notificationId)) return false;
  const fuentes = pedidas(sources);
  if (fuentes.length === 0) return false;
  const { rows } = await tx.query<{ ok: boolean }>(`SELECT EXISTS (${avisoDelBloque(fuentes)}) AS ok`, [notificationId]);
  return rows[0]?.ok === true;
}

/**
 * El gesto de la persona de la transacción sobre un aviso del bloque
 * (notification_ack, 0081). Solo vale para los avisos de las fuentes que
 * esa persona puede ver —el mismo `sources` con el que se leyó— y para
 * los que son de ella (PARA_MI), con la cosa dentro de su alcance
 * (ACC-6): quien no ve Finanzas no marca una factura aunque conozca el
 * id, y quien solo ve lo de Laura no averigua si existe un aviso de
 * Sofía. Escribe solo si cambia algo (el último
 * gesto no era ya ese), así repetir el clic no deja otra fila.
 * Devuelve false si el aviso no existe en este espacio, no es de esas
 * fuentes, no es de ella o su cosa está fuera de su alcance, y siempre sin persona (modo demo): ese gesto
 * no va a la base (ver WeeklyHighlightsOptions.hidden).
 */
async function gesto(tx: WorkspaceTx, notificationId: string, sources: readonly WeeklySource[], action: 'ack' | 'undo'): Promise<boolean> {
  if (!isUuid(notificationId)) return false;
  const fuentes = pedidas(sources);
  if (fuentes.length === 0) return false;
  const { rows } = await tx.query<{ ok: boolean }>(
    `WITH aviso AS (
       ${avisoDelBloque(fuentes)}
          AND current_user_id() IS NOT NULL
     ), nueva AS (
       INSERT INTO notification_ack (workspace_id, notification_id, user_id, action)
       SELECT current_workspace_id(), aviso.id, current_user_id(), $2
         FROM aviso
        WHERE coalesce(${ultimoGesto('aviso.id')}, 'undo') <> $2
       RETURNING id
     )
     SELECT EXISTS (SELECT 1 FROM aviso) AS ok`,
    [notificationId, action],
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
