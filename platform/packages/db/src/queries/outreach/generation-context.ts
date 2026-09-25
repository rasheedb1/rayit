/**
 * Outreach · todo lo que el generador y el juez leen de un toque (VEN-12).
 *
 * Una sola lectura por toque, como mc_worker nombrando el workspace del
 * toque en cada consulta. Lo que devuelve ya tiene la forma de @mc/core
 * (GenerationInput, StepRubric, SalesClaim): el job no traduce nada.
 */
import { CLAIM_SOURCES, type ClaimSource, type SalesClaim } from '@mc/core/outreach/claims';
import type { GenerationAngle, GenerationLang, SentTouch } from '@mc/core/outreach/generate';
import { REGENERATE_HINTS, type RegenerateHint } from '@mc/core/outreach/preflight';
import { bodyFingerprint, SIMILARITY_WINDOW } from '@mc/core/outreach/gates';
import { DEFAULT_RUBRIC, RUBRIC_DIMENSIONS, type StepRubric } from '@mc/core/outreach/judge';
import type { WorkerSql } from '../../client.ts';
import { listSalesClaims } from './claims.ts';
import { assertIds, OutreachMotorError } from './shared.ts';

/** Cuántos toques enviados a la misma persona entran en el prompt. */
export const PREVIOUS_TOUCHES_IN_PROMPT = 8;

/** El tipo de paso de un toque, también de uno manual (sin paso): el correo es 'email', LinkedIn 'linkedin_message'. */
export const TOUCH_STEP_TYPE_SQL = (t: string, st: string) =>
  `coalesce(${st}.step_type, CASE ${t}.channel WHEN 'linkedin' THEN 'linkedin_message' ELSE ${t}.channel END)`;

export interface GenerationContext {
  workspaceId: string;
  touchId: string;
  touchStatus: string;
  stepType: string;
  dayOffset: number;
  contactId: string | null;
  dealId: string | null;
  locale: string;
  lang: GenerationLang;
  automationMode: string;
  requireHumanReview: boolean;
  rubric: StepRubric;
  angle: GenerationAngle | null;
  guidance: string | null;
  creator: { name: string; handle: string | null; niche: string | null; bio: string | null };
  company: { name: string; industry: string | null; city: string | null; country: string | null };
  contact: { fullName: string | null; roleTitle: string | null } | null;
  signal: { headline: string; source: string | null; detectedAt: Date | null } | null;
  brief: { title: string; notes: string | null; requiresDisclosure: boolean } | null;
  claims: SalesClaim[];
  /** Solo lo ENVIADO a esta persona desde este workspace, del más viejo al más nuevo. */
  previousTouches: SentTouch[];
  /**
   * Los últimos cuerpos del mismo tipo de paso en el workspace (compuerta
   * B): los enviados y los que van a salir (programados, en envío,
   * retenidos) y los que la IA redactó y esperan al juez. Así dos correos
   * del mismo lote para dos marcas del mismo nicho también se comparan.
   */
  recentSent: string[];
  /** Huellas de lo enviado a esta persona (compuerta C). */
  sentFingerprints: string[];
  /** Cuántos toques de este tipo ya aprobó una persona o salieron: el calentamiento. */
  approvedOfStepType: number;
  generation: {
    stage: string; subject: string | null; bodyMarked: string | null; model: string | null; attempts: number;
    /** Lo que pidió una persona desde el editor (0057): la pista, sus instrucciones y cuándo. null = un borrador de cadencia. */
    requestedHint: RegenerateHint | null;
    requestedInstructions: string | null;
    requestedAt: Date | null;
    /** Lo que costó el borrador de outbound.generate (0057). */
    usage: { inputTokens: number; outputTokens: number; costUsd: number };
  } | null;
  /** El asunto y el cuerpo que tiene ahora el toque (sin marcas). */
  touchSubject: string | null;
  touchBody: string;
  /** ¿Es un toque de cadencia (con paso) o un pitch suelto de la ficha? */
  fromSequence: boolean;
}

const toDate = (v: unknown): Date | null => (v === null || v === undefined ? null : new Date(v as string));

interface MainRow {
  workspace_id: string; status: string; step_type: string; day_offset: number; contact_id: string | null; deal_id: string | null;
  angle_id: string | null; guidance_es: string | null; locale: string; automation_mode: string; require_human_review: boolean | null;
  subject: string | null; body: string; from_sequence: boolean;
  creator_name: string | null; creator_handle: string | null; creator_niches: string[] | null; creator_bio: string | null; creator_id: string | null;
  company_name: string; industry: string | null; city: string | null; country: string | null;
  contact_name: string | null; role_title: string | null;
  signal_headline: string | null; signal_source: string | null; signal_at: unknown;
  brief_title: string | null; brief_notes: string | null; brief_disclosure: boolean | null; workspace_name: string;
}

export async function loadGenerationContext(tx: WorkerSql, touchId: string): Promise<GenerationContext> {
  assertIds('loadGenerationContext', [touchId]);
  const m = (
    await tx.query<MainRow>(
      `SELECT t.workspace_id, t.status, ${TOUCH_STEP_TYPE_SQL('t', 'st')} AS step_type, coalesce(st.day_offset, 0) AS day_offset,
              t.contact_id, t.deal_id, st.angle_id, st.guidance_es, t.subject, t.body, t.step_id IS NOT NULL AS from_sequence,
              w.locale, w.name AS workspace_name, coalesce(s.automation_mode, 'review') AS automation_mode, p.require_human_review,
              cp.id AS creator_id, cp.display_name AS creator_name, cp.handle AS creator_handle, cp.niche_slugs AS creator_niches, cp.bio AS creator_bio,
              co.name AS company_name, co.industry, co.city, co.country,
              c.full_name AS contact_name, c.role_title,
              sg.headline_es AS signal_headline, sg.source_id AS signal_source, sg.detected_at AS signal_at,
              b.title AS brief_title, b.notes AS brief_notes, b.requires_disclosure AS brief_disclosure
         FROM outbound_touch t
         LEFT JOIN outbound_step st ON st.id = t.step_id
         LEFT JOIN outbound_enrollment e ON e.id = t.enrollment_id
         LEFT JOIN outbound_sequence s ON s.id = e.sequence_id
         JOIN workspace w ON w.id = t.workspace_id
         JOIN company co ON co.id = t.company_id
         LEFT JOIN contact c ON c.id = t.contact_id
         LEFT JOIN deal d ON d.id = t.deal_id AND d.workspace_id = t.workspace_id
         LEFT JOIN signal sg ON sg.id = d.origin_signal_id
         LEFT JOIN outbound_policy p ON p.workspace_id = t.workspace_id
         LEFT JOIN outbound_brief b ON b.id = s.brief_id AND b.workspace_id = t.workspace_id
         LEFT JOIN LATERAL (
           SELECT cp.* FROM creator_profile cp
            WHERE cp.workspace_id = t.workspace_id AND cp.deleted_at IS NULL
            ORDER BY (cp.id = d.creator_id) DESC NULLS LAST, (cp.status = 'active') DESC, cp.created_at
            LIMIT 1) cp ON true
        WHERE t.id = $1::uuid`,
      [touchId],
    )
  ).rows[0];
  if (!m) throw new OutreachMotorError('invalid_input', `El toque ${touchId} no existe.`);
  const ws = m.workspace_id;

  const angleRow = m.angle_id
    ? (await tx.query<{ key: string; label_es: string; goal_es: string; allowed_es: string[]; forbidden_es: string[]; proof_es: string | null; proof_sources: string[] }>(
        `SELECT key, label_es, goal_es, allowed_es, forbidden_es, proof_es, proof_sources FROM outbound_angle
          WHERE id = $1::uuid AND (workspace_id IS NULL OR workspace_id = $2::uuid)`,
        [m.angle_id, ws],
      )).rows[0]
    : undefined;
  const angle: GenerationAngle | null = angleRow
    ? {
        key: angleRow.key, label: angleRow.label_es, goal: angleRow.goal_es, allowed: angleRow.allowed_es, forbidden: angleRow.forbidden_es,
        proof: angleRow.proof_es,
        proofSources: angleRow.proof_sources.filter((x): x is ClaimSource => (CLAIM_SOURCES as readonly string[]).includes(x)),
      }
    : null;

  const r = (
    await tx.query<{ threshold: unknown; min_acceptable: unknown; dead_band: unknown; max_attempts: number; weights: Record<string, unknown>; criteria_es: Record<string, unknown>; max_chars: number | null }>(
      `SELECT threshold, min_acceptable, dead_band, max_attempts, weights, criteria_es, max_chars FROM outbound_step_rubric
        WHERE step_type = $1 AND (workspace_id IS NULL OR workspace_id = $2::uuid) AND (day_offset IS NULL OR day_offset = $3::int)
        ORDER BY (workspace_id IS NOT NULL) DESC, (day_offset IS NOT NULL) DESC LIMIT 1`,
      [m.step_type, ws, m.day_offset],
    )
  ).rows[0];
  const rubric: StepRubric = r
    ? {
        threshold: Number(r.threshold), minAcceptable: Number(r.min_acceptable), deadBand: Number(r.dead_band), maxAttempts: r.max_attempts,
        weights: Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, Number(r.weights[d] ?? 0)])) as StepRubric['weights'],
        criteria: Object.fromEntries(RUBRIC_DIMENSIONS.flatMap((d) => (typeof r.criteria_es[d] === 'string' ? [[d, r.criteria_es[d]]] : []))),
        maxChars: r.max_chars,
      }
    : DEFAULT_RUBRIC;

  const sentToContact = m.contact_id
    ? (await tx.query<{ step_type: string | null; channel: string; sent_at: unknown; subject: string | null; body: string }>(
        `SELECT st.step_type, t.channel, t.sent_at, t.subject, t.body
           FROM outbound_touch t LEFT JOIN outbound_step st ON st.id = t.step_id
          WHERE t.workspace_id = $1::uuid AND t.contact_id = $2::uuid AND t.status = 'sent' AND t.id <> $3::uuid
          ORDER BY t.sent_at DESC NULLS LAST, t.id LIMIT ${PREVIOUS_TOUCHES_IN_PROMPT}`,
        [ws, m.contact_id, touchId],
      )).rows.reverse()
    : [];

  const recentSent = (
    await tx.query<{ body: string }>(
      `SELECT body FROM (
         SELECT t.body, coalesce(t.sent_at, t.status_changed_at) AS at, t.id
           FROM outbound_touch t LEFT JOIN outbound_step st ON st.id = t.step_id
          WHERE t.workspace_id = $1::uuid AND t.id <> $3::uuid AND t.status IN ('sent','scheduled','processing','held')
            AND coalesce(btrim(t.body), '') <> '' AND ${TOUCH_STEP_TYPE_SQL('t', 'st')} = $2
         UNION ALL
         -- Lo que la IA ya redactó en este lote y espera al juez: todavía no está en el toque.
         SELECT g.body_marked, coalesce(g.generated_at, g.updated_at), g.touch_id
           FROM outbound_generation g JOIN outbound_touch t ON t.id = g.touch_id LEFT JOIN outbound_step st ON st.id = t.step_id
          WHERE g.workspace_id = $1::uuid AND g.touch_id <> $3::uuid AND g.stage IN ('generated','reviewing')
            AND g.body_marked IS NOT NULL AND ${TOUCH_STEP_TYPE_SQL('t', 'st')} = $2) x
        ORDER BY at DESC NULLS LAST, id LIMIT ${SIMILARITY_WINDOW}`,
      [ws, m.step_type, touchId],
    )
  ).rows.map((x) => x.body);

  const counts = (
    await tx.query<{ approved: number }>(
      `SELECT (SELECT count(*)::int FROM outbound_touch t LEFT JOIN outbound_step st ON st.id = t.step_id
                WHERE t.workspace_id = $1::uuid AND ${TOUCH_STEP_TYPE_SQL('t', 'st')} = $2
                  AND (t.status = 'sent' OR t.approved_at IS NOT NULL)) AS approved`,
      [ws, m.step_type],
    )
  ).rows[0]!;

  const gen = (
    await tx.query<{
      stage: string; subject: string | null; body_marked: string | null; model: string | null; attempts: number; requested_hint: string | null;
      requested_instructions: string | null; requested_at: unknown; gen_input_tokens: number; gen_output_tokens: number; gen_cost: unknown;
    }>(
      `SELECT stage, subject, body_marked, model, attempts, requested_hint, requested_instructions, requested_at,
              gen_input_tokens, gen_output_tokens, gen_cost
         FROM outbound_generation WHERE touch_id = $1::uuid`,
      [touchId],
    )
  ).rows[0];
  const hint = gen?.requested_hint && (REGENERATE_HINTS as readonly string[]).includes(gen.requested_hint) ? (gen.requested_hint as RegenerateHint) : null;

  const claims = await listSalesClaims(tx, { workspaceId: ws, locale: m.locale, creatorId: m.creator_id, dealId: m.deal_id });
  return {
    workspaceId: ws, touchId, touchStatus: m.status, stepType: m.step_type, dayOffset: m.day_offset, contactId: m.contact_id, dealId: m.deal_id,
    locale: m.locale, lang: m.locale.toLowerCase().startsWith('en') ? 'en' : 'es',
    automationMode: m.automation_mode, requireHumanReview: m.require_human_review ?? true,
    rubric, angle, guidance: m.guidance_es,
    creator: {
      name: m.creator_name ?? m.workspace_name, handle: m.creator_handle, niche: m.creator_niches?.[0] ?? null, bio: m.creator_bio,
    },
    company: { name: m.company_name, industry: m.industry, city: m.city, country: m.country },
    contact: m.contact_id ? { fullName: m.contact_name, roleTitle: m.role_title } : null,
    signal: m.signal_headline ? { headline: m.signal_headline, source: m.signal_source, detectedAt: toDate(m.signal_at) } : null,
    brief: m.brief_title ? { title: m.brief_title, notes: m.brief_notes, requiresDisclosure: m.brief_disclosure ?? true } : null,
    claims,
    previousTouches: sentToContact.map((x) => ({ stepType: x.step_type, channel: x.channel, sentAt: toDate(x.sent_at)!, subject: x.subject, body: x.body })),
    recentSent,
    sentFingerprints: sentToContact.map((x) => bodyFingerprint(x.subject, x.body)),
    approvedOfStepType: counts.approved,
    generation: gen
      ? {
          stage: gen.stage, subject: gen.subject, bodyMarked: gen.body_marked, model: gen.model, attempts: gen.attempts,
          requestedHint: hint, requestedInstructions: gen.requested_instructions, requestedAt: toDate(gen.requested_at),
          usage: { inputTokens: gen.gen_input_tokens, outputTokens: gen.gen_output_tokens, costUsd: Number(gen.gen_cost ?? 0) },
        }
      : null,
    touchSubject: m.subject,
    touchBody: m.body ?? '',
    fromSequence: m.from_sequence,
  };
}
