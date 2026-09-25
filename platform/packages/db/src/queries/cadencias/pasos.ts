/**
 * Cadencias · la línea de tiempo /ventas/cadencias/[id] (VEN-13): la
 * secuencia con sus pasos, y la edición de cada paso (cambiar, añadir,
 * quitar, reordenar).
 *
 * La regla de la edición (assertEditable): mientras nadie esté dentro,
 * todo se cambia. Con alguien enrolado, los toques de esa persona ya
 * existen con su día y su canal (enrollContacts los crea todos al
 * enrolar), así que lo que cambia la forma se rechaza con
 * `has_enrollments` y la pantalla ofrece duplicar. El texto (guía,
 * ángulo, plantilla, hora) sí se edita: vale para quien se enrole
 * después.
 *
 * El hilo de correo y la guía, después de cada cambio de forma
 * (normalizeSequenceThread): la misma regla que el recomendador
 * (normalizeThread de @mc/core), y la guía de un paso que cambió de tipo
 * recompuesta si no la escribió la persona (guidanceAfterRetype).
 */
import {
  checkSequenceAgainstPolicy, guidanceAfterRetype, guidanceIsStale, guidanceLocale, normalizeThread, parseSequenceProposal,
  RECOMMEND_SIGNAL_KINDS, signalKindOfSource, type GuidanceLocale, type GuidanceSource, type RecommendSignalKind,
  type SequenceProposal,
} from '@mc/core';
import type { WorkspaceTx } from '../../client.ts';
import { isUuid } from '../../client.ts';
import type { StepType } from '../../schema/outreach.ts';
import { assertId, CadenciaError, LIVE_ENROLLMENT_STATUSES, MAX_STEPS, type SequenceStatus } from './comun.ts';

export interface SequenceStep {
  id: string;
  /** 1, 2, 3…: el orden en que salen (día y orden dentro del día). */
  position: number;
  dayOffset: number;
  orderInDay: number;
  stepType: StepType;
  channel: string;
  /** 'HH:MM', hora local de la secuencia. */
  scheduledTime: string;
  angleKey: string | null;
  angleLabel: string | null;
  guidanceEs: string | null;
  /** Quién escribió la guía (null: una fila anterior a 0062). */
  guidanceSource: GuidanceSource | null;
  /**
   * La guía se escribió para otro tipo de paso (`guidanceWrittenFor`) y la
   * escribió la persona, así que no se recompuso: la tarjeta pide revisarla.
   */
  guidanceStale: boolean;
  guidanceWrittenFor: StepType | null;
  subjectTemplate: string | null;
  bodyTemplate: string | null;
  generateWithAi: boolean;
  requiresAsset: 'media_kit' | 'quote' | null;
}

export interface SequenceDetail {
  id: string;
  name: string;
  status: SequenceStatus;
  channel: string;
  automationMode: string;
  /** La zona de la secuencia o, si no tiene, la del espacio. */
  timeZone: string;
  templateName: string | null;
  signal: { id: string; headline: string; kind: RecommendSignalKind; companyId: string | null; companyName: string | null } | null;
  proposal: SequenceProposal | null;
  /** La persona para la que se propuso, si este espacio la sigue viendo. */
  proposalContact: { id: string; name: string | null } | null;
  steps: SequenceStep[];
  enrollments: { live: number; total: number; contacted: number; replied: number };
  /** Con alguien dentro, la forma de la secuencia no se cambia (ver el encabezado). */
  locked: boolean;
  /** Lo que la política del espacio no va a dejar cumplir (checkSequenceAgainstPolicy). */
  policy: { maxTouchesPerCompany: number; minDaysBetweenTouches: number; overCap: string[]; closerThanGap: string[] };
  updatedAt: string;
}

export async function readSteps(tx: WorkspaceTx, sequenceId: string): Promise<SequenceStep[]> {
  const { rows } = await tx.query<{
    id: string; day_offset: number; order_in_day: number; step_type: StepType; channel: string; scheduled_time: string;
    angle_key: string | null; angle_label: string | null; guidance_es: string | null; guidance_source: GuidanceSource | null;
    guidance_for_type: StepType | null; subject_template: string | null; body_template: string | null; generate_with_ai: boolean;
    requires_asset: 'media_kit' | 'quote' | null;
  }>(
    `SELECT st.id, st.day_offset, st.order_in_day, st.step_type, st.channel, to_char(st.scheduled_time, 'HH24:MI') AS scheduled_time,
            a.key AS angle_key, a.label_es AS angle_label, st.guidance_es, st.guidance_source, st.guidance_for_type,
            st.subject_template, st.body_template, st.generate_with_ai, st.requires_asset
       FROM outbound_step st LEFT JOIN outbound_angle a ON a.id = st.angle_id
      WHERE st.sequence_id = $1::uuid
      ORDER BY st.day_offset, st.order_in_day, st.id`,
    [sequenceId],
  );
  return rows.map((r, i) => ({
    id: r.id, position: i + 1, dayOffset: r.day_offset, orderInDay: r.order_in_day, stepType: r.step_type,
    channel: r.channel, scheduledTime: r.scheduled_time, angleKey: r.angle_key, angleLabel: r.angle_label,
    guidanceEs: r.guidance_es, guidanceSource: r.guidance_source,
    guidanceStale: guidanceIsStale({ guidance: r.guidance_es, writtenFor: r.guidance_for_type }, r.step_type),
    guidanceWrittenFor: r.guidance_for_type, subjectTemplate: r.subject_template, bodyTemplate: r.body_template,
    generateWithAi: r.generate_with_ai, requiresAsset: r.requires_asset,
  }));
}

/** El nombre de una secuencia de este espacio, o null: el layout del detalle decide el 404 con una sola fila. */
export async function sequenceNameOf(tx: WorkspaceTx, id: string): Promise<string | null> {
  if (!isUuid(id)) return null;
  const r = await tx.query<{ name: string }>(`SELECT name FROM outbound_sequence WHERE id = $1::uuid`, [id]);
  return r.rows[0]?.name ?? null;
}

/** La secuencia con sus pasos, o null si no existe en este espacio. */
export async function getSequenceDetail(tx: WorkspaceTx, id: string): Promise<SequenceDetail | null> {
  if (!isUuid(id)) return null;
  const s = (
    await tx.query<{
      id: string; name: string; status: SequenceStatus; channel: string; automation_mode: string; tz: string;
      template_name: string | null; signal_id: string | null; signal_headline: string | null; source_kind: string | null;
      company_id: string | null; company_name: string | null; proposal: unknown; updated_at: Date; max_touches: number; min_days: number;
      live: number; total: number; contacted: number; replied: number;
    }>(
      `SELECT s.id, s.name, s.status, s.channel, s.automation_mode, coalesce(s.timezone, w.timezone) AS tz,
              tpl.name_es AS template_name, sg.id AS signal_id, sg.headline_es AS signal_headline, src.kind AS source_kind,
              sg.company_id, co.name AS company_name, s.proposal, s.updated_at,
              coalesce(p.max_touches_per_company, 4) AS max_touches, coalesce(p.min_days_between_touches, 3) AS min_days,
              (SELECT count(*) FROM outbound_enrollment e WHERE e.sequence_id = s.id AND e.status = ANY($2::text[]))::int AS live,
              (SELECT count(*) FROM outbound_enrollment e WHERE e.sequence_id = s.id)::int AS total,
              (SELECT count(*) FROM outbound_enrollment e WHERE e.sequence_id = s.id
                  AND EXISTS (SELECT 1 FROM outbound_touch t WHERE t.enrollment_id = e.id AND t.status = 'sent'))::int AS contacted,
              (SELECT count(*) FROM outbound_enrollment e WHERE e.sequence_id = s.id AND e.status = 'replied')::int AS replied
         FROM outbound_sequence s
         JOIN workspace w ON w.id = s.workspace_id
         LEFT JOIN outbound_sequence_template tpl ON tpl.id = s.template_id
         LEFT JOIN signal sg ON sg.id = s.signal_id
         LEFT JOIN signal_source src ON src.id = sg.source_id
         LEFT JOIN company co ON co.id = sg.company_id
         LEFT JOIN outbound_policy p ON p.workspace_id = s.workspace_id
        WHERE s.id = $1::uuid`,
      [id, [...LIVE_ENROLLMENT_STATUSES]],
    )
  ).rows[0];
  if (!s) return null;
  const steps = await readSteps(tx, id);
  const proposal = parseSequenceProposal(s.proposal);
  const persona = proposal?.contactId && isUuid(proposal.contactId)
    ? (await tx.query<{ id: string; full_name: string | null }>(
        `SELECT id, full_name FROM contact WHERE id = $1::uuid AND contact_visible_to(id, $2::uuid)`,
        [proposal.contactId, tx.workspaceId],
      )).rows[0]
    : undefined;
  const check = checkSequenceAgainstPolicy(
    steps.map((x) => ({ id: x.id, stepType: x.stepType, dayOffset: x.dayOffset, orderInDay: x.orderInDay })),
    { maxTouchesPerCompany: s.max_touches, minDaysBetweenTouches: s.min_days },
  );
  return {
    id: s.id, name: s.name, status: s.status, channel: s.channel, automationMode: s.automation_mode, timeZone: s.tz,
    templateName: s.template_name,
    signal: s.signal_id && s.signal_headline !== null
      ? {
          id: s.signal_id, headline: s.signal_headline, kind: signalKindOfSource(s.source_kind), companyId: s.company_id,
          companyName: s.company_name,
        }
      : null,
    proposal,
    proposalContact: persona ? { id: persona.id, name: persona.full_name } : null,
    steps,
    enrollments: { live: s.live, total: s.total, contacted: s.contacted, replied: s.replied },
    locked: s.total > 0,
    policy: {
      maxTouchesPerCompany: s.max_touches, minDaysBetweenTouches: s.min_days, overCap: check.overCap,
      closerThanGap: check.closerThanGap,
    },
    updatedAt: s.updated_at.toISOString(),
  };
}

/** Los tipos de paso de una secuencia, en el orden en que salen (para contar mensajes y gestos). */
export async function stepTypesOf(tx: WorkspaceTx, sequenceId: string): Promise<string[]> {
  assertId('stepTypesOf', sequenceId);
  const { rows } = await tx.query<{ step_type: string }>(
    `SELECT step_type FROM outbound_step WHERE sequence_id = $1::uuid ORDER BY day_offset, order_in_day, id`,
    [sequenceId],
  );
  return rows.map((r) => r.step_type);
}

// ---------------------------------------------------------------------
// Escribir pasos
// ---------------------------------------------------------------------

/** Un paso por escribir: lo que sale del recomendador, de una plantilla o de otra secuencia. */
export interface StepInsert {
  dayOffset: number;
  orderInDay: number;
  stepType: string;
  channel: string;
  scheduledTime: string;
  angleKey: string | null;
  guidanceEs: string | null;
  /** Quién escribió la guía: la plantilla, las reglas o el modelo. */
  guidanceSource: Exclude<GuidanceSource, 'person'>;
  subjectTemplate?: string | null;
  bodyTemplate?: string | null;
  generateWithAi: boolean;
  requiresAsset: 'media_kit' | 'quote' | null;
}

/**
 * Escribe los pasos con el ángulo resuelto por su clave: el del espacio
 * si lo editó, si no el global (lo mismo que listAngles). La guía queda
 * con quién la escribió y para qué tipo de paso.
 */
export async function insertSteps(tx: WorkspaceTx, sequenceId: string, steps: readonly StepInsert[]): Promise<void> {
  if (steps.length > MAX_STEPS) throw new CadenciaError('too_many_steps', `Una secuencia lleva hasta ${MAX_STEPS} pasos.`);
  for (const s of steps) {
    await tx.query(
      `INSERT INTO outbound_step
         (workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time, angle_id, guidance_es,
          guidance_source, guidance_for_type, subject_template, body_template, generate_with_ai, requires_asset)
       VALUES ($1::uuid, $2::uuid, $3::int, $4::int, $5, $6, $7::time,
               (SELECT a.id FROM outbound_angle a WHERE a.key = $8 ORDER BY a.workspace_id NULLS LAST LIMIT 1),
               $9, $10, $11, $12, $13, $14::boolean, $15)`,
      [
        tx.workspaceId, sequenceId, s.dayOffset, s.orderInDay, s.stepType, s.channel, s.scheduledTime, s.angleKey,
        s.guidanceEs, s.guidanceEs === null ? null : s.guidanceSource, s.guidanceEs === null ? null : s.stepType,
        s.subjectTemplate ?? null, s.bodyTemplate ?? null, s.generateWithAi, s.requiresAsset,
      ],
    );
  }
}

// ---------------------------------------------------------------------
// El hilo de correo y la guía, después de cada cambio de forma
// ---------------------------------------------------------------------

/** Con qué se compone la guía de una secuencia: su señal, el idioma del espacio y la divulgación de su brief. */
export interface GuidanceContext {
  signalKind: RecommendSignalKind;
  locale: GuidanceLocale;
  requiresDisclosure: boolean;
}

export async function guidanceContextOf(tx: WorkspaceTx, sequenceId: string): Promise<GuidanceContext> {
  const r = (
    await tx.query<{ locale: string; proposal_kind: string | null; source_kind: string | null; disclosure: boolean }>(
      `SELECT w.locale, s.proposal->>'signalKind' AS proposal_kind, src.kind AS source_kind,
              coalesce(b.requires_disclosure, false) AS disclosure
         FROM outbound_sequence s
         JOIN workspace w ON w.id = s.workspace_id
         LEFT JOIN signal sg ON sg.id = s.signal_id
         LEFT JOIN signal_source src ON src.id = sg.source_id
         LEFT JOIN outbound_brief b ON b.id = s.brief_id
        WHERE s.id = $1::uuid`,
      [sequenceId],
    )
  ).rows[0];
  const kind = (RECOMMEND_SIGNAL_KINDS as readonly (string | null | undefined)[]).includes(r?.proposal_kind)
    ? (r!.proposal_kind as RecommendSignalKind)
    : signalKindOfSource(r?.source_kind);
  return { signalKind: kind, locale: guidanceLocale(r?.locale), requiresDisclosure: r?.disclosure === true };
}

/**
 * Deja el hilo de correo y la guía de cada paso como deben quedar tras
 * un cambio de forma (reordenar, quitar, añadir, cambiar un tipo):
 *
 *   · los tipos, con normalizeThread de @mc/core (la misma regla que el
 *     recomendador): el primer correo abre el hilo y los siguientes
 *     responden, salvo el cierre que ya es correo nuevo y el paso que la
 *     persona acaba de poner como correo nuevo (`keepNewThreadStepId`);
 *   · la guía de cada paso cuyo tipo ya no es para el que se escribió,
 *     con guidanceAfterRetype: recompuesta si era de la plantilla, de las
 *     reglas o del modelo; la de la persona se queda (y la tarjeta pide
 *     revisarla).
 *
 * guidance_for_type NULL (una fila anterior a 0062) se lee como escrita
 * para el tipo que el paso tiene al llegar aquí.
 */
export async function normalizeSequenceThread(
  tx: WorkspaceTx, sequenceId: string, opts: { keepNewThreadStepId?: string } = {},
): Promise<void> {
  const { rows } = await tx.query<{
    id: string; step_type: string; channel: string; angle_key: string | null; guidance_es: string | null;
    guidance_source: GuidanceSource | null; guidance_for_type: string | null;
  }>(
    `SELECT st.id, st.step_type, st.channel, a.key AS angle_key, st.guidance_es, st.guidance_source, st.guidance_for_type
       FROM outbound_step st LEFT JOIN outbound_angle a ON a.id = st.angle_id
      WHERE st.sequence_id = $1::uuid
      ORDER BY st.day_offset, st.order_in_day, st.id`,
    [sequenceId],
  );
  const types = normalizeThread(
    rows.map((r) => ({ stepType: r.step_type, channel: r.channel, angleKey: r.angle_key })),
    { keepNewThread: (i) => rows[i]!.id === opts.keepNewThreadStepId },
  );
  let ctx: GuidanceContext | null = null;
  for (const [i, r] of rows.entries()) {
    const stepType = types[i]!;
    const writtenFor = r.guidance_for_type ?? r.step_type;
    if (stepType === r.step_type && writtenFor === stepType) continue;
    ctx ??= await guidanceContextOf(tx, sequenceId);
    const g = guidanceAfterRetype(
      { guidance: r.guidance_es, source: r.guidance_source, writtenFor, angleKey: r.angle_key }, stepType, ctx,
    );
    if (stepType === r.step_type && g.guidance === r.guidance_es && g.source === r.guidance_source && g.writtenFor === r.guidance_for_type) {
      continue;
    }
    await tx.query(
      `UPDATE outbound_step SET step_type = $2, guidance_es = $3, guidance_source = $4, guidance_for_type = $5 WHERE id = $1::uuid`,
      [r.id, stepType, g.guidance, g.source, g.writtenFor],
    );
  }
}
