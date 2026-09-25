import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La página de baja, la acción del botón y el POST de un clic, sin base:
 * lo que importa aquí es qué se pinta en cada estado y que abrir la
 * página no da de baja a nadie. La baja de punta a punta (el hash del
 * token, la vista previa, el rechazo de quien envió, public_optout, el
 * token del despachador de VEN-10) está probada en pglite:
 * packages/db/test/entregabilidad.test.ts.
 */
const estadoDelEnlaceDeBaja = vi.fn();
const darDeBajaDesdeEnlace = vi.fn();
vi.mock("@/lib/db/baja", () => ({
  estadoDelEnlaceDeBaja: (...a: unknown[]) => estadoDelEnlaceDeBaja(...a),
  darDeBajaDesdeEnlace: (...a: unknown[]) => darDeBajaDesdeEnlace(...a),
}));

/** El Accept-Language de la petición, para la página sin idioma del espacio (r5). */
let acceptLanguage: string | null = null;
vi.mock("next/headers", () => ({
  headers: async () => new Headers(acceptLanguage ? { "accept-language": acceptLanguage } : {}),
}));

import BajaError from "./[token]/error";
import BajaPage from "./[token]/page";
import { POST } from "./[token]/un-clic/route";
import { dejarDeRecibir } from "./actions";
import { bajaIdioma, idiomaDelNavegador, MESSAGES_EN, MESSAGES_ES } from "./messages";

const t = MESSAGES_ES;
const en = MESSAGES_EN;
const TOKEN = "k2Jd8sQ0pX4vN7bW1eR5tY9uI3oP6aS0dF2gH4jK6lZ";
const VALIDO = {
  status: "valid",
  maskedAddress: "v•••@marca.com",
  senderName: "Laura · Cocina fácil",
  locale: "es-CO",
  alreadyOptedOut: false,
};

async function pagina(token = TOKEN) {
  render(await BajaPage({ params: Promise.resolve({ token }) }));
}

beforeEach(() => {
  acceptLanguage = null;
  estadoDelEnlaceDeBaja.mockReset();
  darDeBajaDesdeEnlace.mockReset();
});

describe("/baja/<token>", () => {
  it("un enlace válido dice para qué dirección y de quién, con un solo botón, y abrirla no da de baja a nadie", async () => {
    estadoDelEnlaceDeBaja.mockResolvedValue(VALIDO);
    await pagina();
    expect(screen.getByRole("heading", { name: t.pregunta.title })).toBeInTheDocument();
    expect(screen.getByText(t.pregunta.destino("v•••@marca.com"))).toBeInTheDocument();
    expect(screen.getByText(t.pregunta.alcance("Laura · Cocina fácil"))).toBeInTheDocument();
    expect(screen.getByText("On Cue")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(darDeBajaDesdeEnlace).not.toHaveBeenCalled();
  });

  it("sin nombre de quien escribe (el espacio ya no existe), la frase no inventa uno", async () => {
    estadoDelEnlaceDeBaja.mockResolvedValue({ ...VALIDO, senderName: null });
    await pagina();
    expect(screen.getByText(t.pregunta.alcance(null))).toBeInTheDocument();
  });

  it("quien ya estaba fuera lo sabe sin pulsar nada", async () => {
    estadoDelEnlaceDeBaja.mockResolvedValue({ ...VALIDO, alreadyOptedOut: true });
    await pagina();
    expect(screen.getByRole("heading", { name: t.yaEstaba.title })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("el botón da de baja y lo dice", async () => {
    estadoDelEnlaceDeBaja.mockResolvedValue(VALIDO);
    darDeBajaDesdeEnlace.mockResolvedValue({ status: "ok", alreadyOptedOut: false, scope: "workspace" });
    await pagina();
    fireEvent.click(screen.getByRole("button", { name: t.pregunta.boton }));
    // Con el nombre de quien escribía, que la página ya sabe (r4).
    expect(await screen.findByRole("heading", { name: "Listo. Laura · Cocina fácil no te escribirá más." })).toBeInTheDocument();
    expect(darDeBajaDesdeEnlace).toHaveBeenCalledWith(TOKEN);
    // El aviso recibe el foco para que se anuncie, sin el anillo de un campo:
    // `outline-none!` gana a la regla global de :focus-visible (r3).
    const aviso = screen.getByRole("status");
    expect(aviso).toHaveFocus();
    expect(aviso.className).toMatch(/(^|\s)outline-none!(\s|$)/);
  });

  it("quien ya estaba fuera lo sabe", async () => {
    estadoDelEnlaceDeBaja.mockResolvedValue(VALIDO);
    darDeBajaDesdeEnlace.mockResolvedValue({ status: "ok", alreadyOptedOut: true, scope: "workspace" });
    await pagina();
    fireEvent.click(screen.getByRole("button", { name: t.pregunta.boton }));
    expect(await screen.findByRole("heading", { name: t.yaEstaba.title })).toBeInTheDocument();
  });

  it("si falla, lo dice y deja reintentar", async () => {
    estadoDelEnlaceDeBaja.mockResolvedValue(VALIDO);
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

  it("un enlace que no es de un correo enviado no ofrece nada", async () => {
    estadoDelEnlaceDeBaja.mockResolvedValue({ status: "not_found" });
    await pagina("basura");
    expect(screen.getByRole("heading", { name: t.noExiste.title })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("/baja/<token> en el idioma de quien escribe (r5)", () => {
  it("un espacio en inglés: la página entera en inglés, como el pie del correo que trajo hasta aquí", async () => {
    estadoDelEnlaceDeBaja.mockResolvedValue({ ...VALIDO, senderName: "Laura's Kitchen", locale: "en-US" });
    darDeBajaDesdeEnlace.mockResolvedValue({ status: "ok", alreadyOptedOut: false, scope: "workspace" });
    acceptLanguage = "es-CO,es;q=0.9";
    await pagina();
    expect(screen.getByRole("heading", { name: en.pregunta.title })).toBeInTheDocument();
    expect(screen.getByText(en.pregunta.destino("v•••@marca.com"))).toBeInTheDocument();
    expect(screen.getByText(en.pregunta.alcance("Laura's Kitchen"))).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: en.pregunta.title }).closest("[lang]")).toHaveAttribute("lang", "en");
    fireEvent.click(screen.getByRole("button", { name: en.pregunta.boton }));
    expect(await screen.findByRole("heading", { name: "Done. Laura's Kitchen won't write to you again." })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Dejar de recibir|Listo/);
  });

  it("sin espacio que diga el idioma (un enlace que no existe), el del navegador", async () => {
    estadoDelEnlaceDeBaja.mockResolvedValue({ status: "not_found" });
    acceptLanguage = "fr-FR,en-GB;q=0.8,es;q=0.5";
    await pagina();
    expect(screen.getByRole("heading", { name: en.noExiste.title })).toBeInTheDocument();
  });

  it("el título de la pestaña va en el mismo idioma", async () => {
    const { generateMetadata } = await import("./[token]/page");
    estadoDelEnlaceDeBaja.mockResolvedValue({ ...VALIDO, locale: "en" });
    expect((await generateMetadata({ params: Promise.resolve({ token: TOKEN }) })).title).toBe(en.metaTitle);
    estadoDelEnlaceDeBaja.mockResolvedValue(VALIDO);
    expect((await generateMetadata({ params: Promise.resolve({ token: TOKEN }) })).title).toBe(t.metaTitle);
  });

  it("la regla del idioma es la del pie (footerTextsFor): inglés con «en», español con cualquier otro", () => {
    expect(bajaIdioma("en-US")).toBe("en");
    expect(bajaIdioma("es-CO", "en-US")).toBe("es");
    expect(bajaIdioma("pt-BR")).toBe("es");
    expect(bajaIdioma(null, "en-US,en;q=0.9")).toBe("en");
    expect(bajaIdioma(null, null)).toBe("es");
    expect(idiomaDelNavegador("de-DE, es;q=0.4, en;q=0.6")).toBe("en");
    expect(idiomaDelNavegador("en;q=0, es-MX")).toBe("es");
    expect(idiomaDelNavegador("de, fr")).toBeNull();
  });
});

describe("los textos (r4)", () => {
  it("la pregunta va en infinitivo, como la de Substack, y el listo sin nombre no inventa uno", () => {
    expect(t.pregunta.title).toBe("¿Dejar de recibir estos mensajes?");
    expect(t.listo.title(null)).toBe("Listo. No te escribirá más.");
  });

  it("la promesa no se contradice (r5): ni «a este correo» junto a «por ningún canal», ni la plataforma por dentro", () => {
    expect(t.pregunta.alcance("Laura")).toBe("Un clic y Laura no te vuelve a escribir, ni por correo ni por otro canal.");
    expect(t.listo.body(null)).not.toMatch(/otro creador|On Cue/);
    expect(en.listo.body(null)).not.toMatch(/creator|On Cue/);
  });

  it("el listo no promete que quien escribía puede deshacer la baja: con SUPPORT_EMAIL, a quién escribir; sin él, nada inventado", () => {
    expect(t.listo.body("ayuda@oncue.test")).toBe(
      "Tu dirección quedó fuera de sus envíos. Si fue un error, escríbenos a ayuda@oncue.test desde esta dirección y lo revisamos.",
    );
    expect(en.listo.body("ayuda@oncue.test")).toMatch(/email us at ayuda@oncue\.test from this address/);
    for (const texto of [t.listo.body(null), t.listo.body("ayuda@oncue.test"), en.listo.body("ayuda@oncue.test")]) {
      expect(texto).not.toMatch(/responde al último correo|reply to the last email|lo verá|will see it/);
    }
    expect(t.listo.body(null)).toBe("Tu dirección quedó fuera de sus envíos.");
  });
});

describe("si la base falla al abrir /baja/<token> (error.tsx, r4)", () => {
  it("habla de la baja, no de un documento, dice que se puede responder al correo y deja reintentar", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["es-CO", "es"]);
    const reset = vi.fn();
    render(<BajaError error={Object.assign(new Error("sin DATABASE_URL"), { digest: "abc123" })} reset={reset} />);
    expect(screen.getByRole("alert")).toHaveTextContent(t.errorPagina.title);
    expect(screen.getByText(t.errorPagina.body)).toHaveTextContent(/responde al correo/);
    expect(document.body.textContent).not.toMatch(/documento/i);
    expect(screen.getByText(/abc123/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t.errorPagina.retry }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("sin la base no se sabe quién escribe: habla el idioma del navegador (r5)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
    render(<BajaError error={new Error("x")} reset={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent(en.errorPagina.title);
    expect(screen.getByRole("button", { name: en.errorPagina.retry })).toBeInTheDocument();
  });
});

describe("dejarDeRecibir", () => {
  it("un token vacío, larguísimo o con caracteres raros no llega a la base", async () => {
    expect(await dejarDeRecibir("")).toEqual({ status: "not_found" });
    expect(await dejarDeRecibir("x".repeat(201))).toEqual({ status: "not_found" });
    expect(await dejarDeRecibir("abc def ghi jkl mno pqr")).toEqual({ status: "not_found" });
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
    darDeBajaDesdeEnlace.mockResolvedValueOnce({ status: "ok", alreadyOptedOut: false, scope: "workspace" });
    expect((await post("List-Unsubscribe=One-Click")).status).toBe(200);
    expect(darDeBajaDesdeEnlace).toHaveBeenCalledWith(TOKEN);
    darDeBajaDesdeEnlace.mockResolvedValueOnce({ status: "sender" });
    expect((await post("List-Unsubscribe=One-Click")).status).toBe(403);
    darDeBajaDesdeEnlace.mockResolvedValueOnce({ status: "not_found" });
    expect((await post("List-Unsubscribe=One-Click")).status).toBe(404);
  });

  it("no depende de ningún secreto: sin OUTREACH_OPTOUT_SECRET la baja sale igual", async () => {
    delete process.env.OUTREACH_OPTOUT_SECRET;
    darDeBajaDesdeEnlace.mockResolvedValueOnce({ status: "ok", alreadyOptedOut: false, scope: "workspace" });
    expect((await post("List-Unsubscribe=One-Click")).status).toBe(200);
  });
});
