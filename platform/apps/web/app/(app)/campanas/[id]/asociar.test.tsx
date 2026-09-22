import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkablePost, SuggestedPost } from "@mc/db";

// Las Server Actions se sustituyen: aquí importa cómo reacciona el
// formulario a lo que devuelven (errores por campo, mensaje general).
const asociarPost = vi.fn();
const buscarPosts = vi.fn();
vi.mock("./actions", () => ({
  asociarPost: (...args: unknown[]) => asociarPost(...args),
  buscarPosts: (...args: unknown[]) => buscarPosts(...args),
}));

import { LinkPostForm, LinkPosts } from "./asociar";

const CAMPANA = "00000003-0000-4000-8000-000000ca0001";
const post: LinkablePost = {
  postId: "00000002-0000-4000-8000-000000000d05",
  platformId: "youtube",
  title: null,
  caption: "Una semana de almuerzos saludables con Nutrivé",
  url: "https://www.youtube.com/watch?v=demo-d05",
  coverUrl: null,
  publishedAt: "2026-07-15T14:00:00Z",
  views: 58000,
};
const sugerido: SuggestedPost = { ...post, postId: "00000002-0000-4000-8000-000000000d01", reasons: [{ kind: "mention", text: "Menciona a @cafealma" }] };

beforeEach(() => {
  asociarPost.mockReset();
  buscarPosts.mockReset();
});

describe("LinkPostForm", () => {
  it("envía campaña, post, entregable y principal", async () => {
    asociarPost.mockResolvedValue({ ok: true });
    render(<LinkPostForm campaignId={CAMPANA} post={post} />);
    fireEvent.change(screen.getByLabelText("Entregable"), { target: { value: "dedicado" } });
    fireEvent.click(screen.getByLabelText("Principal"));
    fireEvent.click(screen.getByRole("button", { name: "Asociar" }));
    await waitFor(() => expect(asociarPost).toHaveBeenCalledTimes(1));
    const formData = asociarPost.mock.calls[0]?.[1] as FormData;
    expect(formData.get("campaignId")).toBe(CAMPANA);
    expect(formData.get("postId")).toBe(post.postId);
    expect(formData.get("deliverable")).toBe("dedicado");
    expect(formData.get("isPrimary")).toBe("on");
  });

  it("los errores por campo llegan en español, con aria-invalid y foco", async () => {
    asociarPost.mockResolvedValue({ errors: { deliverable: "Elige un entregable de la lista." } });
    render(<LinkPostForm campaignId={CAMPANA} post={post} />);
    fireEvent.click(screen.getByRole("button", { name: "Asociar" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Elige un entregable de la lista."));
    const select = screen.getByLabelText("Entregable");
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(select).toHaveAccessibleDescription("Elige un entregable de la lista.");
    await waitFor(() => expect(select).toHaveFocus());
  });

  it("un error de dominio (otro workspace, campaña cerrada) se muestra tal cual", async () => {
    asociarPost.mockResolvedValue({ message: "Una campaña cerrada no admite cambios." });
    render(<LinkPostForm campaignId={CAMPANA} post={post} />);
    fireEvent.click(screen.getByRole("button", { name: "Asociar" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Una campaña cerrada no admite cambios."));
  });
});

describe("LinkPosts", () => {
  it("abre en Sugeridos cuando hay, con el motivo, y en Buscar cuando no", () => {
    render(<LinkPosts campaignId={CAMPANA} suggestions={[sugerido]} initial={[post]} />);
    expect(screen.getByRole("button", { name: "Sugeridos (1)" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Menciona a @cafealma")).toBeInTheDocument();
    expect(screen.queryByLabelText("Buscar por título o caption")).not.toBeInTheDocument();
  });

  it("sin sugerencias abre en Buscar con la lista inicial y busca en el servidor al escribir", async () => {
    buscarPosts.mockResolvedValue([]);
    render(<LinkPosts campaignId={CAMPANA} suggestions={[]} initial={[post]} />);
    expect(screen.getByRole("button", { name: "Buscar" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/almuerzos saludables/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Buscar por título o caption"), { target: { value: "cold brew" } });
    await waitFor(() => expect(buscarPosts).toHaveBeenCalledWith(CAMPANA, "cold brew"), { timeout: 2000 });
    await waitFor(() => expect(screen.getByText("Ningún post con «cold brew»")).toBeInTheDocument());
  });

  it("la pestaña Sugeridos vacía lo dice en español", () => {
    render(<LinkPosts campaignId={CAMPANA} suggestions={[]} initial={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Sugeridos (0)" }));
    expect(screen.getByText("Nada que sugerir")).toBeInTheDocument();
  });

  it("cuando la ficha se revalida con la búsqueda escrita, vuelve a buscar y una respuesta vieja no pisa la nueva", async () => {
    let resolveFirst: (v: LinkablePost[]) => void = () => undefined;
    buscarPosts.mockImplementationOnce(() => new Promise<LinkablePost[]>((r) => (resolveFirst = r)));
    buscarPosts.mockResolvedValue([]);
    const { rerender } = render(<LinkPosts campaignId={CAMPANA} suggestions={[]} initial={[post]} />);
    fireEvent.change(screen.getByLabelText("Buscar por título o caption"), { target: { value: "nutriv" } });
    await waitFor(() => expect(buscarPosts).toHaveBeenCalledTimes(1), { timeout: 2000 });
    // La ficha se revalida (el post ya se asoció): initial cambia y se repite la búsqueda.
    rerender(<LinkPosts campaignId={CAMPANA} suggestions={[]} initial={[]} />);
    await waitFor(() => expect(buscarPosts).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await waitFor(() => expect(screen.getByText("Ningún post con «nutriv»")).toBeInTheDocument());
    // La primera respuesta llega tarde con el post: se ignora.
    resolveFirst([post]);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/almuerzos saludables/)).not.toBeInTheDocument();
  });
});
