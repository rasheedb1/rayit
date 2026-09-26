import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  GUIDANCE_PHRASES, GuidanceWriterError, RECOMMEND_MODEL, type GuidanceLocale, type GuidanceRequest, type GuidanceWriter, type LlmUsage,
} from "@mc/core";
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
const MAX_TOKENS = 4000;
/** Reintentos del cliente: un tiempo de espera se reintenta una vez, y cada intento pudo cobrarse. */
const MAX_RETRIES = 1;

/**
 * Una cota superior de lo que costó una petición que falló después de
 * salir: la entrada estimada por su tamaño (unos tres caracteres por
 * token, de más para el español) y la salida completa, por cada intento.
 * Sobrestima a propósito: el tope diario no puede contar de menos.
 */
export function usoEstimado(system: string, user: string): LlmUsage {
  const intentos = MAX_RETRIES + 1;
  return {
    model: RECOMMEND_MODEL,
    inputTokens: Math.ceil((system.length + user.length) / 3) * intentos,
    outputTokens: MAX_TOKENS * intentos,
  };
}

/**
 * Si el error deja la duda de que la API procesó la petición: un tiempo
 * de espera o un corte de conexión. Un 4xx (llave, cuota, petición mal
 * hecha) o un 5xx no se cobran.
 */
function pudoCobrarse(e: unknown): boolean {
  return e instanceof Anthropic.APIConnectionError;
}

/** El redactor real, con el cliente de la API. */
export function redactorAnthropic(client: Anthropic = new Anthropic()): GuidanceWriter {
  return async (req: GuidanceRequest) => {
    const system = instruccionDeSistema(req.locale);
    const user = JSON.stringify(req);
    let response: Anthropic.Message;
    try {
      response = await client.messages.create(
        {
          model: RECOMMEND_MODEL,
          max_tokens: MAX_TOKENS,
          system,
          messages: [{ role: "user", content: user }],
          output_config: { effort: "low", format: { type: "json_schema", schema: { ...GUIDANCE_OUTPUT_SCHEMA } } },
        },
        { timeout: 45_000, maxRetries: MAX_RETRIES },
      );
    } catch (e) {
      // Un tiempo de espera o un corte mientras llegaba la respuesta: la llamada pudo cobrarse y se registra con su cota.
      throw new GuidanceWriterError("el redactor de la guía falló", pudoCobrarse(e) ? usoEstimado(system, user) : null, { cause: e });
    }
    const usage = { model: RECOMMEND_MODEL, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
    // Una negativa o un corte por longitud se cobran igual: la llamada se registra y la guía se queda con las reglas.
    if (response.stop_reason !== "end_turn") return { steps: [], usage };
    const texto = response.content.find((b) => b.type === "text");
    return { steps: parseGuidanceOutput(texto?.type === "text" ? texto.text : null), usage };
  };
}
