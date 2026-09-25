import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPerfil, type PerfilInputs, type PerfilPostInput } from "@mc/core/outreach/perfil";
import { templateNarrative } from "@mc/core/outreach/narrativa";
import type { StoredPerfil } from "@mc/core/outreach/perfil-guardado";

/**
 * /ventas/perfil sin base: la pantalla con un perfil guardado (los cinco
 * mejores videos con sus cifras, cada cifra de la narrativa enlazada a
 * su origen con su tooltip), el estado sin calcular, la edición de la
 * narrativa con los rechazos del verificador, y las acciones (recalcular
 * sin llave usa la plantilla; guardar traduce lo que el verificador
 * rechaza). Leer y guardar de verdad está probado en pglite:
 * packages/db/test/perfil-comercial.test.ts.
 */
const getPerfilComercial = vi.fn();
const getPrimaryCreator = vi.fn();
const readPerfilDataAsOf = vi.fn();
const computePerfil = vi.fn();
const llmBudgetExhausted = vi.fn();
const recordProfileLlmCalls = vi.fn();
const savePerfilComercial = vi.fn();
const saveNarrativeEdit = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../_lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));
vi.mock("@mc/db/queries/perfil-comercial", async () => {
  class PerfilComercialError extends Error {
    code: string;
    issues: unknown[];
    constructor(code: string, message: string, issues: unknown[] = []) {
      super(message);
      this.code = code;
      this.issues = issues;
    }
  }
  return {
    PerfilComercialError,
    getPerfilComercial: (...a: unknown[]) => getPerfilComercial(...a),
    getPrimaryCreator: (...a: unknown[]) => getPrimaryCreator(...a),
    readPerfilDataAsOf: (...a: unknown[]) => readPerfilDataAsOf(...a),
    computePerfil: (...a: unknown[]) => computePerfil(...a),
    llmBudgetExhausted: (...a: unknown[]) => llmBudgetExhausted(...a),
    recordProfileLlmCalls: (...a: unknown[]) => recordProfileLlmCalls(...a),
    savePerfilComercial: (...a: unknown[]) => savePerfilComercial(...a),
    saveNarrativeEdit: (...a: unknown[]) => saveNarrativeEdit(...a),
  };
});

const { default: PerfilPage } = await import("./page");
const { guardarNarrativa, recalcularPerfil } = await import("./actions");
const { PerfilComercialError } = await import("@mc/db/queries/perfil-comercial");

const CREADORA = "00000002-0000-4000-8000-000000000003";
const CAMPANA = "00000003-0000-4000-8000-000000ca0001";
const TITULOS = ["Cold brew en casa en 3 pasos", "La arepa sin plancha", "Tres desayunos", "El error del arroz", "Pasta en cuatro minutos", "Sopa de domingo"];

function post(i: number): PerfilPostInput {
  return {
    id: `00000002-0000-4000-8000-00000000d0${i}${i}`, platformId: i % 2 ? "tiktok" : "instagram",
    url: `https://www.tiktok.com/@laura/video/${i}`, title: TITULOS[i]!, caption: `${TITULOS[i]} 🍳 #receta`, hashtags: ["receta"],
    surface: i % 2 ? "feed" : "reels", mediaType: "video", durationS: 30 + i, isBrandedContent: false,
    publishedAt: "2026-09-01T00:00:00.000Z", hookType: null,
    score: { viewsVsMedian: 6 - i, viewsAtCut: 400_000 - i * 50_000, outlierTier: i === 0 ? "breakout" : "outlier", ageHoursCut: 168 },
  };
}

function entradas(): PerfilInputs {
  return {
    creator: { id: CREADORA, displayName: "Laura Méndez", handle: "laura.cocinafacil", bio: null, country: "CO", languages: ["es"], nicheSlugs: ["cocina"], nicheNames: ["Cocina"] },
    connections: [{ id: "c1", platformId: "tiktok", handle: "laura", status: "active", followers: 243000, followersSnapshotId: "77", followersDay: "2026-09-24" }],
    audience: [{ id: "00000002-0000-4000-8000-0000000a0001", platformId: "tiktok", connectionId: "c1", dimension: "gender", bucket: "F", share: 0.64, day: "2026-09-24" }],
    nonFollowers: [],
    baselines: [{ id: "00000002-0000-4000-8000-0000000b0001", platformId: "tiktok", ageHoursCut: 168, medianViews: 115446, sampleSize: 17, isReliable: true, computedAt: "2026-09-25T00:00:00.000Z" }],
    posts: TITULOS.map((_, i) => post(i)),
    campaigns: [{ id: CAMPANA, name: "Lanzamiento cold brew", companyName: "Café Alma", status: "reported", result: { views: 712000, brandFollowersGained: 1240, codeRedemptions: null, attributedRevenue: null, currency: "COP", viewsVsMedian: null } }],
    rateCard: { id: "00000004-0000-4000-8000-0000007a1f01", currency: "COP", computedAt: "2026-09-20T00:00:00.000Z", items: [{ id: "00000004-0000-4000-8000-0000007a1101", labelEs: "TikTok dedicado", platformId: "tiktok", priceLow: "5200000.00", priceHigh: "8080000.00" }] },
    cutHours: 168,
    computedAt: "2026-09-25T10:00:00.000Z",
  };
}

function guardado(source: "template" | "edited" = "template"): StoredPerfil {
  const perfil = buildPerfil(entradas());
  return {
    version: 1, computedAt: perfil.computedAt, perfil,
    narrative: { text: templateNarrative(perfil), source, model: null, writtenAt: "2026-09-25T10:00:01.000Z", fallback: source === "template" ? "no_model" : null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getPrimaryCreator.mockResolvedValue({ id: CREADORA, displayName: "Laura Méndez" });
  readPerfilDataAsOf.mockResolvedValue("2026-09-25T00:00:00.000Z");
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(cleanup);

describe("la pantalla", () => {
  it("muestra los cinco mejores videos con sus cifras, en orden", async () => {
    getPerfilComercial.mockResolvedValue(guardado());
    render(await PerfilPage());
    const lista = screen.getByText("Tus cinco mejores videos").closest("div, section")!.querySelector("ol")!;
    const items = within(lista).getAllByRole("listitem");
    expect(items).toHaveLength(5);
    expect(items.map((li) => within(li).getAllByRole("link")[0]!.textContent)).toEqual(TITULOS.slice(0, 5));
    // La primera: 6× su mediana, 400 mil views, 30 s, con su pill de breakout.
    expect(within(items[0]!).getByText("6×")).toBeTruthy();
    expect(within(items[0]!).getByText("400 mil")).toBeTruthy();
    expect(within(items[0]!).getByText("30 s")).toBeTruthy();
    expect(within(items[0]!).getByText("Breakout")).toBeTruthy();
    expect(within(items[0]!).getByText(/Abre con una promesa concreta/)).toBeTruthy();
  });

  it("cada cifra de la narrativa lleva a su origen y dice de dónde sale", async () => {
    getPerfilComercial.mockResolvedValue(guardado());
    render(await PerfilPage());
    const narrativa = screen.getByText("Narrativa").closest("section")!;
    const cifras = within(narrativa).getAllByRole("link");
    expect(cifras.length).toBeGreaterThanOrEqual(5);
    for (const a of cifras) {
      expect(a.getAttribute("href")).toBeTruthy();
      const tip = document.getElementById(a.getAttribute("aria-describedby")!)!;
      expect(tip.getAttribute("role")).toBe("tooltip");
      expect(tip.textContent!.length).toBeGreaterThan(10);
    }
    const alVideo = cifras.find((a) => a.textContent === "6×")!;
    expect(alVideo.getAttribute("href")).toBe("https://www.tiktok.com/@laura/video/0");
    expect(alVideo.getAttribute("target")).toBe("_blank");
    expect(document.getElementById(alVideo.getAttribute("aria-describedby")!)!.textContent).toContain("Puntaje del video frente a tu mediana");
    expect(cifras.find((a) => a.getAttribute("href") === `/campanas/${CAMPANA}`)).toBeTruthy();
    // Ninguna marca queda sin pintar.
    expect(narrativa.textContent).not.toContain("[claim:");
    expect(within(narrativa).getByText(/falta la llave de Anthropic/)).toBeTruthy();
  });

  it("sin perfil guardado ofrece calcularlo", async () => {
    getPerfilComercial.mockResolvedValue(null);
    render(await PerfilPage());
    expect(screen.getByText("Tu perfil todavía no está calculado")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Calcular mi perfil" })).toBeTruthy();
  });

  it("dice cuando hay datos más nuevos que el cálculo", async () => {
    getPerfilComercial.mockResolvedValue(guardado());
    readPerfilDataAsOf.mockResolvedValue("2026-09-26T00:00:00.000Z");
    render(await PerfilPage());
    expect(screen.getByText(/Hay datos más nuevos que este cálculo/)).toBeTruthy();
  });
});

describe("la edición de la narrativa", () => {
  it("enseña lo que el verificador rechaza, una línea por problema", async () => {
    getPerfilComercial.mockResolvedValue(guardado());
    saveNarrativeEdit.mockRejectedValue(
      new PerfilComercialError("invalid_narrative", "x", [{ code: "unknown_claim", id: "inventada" }, { code: "bare_number", text: "12.000" }]),
    );
    render(await PerfilPage());
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    fireEvent.change(screen.getByLabelText("Texto de la narrativa"), { target: { value: "Tengo [claim:inventada] y 12.000 fans." } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar narrativa" }));
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain("[claim:inventada] no es una cifra de este perfil.");
    expect(alerta.textContent).toContain("«12.000» es una cifra escrita a mano");
    expect(saveNarrativeEdit).toHaveBeenCalledWith({}, CREADORA, "Tengo [claim:inventada] y 12.000 fans.", "2026-09-25T10:00:01.000Z");
  });

  it("inserta una cifra donde está el cursor", async () => {
    getPerfilComercial.mockResolvedValue(guardado());
    render(await PerfilPage());
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    const area = screen.getByLabelText("Texto de la narrativa") as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: "Mi mediana: " } });
    area.setSelectionRange(12, 12);
    fireEvent.change(screen.getByLabelText("Insertar una cifra"), { target: { value: "mediana-tiktok" } });
    fireEvent.click(screen.getByRole("button", { name: "Insertar" }));
    await waitFor(() => expect(area.value).toBe("Mi mediana: [claim:mediana-tiktok]"));
  });
});

describe("las acciones", () => {
  it("recalcular sin llave de Anthropic guarda la narrativa de plantilla y no registra llamadas", async () => {
    const perfil = buildPerfil(entradas());
    computePerfil.mockResolvedValue(perfil);
    llmBudgetExhausted.mockResolvedValue(false);
    const r = await recalcularPerfil();
    expect(r).toEqual({ ok: true, message: "Perfil recalculado." });
    expect(recordProfileLlmCalls).not.toHaveBeenCalled();
    const [, perfilGuardado, narrativa] = savePerfilComercial.mock.calls[0]!;
    expect(perfilGuardado).toBe(perfil);
    expect(narrativa).toMatchObject({ source: "template", fallback: "no_model", text: templateNarrative(perfil) });
  });

  it("recalcular que falla lo dice sin tumbar la página", async () => {
    computePerfil.mockRejectedValue(new Error("se cayó la base"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await recalcularPerfil()).toEqual({ ok: false, message: "No se pudo recalcular. Inténtalo de nuevo en un momento.", detalles: [] });
    error.mockRestore();
  });

  it("guardar una versión vieja o sin fecha válida no llega a la base", async () => {
    saveNarrativeEdit.mockRejectedValue(new PerfilComercialError("stale_edit", "x"));
    expect((await guardarNarrativa("Hola.", "2026-09-25T10:00:01.000Z")).message).toMatch(/cambió mientras la editabas/);
    saveNarrativeEdit.mockClear();
    expect((await guardarNarrativa("Hola.", "ayer")).ok).toBe(false);
    expect(saveNarrativeEdit).not.toHaveBeenCalled();
  });
});
