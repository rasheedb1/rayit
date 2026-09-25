import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { MODEL_WRITER } from "@mc/core/outreach/llm-precios";
import type { NarrativeModel } from "@mc/core/outreach/narrativa";

/**
 * El modelo que escribe la narrativa del perfil comercial (VEN-11), con
 * el SDK oficial de Anthropic: claude-sonnet-5, una sola llamada de
 * Messages, sin herramientas. Implementa NarrativeModel de @mc/core, que
 * es lo único que el resto del código conoce: las pruebas le pasan un
 * cliente falso con una respuesta grabada y nunca salen a la red.
 *
 * Sin ANTHROPIC_API_KEY no hay modelo (narrativeModelFromEnv devuelve
 * null): la narrativa sale de la plantilla determinista y la pantalla
 * dice «redacción automática no configurada». La llave se consigue en
 * console.anthropic.com → API Keys (ver platform/.env.example).
 */

/** Lo único que se usa del cliente: así las pruebas pasan uno falso sin red. */
export type MessagesClient = Pick<Anthropic, "messages">;

/**
 * Esfuerzo bajo: tres párrafos con reglas claras no piden razonamiento
 * largo, y el esfuerzo es lo que más mueve el costo de salida.
 */
const EFFORT = "low" as const;

export function anthropicNarrativeModel(client: MessagesClient, model: string = MODEL_WRITER): NarrativeModel {
  return {
    model,
    async complete(prompt) {
      const res = await client.messages.create({
        model,
        max_tokens: prompt.maxTokens,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
        output_config: { effort: EFFORT },
      });
      // Una negativa o un texto cortado por el techo no lanzan: los
      // tokens se pagaron y se registran, y el verificador rechaza el
      // texto (vacío o con párrafos de menos), que es lo que pide otro intento.
      const text = res.stop_reason === "refusal"
        ? ""
        : res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return { text, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
    },
  };
}

/** Un minuto por llamada y un reintento del SDK: la acción de «Recalcular» no puede colgarse. */
const TIMEOUT_MS = 60_000;

/** El modelo con la llave del entorno, o null si no hay llave (canal no configurado). */
export function narrativeModelFromEnv(env: NodeJS.ProcessEnv = process.env): NarrativeModel | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  return anthropicNarrativeModel(new Anthropic({ apiKey, maxRetries: 1, timeout: TIMEOUT_MS }));
}
