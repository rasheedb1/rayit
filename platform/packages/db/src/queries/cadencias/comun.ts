/**
 * Cadencias · lo que comparten todas las consultas (VEN-13): límites,
 * errores con código, el bloqueo de una secuencia y la regla de qué se
 * puede editar. Dueño: Rasheed.
 */
import { DISPATCHABLE_STEP_TYPES, RECOMMEND_CHANNELS, SEQUENCE_MAX_DAY_OFFSET } from '@mc/core';
import type { WorkspaceTx } from '../../client.ts';
import { isUuid } from '../../client.ts';
import { STEP_TYPES, type StepType } from '../../schema/outreach.ts';
import type { SEQUENCE_STATUSES } from '../../schema/ventas.ts';

// ---------------------------------------------------------------------
// Límites
// ---------------------------------------------------------------------

/** Pasos como máximo en una secuencia (lo mismo que admite una plantilla, 0037). */
export const MAX_STEPS = 12;
/** Pasos como máximo en un mismo día. */
export const MAX_STEPS_PER_DAY = 4;
/** El último día al que se puede poner un paso (CHECK de outbound_step). */
export const MAX_DAY_OFFSET = SEQUENCE_MAX_DAY_OFFSET;
export const GUIDANCE_MAX = 1000;
export const SUBJECT_MAX = 200;
export const BODY_MAX = 5000;
export const NAME_MAX = 120;
/** Los estados que ven la lista y la pantalla (outbound_sequence.status, SEQUENCE_STATUSES del esquema). */
export type SequenceStatus = (typeof SEQUENCE_STATUSES)[number];
/** Los que no terminaron: siguen ocupando a la persona dentro de la secuencia. */
export const LIVE_ENROLLMENT_STATUSES = ['active', 'paused', 'cooldown'] as const;

/**
 * Los tipos de paso que se pueden poner a mano en la línea de tiempo.
 * WhatsApp es fase 2 (§5.1): no hay conector, el recomendador no lo usa
 * (RECOMMEND_CHANNELS) y el editor no lo ofrece.
 */
export type EditableStepType = Exclude<StepType, 'whatsapp_message'>;
export const EDITABLE_STEP_TYPES = STEP_TYPES.filter((s): s is EditableStepType => s !== 'whatsapp_message') as [
  EditableStepType,
  ...EditableStepType[],
];
/** Los canales de un paso editable: los del recomendador (una tarea a mano elige uno de estos). */
export const EDITABLE_CHANNELS = RECOMMEND_CHANNELS;

/** Los pasos sin texto: ni guía de texto fijo ni generación. */
export const TEXTLESS_STEP_TYPES: readonly string[] = ['linkedin_like', 'instagram_like', 'manual_task'];

/** Un paso que el despachador envía (un mensaje a la persona); los demás los hace alguien a mano. */
export function isMessageStep(stepType: string): boolean {
  return (DISPATCHABLE_STEP_TYPES as readonly string[]).includes(stepType);
}

// ---------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------

export type CadenciaErrorCode =
  | 'not_found'
  | 'has_enrollments'
  | 'archived'
  | 'no_steps'
  | 'too_many_steps'
  | 'day_full'
  | 'invalid'
  | 'no_template'
  | 'no_signal';

/** Un error con código: la pantalla lo traduce en su messages.ts. */
export class CadenciaError extends Error {
  readonly code: CadenciaErrorCode;
  constructor(code: CadenciaErrorCode, detail: string) {
    super(detail);
    this.name = 'CadenciaError';
    this.code = code;
  }
}

export function assertId(fn: string, id: string): void {
  if (!isUuid(id)) throw new CadenciaError('invalid', `${fn}: «${id}» no es un uuid.`);
}

/** El canal que exige cada tipo de paso (el CHECK de outbound_step). manual_task: el que diga el paso. */
export function channelForStepType(stepType: StepType, fallback: string = 'email'): string {
  if (stepType === 'email' || stepType === 'email_reply') return 'email';
  if (stepType.startsWith('linkedin_')) return 'linkedin';
  if (stepType.startsWith('instagram_')) return 'instagram_dm';
  if (stepType === 'whatsapp_message') return 'whatsapp';
  return fallback;
}

export function cleanName(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim();
  if (!n) throw new CadenciaError('invalid', 'La secuencia necesita un nombre.');
  return [...n].slice(0, NAME_MAX).join('');
}

// ---------------------------------------------------------------------
// El bloqueo y la regla de la edición
// ---------------------------------------------------------------------

export interface SequenceState {
  id: string;
  status: SequenceStatus;
  enrolled: number;
  /** La señal de la que salió, o null. */
  signal_id: string | null;
}

/** La secuencia bloqueada para esta transacción: dos ediciones a la vez no se pisan el orden. */
export async function lockSequence(tx: WorkspaceTx, id: string): Promise<SequenceState> {
  assertId('cadencias', id);
  const s = (
    await tx.query<SequenceState>(
      `SELECT s.id, s.status, s.signal_id, (SELECT count(*) FROM outbound_enrollment e WHERE e.sequence_id = s.id)::int AS enrolled
         FROM outbound_sequence s WHERE s.id = $1::uuid FOR UPDATE`,
      [id],
    )
  ).rows[0];
  if (!s) throw new CadenciaError('not_found', `La secuencia ${id} no existe o no es de este espacio.`);
  return s;
}

/**
 * La regla de la edición: mientras nadie esté dentro, todo se cambia.
 * Con alguien enrolado, lo que cambia la forma (día, canal, orden, pasos
 * de más o de menos) se rechaza con `has_enrollments`.
 */
export function assertEditable(s: SequenceState, structural: boolean): void {
  if (s.status === 'archived') throw new CadenciaError('archived', 'La secuencia está archivada: duplícala para cambiarla.');
  if (structural && s.enrolled > 0) {
    throw new CadenciaError('has_enrollments', 'Ya hay personas en esta secuencia: sus días y canales no se cambian.');
  }
}
