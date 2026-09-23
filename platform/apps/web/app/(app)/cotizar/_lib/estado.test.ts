import { describe, expect, it } from "vitest";
import { QUOTE_STATUSES } from "@mc/db/queries/cotizar";
import { MESSAGES } from "../messages";
import { enlaceDeCotizacion, estadoVisible, pillDeCotizacion, validezYaNoAplica } from "./estado";

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

  it("una vencida que reemplazó otra versión se lee «Sin efecto», no «Vencida» (0033)", () => {
    expect(estadoVisible({ status: "expired", supersededById: "q2" })).toBe("superseded");
    expect(estadoVisible({ status: "expired", supersededById: null })).toBe("expired");
    expect(estadoVisible({ status: "sent" })).toBe("sent");
    expect(pillDeCotizacion("superseded")).toEqual({ kind: "neutral", text: "Sin efecto" });
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

describe("enlaceDeCotizacion (pulido r7)", () => {
  it("enviada, vista o aceptada: se ofrece copiar el enlace", () => {
    for (const status of ["sent", "viewed", "accepted"]) {
      expect(enlaceDeCotizacion({ status })).toEqual({ copiable: true, ayuda: MESSAGES.detalle.enlaceAyuda });
    }
  });

  it("rechazada o vencida: no se invita a mandar un enlace que ya no acepta", () => {
    expect(enlaceDeCotizacion({ status: "rejected" })).toEqual({ copiable: false, ayuda: MESSAGES.detalle.enlaceMuerto.rechazada });
    expect(enlaceDeCotizacion({ status: "expired" })).toEqual({ copiable: false, ayuda: MESSAGES.detalle.enlaceMuerto.vencida });
  });

  it("sin efecto: manda a la versión que la reemplazó solo si ese enlace sirve", () => {
    const viva = enlaceDeCotizacion({ status: "expired", supersededByNumber: "COT-2026-009", supersededByStatus: "viewed" });
    expect(viva).toEqual({ copiable: false, ayuda: "Este enlace ya no acepta: comparte el de COT-2026-009." });
    const aceptada = enlaceDeCotizacion({ status: "expired", supersededByNumber: "COT-2026-009", supersededByStatus: "accepted" });
    expect(aceptada.ayuda).toBe("Este enlace ya no acepta: comparte el de COT-2026-009.");
    const muerta = enlaceDeCotizacion({ status: "expired", supersededByNumber: "COT-2026-009", supersededByStatus: "rejected" });
    expect(muerta.ayuda).toMatch(/y el de COT-2026-009, que la reemplazó, tampoco/);
  });
});

describe("quedoSinEfecto: dice cómo está HOY la versión que la reemplazó (pulido r7)", () => {
  const q = MESSAGES.detalle.quedoSinEfecto;
  it("no llama «la que la marca puede aceptar» a una ya aceptada", () => {
    expect(q("COT-2026-009", "sent")).toBe("Quedó sin efecto: la reemplazó COT-2026-009, que es la que la marca puede aceptar.");
    expect(q("COT-2026-009", "accepted")).toBe("Quedó sin efecto: la reemplazó COT-2026-009, que la marca ya aceptó.");
    expect(q("COT-2026-009", "rejected")).toMatch(/que después se rechazó/);
    expect(q("COT-2026-009", "expired")).toMatch(/que tampoco sigue vigente/);
  });
});
