/**
 * El LlmClient de Anthropic (VEN-12), sobre @anthropic-ai/sdk.
 *
 * Lo usan el worker (generador, juez, clasificador) y, en la web, el
 * redactor de la guía de las cadencias (VEN-13): el mismo cliente, la
 * misma cuenta de tokens y la misma cota de lo que pudo cobrarse. Sin
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
 *     para no comerse el del job;
 *   · la señal del job llega a la petición: si el job se aborta, la
 *     llamada se corta ahí mismo (y sus reintentos), no al vencer su
 *     propio tiempo límite.
 */
import Anthropic from '@anthropic-ai/sdk';
import { temperatureFor, type LlmCallOptions, type LlmClient, type LlmRequest, type LlmResponse } from './llm.ts';
import { llmCostUsd } from './llm-precios.ts';

export const ANTHROPIC_TIMEOUT_MS = 60_000;
/** Los reintentos del SDK por defecto (429, 5xx, red). */
export const ANTHROPIC_MAX_RETRIES = 2;

export class AnthropicLlm implements LlmClient {
  readonly name = 'anthropic';
  readonly #client: Anthropic;
  /** Cuántas veces puede salir una misma petición (la primera y sus reintentos): cada una pudo cobrarse. */
  readonly attempts: number;

  constructor(opts: { apiKey: string; timeoutMs?: number; maxRetries?: number; client?: Anthropic }) {
    const maxRetries = opts.maxRetries ?? ANTHROPIC_MAX_RETRIES;
    this.attempts = maxRetries + 1;
    this.#client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries, timeout: opts.timeoutMs ?? ANTHROPIC_TIMEOUT_MS });
  }

  async complete(req: LlmRequest, opts: LlmCallOptions = {}): Promise<LlmResponse> {
    const temperature = temperatureFor(req.model, req.purpose);
    // La señal del job corta la petición (y sus reintentos) en cuanto vence el plazo: no se espera al tiempo límite del cliente.
    const res = await this.#client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      thinking: { type: 'disabled' },
      ...(temperature === undefined ? {} : { temperature }),
      ...(req.jsonSchema ? { output_config: { format: { type: 'json_schema' as const, schema: req.jsonSchema } } } : {}),
    }, opts.signal ? { signal: opts.signal } : undefined);
    let text = '';
    for (const block of res.content) if (block.type === 'text') text += block.text;
    const inputTokens = res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
    const outputTokens = res.usage.output_tokens;
    return {
      text,
      model: res.model,
      inputTokens,
      outputTokens,
      // El precio del modelo que se PIDIÓ (el que la reserva estimó); uno sin precio ya lanzó en estimateCallUsd.
      costUsd: Number(llmCostUsd({ model: req.model, inputTokens, outputTokens })),
      stopReason: res.stop_reason ?? null,
    };
  }
}

/**
 * Si un error deja la duda de que la API procesó la petición (y la
 * cobró): un tiempo de espera o un corte de conexión mientras llegaba la
 * respuesta. Un 4xx (llave, cuota, petición mal hecha) o un 5xx no se
 * cobran.
 */
export function mayHaveBeenBilled(e: unknown): boolean {
  return e instanceof Anthropic.APIConnectionError;
}

/**
 * Una cota superior de lo que costó una petición que falló después de
 * salir: la entrada estimada por su tamaño (unos tres caracteres por
 * token, de más para el español) y la salida completa, por cada intento.
 * Sobrestima a propósito: el tope diario no puede contar de menos.
 */
export function billedUpperBound(
  req: Pick<LlmRequest, 'model' | 'system' | 'user' | 'maxTokens'>,
  attempts: number,
): { model: string; inputTokens: number; outputTokens: number } {
  const n = Math.max(1, Math.floor(attempts));
  return {
    model: req.model,
    inputTokens: Math.ceil((req.system.length + req.user.length) / 3) * n,
    outputTokens: req.maxTokens * n,
  };
}

/** El cliente de Anthropic si hay llave; null si no (la llave es de On Cue y la pone el operador en el entorno del worker). */
export function anthropicLlmFromEnv(env: Record<string, string | undefined>): AnthropicLlm | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  return apiKey ? new AnthropicLlm({ apiKey }) : null;
}
