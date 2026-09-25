/**
 * Cadencias · editar la línea de tiempo (VEN-13): cambiar un paso,
 * añadir uno, quitarlo y reordenar. Cada cambio de forma termina en
 * normalizeSequenceThread (pasos.ts): el hilo de correo con la misma
 * regla que el recomendador, y la guía de cada paso que cambió de tipo
 * recompuesta si no la escribió la persona.
 */
import { composeStepGuidance, DISPATCHABLE_STEP_TYPES, type GuidanceSource } from '@mc/core';
import type { WorkspaceTx } from '../../client.ts';
import type { StepType } from '../../schema/outreach.ts';
import {
  assertEditable, assertId, BODY_MAX, CadenciaError, channelForStepType, EDITABLE_CHANNELS, EDITABLE_STEP_TYPES, GUIDANCE_MAX,
  lockSequence, MAX_DAY_OFFSET, MAX_STEPS, MAX_STEPS_PER_DAY, SUBJECT_MAX, TEXTLESS_STEP_TYPES,
} from './comun.ts';
import { channelStates } from './contexto.ts';
import { guidanceContextOf, normalizeSequenceThread, readSteps } from './pasos.ts';

/** Lo que se puede cambiar de un paso. Lo que no viene, no cambia. */
export interface StepPatch {
  dayOffset?: number;
  stepType?: StepType;
  /** Solo para una tarea a mano: en qué red la hace la persona. */
  channel?: string;
  scheduledTime?: string;
  angleKey?: string | null;
  guidanceEs?: string | null;
  generateWithAi?: boolean;
  subjectTemplate?: string | null;
  bodyTemplate?: string | null;
  requiresAsset?: 'media_kit' | 'quote' | null;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function trimOrNull(v: string | null | undefined, max: number, what: string): string | null {
  if (v === null || v === undefined) return null;
  const t = v.replace(/\r\n?/g, '\n').trim();
  if ([...t].length > max) throw new CadenciaError('invalid', `${what}: hasta ${max} caracteres.`);
  return t === '' ? null : t;
}

/** La siguiente plaza libre de un día, o day_full. */
async function nextOrderInDay(tx: WorkspaceTx, sequenceId: string, day: number, exceptStepId: string | null): Promise<number> {
  const { rows } = await tx.query<{ n: number; next: number }>(
    `SELECT count(*)::int AS n, coalesce(max(order_in_day) + 1, 0)::int AS next
       FROM outbound_step WHERE sequence_id = $1::uuid AND day_offset = $2::int AND id IS DISTINCT FROM $3::uuid`,
    [sequenceId, day, exceptStepId],
  );
  const r = rows[0]!;
  if (r.n >= MAX_STEPS_PER_DAY) throw new CadenciaError('day_full', `Un día lleva hasta ${MAX_STEPS_PER_DAY} pasos.`);
  return Math.min(r.next, 8);
}

interface CurrentStep {
  sequence_id: string;
  day_offset: number;
  step_type: StepType;
  channel: string;
  generate_with_ai: boolean;
  body_template: string | null;
  angle_key: string | null;
  guidance_es: string | null;
  guidance_source: GuidanceSource | null;
  guidance_for_type: string | null;
}

/**
 * La guía de un paso tras un cambio del editor, antes de normalizar el
 * hilo:
 *   · la persona cambió el texto → es suya, escrita para el tipo nuevo;
 *   · guardó el paso sin cambiar el texto ni el tipo → la revisó: vale
 *     para el tipo que tiene (se quita el aviso de revisarla);
 *   · cambió el ángulo y la guía no es suya → se recompone con el ángulo
 *     nuevo (una guía de «prueba social» en un paso de «síntesis» no
 *     sirve);
 *   · si no, queda como estaba, escrita para el tipo de antes: si el tipo
 *     cambió, normalizeSequenceThread la recompone o la marca.
 */
async function guidanceAfterEdit(
  tx: WorkspaceTx, cur: CurrentStep, patch: StepPatch, stepType: string, angleKey: string | null,
): Promise<{ guidance: string | null; source: GuidanceSource | null; writtenFor: string | null }> {
  const writtenFor = cur.guidance_for_type ?? cur.step_type;
  const sent = patch.guidanceEs !== undefined ? trimOrNull(patch.guidanceEs, GUIDANCE_MAX, 'La guía') : undefined;
  if (sent !== undefined && sent !== trimOrNull(cur.guidance_es, Infinity, 'La guía')) {
    return { guidance: sent, source: 'person', writtenFor: stepType };
  }
  if (sent !== undefined && stepType === cur.step_type && cur.guidance_source === 'person') {
    return { guidance: cur.guidance_es, source: 'person', writtenFor: stepType };
  }
  const auto = cur.guidance_source === 'template' || cur.guidance_source === 'rules' || cur.guidance_source === 'llm';
  if (angleKey !== cur.angle_key && auto && cur.guidance_es !== null) {
    const ctx = await guidanceContextOf(tx, cur.sequence_id);
    return { guidance: composeStepGuidance(angleKey, stepType, ctx), source: 'rules', writtenFor: stepType };
  }
  return { guidance: cur.guidance_es, source: cur.guidance_source, writtenFor };
}

/** Cambia un paso. La forma (día, tipo, canal) solo sin nadie dentro. */
export async function updateStep(tx: WorkspaceTx, stepId: string, patch: StepPatch): Promise<void> {
  assertId('updateStep', stepId);
  // Primero la secuencia y su bloqueo; el paso se lee DESPUÉS, dentro del bloqueo: si no, un reordenar o
  // un enrolamiento entre las dos lecturas haría decidir «estructural» o day_full con datos viejos.
  const owner = (await tx.query<{ sequence_id: string }>(`SELECT sequence_id FROM outbound_step WHERE id = $1::uuid`, [stepId])).rows[0];
  if (!owner) throw new CadenciaError('not_found', `El paso ${stepId} no existe o no es de este espacio.`);
  const seq = await lockSequence(tx, owner.sequence_id);
  const cur = (
    await tx.query<CurrentStep>(
      `SELECT st.sequence_id, st.day_offset, st.step_type, st.channel, st.generate_with_ai, st.body_template, a.key AS angle_key,
              st.guidance_es, st.guidance_source, st.guidance_for_type
         FROM outbound_step st LEFT JOIN outbound_angle a ON a.id = st.angle_id
        WHERE st.id = $1::uuid AND st.sequence_id = $2::uuid`,
      [stepId, owner.sequence_id],
    )
  ).rows[0];
  // Se borró mientras se esperaba el bloqueo.
  if (!cur) throw new CadenciaError('not_found', `El paso ${stepId} ya no existe.`);
  const stepType = patch.stepType ?? cur.step_type;
  // Un paso que ya era de WhatsApp (de una plantilla vieja) se puede editar en su texto; poner uno nuevo, no.
  if (!(EDITABLE_STEP_TYPES as readonly string[]).includes(stepType) && (patch.stepType !== undefined || stepType !== cur.step_type)) {
    throw new CadenciaError('invalid', `Tipo de paso que no se puede poner: ${stepType}.`);
  }
  const channel = stepType === 'manual_task' ? (patch.channel ?? cur.channel) : channelForStepType(stepType);
  const day = patch.dayOffset ?? cur.day_offset;
  const structural = day !== cur.day_offset || stepType !== cur.step_type || channel !== cur.channel;
  assertEditable(seq, structural);

  if (!Number.isInteger(day) || day < 0 || day > MAX_DAY_OFFSET) throw new CadenciaError('invalid', `El día va de 0 a ${MAX_DAY_OFFSET}.`);
  if (structural && !(EDITABLE_CHANNELS as readonly string[]).includes(channel)) {
    throw new CadenciaError('invalid', `Canal que no se puede poner: ${channel}.`);
  }
  if (patch.scheduledTime !== undefined && !TIME_RE.test(patch.scheduledTime)) throw new CadenciaError('invalid', 'La hora va como HH:MM.');
  if (patch.angleKey) {
    const ok = (await tx.query(`SELECT 1 FROM outbound_angle WHERE key = $1`, [patch.angleKey])).rows.length > 0;
    if (!ok) throw new CadenciaError('invalid', `Ángulo desconocido: ${patch.angleKey}.`);
  }
  if (patch.requiresAsset !== undefined && patch.requiresAsset !== null && !['media_kit', 'quote'].includes(patch.requiresAsset)) {
    throw new CadenciaError('invalid', 'El activo es el media kit o la cotización.');
  }
  const textless = TEXTLESS_STEP_TYPES.includes(stepType);
  const generate = textless ? false : (patch.generateWithAi ?? cur.generate_with_ai);
  const body = patch.bodyTemplate !== undefined ? trimOrNull(patch.bodyTemplate, BODY_MAX, 'El texto') : cur.body_template;
  if (!generate && !textless && !body) {
    throw new CadenciaError('invalid', 'Sin generación automática, el paso necesita su texto fijo.');
  }
  const order = day !== cur.day_offset ? await nextOrderInDay(tx, cur.sequence_id, day, stepId) : null;
  const angleKey = patch.angleKey !== undefined ? patch.angleKey : cur.angle_key;
  const g = await guidanceAfterEdit(tx, cur, patch, stepType, angleKey);

  await tx.query(
    `UPDATE outbound_step SET
        day_offset = $2::int,
        order_in_day = coalesce($3::int, order_in_day),
        step_type = $4, channel = $5,
        scheduled_time = coalesce($6::time, scheduled_time),
        angle_id = CASE WHEN $7::boolean
                        THEN (SELECT a.id FROM outbound_angle a WHERE a.key = $8 ORDER BY a.workspace_id NULLS LAST LIMIT 1)
                        ELSE angle_id END,
        guidance_es = $9, guidance_source = $10, guidance_for_type = $11,
        generate_with_ai = $12::boolean,
        subject_template = CASE WHEN $13::boolean THEN $14 ELSE subject_template END,
        body_template = $15,
        requires_asset = CASE WHEN $16::boolean THEN $17 ELSE requires_asset END
      WHERE id = $1::uuid`,
    [
      stepId, day, order, stepType, channel, patch.scheduledTime ?? null,
      patch.angleKey !== undefined, patch.angleKey ?? null,
      g.guidance, g.guidance === null ? null : g.source, g.guidance === null ? null : g.writtenFor,
      generate,
      patch.subjectTemplate !== undefined, trimOrNull(patch.subjectTemplate, SUBJECT_MAX, 'El asunto'),
      body,
      patch.requiresAsset !== undefined, patch.requiresAsset ?? null,
    ],
  );
  // La guía de este paso (si el tipo cambió y no es de la persona) y el hilo entero. Un correo nuevo que la
  // persona acaba de elegir para un paso que no lo era se respeta en este cambio.
  const choseNewThread = patch.stepType === 'email' && cur.step_type !== 'email';
  if (structural || g.writtenFor !== stepType) {
    await normalizeSequenceThread(tx, cur.sequence_id, choseNewThread ? { keepNewThreadStepId: stepId } : {});
  }
}

/** Lo que queda de un paso añadido. */
export interface AddedStep {
  id: string;
  /**
   * La política ya estaba llena de mensajes: en lugar de otro mensaje
   * (que nunca saldría) se añadió un gesto público o una tarea a mano.
   */
  asGesture: boolean;
}

/**
 * Añade un paso al final (por defecto, tras el último con la separación
 * de la política, y al menos dos días). Si no se dice el ángulo, toma el
 * primero del catálogo que la secuencia todavía no usa, con su guía
 * compuesta para el canal y la señal: un paso nuevo nace con algo que
 * decir, no «sin ángulo». El hilo se normaliza después (una respuesta
 * sin correo antes pasa a ser el correo que lo abre).
 *
 * Sin `stepType` («Añadir paso» de la línea de tiempo) decide el tipo: el
 * siguiente mensaje del hilo, salvo que los mensajes ya lleguen a
 * max_touches_per_company; entonces un gesto de presencia (una reacción
 * en la red que llegue, como hace el recomendador al ajustarse, o una
 * tarea a mano si no llega ninguna), que sí se cumple. Un mensaje de
 * más quedaría marcado «no sale» desde que nace.
 */
export async function addStep(
  tx: WorkspaceTx, sequenceId: string,
  input: { dayOffset?: number; stepType?: StepType; channel?: string; angleKey?: string | null; guidanceEs?: string | null; scheduledTime?: string } = {},
): Promise<AddedStep> {
  const seq = await lockSequence(tx, sequenceId);
  assertEditable(seq, true);
  if (input.stepType !== undefined && !(EDITABLE_STEP_TYPES as readonly string[]).includes(input.stepType)) {
    throw new CadenciaError('invalid', `Tipo de paso que no se puede poner: ${input.stepType}.`);
  }
  const stats = (
    await tx.query<{ n: number; last: number | null; has_email: boolean; min_days: number; max_touches: number; allowed: string[];
      messages: number; angle: string | null }>(
      `SELECT (SELECT count(*) FROM outbound_step st WHERE st.sequence_id = s.id)::int AS n,
              (SELECT max(day_offset) FROM outbound_step st WHERE st.sequence_id = s.id) AS last,
              EXISTS (SELECT 1 FROM outbound_step st WHERE st.sequence_id = s.id AND st.step_type IN ('email', 'email_reply')) AS has_email,
              coalesce(p.min_days_between_touches, 3) AS min_days, coalesce(p.max_touches_per_company, 4) AS max_touches,
              coalesce(p.allowed_channels, '{email,linkedin}'::text[]) AS allowed,
              (SELECT count(*) FROM outbound_step st WHERE st.sequence_id = s.id AND st.step_type = ANY($2::text[]))::int AS messages,
              (SELECT a.key FROM outbound_angle a
                WHERE NOT EXISTS (SELECT 1 FROM outbound_step st JOIN outbound_angle u ON u.id = st.angle_id
                                   WHERE st.sequence_id = s.id AND u.key = a.key)
                ORDER BY a.position, a.key LIMIT 1) AS angle
         FROM outbound_sequence s
         LEFT JOIN outbound_policy p ON p.workspace_id = s.workspace_id
        WHERE s.id = $1::uuid`,
      [sequenceId, [...DISPATCHABLE_STEP_TYPES]],
    )
  ).rows[0]!;
  if (stats.n >= MAX_STEPS) throw new CadenciaError('too_many_steps', `Una secuencia lleva hasta ${MAX_STEPS} pasos.`);
  const gap = Math.max(2, stats.min_days);
  const day = input.dayOffset ?? Math.min(MAX_DAY_OFFSET, stats.last === null ? 0 : stats.last + gap);
  if (!Number.isInteger(day) || day < 0 || day > MAX_DAY_OFFSET) throw new CadenciaError('invalid', `El día va de 0 a ${MAX_DAY_OFFSET}.`);

  // El tipo: el que se pidió o, sin pedir ninguno, el siguiente mensaje si la política aún deja uno.
  const asGesture = input.stepType === undefined && stats.messages >= stats.max_touches;
  let requested: StepType = input.stepType ?? 'email_reply';
  let requestedChannel = input.channel;
  if (asGesture) {
    const states = await channelStates(tx);
    const network = (['linkedin', 'instagram_dm'] as const).find((c) => stats.allowed.includes(c) && states[c] !== 'missing');
    requested = network === 'linkedin' ? 'linkedin_like' : network === 'instagram_dm' ? 'instagram_like' : 'manual_task';
    requestedChannel = network ?? 'linkedin';
  }
  const stepType: StepType = requested === 'email_reply' && !stats.has_email ? 'email' : requested;
  const time = input.scheduledTime ?? '09:30';
  if (!TIME_RE.test(time)) throw new CadenciaError('invalid', 'La hora va como HH:MM.');
  const channel = stepType === 'manual_task' ? (requestedChannel ?? 'email') : channelForStepType(stepType);
  if (!(EDITABLE_CHANNELS as readonly string[]).includes(channel)) throw new CadenciaError('invalid', `Canal que no se puede poner: ${channel}.`);
  const angleKey = asGesture && input.angleKey === undefined ? 'presencia' : input.angleKey === undefined ? stats.angle : input.angleKey;
  const guidance = input.guidanceEs !== undefined
    ? input.guidanceEs
    : angleKey ? composeStepGuidance(angleKey, stepType, await guidanceContextOf(tx, sequenceId)) : null;
  const guidanceText = trimOrNull(guidance, GUIDANCE_MAX, 'La guía');
  const order = await nextOrderInDay(tx, sequenceId, day, null);
  const textless = TEXTLESS_STEP_TYPES.includes(stepType);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO outbound_step
       (workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time, angle_id, guidance_es,
        guidance_source, guidance_for_type, generate_with_ai)
     VALUES ($1::uuid, $2::uuid, $3::int, $4::int, $5, $6, $7::time,
             (SELECT a.id FROM outbound_angle a WHERE a.key = $8 ORDER BY a.workspace_id NULLS LAST LIMIT 1), $9, $10, $11, $12::boolean)
     RETURNING id`,
    [
      tx.workspaceId, sequenceId, day, order, stepType, channel, time, angleKey ?? null, guidanceText,
      guidanceText === null ? null : input.guidanceEs !== undefined ? 'person' : 'rules', guidanceText === null ? null : stepType,
      !textless,
    ],
  );
  await normalizeSequenceThread(tx, sequenceId);
  return { id: rows[0]!.id, asGesture };
}

export async function deleteStep(tx: WorkspaceTx, stepId: string): Promise<void> {
  assertId('deleteStep', stepId);
  const cur = (await tx.query<{ sequence_id: string }>(`SELECT sequence_id FROM outbound_step WHERE id = $1::uuid`, [stepId])).rows[0];
  if (!cur) throw new CadenciaError('not_found', `El paso ${stepId} no existe o no es de este espacio.`);
  assertEditable(await lockSequence(tx, cur.sequence_id), true);
  await tx.query(`DELETE FROM outbound_step WHERE id = $1::uuid`, [stepId]);
  await normalizeSequenceThread(tx, cur.sequence_id);
}

/**
 * Reordena los pasos (arrastrar en la línea de tiempo). Los días no se
 * mueven: el paso que queda en la posición k toma el día y la hora de
 * orden de la posición k, como en Lemlist (se reordenan los mensajes,
 * no el calendario). `orderedIds` son todos los pasos, en el orden nuevo.
 *
 * El índice único (sequence_id, day_offset, order_in_day) no es
 * diferible, así que se pasa por un orden provisional que no choca con
 * ninguno final: (día, 20 − orden). Los órdenes finales son los de
 * siempre (0–8, MAX_STEPS_PER_DAY los deja en 0–3) y los provisionales
 * quedan en 12–20.
 */
export async function reorderSteps(tx: WorkspaceTx, sequenceId: string, orderedIds: readonly string[]): Promise<void> {
  const seq = await lockSequence(tx, sequenceId);
  assertEditable(seq, true);
  const current = await readSteps(tx, sequenceId);
  const ids = new Set(orderedIds);
  if (ids.size !== orderedIds.length || ids.size !== current.length || current.some((s) => !ids.has(s.id))) {
    throw new CadenciaError('invalid', 'El orden nuevo tiene que nombrar todos los pasos de la secuencia, una vez cada uno.');
  }
  if (current.some((s) => s.orderInDay > 8)) throw new CadenciaError('invalid', 'Un día tiene demasiados pasos para reordenarlo.');
  await tx.query(
    `UPDATE outbound_step SET order_in_day = 20 - order_in_day WHERE sequence_id = $1::uuid`,
    [sequenceId],
  );
  for (const [k, id] of orderedIds.entries()) {
    const slot = current[k]!;
    await tx.query(
      `UPDATE outbound_step SET day_offset = $2::int, order_in_day = $3::int WHERE id = $1::uuid`,
      [id, slot.dayOffset, slot.orderInDay],
    );
  }
  // El paso que abría el hilo puede quedar segundo, y una respuesta primera: el hilo y su guía se rehacen.
  await normalizeSequenceThread(tx, sequenceId);
}
