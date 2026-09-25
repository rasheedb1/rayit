import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPerfil, type PerfilInputs, type PerfilPostInput } from "@mc/core/outreach/perfil";
import { NARRATIVE_ATTEMPTS, templateNarrative, type NarrativeModel } from "@mc/core/outreach/narrativa";
import type { StoredPerfil } from "@mc/core/outreach/perfil-guardado";

/**
 * /ventas/perfil sin base: la pantalla con un perfil guardado (los cinco
 * mejores videos con sus cifras y lo que los distingue, cada cifra de la
 * narrativa con su origen y su enlace por tabla), el estado sin calcular,
 * el globo de cada cifra a 400 px, la edición con vista previa y los
 * rechazos del verificador, los permisos por rol, y las acciones
 * (recalcular sin llave usa la plantilla; con modelo registra cada
 * llamada apenas responde y vuelve a mirar el tope). Leer y guardar de
 * verdad está probado en pglite: packages/db/test/perfil-comercial.test.ts.
 */
const getPerfilComercial = vi.fn();
const getPrimaryCreator = vi.fn();
const readPerfilDataAsOf = vi.fn();
const computePerfil = vi.fn();
const llmBudgetExhausted = vi.fn();
const recordProfileLlmCalls = vi.fn();
const savePerfilComercial = vi.fn();
const saveNarrativeEdit = vi.fn();
const puedeEditarElPerfil = vi.fn();
let modelo: NarrativeModel | null = null;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../_lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("./permiso", () => ({ puedeEditarElPerfil: () => puedeEditarElPerfil() }));
vi.mock("@/lib/llm/narrativa", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/narrativa")>()),
  narrativeModelFromEnv: () => modelo,
}));
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

const { default: PerfilPage, maxDuration } = await import("./page");
const { guardarNarrativa, recalcularPerfil } = await import("./actions");
const { PerfilComercialError } = await import("@mc/db/queries/perfil-comercial");
const { NARRATIVE_TIMEOUT_MS } = await import("@/lib/llm/narrativa");
const { posicionGlobo, GLOBO_MARGEN } = await import("./cifra");

const CREADORA = "00000002-0000-4000-8000-000000000003";
const CAMPANA = "00000003-0000-4000-8000-000000ca0001";
const TITULOS = ["Cold brew en casa en 3 pasos", "La arepa sin plancha", "Tres desayunos", "El error del arroz", "Pasta en cuatro minutos", "Sopa de domingo"];

function post(i: number): PerfilPostInput {
  return {
    id: `00000002-0000-4000-8000-00000000d0${i}${i}`, platformId: i % 2 ? "tiktok" : "instagram",
    url: `https://www.tiktok.com/@laura/video/${i}`, title: TITULOS[i]!, caption: `${TITULOS[i]} 🍳 #receta`, hashtags: ["receta"],
    surface: i % 2 ? "feed" : "reels", mediaType: "video", durationS: 30 + i, isBrandedContent: false,
    publishedAt: "2026-09-01T00:00:00.000Z", hookType: null,
    score: {
      viewsVsMedian: 6 - i, viewsAtCut: 400_000 - i * 50_000, outlierTier: i === 0 ? "breakout" : "outlier", ageHoursCut: 168,
      computedAt: "2026-09-25T00:00:00.000Z",
      baseline: i % 2 ? null : { id: "00000002-0000-4000-8000-0000000b0002", medianViews: 66_667, ageHoursCut: 168, computedAt: "2026-09-25T00:00:00.000Z" },
    },
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
    version: 2, computedAt: perfil.computedAt, perfil,
    narrative: { text: templateNarrative(perfil), source, model: null, writtenAt: "2026-09-25T10:00:01.000Z", fallback: source === "template" ? "no_model" : null },
  };
}

/** El globo de una cifra (su botón controla el elemento con ese id) y el enlace a su origen. */
function globo(boton: HTMLElement) {
  const tip = document.getElementById(boton.getAttribute("aria-controls")!)!;
  return { tip, enlace: within(tip).getByRole("link", { name: /Abrir el origen/ }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  modelo = null;
  getPrimaryCreator.mockResolvedValue({ id: CREADORA, displayName: "Laura Méndez" });
  readPerfilDataAsOf.mockResolvedValue("2026-09-25T00:00:00.000Z");
  puedeEditarElPerfil.mockResolvedValue(true);
  llmBudgetExhausted.mockResolvedValue(false);
  recordProfileLlmCalls.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("la pantalla", () => {
  it("muestra los cinco mejores videos con sus cifras, su corte, su mediana y lo que los distingue", async () => {
    getPerfilComercial.mockResolvedValue(guardado());
    render(await PerfilPage());
    const lista = screen.getByText("Tus cinco mejores videos").closest("div, section")!.querySelector("ol")!;
    const items = within(lista).getAllByRole("listitem").filter((li) => li.parentElement === lista);
    expect(items).toHaveLength(5);
    expect(items.map((li) => within(li).getAllByRole("link")[0]!.textContent)).toEqual(TITULOS.slice(0, 5));
    // La primera: 6× su mediana, 400 mil views a los 7 días, 30 s, con su pill de breakout y la mediana contra la que se midió.
    const primero = within(items[0]!);
    expect(primero.getByRole("button", { name: /^6×/ })).toBeTruthy();
    expect(primero.getByRole("button", { name: /^400 mil/ })).toBeTruthy();
    expect(primero.getByText(/views a los 7 días de publicado/)).toBeTruthy();
    expect(primero.getByRole("button", { name: /^30 s/ })).toBeTruthy();
    expect(primero.getByText("Breakout")).toBeTruthy();
    expect(primero.getByText(/Tu mediana de Instagram a esa edad/)).toBeTruthy();
    expect(primero.getByRole("button", { name: /^66,7 mil/ })).toBeTruthy();
    // Lo que lo distingue contrasta con el resto: «Tus videos que abren con una promesa concreta: 5× frente a 3× del resto».
    const razon = primero.getAllByText(/Tus videos que abren con una promesa concreta/).find((el) => el.tagName === "LI")!;
    expect(razon.textContent).toMatch(/5×.*frente a.*3×.*del resto/);
    expect(primero.queryByText(/de tu duración habitual/)).toBeNull();
  });

  it("cada cifra de la narrativa lleva a su origen: el enlace depende de la tabla y el globo dice red y fecha", async () => {
    getPerfilComercial.mockResolvedValue(guardado());
    render(await PerfilPage());
    const narrativa = screen.getByText("Narrativa").closest("section")!;
    const botones = within(narrativa).getAllByRole("button").filter((b) => b.hasAttribute("aria-controls"));
    expect(botones.length).toBeGreaterThanOrEqual(8);
    const porHref = new Map<string, HTMLElement>();
    for (const b of botones) {
      const { tip, enlace } = globo(b);
      const href = enlace.getAttribute("href")!;
      expect(href).toBeTruthy();
      porHref.set(href, tip);
      // Un ancla de esta página apunta a una fila que existe.
      if (href.startsWith("#")) expect(document.getElementById(href.slice(1)), href).toBeTruthy();
    }
    // post_score → el video en su red, en otra pestaña.
    const alVideo = botones.find((b) => b.textContent === "6×")!;
    expect(globo(alVideo).enlace.getAttribute("href")).toBe("https://www.tiktok.com/@laura/video/0");
    expect(globo(alVideo).enlace.getAttribute("target")).toBe("_blank");
    expect(globo(alVideo).tip.textContent).toContain("Puntaje del video frente a tu mediana · Instagram");
    // campaign_result → su campaña; rate_card_item → el tarifario.
    expect(porHref.has(`/campanas/${CAMPANA}`)).toBe(true);
    expect(porHref.has("/cotizar")).toBe(true);
    // audience_breakdown y creator_baseline → su fila en «De dónde sale cada cifra», con red y fecha de la lectura.
    const demografia = porHref.get("#origen-audiencia-tiktok-genero-f")!;
    expect(demografia.textContent).toContain("Parte de tus seguidores de TikTok que son mujeres");
    expect(demografia.textContent).toMatch(/Demografía de la cuenta · TikTok · al 24 de septiembre de 2026/);
    // 2026-09-25T00:00Z es todavía el 24 en la zona del workspace (America/Bogota).
    const mediana = porHref.get("#origen-mediana-tiktok")!;
    expect(mediana.textContent).toMatch(/Línea base del creador · TikTok · al 24 de septiembre de 2026/);
    const fila = document.getElementById("origen-mediana-tiktok")!;
    expect(fila.textContent).toContain("creator_baseline.median_views");
    expect(fila.textContent).toContain("00000002-0000-4000-8000-0000000b0001");
    // Ninguna marca queda sin pintar.
    expect(narrativa.textContent).not.toContain("[claim:");
    expect(within(narrativa).getByText(/falta la llave de Anthropic/)).toBeTruthy();
    expect(within(narrativa).getByText(/Las cifras marcadas salen de este perfil/)).toBeTruthy();
  });

  it("los seguidores llevan a su serie en Resumen, filtrada a la red", async () => {
    getPerfilComercial.mockResolvedValue(guardado());
    render(await PerfilPage());
    const seguidores = screen.getByRole("button", { name: /^243 mil, Tus seguidores en TikTok/ });
    expect(globo(seguidores).enlace.getAttribute("href")).toBe("/resumen?red=tiktok#seguidores");
    expect(globo(seguidores).enlace.getAttribute("aria-label")).toBe("Abrir el origen: Lectura diaria de la cuenta · TikTok · al 24 de septiembre de 2026");
  });

  it("tocar una cifra abre su globo sin navegar; Escape lo cierra", async () => {
    getPerfilComercial.mockResolvedValue(guardado());
    render(await PerfilPage());
    const cifra = screen.getByRole("button", { name: /^243 mil/ });
    expect(cifra.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(cifra);
    expect(cifra.getAttribute("aria-expanded")).toBe("true");
    expect(globo(cifra).tip.className).toContain("block");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(cifra.getAttribute("aria-expanded")).toBe("false"));
  });

  it("a 400 px, el globo de la última cifra de «Cuánto cobras» cabe en la pantalla", async () => {
    getPerfilComercial.mockResolvedValue(guardado());
    render(await PerfilPage());
    const ancho = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
    try {
      const tarifas = screen.getByText("Cuánto cobras").closest("section")!;
      const cifras = within(tarifas).getAllByRole("button").filter((b) => b.hasAttribute("aria-controls"));
      const ultima = cifras.at(-1)!;
      // La cifra pegada al borde derecho, como en un teléfono (jsdom no maqueta: se le da su caja).
      ultima.parentElement!.getBoundingClientRect = () => ({ left: 330, top: 600, width: 54, height: 20, right: 384, bottom: 620, x: 330, y: 600, toJSON: () => ({}) });
      act(() => ultima.focus());
      const { tip } = globo(ultima);
      const izquierda = parseFloat(tip.style.left);
      const derecha = izquierda + parseFloat(tip.style.width);
      expect(tip.className).toContain("fixed");
      expect(izquierda).toBeGreaterThanOrEqual(GLOBO_MARGEN);
      expect(derecha).toBeLessThanOrEqual(400 - GLOBO_MARGEN);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: ancho });
    }
  });

  it("sin perfil guardado ofrece calcularlo dentro del EmptyState", async () => {
    getPerfilComercial.mockResolvedValue(null);
    render(await PerfilPage());
    const vacio = screen.getByText("Tu perfil todavía no está calculado").closest("[role=status]")!;
    expect(within(vacio as HTMLElement).getByRole("button", { name: "Calcular mi perfil" })).toBeTruthy();
  });

  it("dice cuando hay datos más nuevos que el cálculo", async () => {
    getPerfilComercial.mockResolvedValue(guardado());
    readPerfilDataAsOf.mockResolvedValue("2026-09-26T00:00:00.000Z");
    render(await PerfilPage());
    expect(screen.getByText(/Hay datos más nuevos que este cálculo/)).toBeTruthy();
  });

  it("a un rol que solo mira no le ofrece Recalcular, Editar ni Calcular", async () => {
    puedeEditarElPerfil.mockResolvedValue(false);
    getPerfilComercial.mockResolvedValue(guardado());
    render(await PerfilPage());
    expect(screen.queryByRole("button", { name: "Recalcular" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
    cleanup();
    getPerfilComercial.mockResolvedValue(null);
    render(await PerfilPage());
    expect(screen.queryByRole("button", { name: "Calcular mi perfil" })).toBeNull();
    expect(screen.getByText(/Lo puede calcular quien es dueño/)).toBeTruthy();
  });

  it("el tiempo de dos intentos del modelo cabe en el maxDuration de la página", () => {
    expect(NARRATIVE_ATTEMPTS * NARRATIVE_TIMEOUT_MS).toBeLessThan(maxDuration * 1000);
  });
});

describe("el globo", () => {
  it("se centra sobre la cifra y se corre para no salir de la pantalla", () => {
    const pantalla = { width: 400, height: 800 };
    // En el medio: centrado.
    expect(posicionGlobo({ left: 180, top: 300, width: 40 }, pantalla)).toEqual({ left: 80, bottom: 506, width: 240 });
    // Pegada a la derecha: se abre hacia la izquierda hasta el margen.
    expect(posicionGlobo({ left: 375, top: 300, width: 20 }, pantalla).left).toBe(400 - 16 - 240);
    // Pegada a la izquierda: arranca en el margen.
    expect(posicionGlobo({ left: 0, top: 300, width: 20 }, pantalla).left).toBe(16);
    // Una pantalla más angosta que el globo: se achica.
    expect(posicionGlobo({ left: 100, top: 300, width: 20 }, { width: 200, height: 800 })).toMatchObject({ left: 16, width: 168 });
  });
});

describe("la edición de la narrativa", () => {
  it("enseña lo que el verificador rechaza, una línea por problema", async () => {
    getPerfilComercial.mockResolvedValue(guardado());
    saveNarrativeEdit.mockRejectedValue(
      new PerfilComercialError("invalid_narrative", "x", [
        { code: "unknown_claim", id: "inventada" }, { code: "bare_number", text: "12.000" }, { code: "number_word", text: "millones" },
      ]),
    );
    render(await PerfilPage());
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    fireEvent.change(screen.getByLabelText("Texto de la narrativa"), { target: { value: "Tengo [claim:inventada], 12.000 y dos millones de fans." } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar narrativa" }));
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain("[claim:inventada] no es una cifra de este perfil.");
    expect(alerta.textContent).toContain("«12.000» es una cifra escrita a mano");
    expect(alerta.textContent).toContain("«millones» dice una cantidad con letras");
    expect(saveNarrativeEdit).toHaveBeenCalledWith({}, CREADORA, "Tengo [claim:inventada], 12.000 y dos millones de fans.", "2026-09-25T10:00:01.000Z");
  });

  it("inserta una cifra donde está el cursor y la vista previa la pinta formateada", async () => {
    getPerfilComercial.mockResolvedValue(guardado());
    render(await PerfilPage());
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    const area = screen.getByLabelText("Texto de la narrativa") as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: "Mi mediana: " } });
    area.setSelectionRange(12, 12);
    fireEvent.change(screen.getByLabelText("Insertar una cifra"), { target: { value: "mediana-tiktok" } });
    fireEvent.click(screen.getByRole("button", { name: "Insertar" }));
    await waitFor(() => expect(area.value).toBe("Mi mediana: [claim:mediana-tiktok]"));
    const vista = screen.getByText("Así se verá").closest("section")!;
    expect(vista.textContent).toContain("Mi mediana: 115,4 mil");
    expect(vista.textContent).not.toContain("[claim:");
  });
});

describe("las acciones", () => {
  it("recalcular sin llave de Anthropic guarda la narrativa de plantilla y no registra llamadas", async () => {
    const perfil = buildPerfil(entradas());
    computePerfil.mockResolvedValue(perfil);
    const r = await recalcularPerfil();
    expect(r).toEqual({ ok: true, message: "Perfil recalculado." });
    expect(recordProfileLlmCalls).not.toHaveBeenCalled();
    const [, perfilGuardado, narrativa] = savePerfilComercial.mock.calls[0]!;
    expect(perfilGuardado).toBe(perfil);
    expect(narrativa).toMatchObject({ source: "template", fallback: "no_model", text: templateNarrative(perfil, { locale: "es-CO" }) });
  });

  it("con modelo, cada llamada se registra apenas responde y el tope se mira antes de cada intento", async () => {
    const perfil = buildPerfil(entradas());
    computePerfil.mockResolvedValue(perfil);
    const respuestas = ["Uno sin marcas.\n\nDos.\n\nTres.", templateNarrative(perfil)];
    modelo = { model: "claude-sonnet-5", complete: async () => ({ text: respuestas.shift()!, inputTokens: 3000, outputTokens: 400 }) };
    expect((await recalcularPerfil()).ok).toBe(true);
    expect(llmBudgetExhausted).toHaveBeenCalledTimes(NARRATIVE_ATTEMPTS);
    expect(recordProfileLlmCalls.mock.calls.map((c) => c[1])).toEqual([
      [{ model: "claude-sonnet-5", inputTokens: 3000, outputTokens: 400 }],
      [{ model: "claude-sonnet-5", inputTokens: 3000, outputTokens: 400 }],
    ]);
    expect(savePerfilComercial.mock.calls[0]![2]).toMatchObject({ source: "llm", model: "claude-sonnet-5" });
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

  it("un rol que solo mira no recalcula ni edita: ni base ni modelo", async () => {
    puedeEditarElPerfil.mockResolvedValue(false);
    modelo = { model: "claude-sonnet-5", complete: vi.fn() };
    const sinPermiso = { ok: false, message: expect.stringMatching(/^Solo quien es dueño/), detalles: [] };
    expect(await recalcularPerfil()).toEqual(sinPermiso);
    expect(await guardarNarrativa("Hola.", "2026-09-25T10:00:01.000Z")).toEqual(sinPermiso);
    expect(computePerfil).not.toHaveBeenCalled();
    expect(savePerfilComercial).not.toHaveBeenCalled();
    expect(saveNarrativeEdit).not.toHaveBeenCalled();
    expect(modelo.complete).not.toHaveBeenCalled();
  });
});
