/**
 * El costo de una llamada al modelo, para outbound_llm_call (0046 §5.3).
 *
 * La regla del proyecto: cada llamada deja su fila con tokens y costo, y
 * outbound_health suma ese costo contra llm_daily_cap_usd. Los precios
 * son los de la API de Anthropic por millón de tokens (sin caché ni
 * lotes), en USD. Un modelo que no está en la tabla es un error: un
 * costo 0 silencioso dejaría el tope sin efecto.
 *
 * El cálculo es en micro-dólares enteros: un precio de 2 USD por millón
 * de tokens son 2 micro-dólares por token, así que no hay coma flotante
 * y el resultado entra exacto en numeric(14,6).
 */

/** USD por millón de tokens. claude-sonnet-5 genera y juzga; haiku clasifica (docs/ventas-outreach.md §5). */
export const LLM_PRICES_USD_PER_MTOK: Readonly<Record<string, { input: number; output: number }>> = {
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export class UnknownModelPriceError extends Error {
  readonly model: string;
  constructor(model: string) {
    super(`No hay precio para el modelo «${model}»: agrégalo a LLM_PRICES_USD_PER_MTOK antes de usarlo.`);
    this.name = 'UnknownModelPriceError';
    this.model = model;
  }
}

/** El costo en USD como decimal con seis cifras («0.004120»), listo para numeric(14,6). */
export function llmCostUsd(usage: LlmUsage): string {
  const price = LLM_PRICES_USD_PER_MTOK[usage.model];
  if (!price) throw new UnknownModelPriceError(usage.model);
  for (const n of [usage.inputTokens, usage.outputTokens]) {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`Tokens inválidos: ${n}`);
  }
  const micro = usage.inputTokens * price.input + usage.outputTokens * price.output;
  return `${Math.floor(micro / 1_000_000)}.${String(micro % 1_000_000).padStart(6, '0')}`;
}
