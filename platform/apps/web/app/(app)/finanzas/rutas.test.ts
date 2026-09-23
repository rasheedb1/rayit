// @vitest-environment node
/**
 * Las URLs que Finanzas deja escritas en la base —notification.action_url
 * de FIN-2 (pago recibido) y de FIN-4 (recordatorios)— sobreviven a los
 * despliegues: una notificación de hace un mes se abre con el código de
 * hoy. FIN-3 movió el archivo de facturas a /finanzas/facturas; el
 * detalle ya vivía en /finanzas/facturas/<id> y ahí sigue. Esta prueba
 * falla si alguien lo mueve sin dejar el camino.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { urlRecordatorio } from "@mc/core";

const FINANZAS = join(__dirname);
const ID = "00000003-0000-4000-8000-0000fac26007";

describe("las URLs guardadas en notification siguen abriendo una página", () => {
  it("FIN-4: el recordatorio lleva al detalle de la factura, que existe", () => {
    const url = new URL(urlRecordatorio(ID, 3), "https://on-cue.example");
    expect(url.pathname).toBe(`/finanzas/facturas/${ID}`);
    expect(existsSync(join(FINANZAS, "facturas", "[id]", "page.tsx"))).toBe(true);
  });

  it("FIN-2: el aviso de pago recibido apunta al mismo detalle", () => {
    const consulta = readFileSync(join(__dirname, "..", "..", "..", "..", "..", "packages", "db", "src", "queries", "finanzas.ts"), "utf8");
    expect(consulta).toContain("`/finanzas/facturas/${invoice.id}`");
  });
});
