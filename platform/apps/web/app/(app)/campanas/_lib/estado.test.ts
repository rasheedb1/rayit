import { describe, expect, it } from "vitest";
import { CAMPAIGN_STATUSES } from "@mc/core";
import { LIST_FILTERS, LIST_FILTER_KEYS, filterHref, filterKey, pillForCampaign } from "./estado";

describe("pillForCampaign", () => {
  it("mapea cada estado a su etiqueta en español y su color, en un solo sitio", () => {
    expect(CAMPAIGN_STATUSES.map((s) => [s, pillForCampaign(s)])).toEqual([
      ["planned", { kind: "neutral", text: "Planeada" }],
      ["live", { kind: "good", text: "En curso" }],
      ["measuring", { kind: "warn", text: "Midiendo" }],
      ["reported", { kind: "good", text: "Reporte listo" }],
      ["closed", { kind: "neutral", text: "Cerrada" }],
      ["cancelled", { kind: "bad", text: "Cancelada" }],
    ]);
  });
});

describe("filtros de la lista", () => {
  it("«todas» más un filtro por estado, con su URL", () => {
    expect(LIST_FILTER_KEYS).toEqual(["todas", ...CAMPAIGN_STATUSES]);
    expect(LIST_FILTERS.todas.status).toBeUndefined();
    expect(LIST_FILTERS.live).toEqual({ label: "En curso", status: "live" });
    expect(filterHref("todas")).toBe("/campanas");
    expect(filterHref("measuring")).toBe("/campanas?estado=measuring");
  });
  it("un valor desconocido en la URL cae en «todas»", () => {
    expect(filterKey(undefined)).toBe("todas");
    expect(filterKey("closed")).toBe("closed");
    expect(filterKey("pagada")).toBe("todas");
    expect(filterKey("__proto__")).toBe("todas");
  });
});
