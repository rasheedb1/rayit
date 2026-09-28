/**
 * El costo de una llamada al modelo, para la bitácora outbound_llm_call
 * (0046 §5.3): la regla del proyecto es registrar tokens y costo de CADA
 * llamada, y outbound_health suma ese costo contra llm_daily_cap_usd.
 *
 * Precios de lista de Anthropic en USD por millón de tokens (septiembre
 * de 2026). Van en micro-dólares por token, que son enteros para los
 * modelos que usa el producto: el costo se suma en enteros y se escribe
 * como decimal de seis cifras (numeric(14,6)), sin pasar por float.
 *
 * Un modelo que no está en la tabla LANZA: una llamada que no se puede
 * costear no puede quedar registrada con costo cero, porque el tope
 * diario no la vería.
 *
 * Es la ÚNICA tabla de precios del producto (pulido r5): el generador, el
 * juez y el clasificador del worker (llm.ts, anthropic.ts), la narrativa
 * del perfil y el recomendador de cadencias leen de aquí. Antes había
 * tres, con contratos distintos (una devolvía 0 para un modelo que no
 * conocía), y el tope de gasto dependía de cuál se actualizara.
 */
import type { Decimal } from '../facturacion.ts';

/** El modelo que escribe y juzga (la narrativa del perfil, el generador y el juez de VEN-12). */
export const MODEL_WRITER = 'claude-sonnet-5';
/** El modelo que clasifica (la intención de una respuesta, §5.7). */
export const MODEL_CLASSIFIER = 'claude-haiku-4-5-20251001';

/** Micro-dólares por token de entrada y de salida. $2/MTok = 2 µUSD por token. */
export const LLM_PRICES_MICRO_USD: Readonly<Record<string, { input: number; output: number }>> = {
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};

/**
 * Los dobles de las pruebas y de la demo sin llave (fake.ts, el
 * clasificador falso de intent.ts): no llaman a nadie y no cuestan. Un id
 * con este prefijo cuesta 0 por regla explícita, no por no estar en la
 * tabla; cualquier otro modelo sin precio lanza.
 */
export const FAKE_MODEL_PREFIX = 'on-cue-fake-';
const SIN_COSTO = { input: 0, output: 0 } as const;

export class UnknownModelPriceError extends Error {
  readonly model: string;
  constructor(model: string) {
    super(`No hay precio para el modelo «${model}»: agrégalo a LLM_PRICES_MICRO_USD antes de usarlo.`);
    this.name = 'UnknownModelPriceError';
    this.model = model;
  }
}

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** El costo en USD de una llamada, como decimal de seis cifras («0.004250»). */
export function llmCostUsd(usage: LlmUsage): Decimal {
  const precio = usage.model.startsWith(FAKE_MODEL_PREFIX) ? SIN_COSTO : LLM_PRICES_MICRO_USD[usage.model];
  if (!precio) throw new UnknownModelPriceError(usage.model);
  for (const n of [usage.inputTokens, usage.outputTokens]) {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`Tokens inválidos: ${n}.`);
  }
  const micro = BigInt(usage.inputTokens) * BigInt(precio.input) + BigInt(usage.outputTokens) * BigInt(precio.output);
  const entero = micro / 1_000_000n;
  const resto = (micro % 1_000_000n).toString().padStart(6, '0');
  return `${entero}.${resto}`;
}

/**
 * Lo que se estima que costará una llamada ANTES de hacerla, en USD, para
 * apartarlo del tope diario (outbound_llm_reservation, 0075): la entrada
 * por caracteres (unos tres por token) y la salida al tope. Es un número
 * porque la reserva lo compara y lo suma; sale del mismo decimal exacto
 * de llmCostUsd, y un modelo sin precio lanza aquí, antes de gastar.
 */
export function estimateCallUsd(model: string, promptChars: number, maxTokens: number): number {
  return Number(llmCostUsd({ model, inputTokens: Math.ceil(promptChars / 3), outputTokens: maxTokens }));
}
