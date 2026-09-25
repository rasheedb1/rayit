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
vi.mock("./actions", () => ({ guardarPitch: (...a: unknown[]) => guardarPitch(...a) }));

import type { SalesClaim } from "@mc/core/outreach/claims";
import { EditorDePitch, type EditorData } from "./editor";
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
    deals: [{ id: "00000002-0000-4000-8000-00000000d001", label: "Café Alma · Cold brew", signalHeadline: "Lanzó cold brew en botella" }],
    claims: [MEDIANA],
    creator: { name: "Laura Méndez", handle: "laura.cocinafacil", niche: "cocina" },
    mediaKitPath: null,
    draft: null,
    aiConfigured: false,
    sendingOn: false,
    ...over,
  };
}

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

beforeEach(() => guardarPitch.mockReset());

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
  it("sin llave lo dice, y la ficha de una cifra la inserta con su origen", () => {
    render(<EditorDePitch data={datos()} />);
    expect(screen.getByText(PITCH.revision.iaNoConfigurada)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: PITCH.fichas.insertar(`${MEDIANA.label}: ${MEDIANA.display}`) }));
    const cuerpo = screen.getByLabelText(PITCH.campos.cuerpo) as HTMLTextAreaElement;
    expect(cuerpo.value).toBe(claimSnippet(MEDIANA));
    const cita = within(screen.getByRole("complementary", { name: PITCH.vista.titulo }));
    expect(cita.getByText(MEDIANA.label)).toBeTruthy();
  });

  it("con una cifra inventada, «Programar» y «Copiar» quedan apagados; bien escrito, se encienden", () => {
    render(<EditorDePitch data={datos({ draft: { touchId: "00000002-0000-4000-8000-000000070001", contactId: null, dealId: null, subject: "Una idea para Café Alma", body: BUENO.replace(claimSnippet(MEDIANA), "900.000"), held: null, generated: true, score: "8,7", note: "Abre con la marca.", } })} />);
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
});
