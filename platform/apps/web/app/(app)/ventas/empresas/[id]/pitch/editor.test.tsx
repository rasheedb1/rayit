import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * El editor del pitch (VEN-6 dentro de VEN-12): las fichas insertan la
 * cifra con su origen donde está el cursor, la vista previa enseña lo que
 * recibe la marca (sin marcas, con las variables rellenas) y la revisión
 * en línea no deja programar un pitch con una cifra sin origen. Guardar y
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
import { PITCH } from "./messages";
import { claimSnippet, insertAt, previewOf, reviseDraft } from "./vista";

const MEDIANA: SalesClaim = {
  id: "baseline:tiktok:median_views", source: "creator_baseline", label: "Mediana de views en TikTok a 7 días", value: 115446,
  unit: "count", display: "115.446", ref: { table: "creator_baseline", id: "b1" },
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

const BORRADOR = {
  touchId: "00000002-0000-4000-8000-000000070001", contactId: null, dealId: null, subject: "Una idea para Café Alma", held: null,
  generated: true, score: "8,7", note: "Abre con la marca.", pending: null,
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

beforeEach(() => {
  guardarPitch.mockReset();
  pedirRedaccion.mockReset();
  refresh.mockReset();
});

describe("vista del pitch", () => {
  it("inserta en la selección con espacios y deja el cursor detrás", () => {
    expect(insertAt("Tengo views", 6, 6, "115.446 [claim:x]")).toEqual({ text: "Tengo 115.446 [claim:x] views", cursor: 24 });
    expect(insertAt("", 0, 0, "{{company}}")).toEqual({ text: "{{company}}", cursor: 11 });
  });

  it("la vista previa rellena las variables y quita las marcas", () => {
    const p = previewOf("Una idea para {{company}}", BUENO, { first_name: "Camilo", company: "Café Alma" });
    expect(p.subject).toBe("Una idea para Café Alma");
    expect(p.body.startsWith("Hola Camilo,")).toBe(true);
    expect(p.body).not.toContain("[claim:");
    expect(p.body).toContain("115.446 views");
  });

  it("una cifra sin origen bloquea programar y copiar; el texto dice cómo arreglarlo", () => {
    const r = reviseDraft({ subject: "Una idea para Café Alma", body: BUENO.replace(claimSnippet(MEDIANA), "900.000"), values: { first_name: "Camilo", company: "Café Alma" }, claims: [MEDIANA], firstTouch: true });
    expect(r.ok).toBe(false);
    expect(r.canCopy).toBe(false);
    expect(r.items.map((i) => i.text)).toContain(PITCH.problemas.unsourced_figure("900.000"));
    const bien = reviseDraft({ subject: "Una idea para Café Alma", body: BUENO, values: { first_name: "Camilo", company: "Café Alma" }, claims: [MEDIANA], firstTouch: true });
    expect(bien).toMatchObject({ ok: true, canCopy: true });
    expect(bien.cited.map((c) => c.id)).toEqual([MEDIANA.id]);
  });
});

describe("EditorDePitch", () => {
  it("sin llave en el worker lo dice (y no deja pedir), y la ficha de una cifra la inserta con su origen", () => {
    render(<EditorDePitch data={datos()} />);
    expect(screen.getByText(PITCH.ia.noConfigurada)).toBeTruthy();
    expect(screen.queryByRole("button", { name: PITCH.ia.redactar })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: PITCH.fichas.insertar(`${MEDIANA.label}: ${MEDIANA.display}`) }));
    const cuerpo = screen.getByLabelText(PITCH.campos.cuerpo) as HTMLTextAreaElement;
    expect(cuerpo.value).toBe(claimSnippet(MEDIANA));
    const cita = within(screen.getByRole("complementary", { name: PITCH.vista.titulo }));
    expect(cita.getByText(MEDIANA.label)).toBeTruthy();
  });

  it("con una cifra inventada, «Programar» y «Copiar» quedan apagados; bien escrito, se encienden", () => {
    render(<EditorDePitch data={datos({ draft: { ...BORRADOR, body: BUENO.replace(claimSnippet(MEDIANA), "900.000") } })} />);
    const programar = screen.getByRole("button", { name: PITCH.acciones.programar }) as HTMLButtonElement;
    expect(programar.disabled).toBe(true);
    expect((screen.getByRole("button", { name: PITCH.acciones.copiarLabel }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(PITCH.problemas.unsourced_figure("900.000"))).toBeTruthy();
    // La nota de la revisión automática del borrador generado.
    expect(screen.getByText(PITCH.revision.nota("8,7"))).toBeTruthy();
    expect(screen.getByText("Abre con la marca.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(PITCH.campos.cuerpo), { target: { value: BUENO } });
    expect(programar.disabled).toBe(false);
    expect(screen.getByText(PITCH.revision.ok)).toBeTruthy();
  });

  it("con la IA encendida en el worker, «Redactar con IA» pide un borrador con las instrucciones; con texto, las tres pistas piden otra versión", () => {
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

  it("si el worker no ha corrido, lo dice; con el envío apagado avisa sin decir que algo se programó", () => {
    render(<EditorDePitch data={datos({ ai: "unknown" })} />);
    expect(screen.getByText(PITCH.ia.desconocida)).toBeTruthy();
    expect(screen.getByText(PITCH.revision.envioApagado, { exact: false })).toBeTruthy();
    expect(screen.getByRole("link", { name: PITCH.revision.encenderEnvio }).getAttribute("href")).toBe("/ventas/politica#interruptor");
    expect(screen.queryByText(PITCH.acciones.programadoApagado)).toBeNull();
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
