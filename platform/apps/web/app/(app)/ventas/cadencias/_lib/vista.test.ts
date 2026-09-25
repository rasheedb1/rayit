import { describe, expect, it } from "vitest";
import { formatterFor } from "@/lib/format";
import { parseGuidanceOutput } from "./redactor-salida";
import { avisoDePolitica, horaDePaso, resumenFlujo, textoDeGuia, textoDeNota } from "./vista";

const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });
const plantillas = new Map([["cocina-campana-activa", "Cocina · marca con campaña activa"]]);

describe("cadencias · lo que la pantalla decide sin base", () => {
  it("el resumen dice día y tipo de cada paso, como el flow viewer de Chief", () => {
    expect(
      resumenFlujo(
        [
          { dayOffset: 0, stepType: "linkedin_comment" },
          { dayOffset: 1, stepType: "email" },
          { dayOffset: 5, stepType: "email_reply" },
        ],
        f,
      ),
    ).toEqual(["Día 0: Comentario en LinkedIn", "Día 1: Correo", "Día 5: Respuesta en el hilo"]);
  });

  it("la hora de un paso es una hora de reloj en el idioma del espacio, no un instante", () => {
    expect(horaDePaso("09:30", f)).toMatch(/9:30/);
    expect(horaDePaso("roto", f)).toBe("roto");
  });

  it("cada nota del recomendador tiene su frase", () => {
    expect(textoDeNota({ code: "template", slug: "cocina-campana-activa", match: "niche_and_signal" }, f, plantillas)).toBe(
      "Plantilla «Cocina · marca con campaña activa», la de tu nicho para esta señal.",
    );
    expect(
      textoDeNota({ code: "rerouted", step: 3, from: "linkedin", to: "email", manual: false, reason: "contact_has_no_address" }, f, plantillas),
    ).toBe("Paso 3: de LinkedIn a Correo, porque la persona no tiene dirección ahí.");
    expect(
      textoDeNota({ code: "rerouted", step: 1, from: "instagram_dm", to: "instagram_dm", manual: true, reason: "channel_not_allowed" }, f, plantillas),
    ).toBe("Paso 1: queda como tarea a mano en Instagram, porque tu política de envío no lo permite.");
    expect(textoDeNota({ code: "channel_down", channel: "linkedin" }, f, plantillas)).toMatch(/LinkedIn pide reconectar/);
  });

  it("quién redactó la guía, y por qué no fue el modelo", () => {
    const base = {
      version: 1 as const, templateSlug: "x", signalKind: "active_campaign" as const, notes: [], model: null, contactId: null,
      dealId: null, proposedAt: "",
    };
    expect(textoDeGuia({ ...base, guidance: "llm", guidanceWhyRules: null })).toMatch(/con IA/);
    expect(textoDeGuia({ ...base, guidance: "rules", guidanceWhyRules: "no_key" })).toMatch(/no está configurada/);
    expect(textoDeGuia({ ...base, guidance: "rules", guidanceWhyRules: "budget" })).toMatch(/presupuesto/);
  });

  it("la tarjeta avisa lo que la política no dejará cumplir", () => {
    const d = { policy: { maxTouchesPerCompany: 4, minDaysBetweenTouches: 3, overCap: ["a"], closerThanGap: ["b"] } };
    expect(avisoDePolitica(d, "a", f)).toMatch(/no sale/);
    expect(avisoDePolitica(d, "b", f)).toMatch(/3 días/);
    expect(avisoDePolitica(d, "c", f)).toBeNull();
  });
});

describe("cadencias · lo que devuelve el redactor", () => {
  it("lee los pasos de la salida estructurada", () => {
    expect(parseGuidanceOutput('{"steps":[{"index":0,"guidance":"Abre con su campaña."}]}')).toEqual([
      { index: 0, guidance: "Abre con su campaña." },
    ]);
  });

  it("lo que no tiene la forma se descarta: la guía se queda con las reglas", () => {
    expect(parseGuidanceOutput("no es json")).toEqual([]);
    expect(parseGuidanceOutput('{"steps":[{"index":"0","guidance":1}]}')).toEqual([]);
    expect(parseGuidanceOutput(null)).toEqual([]);
  });
});
