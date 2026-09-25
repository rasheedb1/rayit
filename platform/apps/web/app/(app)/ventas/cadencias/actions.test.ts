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
    listEnrollableDeals: vi.fn(),
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

import { CadenciaError } from "@mc/db/queries/cadencias";
import { proponerCadencia } from "./_lib/proponer";
import { activarCadencia, enrolarDesdeNegocio, guardarPaso, proponerDesdeSenal } from "./actions";
import { MESSAGES } from "./messages";

const SEQ = "00000013-0000-4000-8000-000000000a01";
const STEP = "00000013-0000-4000-8000-000000000b01";
const SIGNAL = "00000002-0000-4000-8000-00000005e001";
const CAMILA = "00000002-0000-4000-8000-0000000c0001";
const DEAL = "00000002-0000-4000-8000-0000000dea07";

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
  contacts: [{ id: CAMILA, name: "Camila Rojas", roleTitle: null, hasEmail: true, hasLinkedin: true, hasInstagram: false, optedOut: false }],
  channels: { email: "connected", linkedin: "connected", instagram_dm: "missing" },
  allowedChannels: ["email", "linkedin"],
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
  vi.unstubAllEnvs();
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
  it("activa y enrola a la persona para la que se propuso", async () => {
    q.getSequenceDetail.mockResolvedValue({
      proposal: { contactId: CAMILA, dealId: DEAL }, proposalContact: { id: CAMILA, name: "Camila Rojas" }, enrollments: { total: 0 },
    });
    enrollContacts.mockResolvedValue({ enrolled: [{ enrollmentId: "e", contactId: CAMILA, scheduled: 0, held: 0, drafts: 5, skipped: 1 }], skipped: [], warnings: [] });
    const r = await activarCadencia(SEQ);
    expect(q.setSequenceStatus).toHaveBeenCalledWith(expect.anything(), SEQ, "active");
    expect(enrollContacts).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sequenceId: SEQ, contactIds: [CAMILA], dealId: DEAL }));
    expect(r.ok).toMatch(/Camila Rojas dentro: 5 por redactar y 1 sin dirección/);
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
    enrollContacts.mockResolvedValue({ enrolled: [], skipped: [{ contactId: CAMILA, reason: "already_enrolled" }], warnings: [] });
    q.listEnrollableDeals.mockResolvedValue([{ id: DEAL, name: "x", companyName: "Fresko", contacts: [{ id: CAMILA, name: "Camila Rojas" }] }]);
    const r = await enrolarDesdeNegocio(SEQ, {}, form({ dealId: DEAL, contactId: [CAMILA] }));
    expect(r.ok).toBe("0 personas enroladas.");
    expect(r.saltadas).toEqual(["Camila Rojas: ya estaba dentro."]);
  });
});
