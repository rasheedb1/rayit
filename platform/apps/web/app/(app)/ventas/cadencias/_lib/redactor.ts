import "server-only";
import {
  GUIDANCE_PHRASES, GuidanceWriterError, RECOMMEND_MODEL, type GuidanceLocale, type GuidanceRequest, type GuidanceWriter,
} from "@mc/core";
import { AnthropicLlm, billedUpperBound, mayHaveBeenBilled } from "@mc/core/outreach/anthropic";
import type { LlmClient, LlmRequest } from "@mc/core/outreach/llm";
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
 * del creador (con los formatos que ofrece y su ventana) y los pasos.
 * Nada de la persona a la que se escribe.
 *
 * El cliente es el de @mc/core/outreach/anthropic (AnthropicLlm), el mismo
 * del generador y del juez: la misma petición, la misma cuenta de tokens
 * y la misma cota de lo que pudo cobrarse (billedUpperBound). Aquí solo
 * viven el prompt y el esquema de salida (redactor-salida.ts).
 */

/** Si el servidor tiene la llave de Anthropic. Sin ella no se llama al modelo. */
export function redactorConfigurado(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim());
}

/**
 * La instrucción del sistema, en el idioma de la petición (req.locale):
 * el mismo de la guía compuesta con reglas (GUIDANCE_PHRASES), para que
 * ningún paso quede en otro idioma que sus vecinos. La frase del idioma
 * sale de la tabla de ese idioma, no de aquí.
 */
export function instruccionDeSistema(locale: GuidanceLocale): string {
  return `Eres el editor de cadencias de On Cue, una plataforma para creadores de contenido que les escriben a marcas para conseguir campañas pagadas.

Recibes una secuencia de pasos ya decidida (día, canal, ángulo) y un borrador de guía para cada paso de mensaje. La guía NO es el mensaje: es la instrucción que seguirá quien redacte el mensaje de ese paso. Solo recibes los pasos que llevan mensaje: una reacción, un comentario público o una tarea a mano los hace una persona, no se escribe nada para ellos y no devuelves guía para ellos.

Reescribe la guía de cada paso para esta marca y esta señal, en ${GUIDANCE_PHRASES[locale].promptLanguage} (idioma «${locale}»), en segunda persona («abre con…»):
- Una o dos frases, entre 60 y 280 caracteres.
- Di con qué abrir, qué no mencionar (respeta lo prohibido del ángulo) y cómo cerrar (una sola pregunta, salvo en el cierre).
- Devuelve guía solo para los "index" que recibiste.
- No inventes cifras, clientes ni resultados. Si hace falta una cifra, di de dónde sale («una cifra de tu perfil»).
- No uses marcadores ni huecos como {{nombre}} o [MARCA].
- No cambies el canal, el día ni el ángulo del paso.
- Si la señal es la colaboración de un competidor, nunca pidas nombrar esa colaboración ni a la competencia.
- Si la petición trae "briefOffer", son los formatos que ofrece el creador y su ventana de disponibilidad: no propongas otros formatos ni fechas fuera de esa ventana.

Devuelve un objeto con "steps": un elemento por paso, con su "index" y su "guidance".`;
}

/** Lo que se le pide a la API por intento: hasta cuántos tokens puede devolver. */
export const MAX_TOKENS = 4000;
/** Reintentos del cliente: un tiempo de espera se reintenta una vez, y cada intento pudo cobrarse. */
const MAX_RETRIES = 1;
/** Cuántas veces puede salir una petición del redactor: con eso se aparta del tope y se acota lo que un corte pudo cobrar. */
export const REDACTOR_ATTEMPTS = MAX_RETRIES + 1;
/** Menos que el del worker: quien espera es una persona delante de «Proponer cadencia». */
const TIMEOUT_MS = 45_000;

/** El cliente del redactor: el de @mc/core con la llave del servidor, un reintento y su tiempo límite. */
function clienteDelRedactor(): AnthropicLlm {
  return new AnthropicLlm({ apiKey: process.env.ANTHROPIC_API_KEY?.trim() ?? "", timeoutMs: TIMEOUT_MS, maxRetries: MAX_RETRIES });
}

/** La petición al modelo para una guía: el prompt de aquí y el esquema de redactor-salida.ts. */
export function peticionDeGuia(req: GuidanceRequest): LlmRequest {
  return {
    purpose: "recommend",
    model: RECOMMEND_MODEL,
    system: instruccionDeSistema(req.locale),
    user: JSON.stringify(req),
    maxTokens: MAX_TOKENS,
    jsonSchema: { ...GUIDANCE_OUTPUT_SCHEMA },
  };
}

/**
 * El redactor real. `llm` es el cliente de @mc/core (en las pruebas, uno
 * falso detrás de la misma interfaz) y `attempts`, cuántas veces puede
 * salir una petición: con eso se acota lo que un corte pudo cobrar.
 */
export function redactorAnthropic(llm: LlmClient = clienteDelRedactor(), attempts = REDACTOR_ATTEMPTS): GuidanceWriter {
  return async (req: GuidanceRequest) => {
    const peticion = peticionDeGuia(req);
    let response: Awaited<ReturnType<LlmClient["complete"]>>;
    try {
      response = await llm.complete(peticion);
    } catch (e) {
      // Un tiempo de espera o un corte mientras llegaba la respuesta: la llamada pudo cobrarse y se registra con su cota.
      throw new GuidanceWriterError("el redactor de la guía falló", mayHaveBeenBilled(e) ? billedUpperBound(peticion, attempts) : null, {
        cause: e,
      });
    }
    // El modelo de la petición (el que tiene precio), no el alias que devuelva la API.
    const usage = { model: RECOMMEND_MODEL, inputTokens: response.inputTokens, outputTokens: response.outputTokens };
    // Una negativa o un corte por longitud se cobran igual: la llamada se registra y la guía se queda con las reglas.
    if (response.stopReason !== "end_turn") return { steps: [], usage };
    return { steps: parseGuidanceOutput(response.text || null), usage };
  };
}
