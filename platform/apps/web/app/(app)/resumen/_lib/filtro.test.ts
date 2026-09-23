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
    expect(hrefDe({ days: PERIODO_POR_DEFECTO, platform: null })).toBe("/resumen");
    expect(hrefDe({ days: 90, platform: null })).toBe("/resumen?periodo=90");
    expect(hrefDe({ days: PERIODO_POR_DEFECTO, platform: "tiktok" })).toBe("/resumen?red=tiktok");
    expect(hrefDe({ days: 7, platform: "youtube" })).toBe("/resumen?periodo=7&red=youtube");
  });

  it("el estado vacío no ofrece una salida a ninguna parte", () => {
    // Con un periodo corto, alargarlo. Ya en el más largo, quitar la
    // red. Y en el más largo sin red, no hay salida: ofrecer «Ver 90
    // días» ahí enlaza a la página en la que ya estás.
    expect(salidaDelVacio({ days: 7, platform: null })).toBe("masLargo");
    expect(salidaDelVacio({ days: 30, platform: "tiktok" })).toBe("masLargo");
    expect(salidaDelVacio({ days: MAX_PERIODO, platform: "tiktok" })).toBe("quitarRed");
    expect(salidaDelVacio({ days: MAX_PERIODO, platform: null })).toBeNull();
    // Y la salida que se ofrece cambia de verdad la URL.
    const enNoventa = { days: MAX_PERIODO, platform: "tiktok" as const };
    expect(hrefDe({ ...enNoventa, platform: null })).not.toBe(hrefDe(enNoventa));
  });

  it("lo que se escribe en la URL es lo que se vuelve a leer", () => {
    for (const filtro of [
      { days: 7 as const, platform: "instagram" as const },
      { days: 90 as const, platform: null },
      { days: 30 as const, platform: "facebook" as const },
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
