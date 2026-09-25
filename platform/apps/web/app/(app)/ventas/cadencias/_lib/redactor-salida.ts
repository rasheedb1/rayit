/**
 * La forma de lo que el modelo devuelve al redactar la guía, y cómo se
 * lee. Pura, para probarla sin red (redactor.ts la usa).
 *
 * El modelo responde con salida estructurada (output_config.format, un
 * JSON Schema), así que el texto ya viene con esta forma; aun así se
 * valida con zod: un campo de más o un índice raro no llega a la base.
 */
import { z } from "zod";
import { GUIDANCE_MAX_CHARS } from "@mc/core";

/** El JSON Schema que se le pasa a la API. */
export const GUIDANCE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          guidance: { type: "string" },
        },
        required: ["index", "guidance"],
        additionalProperties: false,
      },
    },
  },
  required: ["steps"],
  additionalProperties: false,
} as const;

const salida = z.object({
  steps: z.array(z.object({ index: z.number().int().min(0).max(50), guidance: z.string().max(GUIDANCE_MAX_CHARS * 2) })).max(50),
});

/** Los pasos que devolvió el modelo, o [] si el texto no tiene la forma (la guía se queda con las reglas). */
export function parseGuidanceOutput(text: string | null | undefined): Array<{ index: number; guidance: string }> {
  if (!text) return [];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const r = salida.safeParse(json);
  return r.success ? r.data.steps : [];
}
