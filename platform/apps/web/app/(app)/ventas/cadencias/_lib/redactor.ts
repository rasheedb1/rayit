import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { RECOMMEND_MODEL, type GuidanceRequest, type GuidanceWriter } from "@mc/core";
import { GUIDANCE_OUTPUT_SCHEMA, parseGuidanceOutput } from "./redactor-salida";

/**
 * El redactor de la guía con Claude (VEN-13, docs/ventas-outreach.md §5.5).
 *
 * El recomendador de @mc/core decide los pasos con reglas; esto solo le
 * pide al modelo que reescriba la guía de cada paso para esta marca y
 * esta señal. Si no hay llave (ANTHROPIC_API_KEY, ver .env.example), la
 * pantalla lo dice y la guía sale de las reglas: nada se inventa ni se
 * bloquea. Las pruebas nunca llegan aquí: usan un redactor falso detrás
 * de la misma interfaz (GuidanceWriter).
 *
 * Lo que sale hacia la API: la señal, el nombre de la empresa, el brief
 * del creador y los pasos. Nada de la persona a la que se escribe.
 */

/** Si el servidor tiene la llave de Anthropic. Sin ella no se llama al modelo. */
export function redactorConfigurado(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim());
}

const SISTEMA = `Eres el editor de cadencias de On Cue, una plataforma para creadores de contenido que les escriben a marcas para conseguir campañas pagadas.

Recibes una secuencia de pasos ya decidida (día, canal, ángulo) y un borrador de guía para cada paso. La guía NO es el mensaje: es la instrucción que seguirá quien redacte el mensaje de ese paso.

Reescribe la guía de cada paso para esta marca y esta señal, en español neutro, en segunda persona («abre con…»):
- Una o dos frases, entre 60 y 280 caracteres.
- Di con qué abrir, qué no mencionar (respeta lo prohibido del ángulo) y cómo cerrar (una sola pregunta, salvo en comentarios públicos y en el cierre).
- No inventes cifras, clientes ni resultados. Si hace falta una cifra, di de dónde sale («una cifra de tu perfil»).
- No uses marcadores ni huecos como {{nombre}} o [MARCA].
- No cambies el canal, el día ni el ángulo del paso.
- Si la señal es la colaboración de un competidor, nunca pidas nombrar esa colaboración ni a la competencia.

Devuelve un objeto con "steps": un elemento por paso, con su "index" y su "guidance".`;

/** El redactor real, con el cliente de la API. */
export function redactorAnthropic(client: Anthropic = new Anthropic()): GuidanceWriter {
  return async (req: GuidanceRequest) => {
    const response = await client.messages.create(
      {
        model: RECOMMEND_MODEL,
        max_tokens: 4000,
        system: SISTEMA,
        messages: [{ role: "user", content: JSON.stringify(req) }],
        output_config: { effort: "low", format: { type: "json_schema", schema: { ...GUIDANCE_OUTPUT_SCHEMA } } },
      },
      { timeout: 45_000, maxRetries: 1 },
    );
    const usage = { model: RECOMMEND_MODEL, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
    // Una negativa o un corte por longitud se cobran igual: la llamada se registra y la guía se queda con las reglas.
    if (response.stop_reason !== "end_turn") return { steps: [], usage };
    const texto = response.content.find((b) => b.type === "text");
    return { steps: parseGuidanceOutput(texto?.type === "text" ? texto.text : null), usage };
  };
}
