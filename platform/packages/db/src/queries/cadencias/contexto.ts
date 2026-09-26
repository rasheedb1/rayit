/**
 * Cadencias · a quién se le escribe y con qué (VEN-13): las personas de
 * una marca con sus direcciones, por qué canales se les llega de verdad,
 * el creador del negocio y su brief, y todo lo que el recomendador de
 * @mc/core necesita para proponer desde una señal.
 *
 * «Llega» es lo mismo en la propuesta, en «Enrolar desde un negocio» y en
 * «Activar»: hay un paso de mensaje (DISPATCHABLE_STEP_TYPES) por un canal
 * que la política del espacio deja (allowed_channels), con una cuenta
 * conectada (aunque esté por reconectar) y en el que la persona tiene
 * dirección. Un comentario o una reacción públicos no cuentan: no le
 * escriben a nadie. Quien no llega no entra: se quedaría «dentro» sin
 * que le saliera un solo mensaje.
 */
import {
  DISPATCHABLE_STEP_TYPES, RECOMMEND_CHANNELS, signalKindOfSource, type ChannelState, type ProposalNote, type RecommendChannel,
  type RecommendSignalKind,
} from '@mc/core';
import type { WorkspaceTx } from '../../client.ts';
import { isUuid } from '../../client.ts';
import { briefDeliverableKinds } from '../brief.ts';
import { assertId, CadenciaError, LIVE_ENROLLMENT_STATUSES } from './comun.ts';
import { listSequenceTemplates, type TemplateRow } from './lista.ts';

// ---------------------------------------------------------------------
// Las personas y sus direcciones
// ---------------------------------------------------------------------

export interface ContactOption {
  id: string;
  name: string | null;
  roleTitle: string | null;
  hasEmail: boolean;
  hasLinkedin: boolean;
  hasInstagram: boolean;
  /** Dado de baja (la ficha, la lista global o este espacio): no se le propone ni se le enrola. */
  optedOut: boolean;
  /**
   * El nombre de OTRA cadencia del espacio en la que la persona sigue viva
   * (activa, en pausa o en enfriamiento), o null. Mientras lo esté no se
   * la enrola en otra: dos cadencias a la vez duplican los mensajes.
   */
  liveElsewhere: string | null;
  /**
   * Los canales por los que se le llega hoy (ver el encabezado): los que
   * el espacio puede usar y en los que tiene dirección. En «Enrolar desde
   * un negocio», además, solo los que la cadencia usa para escribir.
   */
  reachChannels: RecommendChannel[];
}

/**
 * Si la persona `c` está de baja: la ficha, la lista global de
 * direcciones, un enrolamiento que terminó en baja o el enlace de baja de
 * un correo de este espacio (outbound_workspace_optout, la que el
 * disparador de 0055 hace cumplir al enrolar). Una sola expresión para la
 * etiqueta de la pantalla y para la comprobación de «Activar» y «Enrolar».
 */
const OPTED_OUT_EXPR = (ws: string) => `(c.opted_out OR address_is_suppressed(c.email)
              OR EXISTS (SELECT 1 FROM outbound_enrollment e WHERE e.contact_id = c.id AND e.status = 'opted_out')
              OR EXISTS (SELECT 1 FROM outbound_workspace_optout o
                          WHERE o.workspace_id = ${ws} AND o.email = c.email))`;

/**
 * Las columnas de una persona para elegirla: qué direcciones tiene, si
 * está de baja y en qué otra cadencia sigue viva. `ws` es el espacio de
 * la transacción (lo pone quien llama, nunca la pantalla); `except`, la
 * cadencia que no cuenta como «otra» (o NULL). Una sola definición para
 * la propuesta y para enrolar.
 */
const CONTACT_OPTION_COLUMNS = (ws: string, except: string, live: string) => `c.id, c.full_name, c.role_title,
            (c.email IS NOT NULL AND NOT c.email_invalid) AS has_email,
            (c.linkedin_url IS NOT NULL AND c.linkedin_url <> '') AS has_linkedin,
            (c.instagram_handle IS NOT NULL AND c.instagram_handle <> '') AS has_instagram,
            ${OPTED_OUT_EXPR(ws)} AS opted_out,
            (SELECT s.name FROM outbound_enrollment e JOIN outbound_sequence s ON s.id = e.sequence_id
              WHERE e.contact_id = c.id AND e.sequence_id IS DISTINCT FROM ${except} AND e.status = ANY(${live})
              ORDER BY e.started_at DESC, s.id LIMIT 1) AS live_elsewhere`;

interface ContactOptionRow {
  id: string; full_name: string | null; role_title: string | null; has_email: boolean; has_linkedin: boolean;
  has_instagram: boolean; opted_out: boolean; live_elsewhere: string | null;
}

/** Los canales de `channels` en los que la persona tiene dirección. */
export function reachOf(c: Pick<ContactOption, 'hasEmail' | 'hasLinkedin' | 'hasInstagram'>, channels: readonly string[]): RecommendChannel[] {
  return RECOMMEND_CHANNELS.filter(
    (ch) => channels.includes(ch) && (ch === 'email' ? c.hasEmail : ch === 'linkedin' ? c.hasLinkedin : c.hasInstagram),
  );
}

const toContactOption = (r: ContactOptionRow, channels: readonly string[]): ContactOption => {
  const base = { hasEmail: r.has_email, hasLinkedin: r.has_linkedin, hasInstagram: r.has_instagram };
  return {
    id: r.id, name: r.full_name, roleTitle: r.role_title, ...base, optedOut: r.opted_out, liveElsewhere: r.live_elsewhere,
    reachChannels: reachOf(base, channels),
  };
};

// ---------------------------------------------------------------------
// Canales y política
// ---------------------------------------------------------------------

/** El estado de cada canal: conectado si alguna cuenta lo está; caído si solo hay cuentas por reconectar. */
export async function channelStates(tx: WorkspaceTx): Promise<Record<RecommendChannel, ChannelState>> {
  const { rows } = await tx.query<{ channel: string; connected: boolean; down: boolean }>(
    `SELECT channel, bool_or(status = 'connected') AS connected, bool_or(status IN ('needs_reconnect', 'error')) AS down
       FROM outreach_channel_account GROUP BY channel`,
  );
  const out = Object.fromEntries(RECOMMEND_CHANNELS.map((c) => [c, 'missing'])) as Record<RecommendChannel, ChannelState>;
  for (const r of rows) {
    if (!(RECOMMEND_CHANNELS as readonly string[]).includes(r.channel)) continue;
    out[r.channel as RecommendChannel] = r.connected ? 'connected' : r.down ? 'down' : 'missing';
  }
  return out;
}

interface PolicyRow { allowed: string[]; max_touches: number; min_days: number }

/** outbound_policy del espacio; sin fila, sus valores por defecto (0007 y 0054). */
async function readPolicy(tx: WorkspaceTx): Promise<PolicyRow> {
  return (
    await tx.query<PolicyRow>(
      `SELECT coalesce(p.allowed_channels, '{email,linkedin}'::text[]) AS allowed,
              coalesce(p.max_touches_per_company, 4) AS max_touches, coalesce(p.min_days_between_touches, 3) AS min_days
         FROM (SELECT 1) AS uno LEFT JOIN outbound_policy p ON p.workspace_id = $1::uuid`,
      [tx.workspaceId],
    )
  ).rows[0]!;
}

/** Los canales que el espacio puede usar hoy: la política los deja y hay una cuenta (aunque esté por reconectar). */
export function usableChannels(allowed: readonly string[], states: Readonly<Record<RecommendChannel, ChannelState>>): RecommendChannel[] {
  return RECOMMEND_CHANNELS.filter((c) => allowed.includes(c) && states[c] !== 'missing');
}

/**
 * Los canales por los que la cadencia `sequenceId` le escribe a alguien
 * hoy: los de sus pasos de mensaje que el espacio puede usar. Sin
 * cadencia, todos los que el espacio puede usar.
 */
async function sendChannels(tx: WorkspaceTx, sequenceId: string | null): Promise<RecommendChannel[]> {
  const usable = usableChannels((await readPolicy(tx)).allowed, await channelStates(tx));
  if (sequenceId === null) return usable;
  const { rows } = await tx.query<{ channel: string }>(
    `SELECT DISTINCT channel FROM outbound_step WHERE sequence_id = $1::uuid AND step_type = ANY($2::text[])`,
    [sequenceId, [...DISPATCHABLE_STEP_TYPES]],
  );
  return usable.filter((c) => rows.some((r) => r.channel === c));
}

// ---------------------------------------------------------------------
// Las personas de una marca
// ---------------------------------------------------------------------

/** Las personas de una empresa que este espacio ve, con sus direcciones y por dónde se les llega. */
async function companyContacts(tx: WorkspaceTx, companyId: string, channels: readonly string[]): Promise<ContactOption[]> {
  const { rows } = await tx.query<ContactOptionRow>(
    `SELECT ${CONTACT_OPTION_COLUMNS('$2::uuid', 'NULL::uuid', '$3::text[]')}
       FROM contact c
      WHERE c.company_id = $1::uuid AND contact_visible_to(c.id, $2::uuid)
      ORDER BY c.full_name NULLS LAST, c.id`,
    [companyId, tx.workspaceId, [...LIVE_ENROLLMENT_STATUSES]],
  );
  return rows.map((r) => toContactOption(r, channels));
}

/**
 * Las personas de la marca de una señal (con sus direcciones), para
 * elegir a quién se le propone en un borrador. No el contexto entero del
 * recomendador. Una señal sin empresa, o que este espacio no ve, no tiene
 * a nadie.
 */
export async function signalContacts(tx: WorkspaceTx, signalId: string): Promise<ContactOption[]> {
  assertId('signalContacts', signalId);
  const sg = (await tx.query<{ company_id: string | null }>(`SELECT company_id FROM signal WHERE id = $1::uuid`, [signalId])).rows[0];
  return sg?.company_id ? companyContacts(tx, sg.company_id, await sendChannels(tx, null)) : [];
}

/**
 * La persona a la que se le propone por defecto: la que no está de baja
 * ni viva en otra cadencia (Activar no la enrolaría) y llega por más
 * canales; a igualdad, la primera por nombre. Si nadie sirve, null: se
 * propone sin persona y la nota lo dice.
 */
export function defaultContact(contacts: readonly ContactOption[]): ContactOption | null {
  let best: ContactOption | null = null;
  for (const c of contacts) {
    if (c.optedOut || c.liveElsewhere !== null || c.reachChannels.length === 0) continue;
    if (!best || c.reachChannels.length > best.reachChannels.length) best = c;
  }
  return best;
}

/** Los ángulos que valen en este espacio: el suyo si lo editó, si no el global (misma clave). */
export async function listAngles(tx: WorkspaceTx): Promise<Array<{ key: string; label: string; forbidden: string[]; position: number }>> {
  const { rows } = await tx.query<{ key: string; label_es: string; forbidden_es: string[]; position: number }>(
    `SELECT DISTINCT ON (key) key, label_es, forbidden_es, position
       FROM outbound_angle ORDER BY key, workspace_id NULLS LAST`,
  );
  return rows.map((r) => ({ key: r.key, label: r.label_es, forbidden: r.forbidden_es, position: r.position })).sort(
    (a, b) => a.position - b.position || a.key.localeCompare(b.key),
  );
}

// ---------------------------------------------------------------------
// El contexto del recomendador
// ---------------------------------------------------------------------

export interface RecommendationContext {
  signal: { id: string; headline: string; kind: RecommendSignalKind; companyId: string | null; companyName: string | null };
  deal: { id: string; name: string } | null;
  /** El creador para el que se propone: el del negocio o, si el negocio no tiene, el único del espacio. */
  creator: { id: string; name: string } | null;
  contacts: ContactOption[];
  channels: Record<RecommendChannel, ChannelState>;
  allowedChannels: string[];
  /** outbound_policy del espacio (o sus valores por defecto de 0007): el recomendador propone dentro de ella. */
  policy: { maxTouchesPerCompany: number; minDaysBetweenTouches: number };
  /** Los nichos de ESE creador (nunca los de otro del mismo espacio). */
  nicheSlugs: string[];
  /**
   * El brief activo de ESE creador. Los formatos que ofrece y su ventana
   * de disponibilidad (AAAA-MM-DD) van al redactor de la guía: la guía no
   * propone otro formato ni fechas fuera de la ventana (VEN-7 r4).
   */
  brief: {
    id: string;
    title: string;
    notes: string | null;
    requiresDisclosure: boolean;
    deliverables: string[];
    availabilityFrom: string | null;
    availabilityTo: string | null;
  } | null;
  /** Lo que el contexto ya explica antes de proponer: `no_creator`. */
  notes: ProposalNote[];
  templates: TemplateRow[];
  angles: Record<string, { label: string; forbidden: string[] }>;
}

/**
 * Todo lo que el recomendador necesita para proponer desde una señal.
 *
 * El nicho y el brief son los del creador del negocio abierto de la
 * señal: en un espacio de agencia con varios creadores, los de otro
 * elegirían la plantilla de otro nicho, le aplicarían su divulgación y le
 * mandarían al modelo las notas del brief de otra persona. Si el negocio
 * no tiene creador, vale el del espacio solo cuando hay uno; con varios,
 * sin nicho ni brief y con la nota `no_creator`, para que la pantalla
 * pida asignarlo en el negocio.
 */
export async function getRecommendationContext(tx: WorkspaceTx, signalId: string): Promise<RecommendationContext> {
  assertId('getRecommendationContext', signalId);
  const sg = (
    await tx.query<{ id: string; headline: string; source_kind: string; company_id: string | null; company_name: string | null }>(
      `SELECT sg.id, sg.headline_es AS headline, src.kind AS source_kind, sg.company_id, co.name AS company_name
         FROM signal sg JOIN signal_source src ON src.id = sg.source_id
         LEFT JOIN company co ON co.id = sg.company_id
        WHERE sg.id = $1::uuid`,
      [signalId],
    )
  ).rows[0];
  if (!sg) throw new CadenciaError('no_signal', `La señal ${signalId} no existe o no es de este espacio.`);

  // Solo un negocio abierto: una propuesta nunca guarda un negocio ganado o perdido (Activar lo enrolaría ahí).
  const deal = (
    await tx.query<{ id: string; name: string; creator_id: string | null }>(
      `SELECT d.id, d.name, d.creator_id FROM deal d JOIN pipeline_stage st ON st.id = d.stage_id
        WHERE d.origin_signal_id = $1::uuid AND NOT st.is_won AND NOT st.is_lost
        ORDER BY d.updated_at DESC, d.id LIMIT 1`,
      [signalId],
    )
  ).rows[0];

  const creators = (
    await tx.query<{ id: string; display_name: string; niche_slugs: string[] }>(
      `SELECT id, display_name, niche_slugs FROM creator_profile WHERE deleted_at IS NULL ORDER BY created_at, id`,
    )
  ).rows;
  const creator = deal?.creator_id
    ? (creators.find((c) => c.id === deal.creator_id) ?? null)
    : creators.length === 1 ? creators[0]! : null;
  const notes: ProposalNote[] = !creator && creators.length > 1 ? [{ code: 'no_creator' }] : [];
  const brief = creator
    ? (
        await tx.query<{
          id: string; title: string; notes: string | null; requires_disclosure: boolean;
          deliverables: unknown; availability_from: string | null; availability_to: string | null;
        }>(
          `SELECT id, title, notes, requires_disclosure, deliverables,
                  availability_from::text AS availability_from, availability_to::text AS availability_to
             FROM outbound_brief
            WHERE status = 'active' AND creator_id = $1::uuid ORDER BY updated_at DESC, id LIMIT 1`,
          [creator.id],
        )
      ).rows[0]
    : undefined;

  const policy = await readPolicy(tx);
  const channels = await channelStates(tx);
  const angles = await listAngles(tx);
  return {
    signal: {
      id: sg.id, headline: sg.headline, kind: signalKindOfSource(sg.source_kind), companyId: sg.company_id,
      companyName: sg.company_name,
    },
    deal: deal ? { id: deal.id, name: deal.name } : null,
    creator: creator ? { id: creator.id, name: creator.display_name } : null,
    contacts: sg.company_id ? await companyContacts(tx, sg.company_id, usableChannels(policy.allowed, channels)) : [],
    channels,
    allowedChannels: policy.allowed,
    policy: { maxTouchesPerCompany: policy.max_touches, minDaysBetweenTouches: policy.min_days },
    nicheSlugs: creator ? [...new Set(creator.niche_slugs)] : [],
    brief: brief
      ? {
          id: brief.id, title: brief.title, notes: brief.notes, requiresDisclosure: brief.requires_disclosure,
          deliverables: briefDeliverableKinds(brief.deliverables),
          availabilityFrom: brief.availability_from, availabilityTo: brief.availability_to,
        }
      : null,
    notes,
    templates: await listSequenceTemplates(tx),
    angles: Object.fromEntries(angles.map((a) => [a.key, { label: a.label, forbidden: a.forbidden }])),
  };
}

// ---------------------------------------------------------------------
// Enrolar
// ---------------------------------------------------------------------

export interface EnrollableContact extends ContactOption {
  /** Ya tiene un enrolamiento en esta cadencia (sea cual sea su estado): no se vuelve a enrolar. */
  enrolled: boolean;
  /** Le llega al menos un mensaje de ESTA cadencia (reachChannels no está vacío). */
  reachable: boolean;
}

export interface EnrollableDeal {
  id: string;
  name: string;
  companyName: string;
  contacts: EnrollableContact[];
}

/**
 * Los negocios abiertos con sus personas, para enrolar desde la
 * cadencia `sequenceId`. Una consulta para todos: cada negocio con las
 * personas de su empresa que este espacio ve (un negocio sin personas
 * sale igual, con la lista vacía). `reachChannels` de cada persona son
 * los canales de esta cadencia por los que de verdad se le escribe.
 */
export async function listEnrollableDeals(tx: WorkspaceTx, sequenceId: string | null = null): Promise<EnrollableDeal[]> {
  if (sequenceId !== null) assertId('listEnrollableDeals', sequenceId);
  const channels = await sendChannels(tx, sequenceId);
  const { rows } = await tx.query<
    { deal_id: string; deal_name: string; company_name: string } & ({ id: null } | (ContactOptionRow & { enrolled: boolean }))
  >(
    `SELECT d.id AS deal_id, d.name AS deal_name, co.name AS company_name, p.*
       FROM deal d
       JOIN pipeline_stage st ON st.id = d.stage_id
       JOIN company co ON co.id = d.company_id
       LEFT JOIN LATERAL (
         SELECT ${CONTACT_OPTION_COLUMNS('$1::uuid', '$2::uuid', '$3::text[]')},
                EXISTS (SELECT 1 FROM outbound_enrollment e WHERE e.contact_id = c.id AND e.sequence_id = $2::uuid) AS enrolled
           FROM contact c
          WHERE c.company_id = d.company_id AND contact_visible_to(c.id, $1::uuid)
       ) p ON true
      WHERE NOT st.is_won AND NOT st.is_lost
      ORDER BY co.name, d.updated_at DESC, d.id, p.full_name NULLS LAST, p.id`,
    [tx.workspaceId, sequenceId, [...LIVE_ENROLLMENT_STATUSES]],
  );
  const out: EnrollableDeal[] = [];
  for (const r of rows) {
    let deal = out.at(-1);
    if (!deal || deal.id !== r.deal_id) {
      deal = { id: r.deal_id, name: r.deal_name, companyName: r.company_name, contacts: [] };
      out.push(deal);
    }
    if (r.id === null) continue;
    const c = toContactOption(r, channels);
    deal.contacts.push({ ...c, enrolled: r.enrolled, reachable: c.reachChannels.length > 0 });
  }
  return out;
}

/**
 * Por qué canales de la cadencia `sequenceId` se le escribe a cada una
 * de `contactIds` (la misma regla que listEnrollableDeals). La que no
 * está en el mapa, o tiene la lista vacía, no llega: «Enrolar» y
 * «Activar» la dejan fuera y lo dicen, aunque el formulario la mande.
 */
export async function reachForSequence(
  tx: WorkspaceTx, sequenceId: string, contactIds: readonly string[],
): Promise<Map<string, RecommendChannel[]>> {
  assertId('reachForSequence', sequenceId);
  const ids = contactIds.filter(isUuid);
  if (ids.length === 0) return new Map();
  const channels = await sendChannels(tx, sequenceId);
  const { rows } = await tx.query<{ id: string; has_email: boolean; has_linkedin: boolean; has_instagram: boolean }>(
    `SELECT c.id, (c.email IS NOT NULL AND NOT c.email_invalid) AS has_email,
            (c.linkedin_url IS NOT NULL AND c.linkedin_url <> '') AS has_linkedin,
            (c.instagram_handle IS NOT NULL AND c.instagram_handle <> '') AS has_instagram
       FROM contact c WHERE c.id = ANY($1::uuid[]) AND contact_visible_to(c.id, $2::uuid)`,
    [ids, tx.workspaceId],
  );
  return new Map(
    rows.map((r) => [r.id, reachOf({ hasEmail: r.has_email, hasLinkedin: r.has_linkedin, hasInstagram: r.has_instagram }, channels)]),
  );
}

/**
 * De `contactIds`, las que se pueden enrolar con el negocio `dealId`:
 * personas de la empresa del negocio, que este espacio ve, con el
 * negocio todavía abierto. Enrolar a alguien de otra marca bajo este
 * negocio dejaría sus toques con el deal_id equivocado.
 */
export async function enrollableContactsOfDeal(tx: WorkspaceTx, dealId: string, contactIds: readonly string[]): Promise<string[]> {
  assertId('enrollableContactsOfDeal', dealId);
  for (const id of contactIds) assertId('enrollableContactsOfDeal', id);
  const { rows } = await tx.query<{ id: string }>(
    `SELECT c.id
       FROM contact c
       JOIN deal d ON d.company_id = c.company_id
       JOIN pipeline_stage st ON st.id = d.stage_id
      WHERE d.id = $1::uuid AND c.id = ANY($2::uuid[]) AND NOT st.is_won AND NOT st.is_lost
        AND contact_visible_to(c.id, $3::uuid)`,
    [dealId, [...contactIds], tx.workspaceId],
  );
  return rows.map((r) => r.id);
}

/** El nombre de cada persona de `ids` que este espacio ve (para decir por qué no entró). */
export async function contactNames(tx: WorkspaceTx, ids: readonly string[]): Promise<Map<string, string | null>> {
  const valid = ids.filter(isUuid);
  if (valid.length === 0) return new Map();
  const { rows } = await tx.query<{ id: string; full_name: string | null }>(
    `SELECT id, full_name FROM contact WHERE id = ANY($1::uuid[]) AND contact_visible_to(id, $2::uuid)`,
    [valid, tx.workspaceId],
  );
  return new Map(rows.map((r) => [r.id, r.full_name]));
}

/**
 * De `contactIds`, las que están de baja (la misma expresión que la
 * etiqueta de la pantalla). «Activar» y «Enrolar» las dejan fuera antes de
 * llamar a enrollContacts: la baja puede llegar entre «Proponer» y
 * «Activar», o después de abrir el formulario, y el disparador de 0055
 * rechazaría el INSERT y con él la transacción entera.
 */
export async function optedOutAmong(tx: WorkspaceTx, contactIds: readonly string[]): Promise<Set<string>> {
  const ids = contactIds.filter(isUuid);
  if (ids.length === 0) return new Set();
  const { rows } = await tx.query<{ id: string }>(
    `SELECT c.id FROM contact c WHERE c.id = ANY($1::uuid[]) AND ${OPTED_OUT_EXPR('$2::uuid')}`,
    [ids, tx.workspaceId],
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * De `contactIds`, las que ya están dentro de OTRA cadencia del espacio
 * (activa, en pausa o en enfriamiento), con esa cadencia (la más reciente).
 * Dos cadencias paralelas a la misma persona de una marca duplican los
 * toques; enrollContacts solo evita el duplicado dentro de una misma
 * secuencia. Una sola consulta para todo el lote.
 */
export async function liveEnrollmentsElsewhere(
  tx: WorkspaceTx, contactIds: readonly string[], sequenceId: string,
): Promise<Map<string, { sequenceId: string; name: string }>> {
  assertId('liveEnrollmentsElsewhere', sequenceId);
  const ids = contactIds.filter(isUuid);
  if (ids.length === 0) return new Map();
  const { rows } = await tx.query<{ contact_id: string; id: string; name: string }>(
    `SELECT DISTINCT ON (e.contact_id) e.contact_id, s.id, s.name
       FROM outbound_enrollment e JOIN outbound_sequence s ON s.id = e.sequence_id
      WHERE e.contact_id = ANY($1::uuid[]) AND e.sequence_id <> $2::uuid AND e.status = ANY($3::text[])
      ORDER BY e.contact_id, e.started_at DESC, s.id`,
    [ids, sequenceId, [...LIVE_ENROLLMENT_STATUSES]],
  );
  return new Map(rows.map((r) => [r.contact_id, { sequenceId: r.id, name: r.name }]));
}

/** liveEnrollmentsElsewhere para una sola persona. */
export async function liveEnrollmentElsewhere(
  tx: WorkspaceTx, contactId: string, sequenceId: string,
): Promise<{ sequenceId: string; name: string } | null> {
  assertId('liveEnrollmentElsewhere', contactId);
  return (await liveEnrollmentsElsewhere(tx, [contactId], sequenceId)).get(contactId) ?? null;
}
