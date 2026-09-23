import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BucketSeries,
  ConnectionFreshness,
  DailySeries,
  KpiSeries,
  ResumenKpis,
} from "@mc/db/queries/resumen";

/**
 * Lo que la pantalla decide con lo que le llega de @mc/db: qué nota
 * lleva cada KPI, qué estado vacío pinta cada gráfico y qué líneas
 * lleva el aviso de frescura. Las consultas se sustituyen por los
 * objetos que devolverían; que devuelvan eso lo prueba
 * packages/db/test/resumen.test.ts contra Postgres.
 *
 * El caso que manda es el de RES-2: un workspace que SOLO importó un
 * CSV tiene que ver cifras y explicaciones, no cuatro «—» y dos «No hay
 * datos en este periodo».
 */

const consultas = vi.hoisted(() => ({
  getResumenKpis: vi.fn(),
  getFollowersByPlatform: vi.fn(),
  getViewsByBucket: vi.fn(),
  getFreshnessByConnection: vi.fn(),
}));
vi.mock("@mc/db/queries/resumen", () => consultas);
vi.mock("@/lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));

import { Frescura, FrescuraLista } from "./frescura";
import { Graficos } from "./graficos";
import { Kpis } from "./kpis";

const serie = (value: number | null, extra: Partial<KpiSeries> = {}): KpiSeries => ({
  value,
  previous: null,
  delta: null,
  spark: [],
  ...extra,
});

/** Lo que devuelve getResumenKpis para un workspace que solo importó un CSV. */
const KPIS_SOLO_CSV: ResumenKpis = {
  end: "2026-09-21",
  start: "2026-08-23",
  followers: serie(null),
  views: serie(4000),
  viewsSource: "content",
  nonFollowerReach: serie(0.6667, { sample: 2 }),
  savesPer1k: serie(13, { sample: 1234 }),
  posts: 2,
  hasAccountSeries: false,
};

const FILTRO = { days: 30 as const, platform: null };

beforeEach(() => {
  for (const f of Object.values(consultas)) f.mockReset();
});

describe("los KPIs", () => {
  it("sin cuenta conectada: seguidores explican por qué faltan y las visualizaciones dicen de dónde salen", async () => {
    consultas.getResumenKpis.mockResolvedValue(KPIS_SOLO_CSV);
    render(await Kpis({ filtro: FILTRO }));

    expect(screen.getByText("Llegan al conectar la cuenta: un CSV trae métricas por video")).toBeInTheDocument();
    expect(screen.getByText("De 2 videos publicados en el periodo, con su última lectura · Sin periodo anterior con qué comparar")).toBeInTheDocument();
    // Las razones dicen sobre cuántos videos, con el número formateado.
    expect(screen.getByText("Sobre 2 videos, en su vida completa · Sin periodo anterior con qué comparar")).toBeInTheDocument();
    expect(screen.getByText("Sobre 1.234 videos, en su vida completa · Sin periodo anterior con qué comparar")).toBeInTheDocument();
    // Ni una sola cifra inventada: solo los seguidores quedan en «—».
    expect(screen.getAllByText("—")).toHaveLength(1);
  });

  it("con cuenta: las visualizaciones son de la cuenta y los cuatro comparan", async () => {
    const con = (v: number): KpiSeries => ({ value: v, previous: v / 2, delta: 1, spark: [v / 2, v], sample: 10 });
    consultas.getResumenKpis.mockResolvedValue({
      ...KPIS_SOLO_CSV,
      followers: con(412_000),
      views: con(2_600_000),
      viewsSource: "account",
      nonFollowerReach: con(0.5),
      savesPer1k: con(12),
      hasAccountSeries: true,
    } satisfies ResumenKpis);
    render(await Kpis({ filtro: FILTRO }));
    expect(screen.getByText("De tus cuentas, no solo de lo publicado en el periodo")).toBeInTheDocument();
    expect(screen.queryByText(/Llegan al conectar la cuenta/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/vs\. /)).toHaveLength(4);
  });
});

describe("los dos gráficos", () => {
  const SIN_SEGUIDORES: DailySeries = { labels: [], series: [], hasAccountSeries: false };
  const VIEWS_POR_CONTENIDO: BucketSeries = {
    step: 4,
    source: "content",
    buckets: [
      { start: "2026-09-14", end: "2026-09-17" },
      { start: "2026-09-18", end: "2026-09-21" },
    ],
    series: [{ platformId: "instagram", data: [1000, 3000] }],
  };

  it("solo CSV: el de seguidores ofrece conectar la cuenta, no «otro periodo»; el de barras se llena y lo explica", async () => {
    consultas.getFollowersByPlatform.mockResolvedValue(SIN_SEGUIDORES);
    consultas.getViewsByBucket.mockResolvedValue(VIEWS_POR_CONTENIDO);
    render(await Graficos({ filtro: FILTRO }));

    expect(screen.getByText("Los seguidores llegan al conectar la cuenta")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Conectar una cuenta" })).toHaveAttribute("href", "/conexiones");
    expect(screen.queryByText("No hay datos en este periodo")).not.toBeInTheDocument();
    expect(screen.queryByText(/El eje arranca en cero/)).not.toBeInTheDocument();

    expect(screen.getByText(/Sin cuenta conectada: cada barra suma las visualizaciones de lo publicado/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Visualizaciones por red y periodo" })).toBeInTheDocument();
  });

  it("con cuenta pero sin datos en el periodo: el vacío de siempre, con su salida", async () => {
    consultas.getFollowersByPlatform.mockResolvedValue({ ...SIN_SEGUIDORES, hasAccountSeries: true });
    consultas.getViewsByBucket.mockResolvedValue({ ...VIEWS_POR_CONTENIDO, source: "account", buckets: [], series: [] });
    render(await Graficos({ filtro: FILTRO }));
    expect(screen.getAllByText("No hay datos en este periodo")).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Ver 90 días" })).toHaveLength(2);
  });

  it("la nota de las redes desalineadas solo sale cuando se ven varias redes", async () => {
    const seguidores: DailySeries = {
      labels: ["2026-09-20", "2026-09-21"],
      series: [{ platformId: "tiktok", data: [213_000, 214_000] }],
      hasAccountSeries: true,
    };
    consultas.getFollowersByPlatform.mockResolvedValue(seguidores);
    consultas.getViewsByBucket.mockResolvedValue({ ...VIEWS_POR_CONTENIDO, source: "account" });

    const { unmount } = render(await Graficos({ filtro: { days: 30, platform: "tiktok" } }));
    expect(screen.getByText(/El eje arranca en cero/)).toBeInTheDocument();
    expect(screen.queryByText(/Una red que empezó a medirse/)).not.toBeInTheDocument();
    // Etiquetas cortas en número, en el orden del locale: «20/9», no «20 sep».
    expect(screen.getAllByText("20/9").length).toBeGreaterThan(0);
    unmount();

    render(await Graficos({ filtro: FILTRO }));
    expect(screen.getByText(/Una red que empezó a medirse/)).toBeInTheDocument();
  });
});

describe("el aviso de frescura", () => {
  const base: ConnectionFreshness = {
    connectionId: "00000000-0000-4000-8000-000000000001",
    platformId: "instagram",
    handle: "revisor.csv",
    displayName: null,
    status: "active",
    accessMode: "manual_csv",
    lastSyncedAt: "2026-09-22T16:00:00Z",
    lastAccountDay: null,
    lastSyncedReadingAt: null,
    lastCsvReadingAt: "2026-09-22T16:00:00Z",
    dataUntil: "2026-09-22",
    tokenExpiringSoon: false,
  };

  it("una cuenta alimentada solo por CSV tiene fecha, no «Sin lecturas todavía»", () => {
    render(<FrescuraLista filas={[base]} />);
    const tarjeta = screen.getByText("@revisor.csv").closest("li")!;
    expect(within(tarjeta).queryByText("Sin lecturas todavía")).not.toBeInTheDocument();
    expect(within(tarjeta).getByText(/datos hasta el/).textContent).toBe("datos hasta el 22 sep · CSV importado");
  });

  it("una cuenta OAuth con un CSV encima enseña las dos fuentes por separado", () => {
    render(
      <FrescuraLista
        filas={[
          {
            ...base,
            handle: "laura.cocinafacil",
            accessMode: "direct_oauth",
            lastAccountDay: "2026-09-15",
            lastSyncedReadingAt: "2026-09-15T23:00:00Z",
          },
        ]}
      />,
    );
    const lineas = screen.getAllByText(/datos hasta el/).map((p) => p.textContent);
    // La de la API sigue diciendo el 15: el CSV de hoy no la tapa.
    expect(lineas).toEqual(["datos hasta el 15 sep · API", "datos hasta el 22 sep · CSV importado"]);
  });

  it("sin ninguna lectura, lo dice", () => {
    render(<FrescuraLista filas={[{ ...base, lastCsvReadingAt: null, dataUntil: null }]} />);
    expect(screen.getByText("Sin lecturas todavía")).toBeInTheDocument();
  });

  it("respeta el filtro por red: se lo pasa a la consulta", async () => {
    consultas.getFreshnessByConnection.mockResolvedValue([]);
    await Frescura({ filtro: { days: 30, platform: "tiktok" } });
    expect(consultas.getFreshnessByConnection).toHaveBeenCalledWith({}, { platform: "tiktok" });
  });
});
