import { describe, expect, it } from "vitest";
import { PLATFORM_LABELS, PLATFORM_ORDER } from "@mc/core/plataformas";
import { PLATFORM_LABEL } from "@/components/ui/platform-pill";

/**
 * Los nombres de las redes viven hoy en dos sitios: PLATFORM_LABEL del
 * kit (la pantalla) y PLATFORM_LABELS de @mc/core (el prompt y la
 * narrativa de plantilla, que no pueden importar la web). Hasta que el kit
 * los importe de @mc/core (PR de unificación, rama
 * rasheed/kit-plataformas-desde-core, a revisar por Nicolás), esta prueba
 * impide que se separen: la narrativa no puede decir «Tiktok» mientras la
 * pantalla dice «TikTok».
 */
describe("los nombres de las redes", () => {
  it("son los mismos en el kit y en @mc/core", () => {
    expect(PLATFORM_LABEL).toEqual(PLATFORM_LABELS);
  });

  it("el orden de @mc/core recorre las mismas redes que el kit, una vez cada una", () => {
    expect([...PLATFORM_ORDER].sort()).toEqual(Object.keys(PLATFORM_LABEL).sort());
  });
});
