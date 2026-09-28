/**
 * El modelo de lenguaje del outreach, detrás de una interfaz (VEN-12).
 *
 * El generador y el juez no conocen el SDK: piden un LlmClient. En
 * producción es el de Anthropic (anthropic.ts, con ANTHROPIC_API_KEY); en
 * las pruebas y sin llave, uno falso determinista. Así las pruebas nunca
 * necesitan red y la interfaz dice «canal no configurado» en vez de fallar.
 *
 * Cada llamada devuelve sus tokens y su costo en dólares: la regla del
 * proyecto es registrarlos todos (outbound_llm_call), y el tope diario del
 * workspace (outbound_policy.llm_daily_cap_usd) se mide contra esa suma.
 * El costo y la estimación los calcula llm-precios.ts (llmCostUsd,
 * estimateCallUsd), la única tabla de precios.
 */
import { MODEL_CLASSIFIER, MODEL_WRITER } from './llm-precios.ts';

/** Para qué es la llamada: el CHECK de outbound_llm_call.purpose. */
export type LlmPurpose = 'generate' | 'judge' | 'classify' | 'recommend';

/**
 * Los modelos. claude-sonnet-5 genera y juzga; claude-haiku-4-5 clasifica
 * (VEN-14). Los ids y sus precios viven en llm-precios.ts, la única tabla.
 */
export const OUTREACH_MODELS = {
  generate: MODEL_WRITER,
  judge: MODEL_WRITER,
  classify: MODEL_CLASSIFIER,
} as const;

/**
 * La temperatura que pide la pieza: 0,7 para generar y 0 para juzgar.
 * Los modelos posteriores a Claude Opus 4.6 (claude-sonnet-5 entre ellos)
 * rechazan con un 400 cualquier temperatura distinta de 1: para ellos no
 * se envía, y la variedad (o la estabilidad del juez) sale del prompt y de
 * la salida estructurada. Haiku 4.5 sí la acepta.
 */
export const INTENDED_TEMPERATURE: Readonly<Record<LlmPurpose, number>> = {
  generate: 0.7,
  judge: 0,
  classify: 0,
  recommend: 0.3,
};
const MODELS_WITHOUT_SAMPLING = new Set(['claude-sonnet-5', 'claude-opus-5', 'claude-opus-5-5', 'claude-fable-5', 'claude-fable-5-1']);

/** La temperatura que se envía a un modelo, o undefined si el modelo no la acepta. */
export function temperatureFor(model: string, purpose: LlmPurpose): number | undefined {
  return MODELS_WITHOUT_SAMPLING.has(model) ? undefined : INTENDED_TEMPERATURE[purpose];
}

/** Tope de tokens de salida del generador por tipo de paso: un comentario no necesita lo que un correo. */
export const GENERATION_MAX_TOKENS: Readonly<Record<string, number>> = {
  email: 900,
  email_reply: 600,
  linkedin_message: 500,
  instagram_dm: 450,
  whatsapp_message: 400,
  linkedin_connect: 300,
  linkedin_comment: 300,
  instagram_comment: 250,
};
export const JUDGE_MAX_TOKENS = 700;

export interface LlmRequest {
  purpose: LlmPurpose;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  /** JSON Schema de la salida (salida estructurada): el texto de la respuesta es ese JSON. */
  jsonSchema?: Record<string, unknown>;
}

export interface LlmResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** end_turn, max_tokens, refusal… Lo que dijo el proveedor. */
  stopReason: string | null;
}

/** Lo que acompaña a una llamada sin ser parte de ella: la señal que la corta (el plazo del job). */
export interface LlmCallOptions {
  signal?: AbortSignal;
}

export interface LlmClient {
  /** Un nombre para el registro («anthropic», «fake»). */
  readonly name: string;
  /** Con `signal`, la llamada se corta en cuanto el job se aborta (no espera a su propio tiempo límite). */
  complete(req: LlmRequest, opts?: LlmCallOptions): Promise<LlmResponse>;
}

/** La respuesta del modelo no se pudo leer (JSON roto, cortada por el tope, rechazada). */
export class LlmOutputError extends Error {
  readonly stopReason: string | null;
  /** Lo que costó la llamada que falló: también se registra (se pagó igual). */
  usage: Pick<LlmResponse, 'model' | 'inputTokens' | 'outputTokens' | 'costUsd'> | null = null;
  constructor(message: string, stopReason: string | null) {
    super(message);
    this.name = 'LlmOutputError';
    this.stopReason = stopReason;
  }
}

/** Lee la respuesta con `read`; si no se puede, el error lleva el costo de la llamada. */
export function readLlmResponse<T>(res: LlmResponse, read: (value: unknown) => T): T {
  try {
    return read(parseJsonResponse(res));
  } catch (e) {
    if (e instanceof LlmOutputError) {
      e.usage = { model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd };
    }
    throw e;
  }
}

/** Lee el JSON de una respuesta; tolera un bloque ```json alrededor. */
export function parseJsonResponse(res: LlmResponse): unknown {
  if (res.stopReason === 'refusal') throw new LlmOutputError('El modelo rechazó la petición.', res.stopReason);
  if (res.stopReason === 'max_tokens') throw new LlmOutputError('La respuesta se cortó en el tope de tokens.', res.stopReason);
  const t = res.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch {
    throw new LlmOutputError('La respuesta no es JSON.', res.stopReason);
  }
}
