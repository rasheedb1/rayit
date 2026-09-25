/**
 * El hilo de correo de una secuencia (VEN-13), en una sola regla para el
 * recomendador (recommendSequence) y para la línea de tiempo editable
 * (@mc/db/queries/cadencias, al reordenar, quitar, añadir o cambiar el
 * tipo de un paso):
 *
 *   · el primer correo de la secuencia abre el hilo: es `email`, nunca
 *     `email_reply` (una respuesta sin hilo la retendría el despachador,
 *     reply_without_thread);
 *   · los correos siguientes responden en ese hilo: `email_reply`;
 *   · salvo el cierre (el ángulo `sintesis`) cuando ya es `email`: las
 *     plantillas lo piden como hilo nuevo, con su propio asunto, para que
 *     el media kit no quede enterrado al fondo de la conversación;
 *   · y salvo el paso que la persona acaba de poner como correo nuevo a
 *     propósito (`keepNewThread`): su elección vale en ese cambio.
 *
 * Solo decide tipos. La guía de un paso que cambia de tipo la recompone
 * guidanceAfterRetype (recomendar.ts), si no la escribió la persona.
 */

export interface ThreadStep {
  stepType: string;
  channel: string;
  angleKey: string | null;
}

/** El ángulo del cierre: el único correo que puede abrir un hilo nuevo después del primero. */
export const NEW_THREAD_ANGLE = 'sintesis';

/**
 * El tipo que debe tener cada paso, en el orden en que salen. Los que no
 * son de correo se devuelven como estaban.
 */
export function normalizeThread(
  steps: readonly ThreadStep[],
  opts: { keepNewThread?: (index: number) => boolean } = {},
): string[] {
  let opened = false;
  return steps.map((s, i) => {
    if (s.channel !== 'email' || (s.stepType !== 'email' && s.stepType !== 'email_reply')) return s.stepType;
    if (!opened) {
      opened = true;
      return 'email';
    }
    const newThread = s.stepType === 'email' && (s.angleKey === NEW_THREAD_ANGLE || opts.keepNewThread?.(i) === true);
    return newThread ? 'email' : 'email_reply';
  });
}
