/**
 * Cadencias · guardar lo que propone el recomendador (VEN-13): crear una
 * secuencia desde una propuesta o desde una plantilla, reemplazar los
 * pasos de un borrador con una propuesta nueva, y registrar cada llamada
 * al modelo con sus tokens y su costo.
 *
 * Lo que queda escrito de la propuesta (outbound_sequence.proposal) son
 * códigos: su forma y su lectura viven en @mc/core (proposal-notes.ts,
 * con zod).
 */
import { llmCostUsd, type LlmUsage, type Proposal, type SequenceProposal } from '@mc/core';
import type { WorkspaceTx } from '../../client.ts';
import { assertEditable, assertId, CadenciaError, cleanName, lockSequence, TEXTLESS_STEP_TYPES } from './comun.ts';
import { listSequenceTemplates } from './lista.ts';
import { insertSteps, normalizeSequenceThread, type StepInsert } from './pasos.ts';

export { parseProposalNote, parseSequenceProposal, type SequenceProposal } from '@mc/core';

function proposalSteps(p: Proposal): StepInsert[] {
  return p.steps.map((s) => ({
    dayOffset: s.dayOffset, orderInDay: s.orderInDay, stepType: s.stepType, channel: s.channel,
    scheduledTime: s.scheduledTime, angleKey: s.angleKey, guidanceEs: s.guidanceEs, guidanceSource: s.guidanceSource,
    generateWithAi: TEXTLESS_STEP_TYPES.includes(s.stepType) ? false : s.generateWithAi, requiresAsset: s.requiresAsset,
  }));
}

export interface ProposalMeta {
  signalId: string | null;
  /** El brief del creador del negocio del que sale la propuesta (outbound_sequence.brief_id): el generador lo lee. */
  briefId: string | null;
  contactId: string | null;
  dealId: string | null;
  guidance: 'llm' | 'rules';
  guidanceWhyRules: SequenceProposal['guidanceWhyRules'];
  model: string | null;
  now?: Date;
}

function proposalJson(p: Proposal, meta: ProposalMeta): SequenceProposal {
  return {
    version: 1, templateSlug: p.templateSlug, signalKind: p.signalKind, notes: p.notes, guidance: meta.guidance,
    guidanceWhyRules: meta.guidance === 'llm' ? null : meta.guidanceWhyRules, model: meta.model,
    contactId: meta.contactId, dealId: meta.dealId, proposedAt: (meta.now ?? new Date()).toISOString(),
  };
}

/**
 * Crea una secuencia en borrador con los pasos de una propuesta del
 * recomendador. Devuelve su id.
 *
 * Una señal tiene como mucho un borrador: si ya hay uno (sin nadie
 * dentro), sus pasos se reemplazan en lugar de crear otro con el mismo
 * nombre. Un bloqueo por señal (pg_advisory_xact_lock) hace que dos
 * envíos a la vez del mismo formulario terminen en el mismo borrador.
 */
export async function createSequenceFromProposal(
  tx: WorkspaceTx, input: { proposal: Proposal; name: string; meta: ProposalMeta },
): Promise<string> {
  for (const id of [input.meta.signalId, input.meta.contactId, input.meta.dealId, input.meta.briefId]) {
    if (id) assertId('createSequenceFromProposal', id);
  }
  if (input.meta.signalId) {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('outbound_sequence:signal:' || $1, 0))`, [input.meta.signalId]);
    const draft = (
      await tx.query<{ id: string }>(
        `SELECT s.id FROM outbound_sequence s
          WHERE s.signal_id = $1::uuid AND s.status = 'draft'
            AND NOT EXISTS (SELECT 1 FROM outbound_enrollment e WHERE e.sequence_id = s.id)
          ORDER BY s.updated_at DESC, s.id LIMIT 1`,
        [input.meta.signalId],
      )
    ).rows[0];
    if (draft) {
      await replaceStepsFromProposal(tx, draft.id, input);
      return draft.id;
    }
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO outbound_sequence (workspace_id, name, channel, status, template_id, signal_id, brief_id, proposal)
     VALUES ($1::uuid, $2, $3, 'draft', (SELECT id FROM outbound_sequence_template WHERE slug = $4), $5::uuid, $6::uuid, $7::jsonb)
     RETURNING id`,
    [
      tx.workspaceId, cleanName(input.name), input.proposal.primaryChannel, input.proposal.templateSlug,
      input.meta.signalId, input.meta.briefId, JSON.stringify(proposalJson(input.proposal, input.meta)),
    ],
  );
  await insertSteps(tx, rows[0]!.id, proposalSteps(input.proposal));
  await normalizeSequenceThread(tx, rows[0]!.id);
  return rows[0]!.id;
}

/** Crea una secuencia en borrador copiando una plantilla tal cual. Devuelve su id. */
export async function createSequenceFromTemplate(tx: WorkspaceTx, slug: string, name?: string): Promise<string> {
  const tpl = (await listSequenceTemplates(tx)).find((t) => t.slug === slug);
  if (!tpl) throw new CadenciaError('no_template', `No hay ninguna plantilla activa «${slug}».`);
  const steps: StepInsert[] = tpl.steps.map((s) => ({
    dayOffset: s.day_offset, orderInDay: s.order_in_day, stepType: s.step_type, channel: s.channel,
    scheduledTime: s.scheduled_time, angleKey: s.angle_key, guidanceEs: s.guidance_es, guidanceSource: 'template',
    generateWithAi: TEXTLESS_STEP_TYPES.includes(s.step_type) ? false : s.generate_with_ai, requiresAsset: s.requires_asset,
  }));
  const channel = steps.find((s) => s.channel === 'email') ? 'email' : (steps[0]?.channel ?? 'email');
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO outbound_sequence (workspace_id, name, channel, status, template_id)
     SELECT $1::uuid, $2, $3, 'draft', id FROM outbound_sequence_template WHERE slug = $4
     RETURNING id`,
    [tx.workspaceId, cleanName(name ?? tpl.nameEs), channel, slug],
  );
  await insertSteps(tx, rows[0]!.id, steps);
  await normalizeSequenceThread(tx, rows[0]!.id);
  return rows[0]!.id;
}

/**
 * Reemplaza los pasos por los de una propuesta nueva («Proponer desde
 * esta señal»). Solo sin nadie dentro, y solo con la propuesta de SU
 * señal: la secuencia y la señal llegan de un formulario, y uno hecho a
 * mano no puede ponerle a un borrador la propuesta (ni el origen) de
 * otra señal.
 */
export async function replaceStepsFromProposal(
  tx: WorkspaceTx, sequenceId: string, input: { proposal: Proposal; meta: ProposalMeta },
): Promise<void> {
  if (input.meta.briefId) assertId('replaceStepsFromProposal', input.meta.briefId);
  const s = await lockSequence(tx, sequenceId);
  assertEditable(s, true);
  if (s.signal_id !== (input.meta.signalId ?? null)) {
    throw new CadenciaError('invalid', `La secuencia ${sequenceId} no salió de la señal ${input.meta.signalId ?? '(ninguna)'}.`);
  }
  await tx.query(`DELETE FROM outbound_step WHERE sequence_id = $1::uuid`, [sequenceId]);
  await insertSteps(tx, sequenceId, proposalSteps(input.proposal));
  await tx.query(
    `UPDATE outbound_sequence
        SET channel = $2, template_id = (SELECT id FROM outbound_sequence_template WHERE slug = $3),
            brief_id = $4::uuid, proposal = $5::jsonb
      WHERE id = $1::uuid`,
    [
      sequenceId, input.proposal.primaryChannel, input.proposal.templateSlug, input.meta.briefId,
      JSON.stringify(proposalJson(input.proposal, input.meta)),
    ],
  );
  await normalizeSequenceThread(tx, sequenceId);
}

/**
 * Registra una llamada del recomendador al modelo (outbound_llm_call,
 * propósito 'recommend'), con su costo: outbound_health la suma contra el
 * tope diario. Es una bitácora: se inserta y no se corrige.
 */
export async function recordRecommendLlmCall(tx: WorkspaceTx, usage: LlmUsage): Promise<void> {
  await tx.query(
    `INSERT INTO outbound_llm_call (workspace_id, purpose, model, input_tokens, output_tokens, cost, cost_currency)
     VALUES ($1::uuid, 'recommend', $2, $3::int, $4::int, $5::numeric, 'USD')`,
    [tx.workspaceId, usage.model, usage.inputTokens, usage.outputTokens, llmCostUsd(usage)],
  );
}
