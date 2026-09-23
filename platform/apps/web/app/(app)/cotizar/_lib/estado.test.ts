import { describe, expect, it } from "vitest";
import { QUOTE_STATUSES } from "@mc/db/queries/cotizar";
import { pillDeCotizacion, validezYaNoAplica } from "./estado";

describe("pillDeCotizacion", () => {
  it("cada estado del ciclo tiene su etiqueta en español y su color, en un solo sitio", () => {
    expect(QUOTE_STATUSES.map((s) => [s, pillDeCotizacion(s)])).toEqual([
      ["draft", { kind: "neutral", text: "Borrador" }],
      ["sent", { kind: "neutral", text: "Enviada" }],
      ["viewed", { kind: "warn", text: "Vista por la marca" }],
      ["accepted", { kind: "good", text: "Aceptada" }],
      ["rejected", { kind: "bad", text: "Rechazada" }],
      ["expired", { kind: "bad", text: "Vencida" }],
    ]);
  });

  it("un estado desconocido no rompe la pantalla: se muestra tal cual", () => {
    expect(pillDeCotizacion("inventado")).toEqual({ kind: "neutral", text: "inventado" });
  });
});

describe("validezYaNoAplica", () => {
  it("una cotización cerrada no enseña «Válida hasta»; una abierta sí", () => {
    expect(QUOTE_STATUSES.filter((s) => validezYaNoAplica(s))).toEqual(["accepted", "rejected", "expired"]);
  });
});
