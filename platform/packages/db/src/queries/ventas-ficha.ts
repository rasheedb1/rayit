/**
 * Consultas de la ficha de empresa y de la siguiente acción: VEN-5 y
 * VEN-4. Dueño: Rasheed.
 *
 * Archivo propio para no pisar queries/ventas.ts (empresas, radar y
 * pipeline, VEN-1..3). Las reglas son las de su cabecera:
 *   - Toda función recibe un WorkspaceTx; RLS filtra lo que se lee y los
 *     INSERT escriben `current_workspace_id()`, nunca un id de la pantalla.
 *   - Dinero como string decimal; ningún número derivado se calcula en
 *     React.
 *   - Un id que llega de fuera se valida con `isUuid` antes de consultar.
 *   - Los instantes salen como ISO en UTC (to_char), y las fechas de
 *     calendario que la pantalla pinta en un <input type="date"> salen ya
 *     en la zona del espacio: la pantalla no hace cuentas de husos.
 *
 * Los errores de esta pieza son `FichaError` con un código, sin frase,
 * como VentasError: la web los traduce con su messages.ts.
 */
import { isUuid, type WorkspaceTx } from '../client.ts';
import type { ACTIVITY_KINDS } from '../schema/ventas.ts';
import { CompanyNotFound, DealNotFound, PITCH_DUE_HOUR, WORKSPACE_TZ } from './ventas.ts';

// ---------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------

export const FICHA_ERROR_CODES = [
  /** El negocio ya se ganó o se perdió: su siguiente acción no se toca. */
  'DealClosed',
  /** La acción está vacía o pasa de NEXT_ACTION_MAX caracteres. */
  'InvalidNextAction',
  /** La fecha de la acción no es una fecha, o la hora no es HH:MM. */
  'InvalidDueDate',
  /** La fecha de la acción ya pasó (antes de hoy, en la zona del espacio). */
  'PastDueDate',
  /** El día es hoy pero la hora ya pasó: la acción nacería vencida. */
  'PastDueTime',
  /** El responsable no es alguien de este espacio. */
  'InvalidResponsible',
  /** No hay siguiente acción que marcar como hecha. */
  'NoNextAction',
  /** Ese tipo de actividad no se registra a mano. */
  'InvalidActivityKind',
  /** Una nota sin texto, o un texto de más de ACTIVITY_BODY_MAX caracteres. */
  'InvalidActivityBody',
  /** La fecha de la actividad no es una fecha o es futura. */
  'InvalidActivityDate',
  /** El negocio elegido no es de esta empresa. */
  'DealNotInCompany',
  /** El contacto elegido no es de esta empresa (o no se ve desde aquí). */
  'ContactNotInCompany',
  /** El contacto pidió la baja: no se le atribuye una llamada, un correo ni una reunión. */
  'ContactOptedOut',
] as const;
export type FichaErrorCode = (typeof FICHA_ERROR_CODES)[number];

export class FichaError extends Error {
  readonly code: FichaErrorCode;
  constructor(code: FichaErrorCode) {
    super(code);
    this.name = code;
    this.code = code;
  }
}

// ---------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------

/** Lo que se registra a mano desde la ficha: nota, llamada, correo y reunión. */
export const LOGGABLE_ACTIVITY_KINDS = ['note', 'call', 'email_sent', 'meeting'] as const;
export type LoggableActivityKind = (typeof LOGGABLE_ACTIVITY_KINDS)[number];

/**
 * Las actividades que son HABLAR con la marca: registrarlas mueve
 * deal.last_contact_at. Una nota no es contacto.
 */
export const CONTACT_ACTIVITY_KINDS: readonly LoggableActivityKind[] = ['call', 'email_sent', 'meeting'];

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const NEXT_ACTION_MAX = 200;
export const ACTIVITY_BODY_MAX = 4000;
/** Cuántas actividades trae la ficha de una vez. */
export const TIMELINE_LIMIT = 50;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Un instante como ISO en UTC, para que la web no reciba un Date. */
const iso = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

// ---------------------------------------------------------------------
// VEN-4 · La siguiente acción
// ---------------------------------------------------------------------

/**
 * La siguiente acción de un negocio abierto, lista para pintarla en una
 * línea («Llamar a Sofía · 24 sep · Laura») y para llenar el formulario
 * que la edita.
 */
export interface NextActionRow {
  dealId: string;
  companyId: string;
  companyName: string;
  dealName: string;
  stageLabel: string;
  action: string | null;
  /** El instante en que vence, ISO en UTC. */
  dueAt: string | null;
  /** El día en que vence, en la zona del espacio: «2026-09-24». Para el <input type="date">. */
  dueDate: string | null;
  /** La hora en que vence, en la zona del espacio: «15:00». */
  dueTime: string | null;
  /** 'vencido', 'hoy', 'futuro' o 'sin_fecha', contados en la zona del espacio (0034). */
  dueState: 'sin_fecha' | 'vencido' | 'hoy' | 'futuro';
  /** Quien la tiene que hacer (deal.next_action_user_id). */
  responsibleUserId: string | null;
  responsibleName: string | null;
  /** El responsable del negocio, para proponerlo cuando la acción no tiene. */
  ownerUserId: string | null;
}

interface NextActionSql {
  deal_id: string; company_id: string; company_name: string; deal_name: string; stage_label: string;
  action: string | null; due_at: string | null; due_date: string | null; due_time: string | null;
  due_state: NextActionRow['dueState']; responsible_user_id: string | null; responsible_name: string | null;
  owner_user_id: string | null;
}

/**
 * «Tiene siguiente acción»: un texto que no esté en blanco. El esquema
 * deja guardar una fecha sin texto; ese negocio cuenta como SIN acción en
 * todas partes (la lista, los conteos y el job), no como vencido.
 */
const HAS_ACTION = `nullif(btrim(d.next_action), '') IS NOT NULL`;

/**
 * La parte común de las dos lecturas de siguiente acción. `w` es la fila
 * de WORKSPACE_TZ y `p` la de deal_pipeline, de donde sale el estado del
 * vencimiento: desde 0034 la vista lo cuenta en la zona del espacio, así
 * que el tablero, la ficha y «Para hoy» lo leen de una sola definición.
 * La única copia de ese CASE fuera de la vista es la del job
 * (apps/worker/src/jobs/ventas/seguimientos.ts), que cuenta con el
 * instante de SU corrida y no con now().
 */
const NEXT_ACTION_SELECT = `
  SELECT d.id AS deal_id, d.company_id, p.company_name, d.name AS deal_name, p.stage_label,
         nullif(btrim(d.next_action), '') AS action,
         ${iso('d.next_action_due')} AS due_at,
         to_char(d.next_action_due AT TIME ZONE w.tz, 'YYYY-MM-DD') AS due_date,
         to_char(d.next_action_due AT TIME ZONE w.tz, 'HH24:MI') AS due_time,
         p.due_state,
         d.next_action_user_id AS responsible_user_id,
         coalesce(nullif(btrim(u.name), ''), u.email::text) AS responsible_name,
         d.owner_user_id
    FROM deal_pipeline p
    JOIN deal d ON d.id = p.id
    LEFT JOIN app_user u ON u.id = d.next_action_user_id
    CROSS JOIN ${WORKSPACE_TZ} w
   WHERE NOT p.is_won AND NOT p.is_lost`;

function toNextActionRow(r: NextActionSql): NextActionRow {
  return {
    dealId: r.deal_id,
    companyId: r.company_id,
    companyName: r.company_name,
    dealName: r.deal_name,
    stageLabel: r.stage_label,
    action: r.action,
    dueAt: r.due_at,
    dueDate: r.due_date,
    dueTime: r.due_time,
    dueState: r.due_state,
    responsibleUserId: r.responsible_user_id,
    responsibleName: r.responsible_name,
    ownerUserId: r.owner_user_id,
  };
}

/**
 * La siguiente acción de cada negocio ABIERTO del espacio, o solo de los
 * de una empresa. Los cerrados no tienen: a un negocio ganado no le
 * vence nada.
 */
export async function listNextActions(tx: WorkspaceTx, opts: { companyId?: string } = {}): Promise<NextActionRow[]> {
  if (opts.companyId !== undefined && !isUuid(opts.companyId)) return [];
  const { rows } = await tx.query<NextActionSql>(
    `${NEXT_ACTION_SELECT}
       AND ($1::uuid IS NULL OR d.company_id = $1::uuid)
     ORDER BY d.next_action_due ASC NULLS LAST, p.company_name ASC`,
    [opts.companyId ?? null],
  );
  return rows.map(toNextActionRow);
}

/** El reloj del espacio: lo que los formularios necesitan para no proponer algo que ya pasó. */
export interface LocalDates {
  /** Hoy, «2026-09-23». */
  today: string;
  /** Mañana. */
  tomorrow: string;
  /** La hora de ahora, «17:12». */
  now: string;
  /** La próxima hora en punto, «18:00»: la que se propone hoy cuando la de siempre ya pasó. */
  nextHour: string;
}

/**
 * Hoy, mañana, la hora de ahora y la próxima hora en punto, en la zona
 * del espacio. Son el mínimo y el valor por defecto de los <input
 * type="date"> y type="time" de la siguiente acción y de la actividad:
 * la pantalla no calcula días ni husos.
 */
export async function getLocalDates(tx: WorkspaceTx): Promise<LocalDates> {
  const { rows } = await tx.query<LocalDates>(
    `SELECT to_char(l.t::date, 'YYYY-MM-DD') AS today,
            to_char(l.t::date + 1, 'YYYY-MM-DD') AS tomorrow,
            to_char(l.t, 'HH24:MI') AS now,
            to_char(date_trunc('hour', l.t) + interval '1 hour', 'HH24:MI') AS "nextHour"
       FROM ${WORKSPACE_TZ} w, LATERAL (SELECT now() AT TIME ZONE w.tz AS t) l`,
  );
  const r = rows[0];
  if (!r) {
    // Sin la fila del espacio (no debería pasar: RLS deja leer la propia), en UTC.
    const ahora = new Date();
    return {
      today: ahora.toISOString().slice(0, 10),
      tomorrow: new Date(ahora.getTime() + 86_400_000).toISOString().slice(0, 10),
      now: ahora.toISOString().slice(11, 16),
      nextHour: `${String((ahora.getUTCHours() + 1) % 24).padStart(2, '0')}:00`,
    };
  }
  return r;
}

/** Lo de hoy: lo vencido y lo que vence hoy, y cuántos negocios abiertos no tienen siguiente acción. */
export interface DueToday {
  /** Primero lo más vencido. Como mucho `limit`. */
  rows: NextActionRow[];
  overdueCount: number;
  todayCount: number;
  /** Los vencidos y de hoy que no caben en `rows`: los que el bloque manda a ver al pipeline. */
  moreCount: number;
  /** Abiertos sin siguiente acción (o con la acción sin fecha): la fila que hay que arreglar. */
  withoutActionCount: number;
}

/**
 * «Para hoy», el bloque de arriba de /ventas (VEN-4): los negocios
 * abiertos cuya siguiente acción ya venció o vence antes de que acabe el
 * día EN LA ZONA DEL ESPACIO. Los conteos salen de SQL, no de la lista
 * recortada, y cuadran entre sí: un negocio con fecha pero sin texto no
 * está en la lista ni cuenta como vencido; cuenta solo como «sin
 * siguiente acción», que es lo que hay que arreglar (y el job tampoco
 * avisa de él).
 */
export async function listDueToday(tx: WorkspaceTx, limit = 8): Promise<DueToday> {
  const top = Math.max(1, Math.min(limit, 50));
  const { rows } = await tx.query<NextActionSql>(
    `${NEXT_ACTION_SELECT}
       AND ${HAS_ACTION}
       AND p.due_state IN ('vencido', 'hoy')
     ORDER BY d.next_action_due ASC, p.company_name ASC
     LIMIT $1`,
    [top],
  );
  const counts = await tx.query<{ overdue: string; today: string; without: string }>(
    `SELECT count(*) FILTER (WHERE ${HAS_ACTION} AND p.due_state = 'vencido')::text AS overdue,
            count(*) FILTER (WHERE ${HAS_ACTION} AND p.due_state = 'hoy')::text AS today,
            count(*) FILTER (WHERE NOT (${HAS_ACTION}) OR d.next_action_due IS NULL)::text AS without
       FROM deal_pipeline p
       JOIN deal d ON d.id = p.id
      WHERE NOT p.is_won AND NOT p.is_lost`,
  );
  const c = counts.rows[0];
  const overdueCount = Number(c?.overdue ?? 0);
  const todayCount = Number(c?.today ?? 0);
  return {
    rows: rows.map(toNextActionRow),
    overdueCount,
    todayCount,
    moreCount: Math.max(0, overdueCount + todayCount - rows.length),
    withoutActionCount: Number(c?.without ?? 0),
  };
}

export interface SetNextActionInput {
  /** Qué toca hacer: «Llamar a Sofía». */
  action: string;
  /** El día, en la zona del espacio: «2026-09-24». */
  dueDate: string;
  /**
   * La hora, en la zona del espacio: «09:30». Sin ella, PITCH_DUE_HOUR:00,
   * como las que pone el producto; y si el día es hoy y esa hora ya pasó,
   * la próxima hora en punto.
   */
  dueTime?: string | null;
  /** Quién la hace: alguien de este espacio; null la deja sin responsable y sin el campo no se toca. */
  responsibleUserId?: string | null;
}

/**
 * Fija la siguiente acción de un negocio abierto: qué, cuándo y quién.
 *
 * La fecha y la hora se interpretan en la zona del espacio y se guardan
 * como instante (timestamptz) en SQL, sin cuentas de husos en la web.
 * Una acción que nace vencida es un error de dedo, no un plan, y se mira
 * el instante entero: un día anterior es PastDueDate y una hora de hoy
 * que ya pasó, PastDueTime (si no, a las 17:00 «hoy a las 15:00» se
 * guardaría ya vencida y el job avisaría de algo recién escrito). Sin
 * hora se toma PITCH_DUE_HOUR:00 o, si hoy ya pasó, la próxima hora en
 * punto. Cambiar el texto deja el marcador del producto
 * (next_action_kind) en NULL por el disparador de 0032: a partir de ahí
 * es una acción escrita por una persona y Cotizar la respeta.
 *
 * Devuelve la empresa del negocio, para revalidar su ficha, y el instante
 * en que quedó (ISO en UTC), para decir «Guardada para el 24 sep».
 */
export async function setNextAction(
  tx: WorkspaceTx,
  dealId: string,
  input: SetNextActionInput,
): Promise<{ companyId: string; dueAt: string }> {
  if (!isUuid(dealId)) throw new DealNotFound();
  const action = input.action.trim();
  if (!action || action.length > NEXT_ACTION_MAX) throw new FichaError('InvalidNextAction');
  const dueTime = input.dueTime?.trim() || null;
  if (
    !ISO_DATE_RE.test(input.dueDate) ||
    (dueTime !== null && !TIME_RE.test(dueTime)) ||
    Number.isNaN(Date.parse(`${input.dueDate}T00:00:00Z`))
  ) {
    throw new FichaError('InvalidDueDate');
  }
  const tocaResponsable = input.responsibleUserId !== undefined;
  const responsible = input.responsibleUserId || null;
  if (responsible !== null) await assertMember(tx, responsible);

  const deal = await readOpenDeal(tx, dealId);
  // El instante, en SQL y en la zona del espacio. Con hora, esa; sin
  // ella, la de siempre o, si hoy ya pasó, la próxima en punto.
  const when = await tx.query<{ due: string; past_day: boolean; past_time: boolean }>(
    `SELECT ${iso('x.due')} AS due,
            $1::date < (now() AT TIME ZONE w.tz)::date AS past_day,
            x.due < now() AS past_time
       FROM ${WORKSPACE_TZ} w,
            LATERAL (SELECT CASE
                              WHEN $2::time IS NOT NULL THEN ($1::date + $2::time) AT TIME ZONE w.tz
                              WHEN ($1::date + $3::time) AT TIME ZONE w.tz > now() THEN ($1::date + $3::time) AT TIME ZONE w.tz
                              ELSE (date_trunc('hour', now() AT TIME ZONE w.tz) + interval '1 hour') AT TIME ZONE w.tz
                            END AS due) x`,
    [input.dueDate, dueTime, `${String(PITCH_DUE_HOUR).padStart(2, '0')}:00`],
  );
  const w = when.rows[0];
  if (!w) throw new FichaError('InvalidDueDate');
  if (w.past_day) throw new FichaError('PastDueDate');
  if (w.past_time) throw new FichaError('PastDueTime');

  await tx.query(
    `UPDATE deal
        SET next_action = $2,
            next_action_due = $3::timestamptz,
            next_action_user_id = CASE WHEN $5::boolean THEN $4::uuid ELSE next_action_user_id END,
            updated_at = now()
      WHERE id = $1`,
    [dealId, action, w.due, responsible, tocaResponsable],
  );
  return { companyId: deal.companyId, dueAt: w.due };
}

/**
 * «Hecha»: la siguiente acción se cumplió. Queda en la historia como una
 * nota con su texto (`doneText`, la frase la pone la pantalla) y el
 * negocio se queda sin siguiente acción, marcado, hasta que se le ponga
 * la próxima. El responsable se conserva: es el que se propone para la
 * siguiente.
 */
export async function completeNextAction(
  tx: WorkspaceTx,
  dealId: string,
  doneText: (action: string) => string,
): Promise<{ companyId: string }> {
  if (!isUuid(dealId)) throw new DealNotFound();
  const deal = await readOpenDeal(tx, dealId);
  if (!deal.action) throw new FichaError('NoNextAction');
  await tx.query(
    `INSERT INTO activity (workspace_id, company_id, deal_id, user_id, kind, subject, metadata)
     VALUES (current_workspace_id(), $1, $2, current_user_id(), 'note', $3,
             jsonb_build_object('kind', 'next_action_done', 'action', $4::text))`,
    [deal.companyId, dealId, truncate(doneText(deal.action), 200), deal.action],
  );
  await tx.query(
    `UPDATE deal SET next_action = NULL, next_action_due = NULL, updated_at = now() WHERE id = $1`,
    [dealId],
  );
  return { companyId: deal.companyId };
}

/** Un negocio abierto de este espacio, con su empresa y su acción; lanza si no existe o está cerrado. */
async function readOpenDeal(tx: WorkspaceTx, dealId: string): Promise<{ companyId: string; action: string | null }> {
  const { rows } = await tx.query<{ company_id: string; closed: boolean; action: string | null }>(
    `SELECT d.company_id, (st.is_won OR st.is_lost) AS closed, nullif(btrim(d.next_action), '') AS action
       FROM deal d JOIN pipeline_stage st ON st.id = d.stage_id
      WHERE d.id = $1
      FOR UPDATE OF d`,
    [dealId],
  );
  const d = rows[0];
  if (!d) throw new DealNotFound();
  if (d.closed) throw new FichaError('DealClosed');
  return { companyId: d.company_id, action: d.action };
}

/** Como assertOwner de queries/ventas.ts: el id tiene que ser de alguien con membresía en este espacio. */
async function assertMember(tx: WorkspaceTx, userId: string): Promise<void> {
  if (!isUuid(userId)) throw new FichaError('InvalidResponsible');
  const { rows } = await tx.query(
    `SELECT 1 FROM membership WHERE workspace_id = current_workspace_id() AND user_id = $1 AND role <> 'client'`,
    [userId],
  );
  if (rows.length === 0) throw new FichaError('InvalidResponsible');
}

// ---------------------------------------------------------------------
// VEN-5 · La línea de tiempo
// ---------------------------------------------------------------------

export interface ActivityRow {
  id: string;
  kind: ActivityKind;
  subject: string | null;
  body: string | null;
  occurredAt: string;
  dealId: string | null;
  dealName: string | null;
  contactName: string | null;
  /** Quién la registró; null en las que deja el sistema (el radar, un pago). */
  userName: string | null;
  /** Lo que la pantalla sabe leer de metadata: el motivo de pérdida, el número de una cotización… */
  meta: {
    lostReason: string | null;
    quoteNumber: string | null;
    durationMin: number | null;
    /**
     * Se registró para un día anterior sin decir la hora: se guarda a
     * mediodía de ese día para ordenar, pero la pantalla pinta solo la
     * fecha, no una hora que nadie dijo.
     */
    timeUnknown: boolean;
  };
}

/** Una página de la historia, y el cursor de la siguiente (null si no hay más). */
export interface ActivityPage {
  rows: ActivityRow[];
  hasMore: boolean;
  /** Dónde sigue: se pasa como `before` para traer las anteriores. */
  nextCursor: string | null;
}

/**
 * El cursor de la línea de tiempo: (occurred_at, id) de la última fila
 * de una página, en un texto opaco para la web. Con el id de desempate,
 * dos actividades del mismo instante no se saltan ni se repiten.
 */
function encodeCursor(occurredAt: string, id: string): string {
  return `${occurredAt}_${id}`;
}

function decodeCursor(cursor: string): { at: string; id: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z)_([0-9a-f-]{36})$/i.exec(cursor);
  if (!m || !m[1] || !m[2] || !isUuid(m[2]) || Number.isNaN(Date.parse(m[1]))) return null;
  return { at: m[1], id: m[2] };
}

/** El nombre de una empresa del CRM de este espacio, o null si no está en él. */
export async function getCompanyName(tx: WorkspaceTx, companyId: string): Promise<string | null> {
  if (!isUuid(companyId)) return null;
  const { rows } = await tx.query<{ name: string }>(
    'SELECT co.name FROM company co JOIN company_link l ON l.company_id = co.id WHERE co.id = $1',
    [companyId],
  );
  return rows[0]?.name ?? null;
}

/**
 * La historia de una empresa, la más reciente primero: lo que se registró
 * a mano (notas, llamadas, correos, reuniones) y lo que dejó el producto
 * (una señal aceptada, un cambio de etapa, una cotización). Se lee por
 * páginas: `before` es el `nextCursor` de la página anterior y trae las
 * que van detrás. Un cursor que no se entiende devuelve una página vacía,
 * no la primera otra vez.
 */
export async function listCompanyActivity(
  tx: WorkspaceTx,
  companyId: string,
  opts: { limit?: number; before?: string | null } = {},
): Promise<ActivityPage> {
  const vacia: ActivityPage = { rows: [], hasMore: false, nextCursor: null };
  if (!isUuid(companyId)) return vacia;
  const top = Math.max(1, Math.min(opts.limit ?? TIMELINE_LIMIT, 200));
  const cursor = opts.before ? decodeCursor(opts.before) : null;
  if (opts.before && !cursor) return vacia;
  // El instante del cursor va con microsegundos, como lo guarda Postgres:
  // si se truncara al segundo, la actividad del límite se repetiría.
  const { rows } = await tx.query<{
    id: string; kind: ActivityKind; subject: string | null; body: string | null; occurred_at: string; cursor_at: string;
    deal_id: string | null; deal_name: string | null; contact_name: string | null; user_name: string | null;
    lost_reason: string | null; quote_number: string | null; duration_min: string | null; time_unknown: boolean;
  }>(
    `SELECT a.id, a.kind, a.subject, a.body, ${iso('a.occurred_at')} AS occurred_at,
            to_char(a.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
            a.deal_id, d.name AS deal_name,
            coalesce(nullif(btrim(c.full_name), ''), c.email::text) AS contact_name,
            coalesce(nullif(btrim(u.name), ''), u.email::text) AS user_name,
            a.metadata->>'lost_reason' AS lost_reason,
            coalesce(a.metadata->>'quoteNumber', a.metadata->>'quote_number') AS quote_number,
            CASE WHEN jsonb_typeof(a.metadata->'duration_min') = 'number' THEN a.metadata->>'duration_min' END AS duration_min,
            coalesce(a.metadata->'time_unknown' = 'true'::jsonb, false) AS time_unknown
       FROM activity a
       LEFT JOIN deal d ON d.id = a.deal_id
       LEFT JOIN contact c ON c.id = a.contact_id
       LEFT JOIN app_user u ON u.id = a.user_id
      WHERE a.company_id = $1
        AND ($3::timestamptz IS NULL OR (a.occurred_at, a.id) < ($3::timestamptz, $4::uuid))
      ORDER BY a.occurred_at DESC, a.id DESC
      LIMIT $2`,
    [companyId, top + 1, cursor?.at ?? null, cursor?.id ?? null],
  );
  const page = rows.slice(0, top);
  const last = page[page.length - 1];
  const hasMore = rows.length > top;
  return {
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last.cursor_at, last.id) : null,
    rows: page.map((r) => ({
      id: r.id,
      kind: r.kind,
      subject: r.subject,
      body: r.body,
      occurredAt: r.occurred_at,
      dealId: r.deal_id,
      dealName: r.deal_name,
      contactName: r.contact_name,
      userName: r.user_name,
      meta: {
        lostReason: r.lost_reason,
        quoteNumber: r.quote_number,
        durationMin: r.duration_min === null ? null : Math.round(Number(r.duration_min)),
        timeUnknown: r.time_unknown,
      },
    })),
  };
}

export interface LogActivityInput {
  companyId: string;
  kind: LoggableActivityKind;
  /** Qué pasó. Obligatorio en una nota; en una llamada, un correo o una reunión puede ir vacío. */
  body?: string | null;
  /** El negocio del que se habló. Sin él, una llamada cuenta como contacto para todos los abiertos de la empresa. */
  dealId?: string | null;
  contactId?: string | null;
  /**
   * El día en que pasó, en la zona del espacio. Vacío o hoy: ahora mismo.
   * Un día anterior: a mediodía de ese día, con metadata.time_unknown
   * para que la línea de tiempo no pinte esa hora. Uno futuro no se acepta.
   */
  occurredOn?: string | null;
}

export interface LogActivityResult {
  activityId: string;
  /** Los negocios cuyo last_contact_at se movió (vacío en una nota). */
  touchedDealIds: string[];
}

/**
 * Registra una actividad desde la ficha (VEN-5). Una llamada, un correo o
 * una reunión es hablar con la marca y mueve `deal.last_contact_at` —del
 * negocio elegido o, si no se eligió, de todos los abiertos de la
 * empresa— al instante de la actividad, sin retrocederlo nunca (una
 * llamada de la semana pasada no borra un correo de ayer).
 */
export async function logActivity(tx: WorkspaceTx, input: LogActivityInput): Promise<LogActivityResult> {
  if (!isUuid(input.companyId)) throw new CompanyNotFound();
  if (!LOGGABLE_ACTIVITY_KINDS.includes(input.kind)) throw new FichaError('InvalidActivityKind');
  const body = input.body?.trim() || null;
  if (body !== null && body.length > ACTIVITY_BODY_MAX) throw new FichaError('InvalidActivityBody');
  if (input.kind === 'note' && body === null) throw new FichaError('InvalidActivityBody');
  const occurredOn = input.occurredOn?.trim() || null;
  if (occurredOn !== null && (!ISO_DATE_RE.test(occurredOn) || Number.isNaN(Date.parse(`${occurredOn}T00:00:00Z`)))) {
    throw new FichaError('InvalidActivityDate');
  }
  const dealId = input.dealId || null;
  const contactId = input.contactId || null;
  if (dealId !== null && !isUuid(dealId)) throw new FichaError('DealNotInCompany');
  if (contactId !== null && !isUuid(contactId)) throw new FichaError('ContactNotInCompany');

  const linked = await tx.query('SELECT 1 FROM company_link WHERE company_id = $1', [input.companyId]);
  if (linked.rows.length === 0) throw new CompanyNotFound();
  if (dealId !== null) {
    const d = await tx.query('SELECT 1 FROM deal WHERE id = $1 AND company_id = $2', [dealId, input.companyId]);
    if (d.rows.length === 0) throw new FichaError('DealNotInCompany');
  }
  if (contactId !== null) {
    const c = await tx.query<{ opted_out: boolean }>(
      'SELECT opted_out FROM contact WHERE id = $1 AND company_id = $2',
      [contactId, input.companyId],
    );
    const contacto = c.rows[0];
    if (!contacto) throw new FichaError('ContactNotInCompany');
    // Quien pidió la baja no recibe llamadas, correos ni reuniones: una
    // actividad así no se registra, aunque la pantalla ya lo esconda (un
    // POST armado a mano llega igual). Una nota sobre esa persona sí.
    if (contacto.opted_out && CONTACT_ACTIVITY_KINDS.includes(input.kind)) throw new FichaError('ContactOptedOut');
  }

  // El instante: ahora si es hoy (o no se dijo); mediodía local de un día
  // anterior, marcado como «sin hora»; y un día futuro, nada.
  const when = await tx.query<{ occurred_at: string | null; future: boolean; time_unknown: boolean }>(
    `SELECT CASE
              WHEN $1::date IS NULL OR $1::date = (now() AT TIME ZONE w.tz)::date THEN now()
              WHEN $1::date < (now() AT TIME ZONE w.tz)::date THEN ($1::date + time '12:00') AT TIME ZONE w.tz
            END AS occurred_at,
            coalesce($1::date > (now() AT TIME ZONE w.tz)::date, false) AS future,
            coalesce($1::date < (now() AT TIME ZONE w.tz)::date, false) AS time_unknown
       FROM ${WORKSPACE_TZ} w`,
    [occurredOn],
  );
  const w = when.rows[0];
  if (!w || w.future || w.occurred_at === null) throw new FichaError('InvalidActivityDate');

  const inserted = await tx.query<{ id: string; occurred_at: string }>(
    `INSERT INTO activity (workspace_id, company_id, deal_id, contact_id, user_id, kind, body, occurred_at, metadata)
     VALUES (current_workspace_id(), $1, $2, $3, current_user_id(), $4, $5, $6::timestamptz,
             CASE WHEN $7::boolean THEN jsonb_build_object('time_unknown', true) ELSE '{}'::jsonb END)
     RETURNING id, occurred_at`,
    [input.companyId, dealId, contactId, input.kind, body, w.occurred_at, w.time_unknown],
  );
  const activityId = inserted.rows[0]?.id;
  if (!activityId) throw new FichaError('InvalidActivityKind');

  let touchedDealIds: string[] = [];
  if (CONTACT_ACTIVITY_KINDS.includes(input.kind)) {
    const touched = await tx.query<{ id: string }>(
      `UPDATE deal d
          SET last_contact_at = greatest(coalesce(d.last_contact_at, $3::timestamptz), $3::timestamptz),
              updated_at = now()
         FROM pipeline_stage st
        WHERE st.id = d.stage_id
          AND d.company_id = $1
          AND (d.id = $2::uuid OR ($2::uuid IS NULL AND NOT st.is_won AND NOT st.is_lost))
        RETURNING d.id`,
      [input.companyId, dealId, w.occurred_at],
    );
    touchedDealIds = touched.rows.map((r) => r.id);
  }
  return { activityId, touchedDealIds };
}

// ---------------------------------------------------------------------
// VEN-5 · Lo que sabemos
// ---------------------------------------------------------------------

export interface CompanySignalRow {
  id: string;
  headline: string;
  sourceLabel: string;
  detectedAt: string;
  evidenceUrl: string | null;
  status: 'pending' | 'accepted' | 'discarded' | 'expired' | 'duplicate';
  fitScore: string | null;
  budgetEstimate: string | null;
  budgetCurrency: string | null;
  discardReason: string | null;
}

/**
 * Las señales de esta empresa en este espacio, la más reciente primero:
 * lo que el radar (o la persona) vio de ella, también lo descartado,
 * porque «por qué no» también es algo que sabemos.
 */
export async function listCompanySignals(tx: WorkspaceTx, companyId: string): Promise<CompanySignalRow[]> {
  if (!isUuid(companyId)) return [];
  const { rows } = await tx.query<{
    id: string; headline_es: string; label_es: string; detected_at: string; evidence_url: string | null;
    status: CompanySignalRow['status']; fit_score: string | null; budget_estimate: string | null;
    budget_currency: string | null; discard_reason: string | null;
  }>(
    `SELECT s.id, s.headline_es, src.label_es, ${iso('s.detected_at')} AS detected_at, s.evidence_url, s.status,
            s.fit_score::text AS fit_score, s.budget_estimate::text AS budget_estimate,
            s.budget_currency::text AS budget_currency, s.discard_reason
       FROM signal s
       JOIN signal_source src ON src.id = s.source_id
      WHERE s.company_id = $1
      ORDER BY s.detected_at DESC
      LIMIT 50`,
    [companyId],
  );
  return rows.map((r) => ({
    id: r.id,
    headline: r.headline_es,
    sourceLabel: r.label_es,
    detectedAt: r.detected_at,
    evidenceUrl: r.evidence_url,
    status: r.status,
    fitScore: r.fit_score,
    budgetEstimate: r.budget_estimate,
    budgetCurrency: r.budget_currency,
    discardReason: r.discard_reason,
  }));
}

/** El nombre de cada nicho de la empresa, en los dos idiomas que guarda el catálogo. */
export async function listNicheNames(tx: WorkspaceTx, slugs: readonly string[]): Promise<{ slug: string; nameEs: string; nameEn: string | null }[]> {
  if (slugs.length === 0) return [];
  const { rows } = await tx.query<{ slug: string; name_es: string; name_en: string | null }>(
    'SELECT slug, name_es, name_en FROM niche WHERE slug = ANY($1::text[]) ORDER BY name_es',
    [[...slugs]],
  );
  return rows.map((r) => ({ slug: r.slug, nameEs: r.name_es, nameEn: r.name_en }));
}

// ---------------------------------------------------------------------
// VEN-5 · La cadena negocio → cotización → campaña → factura
// ---------------------------------------------------------------------

export interface ChainQuote {
  id: string;
  number: string;
  status: string;
  supersededById: string | null;
  total: string;
  currency: string;
}

export interface ChainCampaign {
  id: string;
  name: string;
  status: string;
  quoteId: string | null;
}

export interface ChainInvoice {
  id: string;
  number: string;
  campaignId: string | null;
  quoteId: string | null;
}

export interface ChainLinks {
  quotes: ChainQuote[];
  campaigns: ChainCampaign[];
  invoices: ChainInvoice[];
}

export interface CompanyChain {
  /** Lo de cada negocio de la empresa, por id de negocio. Un negocio sin nada no aparece. */
  byDeal: Record<string, ChainLinks>;
  /** Lo que no cuelga de ningún negocio (una factura suelta, una campaña creada a mano). */
  loose: ChainLinks;
}

/**
 * Lo que existe de cada negocio de la empresa, hacia adelante: sus
 * cotizaciones, las campañas que salieron de ellas (o del negocio) y las
 * facturas de esas campañas o cotizaciones. Una campaña cuelga del
 * negocio por su deal_id o por el de su cotización; una factura, por su
 * campaña o por su cotización. Solo enlaza: los montos y estados que la
 * pantalla pinta de una factura los da Finanzas (listInvoices).
 */
export async function getCompanyChain(tx: WorkspaceTx, companyId: string): Promise<CompanyChain> {
  const empty = (): ChainLinks => ({ quotes: [], campaigns: [], invoices: [] });
  if (!isUuid(companyId)) return { byDeal: {}, loose: empty() };

  const quotes = await tx.query<{
    id: string; deal_id: string | null; number: string; status: string; superseded_by: string | null;
    total: string; currency: string;
  }>(
    `SELECT id, deal_id, number, status, superseded_by, total::text AS total, currency::text AS currency
       FROM quote WHERE company_id = $1
      ORDER BY created_at ASC, number ASC`,
    [companyId],
  );
  const campaigns = await tx.query<{ id: string; deal_id: string | null; quote_id: string | null; name: string; status: string }>(
    `SELECT id, deal_id, quote_id, name, status FROM campaign WHERE company_id = $1 ORDER BY created_at ASC`,
    [companyId],
  );
  const invoices = await tx.query<{ id: string; number: string; campaign_id: string | null; quote_id: string | null }>(
    `SELECT id, number, campaign_id, quote_id FROM invoice WHERE company_id = $1 ORDER BY issued_on ASC, number ASC`,
    [companyId],
  );

  const byDeal: Record<string, ChainLinks> = {};
  const loose = empty();
  const bucket = (dealId: string | null | undefined): ChainLinks => {
    if (!dealId) return loose;
    return (byDeal[dealId] ??= empty());
  };
  const quoteDeal = new Map(quotes.rows.map((q) => [q.id, q.deal_id]));
  const campaignDeal = new Map<string, string | null>();

  for (const q of quotes.rows) {
    bucket(q.deal_id).quotes.push({
      id: q.id, number: q.number, status: q.status, supersededById: q.superseded_by, total: q.total, currency: q.currency,
    });
  }
  for (const c of campaigns.rows) {
    const dealId = c.deal_id ?? (c.quote_id ? quoteDeal.get(c.quote_id) ?? null : null);
    campaignDeal.set(c.id, dealId);
    bucket(dealId).campaigns.push({ id: c.id, name: c.name, status: c.status, quoteId: c.quote_id });
  }
  for (const i of invoices.rows) {
    const dealId =
      (i.campaign_id ? campaignDeal.get(i.campaign_id) ?? null : null) ??
      (i.quote_id ? quoteDeal.get(i.quote_id) ?? null : null);
    bucket(dealId).invoices.push({ id: i.id, number: i.number, campaignId: i.campaign_id, quoteId: i.quote_id });
  }
  return { byDeal, loose };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
