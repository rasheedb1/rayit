import { describe, expect, it } from "vitest";
import { verifyNarrativeWith } from "@mc/core/outreach/narrativa";
import type { CifraVista } from "./cifras";
import { aEditable, aMarcas, comoFicha, fichasDe } from "./fichas";

/** Las fichas del editor: el creador ve la cifra, no el id; lo guardado sigue con sus marcas. */
const cifra = (id: string, valor: string, que: string): CifraVista => ({
  id, key: "median", valor, que, origen: "Línea base del creador", href: `#origen-${id}`, externo: false,
});
const CIFRAS = Object.fromEntries(
  [
    cifra("mediana-tiktok", "115,4 mil", "Visualizaciones medianas por video en TikTok"),
    cifra("porque-a-duracion-corto", "3,0×", "Tus otros videos cortos"),
    cifra("porque-b-pieza-reel", "3,0×", "Tus otros reels"),
  ].map((c) => [c.id, c]),
);

describe("las fichas", () => {
  const fichas = fichasDe(CIFRAS);

  it("una cifra con valor único es su valor; dos con el mismo valor dicen además qué son", () => {
    expect(fichas.porId.get("mediana-tiktok")).toBe("115,4 mil");
    expect(fichas.porId.get("porque-a-duracion-corto")).toBe("3,0× · Tus otros videos cortos");
    expect(fichas.porId.get("porque-b-pieza-reel")).toBe("3,0× · Tus otros reels");
  });

  it("ida y vuelta: la narrativa guardada se edita con fichas y vuelve con las mismas marcas", () => {
    const guardada = "Mi mediana es [claim:mediana-tiktok]; mis cortos hacen [claim:porque-a-duracion-corto] y mis reels [claim:porque-b-pieza-reel].";
    const editable = aEditable(guardada, fichas);
    expect(editable).toBe("Mi mediana es ⟦115,4 mil⟧; mis cortos hacen ⟦3,0× · Tus otros videos cortos⟧ y mis reels ⟦3,0× · Tus otros reels⟧.");
    expect(editable).not.toContain("[claim:");
    expect(aMarcas(editable, fichas)).toBe(guardada);
  });

  it("una ficha tocada a mano vuelve como una marca que el verificador rechaza", () => {
    const ctx = { ids: Object.keys(CIFRAS), units: {}, terms: [] };
    const tocada = aMarcas("Mi mediana es ⟦2 millones⟧.", fichas);
    expect(tocada).toBe("Mi mediana es [claim:2 millones].");
    expect(verifyNarrativeWith(tocada, ctx, { paragraphs: null }).issues).toEqual([{ code: "malformed_marker", text: "[claim:2 millones]" }]);
    const inventada = aMarcas("Tengo ⟦inventada⟧.", fichas);
    expect(verifyNarrativeWith(inventada, ctx, { paragraphs: null }).issues).toEqual([{ code: "unknown_claim", id: "inventada" }]);
    // Y el problema se dice como el creador lo escribió.
    expect(comoFicha("[claim:2 millones]")).toBe("⟦2 millones⟧");
    expect(comoFicha("inventada")).toBe("⟦inventada⟧");
  });

  it("una marca escrita a mano con un id del perfil se deja tal cual", () => {
    expect(aMarcas("Mi mediana: [claim:mediana-tiktok].", fichas)).toBe("Mi mediana: [claim:mediana-tiktok].");
  });
});
