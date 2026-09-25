/**
 * El LlmClient de Anthropic (VEN-12), sobre @anthropic-ai/sdk.
 *
 * Solo lo importa el worker: la web no llama al modelo. Sin
 * ANTHROPIC_API_KEY, `anthropicLlmFromEnv` devuelve null y quien lo usa
 * cae al generador y al juez falsos (y la interfaz lo dice).
 *
 * Decisiones:
 *   · salida estructurada (output_config.format con JSON Schema): el
 *     generador devuelve {subject, body} y el juez sus notas, sin tener
 *     que pelear con texto libre;
 *   · sin temperatura para claude-sonnet-5, que la rechaza (llm.ts);
 *   · sin pensamiento extendido: es un texto corto con instrucciones
 *     cerradas, y el pensamiento se cobra como salida;
 *   · dos reintentos del SDK (429, 5xx, red), y un tiempo límite corto
 *     para no comerse el del job.
 */
import Anthropic from '@anthropic-ai/sdk';
import { llmCostUsd, temperatureFor, type LlmClient, type LlmRequest, type LlmResponse } from './llm.ts';

export const ANTHROPIC_TIMEOUT_MS = 60_000;

export class AnthropicLlm implements LlmClient {
  readonly name = 'anthropic';
  readonly #client: Anthropic;

  constructor(opts: { apiKey: string; timeoutMs?: number; client?: Anthropic }) {
    this.#client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: opts.timeoutMs ?? ANTHROPIC_TIMEOUT_MS });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const temperature = temperatureFor(req.model, req.purpose);
    const res = await this.#client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      thinking: { type: 'disabled' },
      ...(temperature === undefined ? {} : { temperature }),
      ...(req.jsonSchema ? { output_config: { format: { type: 'json_schema' as const, schema: req.jsonSchema } } } : {}),
    });
    let text = '';
    for (const block of res.content) if (block.type === 'text') text += block.text;
    const inputTokens = res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
    const outputTokens = res.usage.output_tokens;
    return {
      text,
      model: res.model,
      inputTokens,
      outputTokens,
      costUsd: llmCostUsd(req.model, inputTokens, outputTokens),
      stopReason: res.stop_reason ?? null,
    };
  }
}

/** El cliente de Anthropic si hay llave; null si no (la llave es de On Cue y la pone el operador en el entorno del worker). */
export function anthropicLlmFromEnv(env: Record<string, string | undefined>): AnthropicLlm | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  return apiKey ? new AnthropicLlm({ apiKey }) : null;
}
