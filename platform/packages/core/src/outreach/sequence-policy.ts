/**
 * Una secuencia frente a la política de la marca.
 *
 * El despachador aplica dos reglas de outbound_policy al reclamar:
 * max_touches_per_company (los mensajes a una marca en 90 días; los de
 * más se cancelan, company_cap) y min_days_between_touches (la separación
 * con el último; el mensaje espera). Con la política por defecto (4 y 3,
 * 0007) la cadencia recomendada de docs/ventas-outreach.md §5.3 no cabe:
 * tiene cinco mensajes, el último (síntesis, media kit y cotización) se
 * cancelaba en silencio y los pasos de días seguidos se estiraban a tres
 * días. Esta función lo dice ANTES de activar, con los pasos concretos,
 * para que la pantalla que enrola lo muestre.
 *
 * Es un mínimo: el tope cuenta también lo que la marca ya recibió de otras
 * secuencias del workspace, que aquí no se ve. La separación se mide en
 * los días de la secuencia (hábiles); un fin de semana en medio puede
 * cumplirla, así que un paso marcado «se corre» a veces no se corre.
 */

/** Los pasos que el despachador envía solo (los demás son borradores o tareas de una persona). */
export const DISPATCHABLE_STEP_TYPES = ['email', 'email_reply', 'linkedin_connect', 'linkedin_message', 'instagram_dm'] as const;
export type DispatchableStepType = (typeof DISPATCHABLE_STEP_TYPES)[number];

/**
 * Los pasos que hace una persona y no llevan texto de la cadencia: un
 * comentario o una reacción públicos y una tarea a mano. Ni texto fijo
 * ni generación, y el modelo no les reescribe la guía (§5.5). Es el
 * resto de los tipos editables fuera de DISPATCHABLE_STEP_TYPES
 * (WhatsApp, fase 2, es un mensaje y no entra); el CHECK
 * outbound_step_text_or_by_hand (0063) dice lo mismo, y una prueba de
 * @mc/db comprueba que las dos listas parten los tipos editables.
 * Una sola definición: la usan el recomendador, @mc/db y la pantalla.
 */
export const TEXTLESS_STEP_TYPES: readonly string[] = [
  'linkedin_comment', 'linkedin_like', 'instagram_comment', 'instagram_like', 'manual_task',
];

/** Un paso que hace una persona, sin texto (TEXTLESS_STEP_TYPES). */
export function isTextlessStep(stepType: string): boolean {
  return TEXTLESS_STEP_TYPES.includes(stepType);
}

export interface PolicyStep {
  id: string;
  stepType: string;
  dayOffset: number;
  orderInDay?: number;
}

export interface SequencePolicy {
  maxTouchesPerCompany: number;
  minDaysBetweenTouches: number;
}

export interface SequencePolicyCheck {
  /** Los pasos enviables que pasan del tope de mensajes a la marca: el despachador los cancela (company_cap). */
  overCap: string[];
  /** Los pasos enviables a menos días del anterior que la separación mínima: salen más tarde de lo configurado. */
  closerThanGap: string[];
}

/** ¿Qué pasos de la secuencia no se cumplirán como están, con esta política? Pura. */
export function checkSequenceAgainstPolicy(steps: readonly PolicyStep[], policy: SequencePolicy): SequencePolicyCheck {
  const sendable = steps
    .filter((s) => (DISPATCHABLE_STEP_TYPES as readonly string[]).includes(s.stepType))
    .sort((a, b) => a.dayOffset - b.dayOffset || (a.orderInDay ?? 0) - (b.orderInDay ?? 0));
  const cap = Math.max(0, Math.floor(policy.maxTouchesPerCompany));
  const overCap = sendable.slice(cap).map((s) => s.id);
  const closerThanGap: string[] = [];
  if (policy.minDaysBetweenTouches > 0) {
    for (let i = 1; i < sendable.length; i++) {
      if (sendable[i]!.dayOffset - sendable[i - 1]!.dayOffset < policy.minDaysBetweenTouches) closerThanGap.push(sendable[i]!.id);
    }
  }
  return { overCap, closerThanGap };
}
