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

  it("la clave del editor no cambia cuando la persona guarda (ni en el primer guardado); sí cuando la IA trae un borrador", () => {
    expect(editorKey(null)).toBe("a-mano");
    expect(editorKey({ touchId: "t1", pending: null, generationStamp: null })).toBe("a-mano");
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
    const { rerender } = render(<EditorDePitch key={editorKey(null)} data={inicial} />);
    escribir("Hola, esto lo escribo yo.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: PITCH.acciones.guardar }));
    });
    const aviso = await screen.findByText(PITCH.acciones.guardado, { exact: false });
    // revalidatePath: la página vuelve con el borrador guardado (ya tiene toque). La clave es la misma: no se remonta.
    const guardado = { ...BORRADOR, generated: false, score: null, note: null, subject: "", body: "Hola, esto lo escribo yo." };
    const key = editorKey({ touchId: guardado.touchId, pending: null, generationStamp: null });
    expect(key).toBe(editorKey(null));
    rerender(<EditorDePitch key={key} data={{ ...inicial, draft: guardado }} />);
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
