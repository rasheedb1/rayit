import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Las acciones de la ficha de empresa y del tablero, sin base ni Next:
 * qué llega a @mc/db con cada formulario y cómo vuelve cada error de
 * dominio (en su campo o en la pantalla). Las consultas se prueban
 * contra Postgres embebido en packages/db/test/ventas.test.ts.
 */
const updateCompany = vi.fn();
const updateContact = vi.fn();
const moveDeal = vi.fn();
const revalidatePath = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("./_lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@mc/db/queries/ventas", async (original) => ({
  ...(await original<typeof import("@mc/db/queries/ventas")>()),
  updateCompany: (...a: unknown[]) => updateCompany(...a),
  updateContact: (...a: unknown[]) => updateContact(...a),
  moveDeal: (...a: unknown[]) => moveDeal(...a),
}));

import { CompanyNotEditable, ContactNotOwned, DuplicateDomain, VentasError } from "@mc/db/queries/ventas";
import { cambiarRelacion, editarContacto, editarEmpresa, moverNegocio } from "./actions";

const COMPANY = "00000002-0000-4000-8000-0000000000e1";
const CONTACT = "00000007-0000-4000-8000-000000000001";
const OWNER = "00000002-0000-4000-8000-000000000002";
const DEAL = "00000006-0000-4000-8000-000000000001";

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

const ficha = { companyId: COMPANY, name: "Café Alma", domain: "cafealma.co", country: "co", city: "Bogotá", industry: "Café", notes: "" };
const contacto = { contactId: CONTACT, companyId: COMPANY, source: "public_website", fullName: "Laura Gómez", email: "laura@cafealma.co" };

beforeEach(() => {
  updateCompany.mockReset().mockResolvedValue(undefined);
  updateContact.mockReset().mockResolvedValue(undefined);
  moveDeal.mockReset().mockResolvedValue({});
  revalidatePath.mockReset();
});

describe("editarEmpresa", () => {
  it("corrige la ficha de una empresa propia con los mismos campos del alta", async () => {
    const r = await editarEmpresa({}, form({ ...ficha, name: " Café Alma Tostadores " }));
    expect(r).toMatchObject({ ok: true, notice: "Datos actualizados." });
    expect(updateCompany).toHaveBeenCalledWith({}, COMPANY, {
      name: "Café Alma Tostadores",
      domain: "cafealma.co",
      country: "CO",
      city: "Bogotá",
      industry: "Café",
      notes: null,
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/ventas/empresas/${COMPANY}`);
  });

  it("valida como el alta: sin nombre no llega a la base", async () => {
    const r = await editarEmpresa({}, form({ ...ficha, name: "  ", country: "Colombia" }));
    expect(r.errors).toEqual({ name: "La empresa necesita un nombre.", country: "Elige el país de la lista." });
    expect(updateCompany).not.toHaveBeenCalled();
  });

  it("de una empresa del catálogo compartido solo manda las notas", async () => {
    await editarEmpresa({}, form({ companyId: COMPANY, scope: "notes", notes: "Hablar con Laura en octubre", name: "Otro nombre" }));
    expect(updateCompany).toHaveBeenCalledWith({}, COMPANY, { notes: "Hablar con Laura en octubre" });
  });

  it("el dominio repetido es un error del campo, con el nombre de la que ya lo tiene", async () => {
    updateCompany.mockRejectedValue(new DuplicateDomain("Fresko Market"));
    const r = await editarEmpresa({}, form(ficha));
    expect(r.errors?.domain).toContain("«Fresko Market»");
  });

  it("una empresa que no es de este espacio lo dice en la pantalla", async () => {
    updateCompany.mockRejectedValue(new CompanyNotEditable());
    const r = await editarEmpresa({}, form(ficha));
    expect(r.message).toMatch(/catálogo compartido/);
  });
});

describe("cambiarRelacion", () => {
  it("guarda la relación y el responsable; vacío es «Sin responsable»", async () => {
    await cambiarRelacion({}, form({ companyId: COMPANY, relationship: "client", ownerUserId: OWNER }));
    expect(updateCompany).toHaveBeenLastCalledWith({}, COMPANY, { relationship: "client", ownerUserId: OWNER });
    await cambiarRelacion({}, form({ companyId: COMPANY, relationship: "client", ownerUserId: "" }));
    expect(updateCompany).toHaveBeenLastCalledWith({}, COMPANY, { relationship: "client", ownerUserId: null });
  });

  it("sin el campo de responsable no lo toca", async () => {
    await cambiarRelacion({}, form({ companyId: COMPANY, relationship: "contacted" }));
    expect(updateCompany).toHaveBeenCalledWith({}, COMPANY, { relationship: "contacted" });
  });

  it("alguien de fuera del espacio es un error del campo", async () => {
    updateCompany.mockRejectedValue(new VentasError("InvalidOwner"));
    const r = await cambiarRelacion({}, form({ companyId: COMPANY, relationship: "client", ownerUserId: OWNER }));
    expect(r.errors).toEqual({ ownerUserId: "El responsable tiene que ser alguien de tu espacio." });
  });
});

describe("editarContacto", () => {
  it("corrige un correo mal escrito sin perder la procedencia", async () => {
    const r = await editarContacto({}, form({ ...contacto, email: " Laura.Gomez@cafealma.co " }));
    expect(r).toMatchObject({ ok: true, notice: "Contacto actualizado." });
    expect(updateContact).toHaveBeenCalledWith({}, CONTACT, expect.objectContaining({
      source: "public_website",
      fullName: "Laura Gómez",
      email: "Laura.Gomez@cafealma.co",
    }));
  });

  it("la procedencia sigue siendo obligatoria", async () => {
    const r = await editarContacto({}, form({ ...contacto, source: "" }));
    expect(r.errors?.source).toBe("Di de dónde sacaste el dato: sin eso no se guarda.");
    expect(updateContact).not.toHaveBeenCalled();
  });

  it("un contacto ajeno no se edita, y el correo repetido va en su campo", async () => {
    updateContact.mockRejectedValueOnce(new ContactNotOwned());
    expect((await editarContacto({}, form(contacto))).message).toBe("Solo puedes editar los contactos que guardaste tú.");
    updateContact.mockRejectedValueOnce(new VentasError("DuplicateEmail"));
    expect((await editarContacto({}, form(contacto))).errors).toEqual({ email: "Ya hay un contacto con ese correo." });
  });
});

describe("el país de la ficha (pulido r6)", () => {
  it("dos letras que no son un país no se guardan: el error va en el campo", async () => {
    const r = await editarEmpresa({}, form({ ...ficha, country: "XX" }));
    expect(r.errors).toEqual({ country: "Elige el país de la lista." });
    expect(updateCompany).not.toHaveBeenCalled();
  });

  it("vacío es «sin país»", async () => {
    await editarEmpresa({}, form({ ...ficha, country: "" }));
    expect(updateCompany).toHaveBeenCalledWith({}, COMPANY, expect.objectContaining({ country: null }));
  });
});

describe("moverNegocio", () => {
  it("pasa el motivo de la pérdida a moveDeal", async () => {
    const r = await moverNegocio(DEAL, "perdido", "precio");
    expect(r).toEqual({ ok: true });
    expect(moveDeal).toHaveBeenCalledWith({}, DEAL, "perdido", expect.objectContaining({ lostReason: "precio" }));
    const { quoteClosedActivity } = moveDeal.mock.calls[0]![3] as { quoteClosedActivity: (n: string) => string };
    expect(quoteClosedActivity("COT-2026-007")).toBe("COT-2026-007 se cerró al perder el negocio");
  });

  it("perder un negocio con cotización enviada devuelve cuál se cerró, para decirlo en el aviso", async () => {
    moveDeal.mockResolvedValue({ closedQuotes: [{ id: "q1", number: "COT-2026-007" }] });
    const r = await moverNegocio(DEAL, "perdido", "precio");
    expect(r).toEqual({ ok: true, closedQuotes: ["COT-2026-007"] });
    expect(revalidatePath).toHaveBeenCalledWith("/cotizar", "layout");
  });

  it("un motivo que no existe no llega a la base", async () => {
    const r = await moverNegocio(DEAL, "perdido", "me cayó mal");
    expect(r.ok).toBe(false);
    expect(moveDeal).not.toHaveBeenCalled();
  });

  it("sin motivo, la base no mueve a «Perdido» y se dice por qué", async () => {
    moveDeal.mockRejectedValue(new VentasError("LostReasonRequired"));
    const r = await moverNegocio(DEAL, "perdido");
    expect(r).toEqual({ ok: false, message: "Di por qué lo pierdes antes de pasarlo a «Perdido»." });
  });
});
