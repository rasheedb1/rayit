/**
 * Lo que comparten outbound.generate y outbound.review (VEN-12): con qué
 * modelo se redacta y se juzga. Cómo se pasa del contexto de la base a la
 * entrada del generador y qué estado le toca al toque según la puerta de
 * calidad, la política y el calentamiento por tipo de paso está en @mc/db
 * (generation-mapping.ts) y se reexporta aquí.
 *
 * El modelo:
 *   · con ANTHROPIC_API_KEY, claude-sonnet-5 genera y juzga;
 *   · sin ella, nada: los borradores esperan y el job lo dice
 *     («redacción con IA no configurada»). Nunca un texto de ejemplo en
 *     una base de verdad;
 *   · OUTREACH_WRITER=fake, el generador y el juez falsos deterministas,
 *     con la misma regla que el canal falso (fakeAllowed): Postgres
 *     embebido, una base local o una corrida de la demo; nunca en producción.
 */
import { anthropicLlmFromEnv } from '@mc/core/outreach/anthropic';
import { createFakeGenerator, createFakeJudge } from '@mc/core/outreach/fake';
import { LlmMessageGenerator, type MessageGenerator } from '@mc/core/outreach/generate';
import { LlmMessageJudge, type MessageJudge } from '@mc/core/outreach/judge';
import { ConfigError, type Env } from '../../runner/config.ts';
import { fakeAllowed, type ChannelScope } from './canales/index.ts';

export interface Writers {
  mode: 'anthropic' | 'fake';
  generator: MessageGenerator;
  judge: MessageJudge;
}

/** El generador y el juez de esta corrida, o null si la redacción con IA no está configurada. */
export function writersFrom(env: Env, scope: ChannelScope): Writers | null {
  if (env['OUTREACH_WRITER'] === 'fake') {
    if (env['NODE_ENV'] === 'production' || !fakeAllowed(scope)) {
      throw new ConfigError(
        'OUTREACH_WRITER=fake solo con Postgres embebido, una base local o el workspace de la demo, y nunca en producción: ' +
          'el redactor falso escribe mensajes de ejemplo.',
      );
    }
    return { mode: 'fake', generator: createFakeGenerator(), judge: createFakeJudge() };
  }
  const llm = anthropicLlmFromEnv(env);
  if (!llm) return null;
  return { mode: 'anthropic', generator: new LlmMessageGenerator(llm), judge: new LlmMessageJudge(llm) };
}

// La entrada del generador, el estado final y las filas de outbound_review
// viven en @mc/db (generation-mapping.ts): la demo embebida de la web
// redacta con las mismas reglas. Se reexportan para quien ya las leía aquí.
export {
  AVOID_IN_PROMPT, finalStateFor, generationFinalFrom, generationInputFrom, requestedByPerson, reviewRowsFrom,
} from '@mc/db/queries/outreach';
