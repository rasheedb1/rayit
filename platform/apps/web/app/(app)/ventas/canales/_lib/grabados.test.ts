// @vitest-environment node
/**
 * VEN-9 · la puerta de salida a clientes: la historia no pasa a «hecho»
 * sin haber grabado contra Google y Unipile de verdad el camino que su
 * «terminado cuando» promete (conectar Gmail y LinkedIn, recibir un
 * mensaje y un cambio de salud).
 *
 * Las pruebas de canales corren contra dobles (FakeGmail, FakeUnipile) y
 * fixtures armados de la documentación; lo que ninguna de ellas puede
 * probar es que el servicio responda así. Eso lo prueba una grabación
 * (packages/connectors/scripts/record-outreach.ts), que deja cada
 * respuesta en fixtures/<proveedor>/<endpoint>.recorded.json, y la prueba
 * de @mc/connectors (outreach-grabacion.test.ts) la pasa por los
 * normalizadores de producción. Aquí solo se ata el estado del backlog a
 * que esas grabaciones existan.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR } from "@mc/connectors";
import { recordedFileName, REQUIRED_OUTREACH_RECORDINGS } from "@mc/connectors/testing";
import { STORIES } from "@/content/backlog";

async function recordedAt(entry: string): Promise<string | null> {
  try {
    const fx = JSON.parse(await readFile(join(FIXTURES_DIR, recordedFileName(entry)), "utf8")) as { meta?: { source?: string; recordedAt?: string } };
    return fx.meta?.source === "recorded" ? fx.meta.recordedAt ?? null : null;
  } catch {
    return null;
  }
}

describe("VEN-9 y las grabaciones reales", () => {
  it("VEN-9 solo está hecha si cada respuesta del camino feliz se grabó contra el servicio, y la nota dice cuándo", async () => {
    const story = STORIES.find((s) => s.id === "VEN-9")!;
    const dates = await Promise.all(REQUIRED_OUTREACH_RECORDINGS.map(recordedAt));
    const missing = REQUIRED_OUTREACH_RECORDINGS.filter((_, i) => dates[i] === null);
    if (story.status === "hecho") {
      expect(missing, "grabaciones que faltan para dar VEN-9 por hecha").toEqual([]);
      const days = [...new Set(dates as string[])];
      expect(days.some((d) => story.note?.includes(d)), "la nota de VEN-9 lleva la fecha de la grabación").toBe(true);
    } else {
      // Sin grabar no es «hecho», y la nota dice qué falta y cómo se destraba.
      expect(missing.length + (story.status === "en_curso" ? 1 : 0), "VEN-9 no está hecha: algo tiene que faltar").toBeGreaterThan(0);
      expect(story.note ?? "").toMatch(/record:outreach|grabar/);
    }
  });
});
