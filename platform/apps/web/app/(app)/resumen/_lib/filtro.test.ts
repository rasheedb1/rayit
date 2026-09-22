import { describe, expect, it } from "vitest";
import { hrefDe, MAX_PERIODO, parseFiltro, parsePeriodo, parseRed, PERIODO_POR_DEFECTO, salidaDelVacio } from "./filtro";

/**
 * El filtro de Resumen viaja en la URL, así que lo escribe cualquiera:
 * un `?periodo=chorizo` no puede llegar a Postgres ni tirar la página.
 */
describe("el filtro de la URL", () => {
  it("acepta los tres periodos y descarta el resto", () => {
    expect(parsePeriodo("7")).toBe(7);
    expect(parsePeriodo("90")).toBe(90);
    expect(parsePeriodo("45")).toBe(PERIODO_POR_DEFECTO);
    expect(parsePeriodo("chorizo")).toBe(PERIODO_POR_DEFECTO);
    expect(parsePeriodo(undefined)).toBe(PERIODO_POR_DEFECTO);
    // Sin esto, un "" se leería como Number("") = 0.
    expect(parsePeriodo("")).toBe(PERIODO_POR_DEFECTO);
  });

  it("acepta las cuatro redes y descarta el resto", () => {
    expect(parseRed("tiktok")).toBe("tiktok");
    expect(parseRed("twitter")).toBeNull();
    expect(parseRed(undefined)).toBeNull();
  });

  it("la URL canónica omite lo que ya es por defecto", () => {
    expect(hrefDe({ dias: PERIODO_POR_DEFECTO, red: null })).toBe("/resumen");
    expect(hrefDe({ dias: 90, red: null })).toBe("/resumen?periodo=90");
    expect(hrefDe({ dias: PERIODO_POR_DEFECTO, red: "tiktok" })).toBe("/resumen?red=tiktok");
    expect(hrefDe({ dias: 7, red: "youtube" })).toBe("/resumen?periodo=7&red=youtube");
  });

  it("el estado vacío no ofrece una salida a ninguna parte", () => {
    // Con un periodo corto, alargarlo. Ya en el más largo, quitar la
    // red. Y en el más largo sin red, no hay salida: ofrecer «Ver 90
    // días» ahí enlaza a la página en la que ya estás.
    expect(salidaDelVacio({ dias: 7, red: null })).toBe("masLargo");
    expect(salidaDelVacio({ dias: 30, red: "tiktok" })).toBe("masLargo");
    expect(salidaDelVacio({ dias: MAX_PERIODO, red: "tiktok" })).toBe("quitarRed");
    expect(salidaDelVacio({ dias: MAX_PERIODO, red: null })).toBeNull();
    // Y la salida que se ofrece cambia de verdad la URL.
    const enNoventa = { dias: MAX_PERIODO, red: "tiktok" as const };
    expect(hrefDe({ ...enNoventa, red: null })).not.toBe(hrefDe(enNoventa));
  });

  it("lo que se escribe en la URL es lo que se vuelve a leer", () => {
    for (const filtro of [
      { dias: 7 as const, red: "instagram" as const },
      { dias: 90 as const, red: null },
      { dias: 30 as const, red: "facebook" as const },
    ]) {
      const url = new URL(hrefDe(filtro), "https://oncue.test");
      expect(
        parseFiltro({
          periodo: url.searchParams.get("periodo") ?? undefined,
          red: url.searchParams.get("red") ?? undefined,
        }),
      ).toEqual(filtro);
    }
  });
});
