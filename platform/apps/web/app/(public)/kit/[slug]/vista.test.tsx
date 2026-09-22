import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MediaKitSnapshot } from "@mc/db/queries/cotizar";
import { MediaKitVista } from "./vista";

/** Un snapshot como el que congela `buildMediaKitSnapshot`. */
const SNAPSHOT: MediaKitSnapshot = {
  version: 1,
  capturedAt: "2026-09-20T12:00:00Z",
  creator: { displayName: "Laura Cocina", handle: "@lauracocina", bio: "Recetas de 30 segundos", country: "CO", nicheSlugs: ["cocina"] },
  currency: "COP",
  locale: "es-CO",
  timezone: "America/Bogota",
  redes: [
    { platformId: "tiktok", handle: "@lauracocina", followers: 128_400, followersAsOf: "2026-09-20", medianViews: 115_446, engagement: "0.074", sampleSize: 20, isReliable: true },
    { platformId: "instagram", handle: "@lauracocina", followers: 61_200, followersAsOf: "2026-09-20", medianViews: 62_177, engagement: "0.051", sampleSize: 12, isReliable: true },
  ],
  totales: { followers: 189_600, medianViewsMax: 115_446 },
  topPosts: [
    { platformId: "tiktok", url: "https://tiktok.com/x", caption: "Arepas en 30 s", publishedAt: "2026-09-01T15:00:00Z", views: 412_000, viewsVsMedian: "3.570" },
  ],
  audiencia: [{ dimension: "country", bucket: "Colombia", share: "0.62" }],
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

  it("las tarifas van al final y son un rango, no un precio", () => {
    render(<MediaKitVista snapshot={SNAPSHOT} />);
    const tarifas = screen.getByRole("region", { name: "Tarifas" });
    expect(within(tarifas).getByText("COP 5,2 M – COP 8,1 M")).toBeInTheDocument();
    expect(within(tarifas).getByText(/El precio final se acuerda en la cotización/)).toBeInTheDocument();
  });

  it("sin audiencia ni videos, no pinta las secciones vacías", () => {
    render(<MediaKitVista snapshot={{ ...SNAPSHOT, topPosts: [], audiencia: [], tarifas: [] }} />);
    expect(screen.queryByRole("region", { name: "Tarifas" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Audiencia" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Lo que mejor funciona" })).not.toBeInTheDocument();
    // Lo que sí queda: quién es y sus redes.
    expect(screen.getByRole("heading", { level: 1, name: "Laura Cocina" })).toBeInTheDocument();
  });
});
