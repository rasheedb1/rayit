import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContactRow } from "@mc/db/queries/ventas";

const crearContacto = vi.fn();
const darDeBaja = vi.fn();
const editarContacto = vi.fn();
vi.mock("../../actions", () => ({
  crearContacto: (...a: unknown[]) => crearContacto(...a),
  darDeBaja: (...a: unknown[]) => darDeBaja(...a),
  editarContacto: (...a: unknown[]) => editarContacto(...a),
}));

import { Contactos } from "./contactos";

const COMPANY = "00000002-0000-4000-8000-0000000000e1";
const base: ContactRow = {
  id: "00000007-0000-4000-8000-000000000001",
  companyId: COMPANY,
  fullName: "Laura Gómez",
  roleTitle: "Marketing",
  email: "laura@cafealma.co",
  phone: null,
  linkedinUrl: null,
  instagramHandle: null,
  source: "public_website",
  sourceUrl: null,
  optedOut: false,
  optedOutAt: null,
  optedOutReason: null,
  bounced: false,
  isOwn: true,
  createdAt: "2026-09-20T12:00:00Z",
};

beforeEach(() => {
  crearContacto.mockReset();
  darDeBaja.mockReset();
  editarContacto.mockReset();
});

describe("Contactos", () => {
  it("la procedencia es obligatoria y el error del servidor se ve en su campo", async () => {
    crearContacto.mockResolvedValue({ errors: { source: "Di de dónde sacaste el dato: sin eso no se guarda." } });
    render(<Contactos companyId={COMPANY} contacts={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Añadir el primero" }));
    expect(screen.getByLabelText(/¿De dónde lo sacaste\?/)).toBeRequired();
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Andrés" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar contacto" }));

    expect(await screen.findByText("Di de dónde sacaste el dato: sin eso no se guarda.")).toBeInTheDocument();
    // Lo escrito no se pierde por un error.
    expect(screen.getByLabelText("Nombre")).toHaveValue("Andrés");
    const data = crearContacto.mock.calls[0]?.[1] as FormData;
    expect(data.get("companyId")).toBe(COMPANY);
  });

  it("guardar cierra el formulario y lo anuncia", async () => {
    crearContacto.mockResolvedValue({ ok: true, notice: "Contacto guardado.", stamp: 1 });
    render(<Contactos companyId={COMPANY} contacts={[base]} />);
    fireEvent.click(screen.getByRole("button", { name: "Añadir contacto" }));
    fireEvent.change(screen.getByLabelText(/¿De dónde lo sacaste\?/), { target: { value: "inbound" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar contacto" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Contacto guardado.");
    expect(screen.queryByRole("form", { name: "Añadir contacto" })).toBeNull();
  });

  it("la baja pide confirmación y solo se ofrece en los contactos propios", async () => {
    darDeBaja.mockResolvedValue({ ok: true, notice: "Baja registrada.", stamp: 1 });
    const ajeno = { ...base, id: "00000007-0000-4000-8000-000000000002", fullName: "Otro", isOwn: false };
    render(<Contactos companyId={COMPANY} contacts={[base, ajeno]} />);
    expect(screen.queryByRole("button", { name: "Registrar baja: Otro" })).toBeNull();
    expect(screen.getByText(/Es del catálogo compartido/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Registrar baja: Laura Gómez" }));
    expect(screen.getByText(/no se puede deshacer/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sí, registrar la baja" }));
    await waitFor(() => expect(darDeBaja).toHaveBeenCalled());
    const data = darDeBaja.mock.calls[0]?.[1] as FormData;
    expect(data.get("contactId")).toBe(base.id);
  });

  it("«Editar» abre el formulario del alta con sus datos y su procedencia, y corrige el correo", async () => {
    editarContacto.mockResolvedValue({ ok: true, notice: "Contacto actualizado.", stamp: 1 });
    render(<Contactos companyId={COMPANY} contacts={[base]} />);
    fireEvent.click(screen.getByRole("button", { name: "Editar: Laura Gómez" }));

    const form = screen.getByRole("form", { name: "Editar el contacto" });
    expect(within(form).getByLabelText("Nombre")).toHaveValue("Laura Gómez");
    expect(within(form).getByLabelText("Correo")).toHaveValue("laura@cafealma.co");
    expect(within(form).getByLabelText(/¿De dónde lo sacaste\?/)).toHaveValue("public_website");

    fireEvent.change(within(form).getByLabelText("Correo"), { target: { value: "laura.gomez@cafealma.co" } });
    fireEvent.click(within(form).getByRole("button", { name: "Guardar cambios" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Contacto actualizado.");
    const data = editarContacto.mock.calls[0]?.[1] as FormData;
    expect(data.get("contactId")).toBe(base.id);
    expect(data.get("companyId")).toBe(COMPANY);
    expect(data.get("email")).toBe("laura.gomez@cafealma.co");
    expect(data.get("source")).toBe("public_website");
    expect(screen.queryByRole("form", { name: "Editar el contacto" })).toBeNull();
  });

  it("el error de un campo al editar se ve en ese campo y no se pierde lo escrito", async () => {
    editarContacto.mockResolvedValue({ errors: { email: "Ya hay un contacto con ese correo." } });
    render(<Contactos companyId={COMPANY} contacts={[base]} />);
    fireEvent.click(screen.getByRole("button", { name: "Editar: Laura Gómez" }));
    const form = screen.getByRole("form", { name: "Editar el contacto" });
    fireEvent.change(within(form).getByLabelText("Correo"), { target: { value: "otra@cafealma.co" } });
    fireEvent.click(within(form).getByRole("button", { name: "Guardar cambios" }));
    expect(await within(form).findByText("Ya hay un contacto con ese correo.")).toBeInTheDocument();
    expect(within(form).getByLabelText("Correo")).toHaveValue("otra@cafealma.co");
  });

  it("un contacto ajeno o dado de baja no ofrece «Editar»", () => {
    const ajeno = { ...base, id: "00000007-0000-4000-8000-000000000002", fullName: "Otro", isOwn: false };
    const baja = { ...base, id: "00000007-0000-4000-8000-000000000003", fullName: "Baja", optedOut: true };
    render(<Contactos companyId={COMPANY} contacts={[ajeno, baja]} />);
    expect(screen.queryByRole("button", { name: /^Editar/ })).toBeNull();
  });

  it("un contacto dado de baja se marca y no ofrece escribirle", () => {
    render(<Contactos companyId={COMPANY} contacts={[{ ...base, optedOut: true }]} />);
    expect(screen.getByText("Pidió la baja")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "laura@cafealma.co" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Registrar baja/ })).toBeNull();
  });
});
