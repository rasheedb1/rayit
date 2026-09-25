import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Las acciones de cadencias y la propuesta, sin base, sin Next y sin red:
 * qué llega a @mc/db con cada formulario, cómo vuelve cada error de
 * dominio y qué hace la propuesta con un redactor falso detrás de la
 * misma interfaz que el de Claude. Las consultas se prueban contra
 * Postgres embebido en packages/db/test/cadencias.test.ts.
 */
const { q, enrollContacts, outboundHealth, redirect } = vi.hoisted(() => ({
  q: {
    setSequenceStatus: vi.fn(),
    getSequenceDetail: vi.fn(),
    updateStep: vi.fn(),
    getRecommendationContext: vi.fn(),
    createSequenceFromProposal: vi.fn(),
    replaceStepsFromProposal: vi.fn(),
    recordRecommendLlmCall: vi.fn(),
    duplicateSequence: vi.fn(),
    liveEnrollmentsElsewhere: vi.fn(),
    optedOutAmong: vi.fn(),
    enrollableContactsOfDeal: vi.fn(),
    contactNames: vi.fn(),
    addStep: vi.fn(),
    reachForSequence: vi.fn(),
    stepTypesOf: vi.fn(),
  },
  enrollContacts: vi.fn(),
  outboundHealth: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (...a: unknown[]) => redirect(...a) }));
vi.mock("../_lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({ identity: { userId: null } }) }));
vi.mock("../../_lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({ identity: { userId: null } }) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));
vi.mock("@mc/db/queries/cadencias", async (original) => {
  const real = await original<typeof import("@mc/db/queries/cadencias")>();
  return Object.fromEntries([
    ...Object.entries(real),
    ...Object.entries(q).map(([k, fn]) => [k, (...a: unknown[]) => fn(...a)]),
  ]);
});
vi.mock("@mc/db/queries/outreach", async (original) => ({
  ...(await original<typeof import("@mc/db/queries/outreach")>()),
  enrollContacts: (...a: unknown[]) => enrollContacts(...a),
  outboundHealth: (...a: unknown[]) => outboundHealth(...a),
}));

import { checkSequenceAgainstPolicy } from "@mc/core";
import { CadenciaError } from "@mc/db/queries/cadencias";
import { proponerCadencia } from "./_lib/proponer";
import { SIN_PERSONA } from "./_lib/protocolo";
import { activarCadencia, anadirPaso, enrolarDesdeNegocio, guardarPaso, proponerDesdeSenal } from "./actions";
import { MESSAGES } from "./messages";

const SEQ = "00000013-0000-4000-8000-000000000a01";
const STEP = "00000013-0000-4000-8000-000000000b01";
const SIGNAL = "00000002-0000-4000-8000-00000005e001";
const CAMILA = "00000002-0000-4000-8000-0000000c0001";
const DEAL = "00000002-0000-4000-8000-0000000dea07";
const OTRA = "00000013-0000-4000-8000-00000000c001";
const FRESKO = "00000002-0000-4000-8000-0000000000e2";
/** Andrés Pardo, de Fresko: solo tiene Instagram. */
const ANDRES = "00000002-0000-4000-8000-0000000c0002";
/** Los pasos de «Marca con campaña activa»: cuatro mensajes, un comentario y una reacción públicos. */
const PASOS_CAMPANA = ["linkedin_comment", "email", "linkedin_message", "email_reply", "linkedin_like", "email"];

function form(values: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) for (const x of [v].flat()) fd.append(k, x);
  return fd;
}

const paso = (day: number, type: string, channel: string, angle: string) => ({
  day_offset: day, order_in_day: 0, step_type: type, channel, angle_key: angle, scheduled_time: "09:30",
  generate_with_ai: true, requires_asset: null, guidance_es: `Guía de ${angle}, escrita en la plantilla.`,
});
const contexto = {
  signal: { id: SIGNAL, headline: "6 anuncios activos en Meta", kind: "active_campaign", companyId: null, companyName: "Fresko Market" },
  deal: { id: DEAL, name: "Lanzamiento desayunos" },
  creator: { id: "00000002-0000-4000-8000-000000000003", name: "Laura Méndez" },
  contacts: [{
    id: CAMILA, name: "Camila Rojas", roleTitle: null, hasEmail: true, hasLinkedin: true, hasInstagram: false, optedOut: false,
    liveElsewhere: null as string | null, reachChannels: ["email", "linkedin"],
  }],
  notes: [] as Array<{ code: string }>,
  channels: { email: "connected", linkedin: "connected", instagram_dm: "missing" },
  allowedChannels: ["email", "linkedin"],
  policy: { maxTouchesPerCompany: 4, minDaysBetweenTouches: 3 },
  nicheSlugs: [],
  brief: null,
  templates: [{
    slug: "marca-con-campana-activa", nameEs: "Marca con campaña activa", descriptionEs: "", signalKind: "active_campaign", nicheSlug: null,
    steps: [
      paso(0, "linkedin_comment", "linkedin", "presencia"), paso(1, "email", "email", "encaje_audiencia"),
      paso(3, "linkedin_message", "linkedin", "prueba_desempeno"), paso(5, "email_reply", "email", "concepto_creativo"),
      paso(7, "linkedin_message", "linkedin", "prueba_social"), paso(9, "email", "email", "sintesis"),
    ],
  }],
  angles: {},
};

beforeEach(() => {
  for (const fn of Object.values(q)) fn.mockReset();
  enrollContacts.mockReset();
  outboundHealth.mockReset().mockResolvedValue({ llm: { spentToday: 0, dailyCap: 5, currency: "USD" } });
  redirect.mockReset();
  q.getRecommendationContext.mockResolvedValue(contexto);
  q.createSequenceFromProposal.mockResolvedValue(SEQ);
  q.liveEnrollmentsElsewhere.mockResolvedValue(new Map());
  q.optedOutAmong.mockResolvedValue(new Set());
  q.enrollableContactsOfDeal.mockImplementation(async (_tx: unknown, _deal: string, ids: string[]) => ids);
  q.contactNames.mockResolvedValue(new Map());
  // Por defecto todas llegan por correo; la prueba de Andrés usa la regla de verdad.
  q.reachForSequence.mockImplementation(async (_tx: unknown, _seq: string, ids: string[]) => new Map(ids.map((id) => [id, ["email"]])));
  q.stepTypesOf.mockResolvedValue(PASOS_CAMPANA);
  vi.unstubAllEnvs();
});

describe('la regla de "use server"', () => {
  it("todo lo que exporta actions.ts en tiempo de ejecución es una función async", async () => {
    for (const [nombre, valor] of Object.entries(await import("./actions"))) expect(typeof valor, nombre).toBe("function");
  });
});

describe("proponer", () => {
  it("sin llave de Anthropic: propone con reglas, guarda seis pasos y abre la línea de tiempo", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await proponerDesdeSenal({}, form({ signalId: SIGNAL, contactId: "", sequenceId: "" }));
    const [, input] = q.createSequenceFromProposal.mock.calls[0]!;
    expect(input.proposal.steps).toHaveLength(6);
    expect(input.meta).toMatchObject({ guidance: "rules", guidanceWhyRules: "no_key", contactId: CAMILA, dealId: DEAL });
    expect(input.name).toBe("Fresko Market · Campaña activa");
    expect(q.recordRecommendLlmCall).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith(`/ventas/cadencias/${SEQ}`);
  });

  it("con un redactor (falso, sin red): la guía es del modelo y la llamada queda registrada", async () => {
    const writer = vi.fn(async (req: { steps: Array<{ index: number }> }) => ({
      steps: req.steps.map((s) => ({ index: s.index, guidance: `Guía redactada para el paso ${s.index + 1}, sin huecos.` })),
      usage: { model: "claude-sonnet-5", inputTokens: 800, outputTokens: 200 },
    }));
    await proponerCadencia({ signalId: SIGNAL, contactId: CAMILA }, writer);
    expect(q.recordRecommendLlmCall).toHaveBeenCalledWith(expect.anything(), { model: "claude-sonnet-5", inputTokens: 800, outputTokens: 200 });
    const [, input] = q.createSequenceFromProposal.mock.calls[0]!;
    expect(input.meta).toMatchObject({ guidance: "llm", model: "claude-sonnet-5" });
    expect(input.proposal.steps[0].guidanceEs).toMatch(/^Guía redactada/);
  });

  it("la propuesta nace dentro de la política del espacio: seis pasos y ninguno cortado ni corrido", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await proponerDesdeSenal({}, form({ signalId: SIGNAL, contactId: "", sequenceId: "" }));
    const [, input] = q.createSequenceFromProposal.mock.calls[0]!;
    const pasos = input.proposal.steps.map((s: { stepType: string; dayOffset: number; orderInDay: number }, i: number) => ({ id: String(i), ...s }));
    expect(pasos).toHaveLength(6);
    expect(checkSequenceAgainstPolicy(pasos, contexto.policy)).toEqual({ overCap: [], closerThanGap: [] });
    expect(input.proposal.steps.at(-1).angleKey).toBe("sintesis");
    expect(input.proposal.notes).toContainEqual(expect.objectContaining({ code: "fitted_to_policy", softened: ["prueba_social"] }));
  });

  it("«Sin persona todavía» planea sin nadie y no guarda a quién escribir; vacío es la persona por defecto", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await proponerDesdeSenal({}, form({ signalId: SIGNAL, contactId: SIN_PERSONA, sequenceId: SEQ }));
    const [, seq, input] = q.replaceStepsFromProposal.mock.calls[0]!;
    expect(seq).toBe(SEQ);
    expect(input.meta.contactId).toBeNull();
    expect(input.proposal.notes).toContainEqual({ code: "no_contact" });

    await proponerDesdeSenal({}, form({ signalId: SIGNAL, contactId: "", sequenceId: SEQ }));
    expect(q.replaceStepsFromProposal.mock.calls[1]![2].meta.contactId).toBe(CAMILA);
  });

  it("sin presupuesto de hoy no llama al modelo", async () => {
    outboundHealth.mockResolvedValue({ llm: { spentToday: 5, dailyCap: 5, currency: "USD" } });
    const writer = vi.fn();
    await proponerCadencia({ signalId: SIGNAL, contactId: null }, writer);
    expect(writer).not.toHaveBeenCalled();
    expect(q.createSequenceFromProposal.mock.calls[0]![1].meta.guidanceWhyRules).toBe("budget");
  });

  it("una señal que no es de este espacio vuelve como frase, no como error de Postgres", async () => {
    q.getRecommendationContext.mockRejectedValue(new CadenciaError("no_signal", "x"));
    expect(await proponerDesdeSenal({}, form({ signalId: SIGNAL, contactId: "", sequenceId: "" }))).toEqual({ error: MESSAGES.errores.no_signal });
    expect(await proponerDesdeSenal({}, form({ signalId: "no", contactId: "", sequenceId: "" }))).toEqual({ error: MESSAGES.errores.invalid });
  });
});

describe("activar (el segundo clic)", () => {
  it("activa y enrola a la persona para la que se propuso, y lleva a la ficha donde se aprueban sus mensajes", async () => {
    q.getSequenceDetail.mockResolvedValue({
      proposal: { contactId: CAMILA, dealId: DEAL }, proposalContact: { id: CAMILA, name: "Camila Rojas" }, enrollments: { total: 0 },
      signal: { companyId: FRESKO }, steps: PASOS_CAMPANA.map((stepType) => ({ stepType })),
    });
    enrollContacts.mockResolvedValue({ enrolled: [{ enrollmentId: "e", contactId: CAMILA, scheduled: 0, held: 0, drafts: 5, skipped: 1 }], skipped: [], warnings: [] });
    const r = await activarCadencia(SEQ);
    expect(q.setSequenceStatus).toHaveBeenCalledWith(expect.anything(), SEQ, "active");
    expect(q.enrollableContactsOfDeal).toHaveBeenCalledWith(expect.anything(), DEAL, [CAMILA]);
    expect(enrollContacts).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sequenceId: SEQ, contactIds: [CAMILA], dealId: DEAL }));
    // Los seis toques: tres mensajes por redactar, la reacción y el comentario que hace ella a mano, y uno sin dirección.
    expect(r.ok).toMatch(/Camila Rojas dentro: 3 por redactar, 2 gestos a mano y 1 paso saltado, sin dirección\./);
    expect(r.href).toBe(`/ventas/empresas/${FRESKO}#cadencia`);
  });

  it("si el negocio se cerró después de proponer, activa sin escribirle a nadie y dice por qué", async () => {
    q.getSequenceDetail.mockResolvedValue({
      proposal: { contactId: CAMILA, dealId: DEAL }, proposalContact: { id: CAMILA, name: "Camila Rojas" }, enrollments: { total: 0 },
      signal: { companyId: FRESKO },
    });
    // enrollableContactsOfDeal no devuelve a nadie con el negocio ganado o perdido.
    q.enrollableContactsOfDeal.mockResolvedValue([]);
    const r = await activarCadencia(SEQ);
    expect(q.setSequenceStatus).toHaveBeenCalledWith(expect.anything(), SEQ, "active");
    expect(enrollContacts).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: MESSAGES.estado.activadaSinPersona("Camila Rojas", MESSAGES.enrolar.negocioCerrado) });

    // Una propuesta sin negocio (la señal no tenía uno abierto) tampoco enrola.
    q.getSequenceDetail.mockResolvedValue({
      proposal: { contactId: CAMILA, dealId: null }, proposalContact: { id: CAMILA, name: "Camila Rojas" }, enrollments: { total: 0 },
    });
    expect(await activarCadencia(SEQ)).toEqual({ ok: MESSAGES.estado.activadaSinPersona("Camila Rojas", MESSAGES.enrolar.sinNegocio) });
    expect(enrollContacts).not.toHaveBeenCalled();
  });

  it("si la persona ya está viva en otra cadencia, activa sin enrolarla y dice en cuál", async () => {
    q.getSequenceDetail.mockResolvedValue({
      proposal: { contactId: CAMILA, dealId: DEAL }, proposalContact: { id: CAMILA, name: "Camila Rojas" }, enrollments: { total: 0 },
    });
    q.liveEnrollmentsElsewhere.mockResolvedValue(new Map([[CAMILA, { sequenceId: "x", name: "Fresko Market · Campaña activa" }]]));
    const r = await activarCadencia(SEQ);
    expect(enrollContacts).not.toHaveBeenCalled();
    expect(r.ok).toBe(MESSAGES.estado.activadaYaEnOtra("Camila Rojas", "Fresko Market · Campaña activa"));
  });

  it("la persona pidió la baja entre proponer y activar: se activa sin ella y lo dice", async () => {
    q.getSequenceDetail.mockResolvedValue({
      proposal: { contactId: CAMILA, dealId: DEAL }, proposalContact: { id: CAMILA, name: "Camila Rojas" }, enrollments: { total: 0 },
      signal: { companyId: FRESKO }, steps: PASOS_CAMPANA.map((stepType) => ({ stepType })),
    });
    // Pulsó el enlace de baja de un correo del espacio: el disparador de 0050 rechazaría el enrolamiento y la activación entera.
    q.optedOutAmong.mockResolvedValue(new Set([CAMILA]));
    enrollContacts.mockRejectedValue(Object.assign(new Error("check_violation"), { code: "23514" }));
    const r = await activarCadencia(SEQ);
    expect(q.optedOutAmong).toHaveBeenCalledWith(expect.anything(), [CAMILA]);
    expect(enrollContacts).not.toHaveBeenCalled();
    expect(q.setSequenceStatus).toHaveBeenCalledWith(expect.anything(), SEQ, "active");
    expect(r).toEqual({ ok: MESSAGES.estado.activadaSinPersona("Camila Rojas", MESSAGES.enrolar.saltadas.opted_out!) });
  });

  it("una copia (duplicar) no trae persona: activarla no enrola a nadie", async () => {
    q.getSequenceDetail.mockResolvedValue({ proposal: { contactId: null, dealId: null }, proposalContact: null, enrollments: { total: 0 } });
    expect(await activarCadencia(SEQ)).toEqual({ ok: MESSAGES.estado.activada });
    expect(enrollContacts).not.toHaveBeenCalled();
  });

  it("con alguien dentro ya, solo activa", async () => {
    q.getSequenceDetail.mockResolvedValue({ proposal: { contactId: CAMILA }, proposalContact: { id: CAMILA, name: "Camila" }, enrollments: { total: 2 } });
    expect(await activarCadencia(SEQ)).toEqual({ ok: MESSAGES.estado.activada });
    expect(enrollContacts).not.toHaveBeenCalled();
  });

  it("una cadencia sin pasos no se activa, y lo dice", async () => {
    q.setSequenceStatus.mockRejectedValue(new CadenciaError("no_steps", "x"));
    expect(await activarCadencia(SEQ)).toEqual({ error: MESSAGES.errores.no_steps });
  });
});

describe("pasos y enrolamiento", () => {
  it("guardar un paso valida lo que llega y traduce el bloqueo por personas dentro", async () => {
    expect(await guardarPaso(SEQ, STEP, { dayOffset: 99 })).toEqual({ error: MESSAGES.errores.invalid });
    q.updateStep.mockRejectedValue(new CadenciaError("has_enrollments", "x"));
    expect(await guardarPaso(SEQ, STEP, { dayOffset: 4 })).toEqual({ error: MESSAGES.errores.has_enrollments });
    q.updateStep.mockReset().mockResolvedValue(undefined);
    expect(await guardarPaso(SEQ, STEP, { guidanceEs: "Abre con su campaña." })).toEqual({});
    expect(q.updateStep).toHaveBeenCalledWith(expect.anything(), STEP, { guidanceEs: "Abre con su campaña." });
  });

  it("enrolar pide al menos una persona y dice por qué no entró cada una", async () => {
    expect(await enrolarDesdeNegocio(SEQ, {}, form({ dealId: DEAL }))).toEqual({ error: MESSAGES.enrolar.elige });
    enrollContacts.mockResolvedValue({
      enrolled: [],
      skipped: [
        { contactId: CAMILA, reason: "already_enrolled" },
        { contactId: OTRA, reason: "motivo_nuevo_del_motor" },
      ],
      warnings: [],
    });
    q.contactNames.mockResolvedValue(new Map([[CAMILA, "Camila Rojas"], [OTRA, "Lucía Parra"]]));
    const r = await enrolarDesdeNegocio(SEQ, {}, form({ dealId: DEAL, contactId: [CAMILA, OTRA] }));
    expect(r.ok).toBe("0 personas enroladas.");
    // Un motivo que la pantalla no conoce no sale como código crudo.
    expect(r.saltadas).toEqual(["Camila Rojas: ya estaba dentro.", "Lucía Parra: no se pudo enrolar."]);
    // Los nombres se leen solo de quien no entró, no de todos los negocios.
    expect(q.contactNames).toHaveBeenCalledWith(expect.anything(), [CAMILA, OTRA]);
  });

  it("una persona de otra marca bajo este negocio se rechaza antes de enrolar a nadie", async () => {
    q.enrollableContactsOfDeal.mockResolvedValue([CAMILA]);
    const r = await enrolarDesdeNegocio(SEQ, {}, form({ dealId: DEAL, contactId: [CAMILA, OTRA] }));
    expect(r).toEqual({ error: MESSAGES.enrolar.ajenas });
    expect(enrollContacts).not.toHaveBeenCalled();
    expect(q.enrollableContactsOfDeal).toHaveBeenCalledWith(expect.anything(), DEAL, [CAMILA, OTRA]);
  });

  it("enrolar desde un negocio no mete en esta cadencia a quien ya está viva en otra: la salta y dice en cuál", async () => {
    q.liveEnrollmentsElsewhere.mockResolvedValue(new Map([[CAMILA, { sequenceId: "x", name: "Fresko Market · Campaña activa" }]]));
    enrollContacts.mockResolvedValue({ enrolled: [{ enrollmentId: "e", contactId: OTRA, scheduled: 1, held: 0, drafts: 0, skipped: 0 }], skipped: [], warnings: [] });
    q.contactNames.mockResolvedValue(new Map([[CAMILA, "Camila Rojas"]]));
    const r = await enrolarDesdeNegocio(SEQ, {}, form({ dealId: DEAL, contactId: [CAMILA, OTRA] }));
    // Una sola consulta para todo el lote, no una por persona.
    expect(q.liveEnrollmentsElsewhere).toHaveBeenCalledTimes(1);
    expect(q.liveEnrollmentsElsewhere).toHaveBeenCalledWith(expect.anything(), [CAMILA, OTRA], SEQ);
    expect(enrollContacts).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contactIds: [OTRA], dealId: DEAL }));
    expect(r.ok).toBe("1 persona enrolada.");
    expect(r.saltadas).toEqual(["Camila Rojas: ya está en «Fresko Market · Campaña activa»."]);

    // Si todas están en otra, no se llama al motor.
    enrollContacts.mockClear();
    const r2 = await enrolarDesdeNegocio(SEQ, {}, form({ dealId: DEAL, contactId: [CAMILA] }));
    expect(enrollContacts).not.toHaveBeenCalled();
    expect(r2.ok).toBe("0 personas enroladas.");
  });

  it("la persona pidió la baja después de abrir el formulario: las demás entran y ella sale entre las saltadas", async () => {
    q.optedOutAmong.mockResolvedValue(new Set([CAMILA]));
    enrollContacts.mockResolvedValue({ enrolled: [{ enrollmentId: "e", contactId: OTRA, scheduled: 1, held: 0, drafts: 0, skipped: 0 }], skipped: [], warnings: [] });
    q.contactNames.mockResolvedValue(new Map([[CAMILA, "Camila Rojas"], [OTRA, "Lucía Parra"]]));
    const r = await enrolarDesdeNegocio(SEQ, {}, form({ dealId: DEAL, contactId: [CAMILA, OTRA] }));
    expect(q.optedOutAmong).toHaveBeenCalledWith(expect.anything(), [CAMILA, OTRA]);
    // Camila no llega al motor: una sola persona de baja no tumba el lote.
    expect(enrollContacts).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contactIds: [OTRA] }));
    expect(r.ok).toBe("1 persona enrolada.");
    expect(r.saltadas).toEqual(["Camila Rojas: pidió no recibir mensajes."]);

    // Si la única elegida está de baja, no se llama al motor.
    enrollContacts.mockClear();
    const r2 = await enrolarDesdeNegocio(SEQ, {}, form({ dealId: DEAL, contactId: [CAMILA] }));
    expect(enrollContacts).not.toHaveBeenCalled();
    expect(r2.saltadas).toEqual(["Camila Rojas: pidió no recibir mensajes."]);
  });

  it("«Añadir paso» avisa cuando el paso nuevo es un gesto porque la política ya está llena de mensajes", async () => {
    q.addStep.mockResolvedValue({ id: STEP, asGesture: true });
    expect(await anadirPaso(SEQ)).toEqual({ ok: MESSAGES.paso.anadidoComoGesto });
    expect(q.addStep).toHaveBeenCalledWith(expect.anything(), SEQ);
    q.addStep.mockResolvedValue({ id: STEP, asGesture: false });
    expect(await anadirPaso(SEQ)).toEqual({});
  });

  it("los errores con límite dicen la cifra de @mc/db, formateada", async () => {
    q.updateStep.mockRejectedValue(new CadenciaError("day_full", "x"));
    expect(await guardarPaso(SEQ, STEP, { dayOffset: 4 })).toEqual({ error: "Ese día ya tiene 4 pasos: elige otro." });
  });

  it("WhatsApp no llega a la base aunque el formulario lo mande", async () => {
    expect(await guardarPaso(SEQ, STEP, { stepType: "whatsapp_message" as never })).toEqual({ error: MESSAGES.errores.invalid });
    expect(q.updateStep).not.toHaveBeenCalled();
  });
});

describe("quién llega (una persona solo con Instagram, política de correo y LinkedIn)", () => {
  /** El alcance de verdad: la regla de @mc/db (reachOf y usableChannels) con la política y las direcciones del caso. */
  async function alcanceReal() {
    const { reachOf, usableChannels } = await vi.importActual<typeof import("@mc/db/queries/cadencias")>("@mc/db/queries/cadencias");
    const canales = usableChannels(["email", "linkedin"], { email: "connected", linkedin: "down", instagram_dm: "missing" });
    const direcciones: Record<string, { hasEmail: boolean; hasLinkedin: boolean; hasInstagram: boolean }> = {
      [CAMILA]: { hasEmail: true, hasLinkedin: true, hasInstagram: false },
      [ANDRES]: { hasEmail: false, hasLinkedin: false, hasInstagram: true },
    };
    q.reachForSequence.mockImplementation(async (_tx: unknown, _seq: string, ids: string[]) =>
      new Map(ids.map((id) => [id, reachOf(direcciones[id]!, canales)])));
  }

  it("enrolar desde un negocio deja fuera a Andrés con su motivo y dice qué le queda a quien entra", async () => {
    await alcanceReal();
    enrollContacts.mockResolvedValue({
      enrolled: [{ enrollmentId: "e", contactId: CAMILA, scheduled: 0, held: 0, drafts: 6, skipped: 0 }], skipped: [], warnings: [],
    });
    q.contactNames.mockResolvedValue(new Map([[CAMILA, "Camila Rojas"], [ANDRES, "Andrés Pardo"]]));
    const r = await enrolarDesdeNegocio(SEQ, {}, form({ dealId: DEAL, contactId: [CAMILA, ANDRES] }));
    // Andrés no llega al motor: entraría «dentro» sin que le saliera un solo mensaje.
    expect(enrollContacts).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contactIds: [CAMILA] }));
    expect(r.ok).toBe("1 persona enrolada.");
    expect(r.dentro).toEqual(["Camila Rojas: 4 por redactar y 2 gestos a mano."]);
    expect(r.saltadas).toEqual(["Andrés Pardo: no llega por los canales de esta cadencia."]);
  });

  it("activar una propuesta para Andrés activa sin enrolarlo y dice por qué", async () => {
    await alcanceReal();
    q.getSequenceDetail.mockResolvedValue({
      proposal: { contactId: ANDRES, dealId: DEAL }, proposalContact: { id: ANDRES, name: "Andrés Pardo" }, enrollments: { total: 0 },
      signal: { companyId: FRESKO }, steps: PASOS_CAMPANA.map((stepType) => ({ stepType })),
    });
    const r = await activarCadencia(SEQ);
    expect(enrollContacts).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: MESSAGES.estado.activadaSinPersona("Andrés Pardo", MESSAGES.enrolar.noLlega) });
  });
});

describe("las notas del contexto en la propuesta", () => {
  it("la persona elegida que ya está en otra cadencia deja la nota contact_busy; sin creador, no_creator", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    q.getRecommendationContext.mockResolvedValue({
      ...contexto,
      creator: null,
      notes: [{ code: "no_creator" }],
      contacts: [{ ...contexto.contacts[0]!, liveElsewhere: "Marca con campaña activa" }],
    });
    await proponerDesdeSenal({}, form({ signalId: SIGNAL, contactId: CAMILA, sequenceId: "" }));
    const [, input] = q.createSequenceFromProposal.mock.calls[0]!;
    expect(input.meta).toMatchObject({ contactId: CAMILA, briefId: null });
    expect(input.proposal.notes).toContainEqual({ code: "no_creator" });
    expect(input.proposal.notes).toContainEqual({ code: "contact_busy", sequenceName: "Marca con campaña activa" });
  });

  it("el brief del creador del negocio viaja con la propuesta (outbound_sequence.brief_id)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const BRIEF = "00000002-0000-4000-8000-0000000b0001";
    q.getRecommendationContext.mockResolvedValue({ ...contexto, brief: { id: BRIEF, title: "Q4", notes: null, requiresDisclosure: true } });
    await proponerDesdeSenal({}, form({ signalId: SIGNAL, contactId: "", sequenceId: "" }));
    expect(q.createSequenceFromProposal.mock.calls[0]![1].meta.briefId).toBe(BRIEF);
  });
});

describe("el redactor con Claude, sin red", () => {
  it("le dice al modelo en qué idioma escribir: el de la petición, el mismo de la guía de reglas", async () => {
    const { redactorAnthropic } = await import("./_lib/redactor");
    const create = vi.fn(async () => ({
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: "text", text: JSON.stringify({ steps: [{ index: 0, guidance: "Abre con su campaña y una cifra de tu perfil." }] }) }],
    }));
    const writer = redactorAnthropic({ messages: { create } } as never);
    const r = await writer({
      signalKind: "launch", locale: "es", signalHeadline: null, companyName: null, briefTitle: null, briefNotes: null,
      requiresDisclosure: false, steps: [],
    });
    const [body] = create.mock.calls[0]! as unknown as [{ system: string; messages: Array<{ content: string }> }];
    expect(body.system).toContain("en español neutro (idioma «es»)");
    expect(JSON.parse(body.messages[0]!.content).locale).toBe("es");
    expect(r.steps).toEqual([{ index: 0, guidance: "Abre con su campaña y una cifra de tu perfil." }]);
  });
});
