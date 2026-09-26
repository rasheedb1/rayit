import { describe, expect, it } from "vitest";
import { formatterFor } from "@/lib/format";
import { parseGuidanceOutput } from "./redactor-salida";
import { MESSAGES, plural } from "../messages";
import type { EnrollableContact, SequenceDetail } from "@mc/db/queries/cadencias";
import {
  avisoDePolitica, esperaEntre, etiquetaActivar, horaDePaso, modoDePaso, partesDeEnrolamiento, personaParaEnrolar, resumenFlujo,
  sinTexto, textoDeGuia, textoDeNota,
} from "./vista";
import { EDITABLE_STEP_TYPES, TEXTLESS_STEP_TYPES } from "@mc/db/queries/cadencias";
import { DISPATCHABLE_STEP_TYPES } from "@mc/core/outreach/sequence-policy";

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

  it("un comentario público lo escribe una persona y una reacción no lleva mensaje: la tarjeta no dice «Generación automática»", () => {
    // El paso 1 de Fresko: un comentario en LinkedIn. «Activar» lo cuenta como gesto a mano; la tarjeta dice lo mismo.
    expect(modoDePaso({ stepType: "linkedin_comment", generateWithAi: true })).toBe(
      "Lo escribes tú en su publicación: On Cue no lo redacta ni lo envía.",
    );
    expect(modoDePaso({ stepType: "instagram_comment", generateWithAi: false })).toBe(MESSAGES.paso.comentarioAMano);
    expect(modoDePaso({ stepType: "instagram_like", generateWithAi: false })).toBe("Lo haces tú a mano: no lleva mensaje.");
    expect(modoDePaso({ stepType: "manual_task", generateWithAi: false })).toBe(MESSAGES.paso.sinTexto);
    expect(modoDePaso({ stepType: "email", generateWithAi: true })).toBe(MESSAGES.paso.generacion);
    expect(modoDePaso({ stepType: "linkedin_message", generateWithAi: false })).toBe(MESSAGES.paso.textoFijo);
    // Una sola regla para la pantalla y para la base: TEXTLESS_STEP_TYPES, que parte los tipos editables con los que se despachan.
    const tipos = [...EDITABLE_STEP_TYPES];
    expect(tipos.filter(sinTexto)).toEqual(tipos.filter((t) => TEXTLESS_STEP_TYPES.includes(t)));
    expect(tipos.filter(sinTexto)).toEqual(["linkedin_comment", "linkedin_like", "instagram_comment", "instagram_like", "manual_task"]);
    expect(tipos.filter((t) => !sinTexto(t))).toEqual(tipos.filter((t) => (DISPATCHABLE_STEP_TYPES as readonly string[]).includes(t)));
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

  it("el ajuste a la política se dice con los nombres de los ángulos y la cifra del espacio", () => {
    const angulos = new Map([["prueba_social", "Prueba social"], ["concepto_creativo", "Concepto creativo"]]);
    expect(
      textoDeNota(
        { code: "fitted_to_policy", softened: ["prueba_social"], dropped: [], shiftedDays: 2, maxTouches: 4, minDays: 3 },
        f,
        plantillas,
        angulos,
      ),
    ).toBe(
      "Ajustada a tu política de envío (hasta 4 mensajes por marca, 3 días entre ellos): «Prueba social» pasa a una reacción en su publicación, que no cuenta como mensaje; el cierre sale 2 días más tarde.",
    );
    expect(
      textoDeNota(
        { code: "fitted_to_policy", softened: [], dropped: ["prueba_social", "concepto_creativo"], shiftedDays: 1, maxTouches: 2, minDays: 1 },
        f,
        plantillas,
        angulos,
      ),
    ).toMatch(/«Prueba social» y «Concepto creativo» se quitan; el cierre sale 1 día más tarde\.$/);
  });

  it("la espera entre dos pasos, en días hábiles y con su plural", () => {
    expect(esperaEntre(undefined, { dayOffset: 0 }, f)).toBeNull();
    expect(esperaEntre({ dayOffset: 1 }, { dayOffset: 4 }, f)).toBe("Espera 3 días hábiles");
    expect(esperaEntre({ dayOffset: 1 }, { dayOffset: 2 }, f)).toBe("Espera 1 día hábil");
    expect(esperaEntre({ dayOffset: 2 }, { dayOffset: 2 }, f)).toBe("El mismo día");
  });

  it("los plurales salen de Intl.PluralRules, no de count === 1", () => {
    expect(MESSAGES.notas.politica.overCap("1", 1, "4")).toBe("1 de estos mensajes no saldrá: tu política permite 4 mensajes por marca.");
    expect(MESSAGES.notas.politica.overCap("2", 2, "4")).toMatch(/^2 de estos mensajes no saldrán/);
    expect(plural({ one: "{n} paso", other: "{n} pasos" })("1.000", 1000)).toBe("1.000 pasos");
    expect(MESSAGES.erroresConLimite.too_many_steps!("12")).toBe("Una cadencia lleva hasta 12 pasos.");
  });

  it("quién redactó la guía, y por qué no fue el modelo", () => {
    const base = {
      version: 1 as const, templateSlug: "x", signalKind: "active_campaign" as const, notes: [], model: null, contactId: null,
      dealId: null, proposedAt: "",
    };
    expect(textoDeGuia({ ...base, guidance: "llm", guidanceWhyRules: null })).toMatch(/con IA/);
    // Sin llave: dice que está apagada en On Cue (lo mismo que promete .env.example). No lo presenta como un ajuste
    // del espacio ni le pide a la creadora que configure nada: la llave es del servidor.
    expect(textoDeGuia({ ...base, guidance: "rules", guidanceWhyRules: "no_key" })).toBe(
      "La guía sale de las reglas: la redacción con IA está apagada en On Cue.",
    );
    expect(textoDeGuia({ ...base, guidance: "rules", guidanceWhyRules: "no_key" })).not.toMatch(/espacio|configúr|configura/);
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

describe("cadencias · quién entra y qué le queda", () => {
  const persona = (over: Partial<EnrollableContact> = {}): EnrollableContact => ({
    id: "c1", name: "Camila Rojas", roleTitle: "Marca", hasEmail: true, hasLinkedin: true, hasInstagram: false, optedOut: false,
    liveElsewhere: null, reachChannels: ["email", "linkedin"], enrolled: false, reachable: true, ...over,
  });
  // Andrés: solo Instagram, que ni está en la política ni en la cadencia: su alcance sale vacío de @mc/db.
  const andres = persona({
    id: "c2", name: "Andrés Pardo", roleTitle: null, hasEmail: false, hasLinkedin: false, hasInstagram: true, reachChannels: [], reachable: false,
  });

  it("«Llega por» dice solo los canales con los que la cadencia le escribe; quien no llega no se marca", () => {
    expect(personaParaEnrolar(persona())).toMatchObject({ detalle: "Marca · Llega por: Correo, LinkedIn", disponible: true });
    expect(personaParaEnrolar(andres)).toMatchObject({ detalle: "No llega por los canales de esta cadencia", disponible: false });
    expect(personaParaEnrolar(persona({ liveElsewhere: "Otra" }))).toMatchObject({ detalle: "Marca · Ya está en «Otra»", disponible: false });
  });

  it("«Activar y escribir a X» solo si X de verdad entra", () => {
    const d = (contactId: string) => ({
      status: "draft", proposal: { dealId: "d1" }, proposalContact: { id: contactId, name: "X" }, enrollments: { total: 0 },
    }) as unknown as SequenceDetail;
    const negocios = [{ id: "d1", name: "N", companyName: "Fresko", contacts: [persona(), andres] }];
    expect(etiquetaActivar(d("c1"), negocios)).toBe(MESSAGES.estado.activarPara("Camila Rojas"));
    expect(etiquetaActivar(d("c2"), negocios)).toBe(MESSAGES.estado.activar);
  });

  it("lo que le queda separa los mensajes por redactar de los gestos que se hacen a mano", () => {
    const tipos = ["linkedin_comment", "email", "linkedin_message", "email_reply", "linkedin_like", "email"];
    expect(partesDeEnrolamiento({ scheduled: 0, held: 0, drafts: 6, skipped: 0 }, tipos, f)).toBe("4 por redactar y 2 gestos a mano");
    expect(partesDeEnrolamiento({ scheduled: 1, held: 2, drafts: 2, skipped: 1 }, tipos, f)).toBe(
      "1 mensaje programado, 2 esperando tu revisión, 2 gestos a mano y 1 paso saltado, sin dirección",
    );
  });

  it("las notas del contexto: la persona ocupada y el negocio sin creador", () => {
    expect(textoDeNota({ code: "contact_busy", sequenceName: "Marca con campaña activa" }, f, plantillas, new Map(), "Carolina Ruiz")).toBe(
      "Carolina Ruiz ya está en «Marca con campaña activa»: Activar no la enrolará aquí.",
    );
    expect(textoDeNota({ code: "no_creator" }, f, plantillas)).toMatch(/Asigna el creador en el negocio/);
  });

  it("la columna Respuesta dice cuántas respondieron de cuántas contactadas", () => {
    expect(MESSAGES.lista.contactadas(f.int(1), f.int(3))).toBe("1 de 3 contactadas");
  });
});
