// @vitest-environment node
// (el SDK se niega a construirse en un entorno con `window`, como jsdom)
import { describe, expect, it, vi } from "vitest";
import respuesta from "./fixtures/sonnet-narrativa.json";
import { anthropicNarrativeModel, narrativeModelFromEnv, type MessagesClient } from "./narrativa";

/**
 * El adaptador del SDK de Anthropic para la narrativa (VEN-11), sin red:
 * un cliente falso devuelve una respuesta con la forma de Messages API.
 * Lo que se prueba es lo que el resto del código necesita: el texto
 * (solo los bloques de texto), los tokens para la bitácora, el modelo y
 * los parámetros de la llamada.
 */
function clienteFalso(res: unknown) {
  const create = vi.fn(async () => res);
  return { client: { messages: { create } } as unknown as MessagesClient, create };
}

const prompt = { system: "reglas", user: "datos", maxTokens: 4000 };

describe("anthropicNarrativeModel", () => {
  it("devuelve el texto sin el bloque de pensamiento y los tokens de la respuesta", async () => {
    const { client, create } = clienteFalso(respuesta);
    const r = await anthropicNarrativeModel(client).complete(prompt);
    expect(r.text.startsWith("Soy Laura y cocino fácil.")).toBe(true);
    expect(r.text.split("\n\n")).toHaveLength(3);
    expect(r).toMatchObject({ inputTokens: 3412, outputTokens: 287 });
    expect(create).toHaveBeenCalledWith({
      model: "claude-sonnet-5",
      max_tokens: 4000,
      system: "reglas",
      messages: [{ role: "user", content: "datos" }],
      output_config: { effort: "low" },
    });
  });

  it("una negativa vuelve texto vacío con sus tokens: se registran y el verificador pide otro intento", async () => {
    const { client } = clienteFalso({ ...respuesta, stop_reason: "refusal", usage: { ...respuesta.usage, output_tokens: 3 } });
    const r = await anthropicNarrativeModel(client).complete(prompt);
    expect(r).toEqual({ text: "", inputTokens: 3412, outputTokens: 3 });
  });

  it("sin ANTHROPIC_API_KEY no hay modelo: la narrativa sale de la plantilla", () => {
    expect(narrativeModelFromEnv({})).toBeNull();
    expect(narrativeModelFromEnv({ ANTHROPIC_API_KEY: "  " })).toBeNull();
    expect(narrativeModelFromEnv({ ANTHROPIC_API_KEY: "sk-ant-prueba" })?.model).toBe("claude-sonnet-5");
  });
});
