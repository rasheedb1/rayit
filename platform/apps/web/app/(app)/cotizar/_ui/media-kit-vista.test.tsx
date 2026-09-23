import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MediaKitSnapshot } from "@mc/db/queries/cotizar";
import { MediaKitVista } from "./media-kit-vista";

/** Un snapshot como el que congela `buildMediaKitSnapshot`. */
const SNAPSHOT: MediaKitSnapshot = {
  version: 2,
  capturedAt: "2026-09-20T12:00:00Z",
  creator: { displayName: "Laura Cocina", handle: "@lauracocina", bio: "Recetas de 30 segundos", country: "CO", nicheSlugs: ["cocina"] },
  currency: "COP",
  locale: "es-CO",
  timezone: "America/Bogota",
  redes: [
    { platformId: "tiktok", handle: "@lauracocina", followers: 128_400, followersAsOf: "2026-09-20", medianViews: 115_446, engagement: "0.074", sampleSize: 20, isReliable: true },
    { platformId: "instagram", handle: "@lauracocina", followers: 61_200, followersAsOf: "2026-09-20", medianViews: 62_177, engagement: "0.051", sampleSize: 12, isReliable: true },
  ],
  totales: { followers: 189_600, medianViewsMax: 115_446, medianViewsMaxPlatform: "tiktok" },
  topPosts: [
    { platformId: "tiktok", url: "https://tiktok.com/x", caption: "Arepas en 30 s", publishedAt: "2026-09-01T15:00:00Z", views: 412_000, viewsVsMedian: "3.570" },
  ],
  audiencia: [
    { platformId: "tiktok", dimension: "age", buckets: [{ bucket: "18-24", share: "0.34" }, { bucket: "25-34", share: "0.37" }] },
    { platformId: "tiktok", dimension: "gender", buckets: [{ bucket: "F", share: "0.61" }, { bucket: "M", share: "0.39" }] },
    { platformId: "tiktok", dimension: "country", buckets: [{ bucket: "CO", share: "0.69" }, { bucket: "OTHER", share: "0.03" }] },
  ],
  tarifas: [{ labelEs: "TikTok dedicado", platformId: "tiktok", priceLow: "5195070.00", priceHigh: "8081220.00" }],
};

describe("MediaKitVista", () => {
  it("enseña las cifras congeladas en la moneda y el locale del workspace", () => {
    render(<MediaKitVista snapshot={SNAPSHOT} />);

    expect(screen.getByRole("heading", { level: 1, name: "Laura Cocina" })).toBeInTheDocument();
    expect(screen.getByText("Cifras congeladas el 20 de septiembre de 2026")).toBeInTheDocument();
    // Compacto en el locale del snapshot: 189.600 → "189,6 mil".
    expect(screen.getByText("189,6 mil")).toBeInTheDocument();
    expect(screen.getAllByText("115,4 mil").length).toBeGreaterThan(0);
    expect(screen.getByText("7,4 %")).toBeInTheDocument();
  });

  it("la cifra grande de views dice de qué red sale: es la mediana de la mejor red, no la del creador", () => {
    render(<MediaKitVista snapshot={SNAPSHOT} />);
    const cifras = screen.getByRole("region", { name: "Cifras principales" });
    expect(within(cifras).getByText("Views medianas · mejor red")).toBeInTheDocument();
    expect(within(cifras).getByText("115,4 mil")).toBeInTheDocument();
    expect(within(cifras).getByText("TikTok")).toBeInTheDocument();
    expect(within(cifras).queryByText("Views medianas")).not.toBeInTheDocument();
  });

  it("un media kit anterior, sin la red de la mejor mediana, no la enseña en la cabecera (sí por red)", () => {
    const viejo = { ...SNAPSHOT, totales: { followers: 189_600, medianViewsMax: 115_446 } };
    render(<MediaKitVista snapshot={viejo} />);
    const cifras = screen.getByRole("region", { name: "Cifras principales" });
    expect(within(cifras).queryByText("115,4 mil")).not.toBeInTheDocument();
    expect(within(cifras).getByText("189,6 mil")).toBeInTheDocument();
    expect(screen.getAllByText("115,4 mil")).toHaveLength(1);
  });

  it("el documento declara el idioma de sus textos, no el del locale de las cifras", () => {
    const { container, unmount } = render(<MediaKitVista snapshot={SNAPSHOT} />);
    expect(container.querySelector("article")).toHaveAttribute("lang", "es-CO");
    unmount();
    // Un workspace en EE. UU.: cifras en en-US, textos en español.
    const { container: usa } = render(<MediaKitVista snapshot={{ ...SNAPSHOT, locale: "en-US", currency: "USD" }} />);
    expect(usa.querySelector("article")).toHaveAttribute("lang", "es");
  });

  it("el video que despegó dice cuántas veces su mediana, como multiplicador", () => {
    render(<MediaKitVista snapshot={SNAPSHOT} />);
    expect(screen.getByText("3,6× su mediana")).toBeInTheDocument();
  });

  it("la audiencia va por dimensión y con su red, sin pastillas repetidas", () => {
    render(<MediaKitVista snapshot={SNAPSHOT} />);
    const audiencia = screen.getByRole("region", { name: "Audiencia" });
    expect(within(audiencia).getByText("Edad · TikTok")).toBeInTheDocument();
    expect(within(audiencia).getByText("Género · TikTok")).toBeInTheDocument();
    expect(within(audiencia).getByText("País · TikTok")).toBeInTheDocument();
    expect(within(audiencia).getByText("Mujeres")).toBeInTheDocument();
    expect(within(audiencia).getByText("Colombia")).toBeInTheDocument();
    expect(within(audiencia).getByText("Otros")).toBeInTheDocument();
    expect(within(audiencia).getAllByText("25-34")).toHaveLength(1);
    expect(within(audiencia).getByText("37 %")).toBeInTheDocument();
  });

  it("las tarifas van al final y son un rango, no un precio", () => {
    render(<MediaKitVista snapshot={SNAPSHOT} />);
    const tarifas = screen.getByRole("region", { name: "Tarifas" });
    expect(within(tarifas).getByText("COP 5,2 M – COP 8,1 M")).toBeInTheDocument();
    expect(within(tarifas).getByText(/El precio final se acuerda en la cotización/)).toBeInTheDocument();
  });

  it("si los rangos ya llevan derechos o exclusividad, lo dice debajo; un kit anterior no dice nada", () => {
    const { unmount } = render(
      <MediaKitVista snapshot={{ ...SNAPSHOT, tarifasIncluyen: ["derechos_uso_30d", "exclusividad_30d"] }} />,
    );
    const tarifas = screen.getByRole("region", { name: "Tarifas" });
    expect(within(tarifas).getByTestId("tarifas-incluyen")).toHaveTextContent(
      "Estos rangos ya incluyen: Derechos de uso · 30 días, Exclusividad de categoría · 30 días.",
    );
    unmount();
    render(<MediaKitVista snapshot={SNAPSHOT} />);
    expect(screen.queryByTestId("tarifas-incluyen")).not.toBeInTheDocument();
  });

  it("la pastilla de la red mide lo que su texto, no el ancho de la columna", () => {
    render(<MediaKitVista snapshot={SNAPSHOT} />);
    const tarifas = screen.getByRole("region", { name: "Tarifas" });
    // flex-col estira a sus hijos (align-items: stretch) salvo que diga items-start.
    const pastilla = within(tarifas).getByText("TikTok");
    const columna = pastilla.closest(".flex-col");
    expect(columna).toHaveClass("items-start");
  });

  it("sin audiencia ni videos, no pinta las secciones vacías; un snapshot v1 no enseña su audiencia plana", () => {
    render(<MediaKitVista snapshot={{ ...SNAPSHOT, topPosts: [], audiencia: [], tarifas: [] }} />);
    expect(screen.queryByRole("region", { name: "Tarifas" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Audiencia" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Lo que mejor funciona" })).not.toBeInTheDocument();
    // Lo que sí queda: quién es y sus redes.
    expect(screen.getByRole("heading", { level: 1, name: "Laura Cocina" })).toBeInTheDocument();
  });

  it("un snapshot de la primera versión (audiencia plana) no enseña la sección", () => {
    const v1 = { ...SNAPSHOT, audiencia: [{ dimension: "age", bucket: "25-34", share: "0.4" }] } as unknown as MediaKitSnapshot;
    render(<MediaKitVista snapshot={v1} />);
    expect(screen.queryByRole("region", { name: "Audiencia" })).not.toBeInTheDocument();
  });
});
