import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La página de baja, la acción del botón y el POST de un clic, sin base:
 * lo que importa aquí es qué se pinta en cada estado y que abrir la
 * página no da de baja a nadie. La baja de punta a punta (firma, rechazo
 * de quien envió, public_optout) está probada en pglite:
 * packages/db/test/entregabilidad.test.ts.
 */
const estadoDelEnlaceDeBaja = vi.fn();
const darDeBajaDesdeEnlace = vi.fn();
vi.mock("@/lib/db/baja", () => ({
  estadoDelEnlaceDeBaja: (...a: unknown[]) => estadoDelEnlaceDeBaja(...a),
  darDeBajaDesdeEnlace: (...a: unknown[]) => darDeBajaDesdeEnlace(...a),
}));

import BajaPage from "./[token]/page";
import { POST } from "./[token]/un-clic/route";
import { dejarDeRecibir } from "./actions";
import { MESSAGES } from "./messages";

const t = MESSAGES;
const TOKEN = "v1.abc.def";

async function pagina(token = TOKEN) {
  render(await BajaPage({ params: Promise.resolve({ token }) }));
}

beforeEach(() => {
  estadoDelEnlaceDeBaja.mockReset();
  darDeBajaDesdeEnlace.mockReset();
});

describe("/baja/<token>", () => {
  it("un enlace válido pregunta con un solo botón, y abrirla no da de baja a nadie", async () => {
    estadoDelEnlaceDeBaja.mockResolvedValue({ status: "valid" });
    await pagina();
    expect(screen.getByRole("heading", { name: t.pregunta.title })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(darDeBajaDesdeEnlace).not.toHaveBeenCalled();
  });

  it("el botón da de baja y lo dice", async () => {
    estadoDelEnlaceDeBaja.mockResolvedValue({ status: "valid" });
    darDeBajaDesdeEnlace.mockResolvedValue({ status: "ok", alreadyOptedOut: false });
    await pagina();
    fireEvent.click(screen.getByRole("button", { name: t.pregunta.boton }));
    expect(await screen.findByRole("heading", { name: t.listo.title })).toBeInTheDocument();
    expect(darDeBajaDesdeEnlace).toHaveBeenCalledWith(TOKEN);
  });

  it("quien ya estaba fuera lo sabe", async () => {
    estadoDelEnlaceDeBaja.mockResolvedValue({ status: "valid" });
    darDeBajaDesdeEnlace.mockResolvedValue({ status: "ok", alreadyOptedOut: true });
    await pagina();
    fireEvent.click(screen.getByRole("button", { name: t.pregunta.boton }));
    expect(await screen.findByRole("heading", { name: t.yaEstaba.title })).toBeInTheDocument();
  });

  it("si falla, lo dice y deja reintentar", async () => {
    estadoDelEnlaceDeBaja.mockResolvedValue({ status: "valid" });
    darDeBajaDesdeEnlace.mockRejectedValue(new Error("base caída"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await pagina();
    fireEvent.click(screen.getByRole("button", { name: t.pregunta.boton }));
    expect(await screen.findByRole("alert")).toHaveTextContent(t.error);
    expect(screen.getByRole("button", { name: t.pregunta.boton })).toBeInTheDocument();
  });

  it("quien envió el correo no ve el botón", async () => {
    estadoDelEnlaceDeBaja.mockResolvedValue({ status: "sender" });
    await pagina();
    expect(screen.getByRole("heading", { name: t.remitente.title })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t.pregunta.boton })).not.toBeInTheDocument();
  });

  it("un enlace que no es nuestro, o sin secreto configurado, no ofrece nada", async () => {
    estadoDelEnlaceDeBaja.mockResolvedValue({ status: "not_found" });
    await pagina("basura");
    expect(screen.getByRole("heading", { name: t.noExiste.title })).toBeInTheDocument();
    estadoDelEnlaceDeBaja.mockResolvedValue({ status: "unavailable" });
    await pagina();
    expect(screen.getByRole("heading", { name: t.noDisponible.title })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("dejarDeRecibir", () => {
  it("un token vacío o larguísimo no llega a la base", async () => {
    expect(await dejarDeRecibir("")).toEqual({ status: "not_found" });
    expect(await dejarDeRecibir("x".repeat(201))).toEqual({ status: "not_found" });
    expect(darDeBajaDesdeEnlace).not.toHaveBeenCalled();
  });
});

describe("POST /baja/<token>/un-clic (RFC 8058)", () => {
  const post = (body: string) =>
    POST(new Request("http://app.test/baja/t/un-clic", { method: "POST", body }), { params: Promise.resolve({ token: TOKEN }) });

  it("sin el cuerpo de la RFC no hace nada", async () => {
    expect((await post("")).status).toBe(400);
    expect(darDeBajaDesdeEnlace).not.toHaveBeenCalled();
  });

  it("con él da de baja; quien envió recibe 403 y un token ajeno 404", async () => {
    darDeBajaDesdeEnlace.mockResolvedValueOnce({ status: "ok", alreadyOptedOut: false });
    expect((await post("List-Unsubscribe=One-Click")).status).toBe(200);
    expect(darDeBajaDesdeEnlace).toHaveBeenCalledWith(TOKEN);
    darDeBajaDesdeEnlace.mockResolvedValueOnce({ status: "sender" });
    expect((await post("List-Unsubscribe=One-Click")).status).toBe(403);
    darDeBajaDesdeEnlace.mockResolvedValueOnce({ status: "not_found" });
    expect((await post("List-Unsubscribe=One-Click")).status).toBe(404);
  });
});
