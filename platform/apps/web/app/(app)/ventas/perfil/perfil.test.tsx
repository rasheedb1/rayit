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
const readPostCovers = vi.fn();
const computePerfil = vi.fn();
const reserveProfileLlmBudget = vi.fn();
const releaseProfileLlmReservation = vi.fn();
const recordProfileLlmCalls = vi.fn();
const savePerfilComercial = vi.fn();
const saveNarrativeEdit = vi.fn();
const claimPerfilRecalc = vi.fn();
const releasePerfilRecalc = vi.fn();
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
    readPostCovers: (...a: unknown[]) => readPostCovers(...a),
    computePerfil: (...a: unknown[]) => computePerfil(...a),
    reserveProfileLlmBudget: (...a: unknown[]) => reserveProfileLlmBudget(...a),
    releaseProfileLlmReservation: (...a: unknown[]) => releaseProfileLlmReservation(...a),
    estimateProfileCallUsd: () => 0.044,
    recordProfileLlmCalls: (...a: unknown[]) => recordProfileLlmCalls(...a),
    savePerfilComercial: (...a: unknown[]) => savePerfilComercial(...a),
    saveNarrativeEdit: (...a: unknown[]) => saveNarrativeEdit(...a),
    claimPerfilRecalc: (...a: unknown[]) => claimPerfilRecalc(...a),
    releasePerfilRecalc: (...a: unknown[]) => releasePerfilRecalc(...a),
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

/** Cuatro videos largos y flojos en YouTube: con ellos, los cortos tienen contra qué compararse (tres o más a cada lado). */
function largos(): PerfilPostInput[] {
  return [0.5, 0.6, 0.8, 0.9].map((x, i) => ({
    id: `00000002-0000-4000-8000-00000000e0${i}${i}`, platformId: "youtube", url: `https://www.youtube.com/watch?v=${i}`,
    title: `Receta larga ${["uno", "dos", "tres", "cuatro"][i]}`, caption: "Receta larga 🍳 #receta", hashtags: ["receta"],
    surface: "feed", mediaType: "video", durationS: 200, isBrandedContent: false, publishedAt: "2026-08-01T00:00:00.000Z", hookType: null,
    score: { viewsVsMedian: x, viewsAtCut: 20_000, outlierTier: "under", ageHoursCut: 168, computedAt: "2026-09-25T00:00:00.000Z", baseline: null },
  }));
}

function entradas(): PerfilInputs {
  return {
    creator: { id: CREADORA, displayName: "Laura Méndez", handle: "laura.cocinafacil", bio: null, country: "CO", languages: ["es"], nicheSlugs: ["cocina"], nicheNames: ["Cocina"] },
    connections: [{ id: "c1", platformId: "tiktok", handle: "laura", status: "active", followers: 243000, followersSnapshotId: "77", followersDay: "2026-09-24" }],
    audience: [{ id: "00000002-0000-4000-8000-0000000a0001", platformId: "tiktok", connectionId: "c1", dimension: "gender", bucket: "F", share: 0.64, day: "2026-09-24" }],
    nonFollowers: [],
    baselines: [{ id: "00000002-0000-4000-8000-0000000b0001", platformId: "tiktok", ageHoursCut: 168, medianViews: 115446, sampleSize: 17, isReliable: true, computedAt: "2026-09-25T00:00:00.000Z" }],
    posts: TITULOS.map((_, i) => post(i)),
    campaigns: [{ id: CAMPANA, name: "Lanzamiento cold brew", companyName: "Café Alma", status: "reported", result: { views: 712000, brandFollowersGained: 1240, codeRedemptions: null, attributedRevenue: null, currency: "COP", viewsVsMedian: null, computedAt: "2026-09-20T15:00:00.000Z" } }],
    rateCard: { id: "00000004-0000-4000-8000-0000007a1f01", currency: "COP", computedAt: "2026-09-20T00:00:00.000Z", items: [{ id: "00000004-0000-4000-8000-0000007a1101", labelEs: "TikTok dedicado", platformId: "tiktok", priceLow: "5200000.00", priceHigh: "8080000.00" }] },
    cutHours: 168,
    computedAt: "2026-09-25T10:00:00.000Z",
  };
}

function guardado(source: "template" | "edited" = "template", e: PerfilInputs = entradas()): StoredPerfil {
  const perfil = buildPerfil(e);
  return {
    version: 3, computedAt: perfil.computedAt, perfil,
    narrative: { text: templateNarrative(perfil), source, model: null, writtenAt: "2026-09-25T10:00:01.000Z", fallback: source === "template" ? "no_model" : null },
  };
}

/** El texto que se ve, sin los globos de las cifras (que están en el DOM, cerrados). */
function visible(el: Element): string {
  const copia = el.cloneNode(true) as Element;
  copia.querySelectorAll("[data-globo]").forEach((g) => g.remove());
  return copia.textContent ?? "";
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
  // Por defecto, ningún post trae portada viva: se usa la guardada.
  readPostCovers.mockResolvedValue({});
  puedeEditarElPerfil.mockResolvedValue(true);
  let n = 0;
  reserveProfileLlmBudget.mockImplementation(async () => `reserva-${++n}`);
  releaseProfileLlmReservation.mockResolvedValue(undefined);
  recordProfileLlmCalls.mockResolvedValue(undefined);
  claimPerfilRecalc.mockResolvedValue({ token: "marca-1", narrativeWrittenAt: "2026-09-25T10:00:01.000Z" });
  releasePerfilRecalc.mockResolvedValue(undefined);
  // Lo que una prueba hizo fallar no se arrastra a la siguiente.
  computePerfil.mockReset();
  savePerfilComercial.mockReset().mockResolvedValue(undefined);
  saveNarrativeEdit.mockReset();
});
afterEach(cleanup);

describe("la pantalla", () => {
  it("las cifras de una campaña dicen que son las del reporte, con su fecha (pulido r3)", async () => {
    getPerfilComercial.mockResolvedValue(guardado());
    render(await PerfilPage());
    const prueba = screen.getByText("Con quién has trabajado").closest("section")!;
    expect(within(prueba).getByText(/^Al cierre del reporte, .*20/)).toBeTruthy();
    expect(screen.getByText(/^Las cifras de campañas son al cierre de su reporte \(Café Alma, .*20.*\); en Campañas ves las de hoy\.$/)).toBeTruthy();
  });

  it("muestra los cinco mejores videos con su portada, sus cifras, su corte, su mediana y cómo son", async () => {
    getPerfilComercial.mockResolvedValue(guardado());
    render(await PerfilPage());
    const lista = screen.getByText("Tus cinco mejores videos").closest("div, section")!.querySelector("ol")!;
    const items = within(lista).getAllByRole("listitem").filter((li) => li.parentElement === lista);
    expect(items).toHaveLength(5);
    expect(items.map((li) => within(li).getAllByRole("link")[0]!.textContent)).toEqual(TITULOS.slice(0, 5));
    // La primera: 6,0× su mediana, 400 mil visualizaciones a los 7 días, 30 s, «Fuera de serie» y la mediana contra la que se midió.
    const primero = within(items[0]!);
    expect(primero.getByRole("button", { name: /^6,0×/ })).toBeTruthy();
    expect(primero.getByRole("button", { name: /^400 mil/ })).toBeTruthy();
    expect(primero.getByText(/visualizaciones a los 7 días de publicado/)).toBeTruthy();
    expect(primero.getByRole("button", { name: /^30 s/ })).toBeTruthy();
    expect(primero.getByText("Fuera de serie")).toBeTruthy();
    expect(within(items[1]!).getByText("Muy por encima")).toBeTruthy();
    expect(primero.getByText(/Tu mediana de Instagram a esa edad/)).toBeTruthy();
    expect(primero.getByRole("button", { name: /^66,7 mil/ })).toBeTruthy();
    // Sin datos para contrastar, la explicación es cómo es el video, sin inventar una causa.
    expect(primero.getByText("Cómo es:")).toBeTruthy();
    expect(visible(items[0]!)).toMatch(/Cómo es: abre con una promesa concreta · reel · tutorial · corto/);
    expect(primero.queryByText(/Lo que lo distingue/)).toBeNull();
    expect(primero.queryByText(/Ningún rasgo/)).toBeNull();
    // Ninguno de los cinco tiene portada: la columna no se pinta (ni imágenes ni cinco rectángulos vacíos).
    for (const li of items) {
      expect(li.querySelector("img")).toBeNull();
      expect(li.querySelector("[data-marcador]")).toBeNull();
      expect(li.querySelector("span.bg-hover")).toBeNull();
    }
    // Las portadas se leen vivas para los cinco que se pintan.
    expect(readPostCovers).toHaveBeenCalledWith({}, guardado().perfil.performance.top.map((v) => v.postId));
  });

  it("si solo algunos tienen portada, los demás llevan el color de su red, su nombre y su duración", async () => {
    const e = entradas();
    e.posts[0]!.coverUrl = "https://p16.tiktokcdn.com/portada-0.jpg";
    getPerfilComercial.mockResolvedValue(guardado("template", e));
    render(await PerfilPage());
    const lista = screen.getByText("Tus cinco mejores videos").closest("div, section")!.querySelector("ol")!;
    const items = within(lista).getAllByRole("listitem").filter((li) => li.parentElement === lista);
    expect(within(items[0]!).getByRole("img", { name: "Portada de «Cold brew en casa en 3 pasos»" })).toBeTruthy();
    const marcador = within(items[1]!).getByRole("img", { name: "Video de TikTok de 31 s, sin portada" });
    expect(marcador.getAttribute("data-marcador")).toBe("tiktok");
    expect(marcador.className).toContain("bg-s-tiktok/15");
    expect(marcador.textContent).toBe("TikTok31 s");
    expect(within(items[2]!).getByRole("img", { name: "Video de Instagram de 32 s, sin portada" })).toBeTruthy();
  });

  it("pinta la portada viva y no la del cálculo, y una que ya no carga cambia al marcador", async () => {
    const e = entradas();
    // La portada que quedó en el perfil al calcularlo: una URL firmada que ya caducó.
    e.posts[0]!.coverUrl = "https://p16.tiktokcdn.com/portada-0.jpg?x-expires=1";
    const g = guardado("template", e);
    getPerfilComercial.mockResolvedValue(g);
    const primero = g.perfil.performance.top[0]!.postId;
    const segundo = g.perfil.performance.top[1]!.postId;
    readPostCovers.mockResolvedValue({ [primero]: "https://p16.tiktokcdn.com/portada-0.jpg?x-expires=2", [segundo]: "/demo/portadas/2.svg" });
    render(await PerfilPage());
    const img = screen.getByRole("img", { name: "Portada de «Cold brew en casa en 3 pasos»" });
    expect(img.getAttribute("src")).toBe("https://p16.tiktokcdn.com/portada-0.jpg?x-expires=2");
    expect(screen.getByRole("img", { name: "Portada de «La arepa sin plancha»" }).getAttribute("src")).toBe("/demo/portadas/2.svg");
    // La plataforma ya no la sirve: en vez de una imagen rota, la red y la duración.
    fireEvent.error(img);
    expect(screen.queryByRole("img", { name: "Portada de «Cold brew en casa en 3 pasos»" })).toBeNull();
    expect(screen.getByRole("img", { name: "Video de Instagram de 30 s, sin portada" })).toBeTruthy();
  });

  it("con videos para comparar, dice lo que distingue al mejor sin contarlo a él, y enseña su portada", async () => {
    const e = entradas();
    e.posts[0]!.coverUrl = "https://p16.tiktokcdn.com/portada-0.jpg";
    e.posts.push(...largos());
    getPerfilComercial.mockResolvedValue(guardado("template", e));
    render(await PerfilPage());
    const lista = screen.getByText("Tus cinco mejores videos").closest("div, section")!.querySelector("ol")!;
    const primero = lista.querySelector("li")!;
    // Los otros cortos (5, 4, 3, 2 y 1 veces) frente a los largos (0,5; 0,6; 0,8 y 0,9): 3,0× frente a 0,7×.
    expect(visible(primero)).toMatch(/Lo que lo distingue: Tus otros videos cortos hacen 3,0× tu mediana, frente a 0,7× de tus videos sin ser corto/);
    const img = within(primero).getByRole("img", { name: "Portada de «Cold brew en casa en 3 pasos»" });
    expect(img.getAttribute("src")).toBe("https://p16.tiktokcdn.com/portada-0.jpg");
    expect(img.getAttribute("loading")).toBe("lazy");
    // La mediana del grupo es un claim con su origen: los otros videos, con enlace, en «De dónde sale cada cifra».
    const grupo = within(primero).getByRole("button", { name: /^3,0×/ });
    const { enlace } = globo(grupo);
    const fila = document.getElementById(enlace.getAttribute("href")!.slice(1))!;
    expect(fila.textContent).toContain("Videos que la forman:");
    expect(within(fila).getByRole("link", { name: "La arepa sin plancha" }).getAttribute("href")).toBe("https://www.tiktok.com/@laura/video/1");
    expect(within(fila).queryByRole("link", { name: "Cold brew en casa en 3 pasos" })).toBeNull();
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
    const alVideo = botones.find((b) => b.textContent === "6,0×")!;
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
    // La fila se lee sin jerga: la tabla, la columna y la fila quedan en su title, para soporte.
    const fila = document.getElementById("origen-mediana-tiktok")!;
    expect(fila.textContent).not.toContain("creator_baseline.median_views");
    expect(fila.textContent).not.toContain("00000002-0000-4000-8000-0000000b0001");
    expect(fila.getAttribute("title")).toBe("creator_baseline.median_views · 00000002-0000-4000-8000-0000000b0001");
    // Ninguna marca queda sin pintar.
    expect(narrativa.textContent).not.toContain("[claim:");
    expect(within(narrativa).getByText(/todavía no está activada en On Cue; usamos una plantilla con tus mismas cifras/)).toBeTruthy();
    expect(within(narrativa).getByText("La narrativa se redacta en español.")).toBeTruthy();
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

  it("con el teclado, cada cifra es una sola parada de Tab; Enter la fija y entonces su enlace sí entra", async () => {
    getPerfilComercial.mockResolvedValue(guardado());
    render(await PerfilPage());
    const narrativa = screen.getByText("Narrativa").closest("section")!;
    const [primera, segunda] = within(narrativa).getAllByRole("button").filter((b) => b.hasAttribute("aria-controls"));
    /** Las paradas de Tab desde `a` hasta `b` (incluida b), en el orden del documento: jsdom no tabula, se cuentan. */
    const paradas = (a: HTMLElement, b: HTMLElement) => {
      const todas = [...document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")].filter(
        (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled,
      );
      return todas.indexOf(b) - todas.indexOf(a);
    };
    // El foco abre el globo para leerlo, pero su enlace no es una parada: la siguiente es la otra cifra.
    act(() => primera!.focus());
    expect(primera!.getAttribute("aria-expanded")).toBe("true");
    expect(globo(primera!).enlace.tabIndex).toBe(-1);
    expect(paradas(primera!, segunda!)).toBe(1);
    // Enter (un clic en el botón) lo fija: ahora el siguiente Tab llega a «Abrir el origen».
    fireEvent.click(primera!);
    expect(globo(primera!).enlace.tabIndex).toBe(0);
    expect(paradas(primera!, segunda!)).toBe(2);
    // El anillo de foco del enlace se ve sobre el fondo del globo.
    expect(globo(primera!).enlace.className).toContain("focus-visible:ring-tooltip-ink");
    // Sacar el foco de la cifra y de su globo lo cierra, también fijo.
    act(() => segunda!.focus());
    expect(primera!.getAttribute("aria-expanded")).toBe("false");
  });

  it("a 400 px, el globo de la última cifra de «Cuánto cobras» cabe en la pantalla", async () => {
    getPerfilComercial.mockResolvedValue(guardado());
    render(await PerfilPage());
    const ancho = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
    try {
      const tarifas = screen.getByText("Cuánto cobras").closest("section")!;
      // Cada fila en dos columnas: al envolver la etiqueta, el rango sigue a la derecha.
      for (const li of tarifas.querySelectorAll("li")) expect(li.className).toContain("grid-cols-[minmax(0,1fr)_auto]");
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
    expect(alerta.textContent).toContain("⟦inventada⟧ no es una cifra de este perfil");
    expect(alerta.textContent).toContain("«12.000» es una cifra escrita a mano");
    expect(alerta.textContent).toContain("«millones» dice una cantidad");
    expect(saveNarrativeEdit).toHaveBeenCalledWith({}, CREADORA, "Tengo [claim:inventada], 12.000 y dos millones de fans.", "2026-09-25T10:00:01.000Z");
  });

  it("el editor enseña cada cifra como una ficha legible, sin ids, y guarda las mismas marcas", async () => {
    const g = guardado();
    getPerfilComercial.mockResolvedValue(g);
    saveNarrativeEdit.mockResolvedValue({ ...g, narrative: { ...g.narrative, source: "edited", writtenAt: "2026-09-25T10:05:00.000Z" } });
    render(await PerfilPage());
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    const area = screen.getByLabelText("Texto de la narrativa") as HTMLTextAreaElement;
    expect(area.value).not.toContain("[claim:");
    expect(area.value).toContain("mediana de ⟦115,4 mil⟧ views");
    expect(area.className).not.toContain("font-mono");
    // Sin tocar nada, lo que se guarda es la narrativa con sus marcas, igual que estaba.
    fireEvent.click(screen.getByRole("button", { name: "Guardar narrativa" }));
    await waitFor(() => expect(saveNarrativeEdit).toHaveBeenCalledWith({}, CREADORA, g.narrative.text, g.narrative.writtenAt));
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
    // En el editor la cifra es una ficha legible, no un id.
    await waitFor(() => expect(area.value).toBe("Mi mediana: ⟦115,4 mil⟧"));
    const vista = screen.getByText("Así se verá").closest("section")!;
    expect(vista.textContent).toContain("Mi mediana: 115,4 mil");
    expect(vista.textContent).not.toContain("[claim:");
    expect(vista.textContent).toContain("Todas las cifras están marcadas y salen de tu perfil.");
  });

  it("la vista previa subraya lo que el verificador rechazaría, antes de guardar", async () => {
    getPerfilComercial.mockResolvedValue(guardado());
    render(await PerfilPage());
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    fireEvent.change(screen.getByLabelText("Texto de la narrativa"), {
      target: {
        value:
          "Tengo [claim:inventada], ⟦seguidores inventados⟧, ⟦115,4 mil⟧ seguidores, 3 millones y cuadrupliqué mis views con «Cold brew en casa en 3 pasos».",
      },
    });
    const vista = screen.getByText("Así se verá").closest("section")!;
    const marcas = [...vista.querySelectorAll("mark")].map((m) => m.textContent);
    // Una marca que no es de ninguna cifra se ve como en el editor, ⟦…⟧: el id técnico no se asoma.
    expect(marcas).toEqual(["⟦inventada⟧", "⟦seguidores inventados⟧", "seguidores", "3", "millones", "cuadrupliqué"]);
    expect(vista.textContent).not.toContain("[claim:");
    // Una mediana de views seguida de «seguidores»: la cifra es real, la afirmación no.
    expect(vista.textContent).toContain("«seguidores» no es lo que mide ⟦115,4 mil⟧");
    expect(vista.textContent).toContain("Lo subrayado no pasará el verificador al guardar:");
    expect(vista.textContent).toContain("⟦inventada⟧ no es una cifra de este perfil");
    expect(vista.textContent).toContain("«cuadrupliqué» dice una cantidad");
    // Nada se mandó todavía: la puerta de verdad sigue siendo la del servidor.
    expect(saveNarrativeEdit).not.toHaveBeenCalled();
  });

  it("ninguna fila de «De dónde sale cada cifra» repite el globo: enseña sus videos o su informe", async () => {
    const e = entradas();
    // Las líneas base con los videos que las forman (readBaselinePosts) y un reparto de género de dos segmentos.
    e.baselinePosts = {
      "00000002-0000-4000-8000-0000000b0001": [post(1).id, post(3).id, post(5).id],
      "00000002-0000-4000-8000-0000000b0002": [post(0).id, post(2).id, post(4).id],
    };
    e.audience = [...e.audience, { id: "00000002-0000-4000-8000-0000000a0002", platformId: "tiktok", connectionId: "c1", dimension: "gender", bucket: "M", share: 0.36, day: "2026-09-24" }];
    getPerfilComercial.mockResolvedValue(guardado("template", e));
    render(await PerfilPage());
    const fuentes = screen.getByText("De dónde sale cada cifra").closest("section")!;
    const filas = [...fuentes.querySelectorAll("li[id^='origen-']")];
    expect(filas.length).toBeGreaterThan(0);
    for (const fila of filas) expect(fila.querySelector("[data-detalle-origen]"), fila.id).not.toBeNull();
    // La mediana lista sus videos; la demografía, su informe y el resto del reparto.
    expect(document.getElementById("origen-mediana-tiktok")!.textContent).toContain("Videos que la forman: La arepa sin plancha");
    const mujeres = document.getElementById("origen-audiencia-tiktok-genero-f")!.textContent;
    expect(mujeres).toContain("Del informe de audiencia que da TikTok, solo sobre tus seguidores.");
    expect(mujeres).toContain("En la misma lectura: Hombres 36");
  });

  it("«De dónde sale cada cifra» empieza plegado y la cifra que lleva a una fila lo abre", async () => {
    getPerfilComercial.mockResolvedValue(guardado());
    render(await PerfilPage());
    const fuentes = screen.getByText("De dónde sale cada cifra").closest("section")!;
    const plegable = fuentes.querySelector("details")!;
    expect(plegable.open).toBe(false);
    expect(within(fuentes).getByText(/^Ver las \d+ fuentes$/)).toBeTruthy();
    // Agrupado por origen, con nombres legibles.
    expect(within(fuentes).getByText("Demografía y alcance")).toBeTruthy();
    expect(within(fuentes).getByText("Líneas base")).toBeTruthy();
    const mediana = screen.getAllByRole("button", { name: /^115,4 mil/ })[0]!;
    fireEvent.click(globo(mediana).enlace);
    expect(plegable.open).toBe(true);
  });
});

describe("las acciones", () => {
  it("recalcular sin llave de Anthropic guarda la narrativa de plantilla y no registra llamadas", async () => {
    const perfil = buildPerfil(entradas());
    computePerfil.mockResolvedValue(perfil);
    const r = await recalcularPerfil();
    expect(r).toEqual({ ok: true, message: "Perfil recalculado." });
    expect(recordProfileLlmCalls).not.toHaveBeenCalled();
    const [, perfilGuardado, narrativa, opciones] = savePerfilComercial.mock.calls[0]!;
    expect(perfilGuardado).toBe(perfil);
    expect(narrativa).toMatchObject({ source: "template", fallback: "no_model", text: templateNarrative(perfil, { locale: "es-CO" }) });
    // Guarda contra la narrativa que había al empezar y suelta la marca en la misma transacción.
    expect(opciones).toEqual({ expectedWrittenAt: "2026-09-25T10:00:01.000Z", recalcToken: "marca-1" });
    expect(claimPerfilRecalc).toHaveBeenCalledWith({}, CREADORA);
    expect(releasePerfilRecalc).not.toHaveBeenCalled();
  });

  it("si ya hay un recálculo en curso, lo dice y no llama al modelo", async () => {
    claimPerfilRecalc.mockRejectedValue(new PerfilComercialError("recalc_in_progress", "x"));
    modelo = { model: "claude-sonnet-5", complete: vi.fn() };
    expect(await recalcularPerfil()).toEqual({ ok: false, message: expect.stringMatching(/^Ya se está recalculando/), detalles: [] });
    expect(modelo.complete).not.toHaveBeenCalled();
    expect(computePerfil).not.toHaveBeenCalled();
    expect(savePerfilComercial).not.toHaveBeenCalled();
  });

  it("una edición guardada mientras se recalculaba no se pisa, y la marca se suelta", async () => {
    computePerfil.mockResolvedValue(buildPerfil(entradas()));
    savePerfilComercial.mockRejectedValue(new PerfilComercialError("stale_edit", "x"));
    expect((await recalcularPerfil()).message).toMatch(/^Alguien editó la narrativa mientras se recalculaba/);
    expect(releasePerfilRecalc).toHaveBeenCalledWith({}, CREADORA, "marca-1");
  });

  it("con modelo, cada intento aparta su costo antes de llamar y lo suelta al registrarse la llamada", async () => {
    const perfil = buildPerfil(entradas());
    computePerfil.mockResolvedValue(perfil);
    const respuestas = ["Uno sin marcas.\n\nDos.\n\nTres.", templateNarrative(perfil)];
    modelo = { model: "claude-sonnet-5", complete: async () => ({ text: respuestas.shift()!, inputTokens: 3000, outputTokens: 400 }) };
    expect((await recalcularPerfil()).ok).toBe(true);
    expect(reserveProfileLlmBudget).toHaveBeenCalledTimes(NARRATIVE_ATTEMPTS);
    expect(reserveProfileLlmBudget).toHaveBeenCalledWith({}, 0.044);
    expect(recordProfileLlmCalls.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [[{ model: "claude-sonnet-5", inputTokens: 3000, outputTokens: 400 }], "reserva-1"],
      [[{ model: "claude-sonnet-5", inputTokens: 3000, outputTokens: 400 }], "reserva-2"],
    ]);
    // Cada reserva la soltó su registro: no queda ninguna por soltar.
    expect(releaseProfileLlmReservation).not.toHaveBeenCalled();
    expect(savePerfilComercial.mock.calls[0]![2]).toMatchObject({ source: "llm", model: "claude-sonnet-5" });
  });

  it("sin saldo (contando lo que el worker ya apartó) no llama al modelo: guarda la plantilla", async () => {
    const perfil = buildPerfil(entradas());
    computePerfil.mockResolvedValue(perfil);
    reserveProfileLlmBudget.mockResolvedValue(null);
    modelo = { model: "claude-sonnet-5", complete: vi.fn() };
    expect((await recalcularPerfil()).ok).toBe(true);
    expect(modelo.complete).not.toHaveBeenCalled();
    expect(savePerfilComercial.mock.calls[0]![2]).toMatchObject({ source: "template", fallback: "budget" });
  });

  it("si el modelo falla, la reserva de ese intento se suelta", async () => {
    computePerfil.mockResolvedValue(buildPerfil(entradas()));
    modelo = { model: "claude-sonnet-5", complete: async () => { throw new Error("529"); } };
    expect((await recalcularPerfil()).ok).toBe(true);
    expect(recordProfileLlmCalls).not.toHaveBeenCalled();
    expect(releaseProfileLlmReservation).toHaveBeenCalledWith({}, "reserva-1");
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
