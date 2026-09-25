import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * El editor del pitch (VEN-6 dentro de VEN-12): las fichas insertan la
 * cifra con su origen donde está el cursor, y dentro del mensaje la cifra
 * y la variable se ven como fichas, nunca como marcas; la vista previa
 * enseña lo que recibe la marca; la revisión en línea no deja programar un
 * pitch con una cifra sin origen (y lo dice junto al botón). Guardar y
 * programar de verdad (RLS, pre-vuelo en el servidor) está probado en
 * pglite: packages/db/test/outreach-pitch.test.ts.
 */
const guardarPitch = vi.fn();
const pedirRedaccion = vi.fn();
const refresh = vi.fn();
vi.mock("./actions", () => ({
  guardarPitch: (...a: unknown[]) => guardarPitch(...a),
  pedirRedaccion: (...a: unknown[]) => pedirRedaccion(...a),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import type { SalesClaim } from "@mc/core/outreach/claims";
import { EditorDePitch, type EditorData } from "./editor";
import { MontajeDelEditor } from "./montaje";
import { groupClaims } from "./fichas";
import { markedOf, segmentsOf } from "./marcas";
import { PITCH } from "./messages";
import { claimSnippet, editorKey, previewOf, reviseDraft, revisionSummary } from "./vista";

const MEDIANA: SalesClaim = {
  id: "baseline:tiktok:median_views", source: "creator_baseline", label: "Mediana de views en TikTok a 7 días", value: 115446,
  unit: "count", display: "115.446", ref: { table: "creator_baseline", id: "b1" },
};

const DEAL = "00000002-0000-4000-8000-00000000d001";
const VARIANTE = {
  creator: { id: "00000002-0000-4000-8000-000000000003", name: "Laura Méndez", handle: "laura.cocinafacil", niche: "cocina" },
  claims: [MEDIANA],
  sources: {
    company: { name: "Café Alma", industry: "alimentos", city: "Bogotá" },
    signal: { headline: "Lanzó cold brew en botella" },
    creator: { senderName: "Laura Méndez", handle: "laura.cocinafacil", niche: "cocina", mediaKitUrl: null, quoteUrl: null },
  },
};

function datos(over: Partial<EditorData> = {}): EditorData {
  return {
    companyId: "00000002-0000-4000-8000-0000000000e1",
    company: { name: "Café Alma", industry: "alimentos", city: "Bogotá" },
    contacts: [{ id: "00000002-0000-4000-8000-0000000c0004", fullName: "Camilo Herrera", roleTitle: "Marketing digital", email: "c.herrera@cafealma.co", firstTouch: true }],
    deals: [{ id: DEAL, label: "Café Alma · Cold brew", signalHeadline: "Lanzó cold brew en botella" }],
    variants: { "": VARIANTE, [DEAL]: VARIANTE },
    draft: null,
    ai: "off",
    sendingOn: false,
    policy: { hasPostalAddress: true, hasEmailAccount: true },
    ...over,
  };
}

const BORRADOR = {
  touchId: "00000002-0000-4000-8000-000000070001", contactId: null, dealId: null, subject: "Una idea para Café Alma", held: null,
  generated: true, score: "8,7", note: "Abre con la marca.", pending: null, failed: false,
};

const BUENO = [
  "Hola {{first_name}},",
  "",
  `Vi que {{company}} lanzó su cold brew en botella y pensé en quien me ve: mi mediana en TikTok es de ${claimSnippet(MEDIANA)} views.`,
  "",
  "Mis recetas de desayuno se guardan para la semana y el café entra ahí sin forzarlo, justo cuando la gente arma su mañana.",
  "",
  "¿Te interesa que te mande una idea de video para el lanzamiento?",
  "",
  "Laura",
].join("\n");

/** El cuerpo del editor: un campo de texto con fichas, no un <textarea>. */
const cuerpo = () => screen.getByRole("textbox", { name: PITCH.campos.cuerpo });
/** Lo que va al formulario: el texto marcado, con sus [claim:id] y sus {{variables}}. */
const marcado = (container: HTMLElement) => (container.querySelector('input[name="body"]') as HTMLInputElement).value;
/** Escribe en el cuerpo como lo haría el navegador: cambia el texto y avisa. */
function escribir(texto: string) {
  const el = cuerpo();
  el.textContent = texto;
  fireEvent.input(el);
}
const programar = () => screen.getByRole("button", { name: PITCH.acciones.programar }) as HTMLButtonElement;
const copiar = () => screen.getByRole("button", { name: PITCH.acciones.copiarLabel }) as HTMLButtonElement;

beforeEach(() => {
  guardarPitch.mockReset();
  pedirRedaccion.mockReset();
  refresh.mockReset();
});

describe("vista del pitch", () => {
  it("la vista previa rellena las variables y quita las marcas", () => {
    const p = previewOf("Una idea para {{company}}", BUENO, { first_name: "Camilo", company: "Café Alma" });
    expect(p.subject).toBe("Una idea para Café Alma");
    expect(p.body.startsWith("Hola Camilo,")).toBe(true);
    expect(p.body).not.toContain("[claim:");
    expect(p.body).toContain("115.446 views");
  });

  it("una cifra sin origen impide programar, pero no copiar; una que dice otra cosa, las dos", () => {
    const values = { first_name: "Camilo", company: "Café Alma" };
    const r = reviseDraft({ subject: "Una idea para Café Alma", body: BUENO.replace(claimSnippet(MEDIANA), "900.000"), values, claims: [MEDIANA], firstTouch: true });
    expect([r.ok, r.canCopy]).toEqual([false, true]);
    expect(r.items.map((i) => i.text)).toContain(PITCH.problemas.unsourced_figure("900.000"));
    const otra = reviseDraft({ subject: "Una idea para Café Alma", body: BUENO.replace("115.446 [claim", "900.000 [claim"), values, claims: [MEDIANA], firstTouch: true });
    expect([otra.ok, otra.canCopy]).toEqual([false, false]);
    const bien = reviseDraft({ subject: "Una idea para Café Alma", body: BUENO, values, claims: [MEDIANA], firstTouch: true });
    expect(bien).toMatchObject({ ok: true, canCopy: true });
    expect(bien.cited.map((c) => c.id)).toEqual([MEDIANA.id]);
  });

  it("recién abierto y vacío no es un error: no dice «falta el asunto» ni «está vacío», solo qué hacer", () => {
    const r = reviseDraft({ subject: "", body: "", values: {}, claims: [MEDIANA], firstTouch: true });
    expect([r.ok, r.pristine, r.items]).toEqual([false, true, []]);
    expect(revisionSummary(r)).toBe(PITCH.revision.empezar);
    const escrito = reviseDraft({ subject: "", body: "Hola", values: {}, claims: [MEDIANA], firstTouch: true });
    expect(escrito.items.map((i) => i.code)).toContain("subject_missing");
    expect(revisionSummary(escrito)).toBe(PITCH.revision.resumen(escrito.items.length, escrito.items[0]!.text));
  });

  it("la clave de la IA es null cuando lo último lo escribió una persona; cambia cuando la IA redacta o trae un borrador", () => {
    expect(editorKey(null)).toBeNull();
    expect(editorKey({ touchId: "t1", pending: null, generationStamp: null })).toBeNull();
    expect(editorKey({ touchId: "t1", pending: { stage: "generating" }, generationStamp: null })).toBe("t1:pendiente");
    expect(editorKey({ touchId: "t1", pending: null, generationStamp: "2026-09-25T10:00:00.000Z" })).toBe("t1:2026-09-25T10:00:00.000Z");
  });
});

describe("marcas y fichas del mensaje", () => {
  it("cada marca se lleva su cifra y queda como ficha; las variables también; al unirlo, lo que ve la marca no cambia", () => {
    const s = segmentsOf("Hola {{first_name}}: tengo 115.446 views [claim:baseline:tiktok:median_views] de mediana.");
    expect(s).toEqual([
      { kind: "text", text: "Hola " },
      { kind: "variable", name: "first_name" },
      { kind: "text", text: ": tengo " },
      { kind: "claim", id: "baseline:tiktok:median_views", raw: "115.446" },
      { kind: "text", text: " views de mediana." },
    ]);
    expect(markedOf(s)).toBe("Hola {{first_name}}: tengo 115.446 [claim:baseline:tiktok:median_views] views de mediana.");
    // Una variable desconocida no es una ficha: es un hueco y se queda a la vista.
    expect(segmentsOf("Hola {{apodo}}")).toEqual([{ kind: "text", text: "Hola {{apodo}}" }]);
    expect(markedOf(segmentsOf(BUENO))).toBe(BUENO);
  });
});

describe("EditorDePitch", () => {
  it("la ficha de una cifra la inserta con su origen, y en el mensaje se ve la cifra, nunca la marca", () => {
    const { container } = render(<EditorDePitch data={datos()} />);
    fireEvent.click(screen.getByRole("button", { name: PITCH.fichas.insertar(`${MEDIANA.label}: ${MEDIANA.display}`) }));
    expect(marcado(container).trim()).toBe(claimSnippet(MEDIANA));
    expect(cuerpo().textContent).not.toContain("[claim:");
    const ficha = within(cuerpo()).getByLabelText(PITCH.cuerpo.cifra(MEDIANA.display, MEDIANA.label, PITCH.origen.creator_baseline));
    expect(ficha.textContent).toBe(MEDIANA.display);
    expect(ficha.getAttribute("contenteditable")).toBe("false");
    const cita = within(screen.getByRole("complementary", { name: PITCH.vista.titulo }));
    expect(cita.getByText(MEDIANA.label)).toBeTruthy();
    // La variable, igual: una ficha con su nombre en palabras.
    fireEvent.click(screen.getByRole("button", { name: PITCH.fichas.insertar(PITCH.variables.first_name) }));
    expect(marcado(container)).toContain("{{first_name}}");
    expect(cuerpo().textContent).toContain(PITCH.variables.first_name);
    expect(cuerpo().textContent).not.toContain("{{");
  });

  it("un borrador con marcas abre con fichas; la ayuda del mensaje no habla de «claim»", () => {
    render(<EditorDePitch data={datos({ draft: { ...BORRADOR, body: BUENO } })} />);
    expect(cuerpo().textContent).not.toMatch(/\[claim:|\{\{/);
    expect(cuerpo().textContent).toContain("115.446");
    expect(PITCH.campos.cuerpoHelp.toLowerCase()).not.toContain("claim");
    expect(screen.getByText(PITCH.campos.cuerpoHelp)).toBeTruthy();
  });

  it("con una cifra inventada, «Programar» se apaga y dice por qué junto al botón; «Copiar» sigue; bien escrito, se enciende", () => {
    const { unmount } = render(<EditorDePitch data={datos({ draft: { ...BORRADOR, body: BUENO.replace(claimSnippet(MEDIANA), "900.000") } })} />);
    expect(programar().disabled).toBe(true);
    expect(copiar().disabled).toBe(false);
    const aviso = PITCH.revision.resumen(1, PITCH.problemas.unsourced_figure("900.000"));
    expect(screen.getByText(aviso, { exact: false })).toBeTruthy();
    expect(programar().getAttribute("aria-describedby")).toBe("pitch-resumen");
    expect(screen.getByRole("link", { name: PITCH.revision.verRevision }).getAttribute("href")).toBe("#pitch-revision");
    // La nota de la revisión automática del borrador generado.
    expect(screen.getByText(PITCH.revision.nota("8,7"))).toBeTruthy();
    expect(screen.getByText("Abre con la marca.")).toBeTruthy();
    unmount();

    render(<EditorDePitch data={datos({ draft: { ...BORRADOR, body: BUENO } })} />);
    expect(programar().disabled).toBe(false);
    expect(screen.getByText(PITCH.revision.ok)).toBeTruthy();
    expect(screen.queryByRole("link", { name: PITCH.revision.verRevision })).toBeNull();
  });

  it("«x3», «#1», «top 1» y «3-fold» son cifras sin origen: «Programar» se apaga (ronda 3)", () => {
    for (const inventada of ["Con mis videos las ventas crecieron x3.", "Soy la creadora #1 de recetas.", "Estuve en el top 1 de TikTok.", "My sales grew 3-fold."]) {
      const { unmount } = render(<EditorDePitch data={datos({ draft: { ...BORRADOR, body: BUENO.replace("Mis recetas de desayuno", `${inventada} Mis recetas de desayuno`) } })} />);
      expect(programar().disabled, inventada).toBe(true);
      expect(screen.getAllByText(/no tiene origen/).length, inventada).toBeGreaterThan(0);
      unmount();
    }
  });

  it("lo normal de una propuesta («te propongo 3 videos», «un reel de 30 segundos») no apaga nada", () => {
    render(<EditorDePitch data={datos({ draft: { ...BORRADOR, body: BUENO.replace("Mis recetas de desayuno", "Te propongo 3 videos y un reel de 30 segundos. Mis recetas de desayuno") } })} />);
    expect(programar().disabled).toBe(false);
  });

  it("recién abierto y vacío: sin errores en rojo, con una línea de qué hacer; al escribir aparecen", () => {
    render(<EditorDePitch data={datos()} />);
    expect(screen.queryByText(PITCH.asunto.subject_missing!)).toBeNull();
    expect(screen.queryByText(PITCH.problemas.empty())).toBeNull();
    expect(screen.getByText(PITCH.revision.empezar)).toBeTruthy();
    expect(screen.getByText(PITCH.revision.vacioNeutro)).toBeTruthy();
    escribir("Hola");
    expect(screen.getAllByText(PITCH.asunto.subject_missing!).length).toBeGreaterThan(0);
  });

  it("guardar: el aviso se queda y recibe el foco aunque la página se vuelva a pintar con el borrador guardado", async () => {
    guardarPitch.mockResolvedValue({ ok: true, notice: PITCH.acciones.guardado, touchId: BORRADOR.touchId, intent: "draft", stamp: 1 });
    const inicial = datos();
    const { rerender } = render(<MontajeDelEditor data={inicial} aiKey={editorKey(null)} />);
    escribir("Hola, esto lo escribo yo.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: PITCH.acciones.guardar }));
    });
    const aviso = await screen.findByText(PITCH.acciones.guardado, { exact: false });
    // revalidatePath: la página vuelve con el borrador guardado (ya tiene toque). Sin clave de la IA: no se remonta.
    const guardado = { ...BORRADOR, generated: false, score: null, note: null, subject: "", body: "Hola, esto lo escribo yo." };
    rerender(<MontajeDelEditor data={{ ...inicial, draft: guardado }} aiKey={editorKey({ touchId: guardado.touchId, pending: null, generationStamp: null })} />);
    expect(screen.getByText(PITCH.acciones.guardado, { exact: false })).toBe(aviso);
    expect(document.activeElement).toBe(aviso);
  });
});

describe("la redacción con IA en el editor", () => {
  it("sin IA disponible lo dice en la voz del producto (sin llaves ni worker) y no deja pedir", () => {
    const { unmount } = render(<EditorDePitch data={datos({ ai: "off" })} />);
    expect(screen.getByText(PITCH.ia.noConfigurada)).toBeTruthy();
    expect(screen.queryByRole("button", { name: PITCH.ia.redactar })).toBeNull();
    unmount();
    render(<EditorDePitch data={datos({ ai: "unknown" })} />);
    expect(screen.getByText(PITCH.ia.desconocida)).toBeTruthy();
    for (const jerga of [/worker/i, /llave/i, /anthropic/i]) {
      expect(PITCH.ia.noConfigurada).not.toMatch(jerga);
      expect(PITCH.ia.desconocida).not.toMatch(jerga);
    }
    // Con el envío apagado lo avisa, sin decir que algo se programó.
    expect(screen.getByText(PITCH.revision.envioApagado, { exact: false })).toBeTruthy();
    expect(screen.getByRole("link", { name: PITCH.revision.encenderEnvio }).getAttribute("href")).toBe("/ventas/politica#interruptor");
    expect(screen.queryByText(PITCH.acciones.programadoApagado)).toBeNull();
  });

  it("«Redactar con IA» pide un borrador con las instrucciones; con texto, las tres pistas piden otra versión", () => {
    pedirRedaccion.mockResolvedValue({});
    const { unmount } = render(<EditorDePitch data={datos({ ai: "on" })} />);
    fireEvent.change(screen.getByLabelText(PITCH.ia.instrucciones), { target: { value: "Más cercano." } });
    fireEvent.click(screen.getByRole("button", { name: PITCH.ia.redactar }));
    expect(pedirRedaccion).toHaveBeenCalledTimes(1);
    const pedido = pedirRedaccion.mock.calls[0]![1] as FormData;
    expect([pedido.get("hint"), pedido.get("instructions"), pedido.get("contactId")]).toEqual(["", "Más cercano.", datos().contacts[0]!.id]);
    unmount();

    pedirRedaccion.mockReset();
    pedirRedaccion.mockResolvedValue({});
    render(<EditorDePitch data={datos({ ai: "on", draft: { ...BORRADOR, body: BUENO } })} />);
    for (const pista of Object.values(PITCH.ia.pistas)) expect(screen.getByRole("button", { name: PITCH.ia.pistaLabel(pista) })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: PITCH.ia.pistaLabel(PITCH.ia.pistas.shorter) }));
    const corto = pedirRedaccion.mock.calls[0]![1] as FormData;
    // Va el texto marcado, con sus fichas como marcas: el servidor lo guarda tal cual.
    expect([corto.get("hint"), corto.get("touchId"), corto.get("body")]).toEqual(["shorter", BORRADOR.touchId, BUENO]);
  });

  it("mientras la IA redacta lo dice, no deja pedir otra vez y la página se actualiza sola", () => {
    vi.useFakeTimers();
    try {
      render(<EditorDePitch data={datos({ ai: "on", draft: { ...BORRADOR, body: "", pending: { stage: "generating", hint: null, error: null } } })} />);
      expect(screen.getByText(PITCH.ia.redactando, { exact: false })).toBeTruthy();
      expect(screen.getByText(PITCH.ia.editarCancela)).toBeTruthy();
      expect(screen.queryByRole("button", { name: PITCH.ia.redactar })).toBeNull();
      vi.advanceTimersByTime(5_000);
      expect(refresh).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("el último fallo se dice en palabras de la creadora, nunca con el código ni el error del SDK", () => {
    const casos: Array<[string, string]> = [
      ["llm_budget", "Se agotó el presupuesto de IA de hoy: lo retomamos mañana, o escríbelo tú."],
      ["interrupted", "Se interrumpió; lo retomamos en unos minutos."],
      ["touch_not_draft,lease_lost", "Se interrumpió; lo retomamos en unos minutos."],
      ["llm_output", "La IA no pudo redactarlo; lo intentamos de nuevo en unos minutos."],
      ["400 invalid_request_error: temperature is not supported", "La IA no pudo redactarlo; lo intentamos de nuevo en unos minutos."],
    ];
    for (const [code, texto] of casos) {
      const { unmount } = render(<EditorDePitch data={datos({ ai: "on", draft: { ...BORRADOR, body: "", pending: { stage: "requested", hint: null, error: code } } })} />);
      expect(screen.getByText(texto)).toBeTruthy();
      expect(screen.queryByText(code, { exact: false })).toBeNull();
      unmount();
    }
    // La IA se rindió: lo dice y deja pedir otra versión.
    render(<EditorDePitch data={datos({ ai: "on", draft: { ...BORRADOR, body: "", failed: true } })} />);
    expect(screen.getByText(PITCH.ia.fallo)).toBeTruthy();
    expect(screen.getByRole("button", { name: PITCH.ia.redactar })).toBeTruthy();
  });

  it("las columnas llevan pistas explícitas (minmax(0,1fr)): un correo largo en «Para» no ensancha la página a 400 px", () => {
    const largo = { id: "00000002-0000-4000-8000-0000000c0099", fullName: "Camilo Herrera de la Torre y Mosquera", roleTitle: null, email: "camilo.herrera.de.la.torre.y.mosquera@cafealma-colombia.co", firstTouch: true };
    const { container } = render(<EditorDePitch data={datos({ contacts: [largo] })} />);
    const raiz = container.firstElementChild as HTMLElement;
    expect(raiz.className).toContain("grid-cols-[minmax(0,1fr)]");
    expect(raiz.className).toContain("lg:grid-cols-[minmax(0,1fr)_360px]");
    const form = screen.getByRole("form", { name: PITCH.title("Café Alma") });
    expect(form.className).toContain("grid-cols-[minmax(0,1fr)]");
    const fila = screen.getByLabelText(PITCH.campos.contacto).closest("div.grid") as HTMLElement;
    expect(fila.className).toContain("sm:grid-cols-[repeat(2,minmax(0,1fr))]");
    expect(cuerpo().className).toContain("break-words");
  });
});

describe("fichas de cifras", () => {
  const CAMPANA_ALMA: SalesClaim = {
    id: "campaign:c1:views", source: "campaign_result", label: "Views de la campaña con Café Alma", value: 412000, unit: "count",
    display: "412.000", ref: { table: "campaign_result", id: "c1" }, entities: ["Café Alma"],
  };
  const CAMPANA_OTRA: SalesClaim = { ...CAMPANA_ALMA, id: "campaign:c2:views", label: "Views de la campaña con Fresko", entities: ["Fresko Market"] };
  const AUDIENCIA: SalesClaim = { ...MEDIANA, id: "audience:tiktok:age:25-34", source: "creator_profile", label: "Seguidores de 25-34 años en TikTok", display: "37 %" };

  it("se agrupan por origen, con la mediana y las campañas con esta marca primero, y se filtran por texto", () => {
    const grupos = groupClaims([AUDIENCIA, CAMPANA_OTRA, CAMPANA_ALMA, MEDIANA], "Café Alma", "");
    expect(grupos.map((g) => g.group)).toEqual(["creator_baseline", "campaign_brand", "creator_profile", "campaign_result"]);
    expect(groupClaims([AUDIENCIA, CAMPANA_OTRA, CAMPANA_ALMA, MEDIANA], "Café Alma", "fresko").map((g) => [g.group, g.claims.map((c) => c.id)])).toEqual([
      ["campaign_result", ["campaign:c2:views"]],
    ]);
  });

  it("la búsqueda del editor deja solo lo que coincide", () => {
    render(<EditorDePitch data={datos({ variants: { "": { ...VARIANTE, claims: [MEDIANA, AUDIENCIA, CAMPANA_ALMA] }, [DEAL]: { ...VARIANTE, claims: [MEDIANA, AUDIENCIA, CAMPANA_ALMA] } } })} />);
    expect(screen.getByText(PITCH.fichas.grupos.campaign_brand)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(PITCH.fichas.buscar), { target: { value: "25-34" } });
    expect(screen.queryByText(PITCH.fichas.grupos.campaign_brand)).toBeNull();
    expect(screen.getByRole("button", { name: PITCH.fichas.insertar(`${AUDIENCIA.label}: ${AUDIENCIA.display}`) })).toBeTruthy();
  });

  it("la marca en mayúsculas no es gritar, en la pantalla igual que en el servidor", () => {
    const r = reviseDraft({ subject: "Una idea para CAFÉ ALMA", body: BUENO, values: { first_name: "Camilo", company: "CAFÉ ALMA" }, claims: [MEDIANA], firstTouch: true, companyName: "Café Alma" });
    expect(r.items.filter((i) => i.code === "shouting")).toEqual([]);
  });
});

describe("ronda 4: el aviso donde está el problema y las acciones junto al mensaje", () => {
  const INVENTADO = BUENO.replace("Mis recetas de desayuno", "Trabajé con 11 marcas este año. Mis recetas de desayuno");

  it("una cifra sin origen se dice bajo el mensaje, y el campo la anuncia (aria-describedby)", () => {
    render(<EditorDePitch data={datos({ draft: { ...BORRADOR, body: INVENTADO } })} />);
    const aviso = screen.getByText(PITCH.cuerpo.cifrasSinOrigen("«11»", 1));
    expect(aviso.id).toBe("pitch-cuerpo-cifras");
    expect(cuerpo().getAttribute("aria-describedby")).toBe("pitch-cuerpo-help pitch-cuerpo-cifras");
  });

  it("con la API de resaltado del navegador, la cifra se subraya dentro del mensaje sin tocar el texto", () => {
    const registry = new Map<string, { ranges: Range[] }>();
    class FakeHighlight {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    }
    vi.stubGlobal("CSS", { highlights: registry });
    vi.stubGlobal("Highlight", FakeHighlight);
    try {
      const { unmount } = render(<EditorDePitch data={datos({ draft: { ...BORRADOR, body: INVENTADO } })} />);
      const marcadas = registry.get("pitch-cifra-sin-origen")?.ranges.map((r) => r.toString());
      expect(marcadas).toEqual(["11"]);
      expect(cuerpo().textContent).toContain("Trabajé con 11 marcas");
      // Al corregirlo, el subrayado se va.
      escribir("Hola, mis recetas de desayuno se guardan para la semana.");
      expect(registry.has("pitch-cifra-sin-origen")).toBe(false);
      unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("«Programar», «Copiar» y «Guardar borrador» van antes de la biblioteca de fichas; las medianas empiezan plegadas", () => {
    render(<EditorDePitch data={datos()} />);
    const cifras = screen.getByRole("heading", { name: PITCH.fichas.cifras });
    for (const boton of [programar(), copiar(), screen.getByRole("button", { name: PITCH.acciones.guardar })]) {
      expect(boton.compareDocumentPosition(cifras) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    const medianas = screen.getByText(PITCH.fichas.grupos.creator_baseline).closest("details")!;
    expect(medianas.open).toBe(false);
  });

  it("con el editor vacío no dice por qué no se copia; con un hueco dice el motivo exacto", () => {
    render(<EditorDePitch data={datos()} />);
    for (const texto of Object.values(PITCH.acciones.copiarBloqueado)) expect(screen.queryByText(texto)).toBeNull();
    escribir("Hola {{apodo}}, mis recetas de desayuno se guardan para la semana.");
    expect(screen.getByText(PITCH.acciones.copiarBloqueado.holes)).toBeTruthy();
    expect(screen.queryByText(PITCH.acciones.copiarBloqueado.both)).toBeNull();
  });

  it("una marca detrás de un número pequeño se lleva ese número: «6 [claim] anuncios» es una ficha que dice 6", () => {
    const s = segmentsOf("Vi que Fresko tiene 6 [claim:signal:s1:active_ads] anuncios activos.");
    expect(s).toEqual([
      { kind: "text", text: "Vi que Fresko tiene " },
      { kind: "claim", id: "signal:s1:active_ads", raw: "6" },
      { kind: "text", text: " anuncios activos." },
    ]);
    expect(markedOf(s)).toBe("Vi que Fresko tiene 6 [claim:signal:s1:active_ads] anuncios activos.");
  });
});

describe("ronda 5: el camino principal IA → Programar/Copiar, la política y a quién se escribe", () => {
  const STAMP = "2026-09-25T10:00:00.000Z";
  const IA = { ...BORRADOR, body: BUENO };
  const keyIA = editorKey({ touchId: IA.touchId, pending: null, generationStamp: STAMP });
  const VALENTINA = {
    id: "00000002-0000-4000-8000-0000000c0003", fullName: "Valentina Ortiz", roleTitle: "Marca", email: "valentina@cafealma.co", firstTouch: true,
  };

  it("borrador de la IA → Programar: el aviso sigue a la vista con el foco, y el texto también, aunque la página ya no traiga el borrador", async () => {
    guardarPitch.mockResolvedValue({ ok: true, notice: PITCH.acciones.programado, touchId: IA.touchId, intent: "schedule", stamp: 7 });
    const inicial = datos({ draft: IA });
    const { rerender } = render(<MontajeDelEditor data={inicial} aiKey={keyIA} />);
    await act(async () => {
      fireEvent.click(programar());
    });
    const aviso = await screen.findByText(PITCH.acciones.programado, { exact: false });
    // revalidatePath: el toque ya está programado y loadPitchComposer no devuelve borrador.
    rerender(<MontajeDelEditor data={{ ...inicial, draft: null }} aiKey={editorKey(null)} />);
    expect(screen.getByText(PITCH.acciones.programado, { exact: false })).toBe(aviso);
    expect(document.activeElement).toBe(aviso);
    expect(within(aviso).getByRole("link", { name: PITCH.acciones.verFicha }).getAttribute("href")).toBe(`/ventas/empresas/${inicial.companyId}`);
    expect(cuerpo().textContent).toContain("115.446");
    // Ya no se edita aquí: sin botones de guardar, y se puede empezar otro.
    expect(cuerpo().getAttribute("contenteditable")).toBe("false");
    expect(screen.queryByRole("button", { name: PITCH.acciones.programar })).toBeNull();
    expect(screen.getByText(PITCH.acciones.yaProgramado)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: PITCH.acciones.escribirOtro }));
    expect(refresh).toHaveBeenCalled();
    expect(cuerpo().textContent?.trim()).toBe("");
    expect(programar()).toBeTruthy();
  });

  it("borrador de la IA → Copiar: si el navegador no deja copiar, lo dice en vez de «Copiado»; sin asunto copia solo el cuerpo", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      guardarPitch.mockResolvedValue({ ok: true, notice: PITCH.acciones.copiado, touchId: IA.touchId, intent: "copy", stamp: 8 });
      const inicial = datos({ draft: { ...IA, subject: "" } });
      const { rerender } = render(<MontajeDelEditor data={inicial} aiKey={keyIA} />);
      await act(async () => {
        fireEvent.click(copiar());
      });
      expect(writeText).toHaveBeenCalledWith(previewOf("", BUENO, { first_name: "Camilo", company: "Café Alma" }).body);
      const aviso = await screen.findByText(PITCH.acciones.noSeCopio, { exact: false });
      expect(screen.queryByText(PITCH.acciones.copiado, { exact: false })).toBeNull();
      rerender(<MontajeDelEditor data={{ ...inicial, draft: { ...inicial.draft!, generated: false } }} aiKey={editorKey(null)} />);
      expect(screen.getByText(PITCH.acciones.noSeCopio, { exact: false })).toBe(aviso);
      expect(document.activeElement).toBe(aviso);
    } finally {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    }
  });

  it("sin dirección postal, «Programar» se apaga y lo dice con el enlace a la política; sin correo conectado, una nota neutra", () => {
    render(<EditorDePitch data={datos({ draft: IA, policy: { hasPostalAddress: false, hasEmailAccount: false } })} />);
    expect(programar().disabled).toBe(true);
    expect(screen.queryByText(PITCH.revision.ok)).toBeNull();
    expect(screen.getAllByText(PITCH.revision.sinDireccion, { exact: false }).length).toBeGreaterThan(0);
    const enlaces = screen.getAllByRole("link", { name: PITCH.revision.agregarDireccion });
    expect(enlaces.every((l) => l.getAttribute("href") === "/ventas/politica#postalAddress")).toBe(true);
    expect(screen.getByText(PITCH.revision.sinCorreo, { exact: false })).toBeTruthy();
    expect(screen.getByRole("link", { name: PITCH.revision.conectarCorreo }).getAttribute("href")).toBe("/ventas/canales");
    // Copiar sigue: la creadora puede enviarlo desde su correo.
    expect(copiar().disabled).toBe(false);
  });

  it("un borrador escrito para Camilo no se programa a Valentina; con {{first_name}}, el saludo cambia con la persona", () => {
    const camilo = datos().contacts[0]!;
    const paraCamilo = { ...IA, contactId: camilo.id, body: BUENO.replace("{{first_name}}", "Camilo") };
    const { unmount } = render(<EditorDePitch data={datos({ contacts: [camilo, VALENTINA], draft: paraCamilo })} />);
    expect(programar().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(PITCH.campos.contacto), { target: { value: VALENTINA.id } });
    expect(screen.getByText(PITCH.vista.para("Valentina Ortiz"))).toBeTruthy();
    expect(programar().disabled).toBe(true);
    expect(screen.getAllByText(PITCH.revision.otraPersona("Camilo"), { exact: false }).length).toBeGreaterThan(0);
    unmount();

    render(<EditorDePitch data={datos({ contacts: [camilo, VALENTINA], draft: { ...IA, contactId: camilo.id } })} />);
    fireEvent.change(screen.getByLabelText(PITCH.campos.contacto), { target: { value: VALENTINA.id } });
    const vista = within(screen.getByRole("complementary", { name: PITCH.vista.titulo }));
    expect(vista.getByText(/^Hola Valentina,/)).toBeTruthy();
    expect(programar().disabled).toBe(false);
  });

  it("si la persona reescribe el borrador, la nota de la IA se rotula como de su versión", () => {
    render(<EditorDePitch data={datos({ draft: IA })} />);
    expect(screen.getByText(PITCH.revision.calidad)).toBeTruthy();
    escribir("Hola, esto ya lo cambié yo por completo.");
    expect(screen.queryByText(PITCH.revision.calidad)).toBeNull();
    expect(screen.getByText(PITCH.revision.calidadEditada)).toBeTruthy();
  });

  it("cuando llega otra versión de la IA, el foco va a su aviso; un error al programar también se lleva el foco", async () => {
    const { rerender } = render(<MontajeDelEditor data={datos({ ai: "on", draft: IA })} aiKey={keyIA} />);
    expect(document.activeElement).toBe(document.body);
    const nueva = { ...IA, body: BUENO.replace("Mis recetas", "Mis desayunos") };
    const otra = editorKey({ touchId: IA.touchId, pending: null, generationStamp: "2026-09-25T10:05:00.000Z" });
    rerender(<MontajeDelEditor data={datos({ ai: "on", draft: nueva })} aiKey={otra} />);
    expect(document.activeElement).toBe(screen.getByText(PITCH.revision.generado));
    expect(cuerpo().textContent).toContain("Mis desayunos");

    guardarPitch.mockResolvedValue({ message: PITCH.errores.no_postal_address });
    await act(async () => {
      fireEvent.click(programar());
    });
    const error = await screen.findByText(PITCH.errores.no_postal_address);
    expect(document.activeElement).toBe(error);
  });

  it("tocar una ficha dice su origen debajo del mensaje (en un teléfono no hay cursor)", () => {
    render(<EditorDePitch data={datos({ draft: IA })} />);
    const etiqueta = PITCH.cuerpo.cifra(MEDIANA.display, MEDIANA.label, PITCH.origen.creator_baseline);
    fireEvent.click(within(cuerpo()).getByLabelText(etiqueta));
    expect(screen.getByText(PITCH.cuerpo.detalle(etiqueta))).toBeTruthy();
  });

  it("Enter con tecleo instantáneo pone el salto donde está el cursor de verdad, no donde estaba antes", () => {
    const { container } = render(<EditorDePitch data={datos()} />);
    escribir("abcdef");
    const texto = cuerpo().firstChild as Text;
    const sel = document.getSelection()!;
    const poner = (offset: number) => {
      const r = document.createRange();
      r.setStart(texto, offset);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    };
    // Lo que guardó el último «selectionchange»: el cursor al final.
    poner(6);
    document.dispatchEvent(new Event("selectionchange"));
    // La tecla siguiente llega antes que el aviso: el cursor ya está en el medio.
    poner(3);
    fireEvent.keyDown(cuerpo(), { key: "Enter" });
    expect(marcado(container)).toBe("abc\ndef");
  });
});
