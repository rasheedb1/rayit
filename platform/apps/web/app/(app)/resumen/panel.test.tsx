import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConnectionFreshness,
  DailySeries,
  KpiSeries,
  ResumenKpis,
  WeekSeries,
} from "@mc/db/queries/resumen";

/**
 * Lo que la pantalla decide con lo que le llega de @mc/db: qué dice cada
 * KPI y qué explica su (i), qué estado vacío pinta cada gráfico y qué
 * líneas lleva el aviso de frescura. Las consultas se sustituyen por los
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
  getViewsByWeek: vi.fn(),
  getFreshnessByConnection: vi.fn(),
}));
vi.mock("@mc/db/queries/resumen", () => consultas);
vi.mock("@/lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));

import { formatterFor } from "@/lib/format";
import { Frescura, FrescuraLista } from "./frescura";
import { Graficos } from "./graficos";
import { Kpis } from "./kpis";

const serie = (value: number | null, extra: Partial<KpiSeries> = {}): KpiSeries => ({
  value,
  previous: null,
  delta: null,
  deltaKind: "relative",
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
  viewsWindow: { start: "2026-08-23", end: "2026-09-21" },
  nonFollowerReach: serie(0.6667, { sample: 2, deltaKind: "points" }),
  savesPer1k: serie(13, { sample: 1234 }),
  posts: 2,
  hasAccountSeries: false,
};

const FILTRO = { days: 30 as const, platform: null };

/** Abre el (i) de una tarjeta y devuelve su panel. */
function abrirInfo(kpi: string): HTMLElement {
  const boton = screen.getByRole("button", { name: `Qué cuenta «${kpi}»` });
  expect(boton).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(boton);
  expect(boton).toHaveAttribute("aria-expanded", "true");
  const panel = document.getElementById(boton.getAttribute("aria-controls")!)!;
  expect(panel).toBeVisible();
  return panel;
}

beforeEach(() => {
  for (const f of Object.values(consultas)) f.mockReset();
});

describe("los KPIs", () => {
  it("en la tarjeta, solo el dato; sin comparación, UNA línea que dice por qué", async () => {
    consultas.getResumenKpis.mockResolvedValue(KPIS_SOLO_CSV);
    render(await Kpis({ filtro: FILTRO }));

    // Los seguidores explican su «—» en la tarjeta: es lo único que la sostiene.
    expect(screen.getByText("Llegan al conectar la cuenta")).toBeInTheDocument();
    // Las otras tres dicen por qué no hay flecha, y nada más.
    expect(screen.getAllByText("Sin periodo anterior con qué comparar")).toHaveLength(3);
    // Ni una sola cifra inventada: solo los seguidores quedan en «—».
    expect(screen.getAllByText("—")).toHaveLength(1);
    // Y ninguna nota de dos líneas bajo la cifra: las explicaciones están cerradas.
    for (const b of screen.getAllByRole("button", { name: /^Qué cuenta/ })) {
      expect(b).toHaveAttribute("aria-expanded", "false");
      expect(document.getElementById(b.getAttribute("aria-controls")!)).not.toBeVisible();
    }
  });

  it("el (i) dice de dónde sale cada cifra: lo publicado sin cuenta, y la base de las razones", async () => {
    consultas.getResumenKpis.mockResolvedValue(KPIS_SOLO_CSV);
    render(await Kpis({ filtro: FILTRO }));

    expect(abrirInfo("Visualizaciones en 30 días")).toHaveTextContent("La suma de 2 videos publicados en el periodo");
    expect(abrirInfo("Seguidores en total")).toHaveTextContent("un CSV trae métricas por video");
    // La base, con el número formateado con el locale.
    expect(abrirInfo("Guardados por 1 000 visualizaciones")).toHaveTextContent("Calculado sobre 1.234 videos publicados");
    expect(abrirInfo("Alcance en no seguidores")).toHaveTextContent("Calculado sobre 2 videos publicados");
  });

  it("el (i) se cierra con Escape y devuelve el foco a su botón", async () => {
    consultas.getResumenKpis.mockResolvedValue(KPIS_SOLO_CSV);
    render(await Kpis({ filtro: FILTRO }));
    const panel = abrirInfo("Visualizaciones en 30 días");
    const boton = screen.getByRole("button", { name: "Qué cuenta «Visualizaciones en 30 días»" });
    fireEvent.keyDown(boton, { key: "Escape" });
    expect(panel).not.toBeVisible();
    expect(boton).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(boton);
  });

  it("con cuenta: los cuatro comparan, y el (i) de visualizaciones dice que son de la cuenta", async () => {
    const con = (v: number): KpiSeries => ({ value: v, previous: v / 2, delta: 1, deltaKind: "relative", spark: [v / 2, v], sample: 10 });
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
    expect(screen.queryByText(/Llegan al conectar la cuenta/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/vs\. /)).toHaveLength(4);
    expect(screen.queryByText("Sin periodo anterior con qué comparar")).not.toBeInTheDocument();
    expect(abrirInfo("Visualizaciones en 30 días")).toHaveTextContent("no solo las de lo que publicaste en el periodo");
  });

  it("el alcance en no seguidores, que ya es un porcentaje, compara en puntos y no en «%»", async () => {
    consultas.getResumenKpis.mockResolvedValue({
      ...KPIS_SOLO_CSV,
      // De 53,9 % a 56 %: +2,1 puntos (relativo serían +4 %).
      nonFollowerReach: serie(0.56, { previous: 0.539, delta: 0.021, deltaKind: "points", sample: 12, spark: [0.539, 0.56] }),
    } satisfies ResumenKpis);
    render(await Kpis({ filtro: FILTRO }));
    expect(screen.getByText("56 %")).toBeInTheDocument();
    expect(screen.getByText("+2,1 puntos")).toBeInTheDocument();
    expect(screen.queryByText("+4 %")).not.toBeInTheDocument();
    expect(screen.getByText("+2,1 puntos").parentElement).toHaveClass("text-good");
  });

  it("con pocos videos no pinta una flecha que alarma: dice «Pocos videos para comparar»", async () => {
    // ?periodo=7&red=instagram con UN video: «−50 %» en rojo era ruido.
    consultas.getResumenKpis.mockResolvedValue({
      ...KPIS_SOLO_CSV,
      nonFollowerReach: serie(0.39, { previous: 0.62, delta: null, deltaKind: "points", sample: 1, lowSample: true }),
      savesPer1k: serie(8, { previous: 16, delta: null, sample: 1, lowSample: true }),
    } satisfies ResumenKpis);
    render(await Kpis({ filtro: { days: 7, platform: "instagram" } }));
    expect(screen.getAllByText("Pocos videos para comparar")).toHaveLength(2);
    expect(screen.queryByText(/puntos/)).not.toBeInTheDocument();
    expect(screen.queryByText(/−50/)).not.toBeInTheDocument();
  });

  it("las cuentas nuevas suman en la cifra y el (i) dice que no entran en la comparación", async () => {
    consultas.getResumenKpis.mockResolvedValue({
      ...KPIS_SOLO_CSV,
      followers: serie(712_000, { previous: 400_000, delta: 0.03, spark: [400_000, 412_000], newAccounts: 1 }),
      views: serie(2_650_000, { previous: 2_200_000, delta: 0.2, spark: [1, 2], newAccounts: 2 }),
      viewsSource: "account",
      hasAccountSeries: true,
    } satisfies ResumenKpis);
    render(await Kpis({ filtro: FILTRO }));
    expect(screen.getByText("+3 %")).toBeInTheDocument();
    expect(abrirInfo("Seguidores en total")).toHaveTextContent("Una cuenta que conectaste dentro del periodo suma en la cifra");
    expect(abrirInfo("Visualizaciones en 30 días")).toHaveTextContent("2 cuentas que conectaste dentro del periodo");
  });

  it("si la cuenta aún no cerró el último día, el (i) de visualizaciones dice hasta cuándo suma", async () => {
    consultas.getResumenKpis.mockResolvedValue({
      ...KPIS_SOLO_CSV,
      end: "2026-09-21",
      views: serie(2_600_000, { previous: 2_500_000, delta: 0.04, spark: [1, 2] }),
      viewsSource: "account",
      viewsWindow: { start: "2026-08-22", end: "2026-09-20" },
      hasAccountSeries: true,
    } satisfies ResumenKpis);
    render(await Kpis({ filtro: FILTRO }));
    expect(abrirInfo("Visualizaciones en 30 días")).toHaveTextContent("Suma hasta el 20 sep, el último día que tu cuenta ya cerró.");
  });
});

describe("los dos gráficos", () => {
  const SIN_SEGUIDORES: DailySeries = { labels: [], series: [], hasAccountSeries: false };
  const SEMANAS_POR_CONTENIDO: WeekSeries = {
    source: "content",
    weeks: [
      { start: "2026-09-08", end: "2026-09-14" },
      { start: "2026-09-15", end: "2026-09-21" },
    ],
    series: [{ platformId: "instagram", data: [1000, 3000] }],
  };

  it("solo CSV: el de seguidores ofrece conectar la cuenta, no «otro periodo»; el de barras se llena y lo explica", async () => {
    consultas.getFollowersByPlatform.mockResolvedValue(SIN_SEGUIDORES);
    consultas.getViewsByWeek.mockResolvedValue(SEMANAS_POR_CONTENIDO);
    render(await Graficos({ filtro: FILTRO }));

    expect(screen.getByText("Los seguidores llegan al conectar la cuenta")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Conectar una cuenta" })).toHaveAttribute("href", "/conexiones");
    expect(screen.queryByText("No hay datos en este periodo")).not.toBeInTheDocument();

    expect(screen.getByText("Sin cuenta conectada, cada barra suma lo que publicaste esa semana.")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Visualizaciones por red y semana" })).toBeInTheDocument();
  });

  it("las barras son semanas: el gráfico no depende del periodo y la consulta ni lo recibe", async () => {
    consultas.getFollowersByPlatform.mockResolvedValue(SIN_SEGUIDORES);
    consultas.getViewsByWeek.mockResolvedValue({ ...SEMANAS_POR_CONTENIDO, source: "account" });
    render(await Graficos({ filtro: { days: 7, platform: "tiktok" } }));
    expect(consultas.getViewsByWeek).toHaveBeenCalledWith({}, { platform: "tiktok" });
    expect(screen.getByText("Por semana · 2 semanas")).toBeInTheDocument();
    expect(screen.getByText("No es la suma del periodo elegido: siempre enseña las últimas semanas.")).toBeInTheDocument();
  });

  it("una semana: el último día bajo la barra y la semana entera en la tabla, sin partirse", async () => {
    consultas.getFollowersByPlatform.mockResolvedValue(SIN_SEGUIDORES);
    consultas.getViewsByWeek.mockResolvedValue(SEMANAS_POR_CONTENIDO);
    render(await Graficos({ filtro: FILTRO }));
    const tarjeta = screen.getByRole("heading", { name: "Visualizaciones por semana" }).closest("article")!;
    // Bajo la barra, solo el día final: dos rangos seguidos se pisaban a 400 px.
    const eje = [...tarjeta.querySelectorAll("svg text")].map((t) => t.textContent);
    expect(eje).toEqual(expect.arrayContaining(["14/9", "21/9"]));
    expect(eje.some((t) => t?.includes("–"))).toBe(false);
    within(tarjeta).getByRole("button", { name: "Ver tabla" }).click();
    const tabla = await within(tarjeta).findByRole("table");
    expect(within(tabla).getByRole("columnheader", { name: "Semana" })).toBeInTheDocument();
    // El rango, con el guion unido a sus dos lados (WORD JOINER): no se parte en dos líneas.
    expect(within(tabla).getByRole("rowheader", { name: "15⁠–⁠21/9" })).toBeInTheDocument();
  });

  it("ningún «datos hasta el…» de los gráficos habla de UTC: se dice una vez, en la frescura", async () => {
    consultas.getFollowersByPlatform.mockResolvedValue({
      labels: ["2026-09-20", "2026-09-21"],
      series: [{ platformId: "tiktok", data: [213_000, 214_000] }],
      hasAccountSeries: true,
    } satisfies DailySeries);
    consultas.getViewsByWeek.mockResolvedValue(SEMANAS_POR_CONTENIDO);
    render(await Graficos({ filtro: FILTRO }));
    expect(screen.queryByText(/UTC/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/datos hasta el/).map((p) => p.textContent)).toEqual([
      "datos hasta el 21 sep",
      "datos hasta el 21 sep",
    ]);
  });

  it("con cuenta pero sin datos: cada tarjeta ofrece la salida que de verdad existe", async () => {
    consultas.getFollowersByPlatform.mockResolvedValue({ ...SIN_SEGUIDORES, hasAccountSeries: true });
    consultas.getViewsByWeek.mockResolvedValue({ ...SEMANAS_POR_CONTENIDO, source: "account", weeks: [], series: [] });
    render(await Graficos({ filtro: FILTRO }));
    // La de seguidores depende del periodo: «Ver 90 días».
    expect(screen.getByText("No hay datos en este periodo")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Ver 90 días" })).toHaveLength(1);
    // La semanal no: ofrecerle otro periodo no le cambiaría nada.
    expect(screen.getByText("No hay datos en estas semanas")).toBeInTheDocument();
  });

  it("sin semanas y con una red elegida, la salida del gráfico semanal es quitar la red", async () => {
    consultas.getFollowersByPlatform.mockResolvedValue({ ...SIN_SEGUIDORES, hasAccountSeries: true });
    consultas.getViewsByWeek.mockResolvedValue({ source: "account", weeks: [], series: [] } satisfies WeekSeries);
    render(await Graficos({ filtro: { days: 90, platform: "tiktok" } }));
    const quitar = screen.getAllByRole("link", { name: "Quitar el filtro de red" });
    expect(quitar.length).toBeGreaterThan(0);
    for (const l of quitar) expect(l).toHaveAttribute("href", "/resumen?periodo=90");
  });

  it("la nota de las redes desalineadas solo sale cuando se ven varias redes", async () => {
    const dosRedes: DailySeries = {
      labels: ["2026-09-20", "2026-09-21"],
      series: [
        { platformId: "tiktok", data: [213_000, 214_000] },
        { platformId: "instagram", data: [0, 98_000] },
      ],
      hasAccountSeries: true,
    };
    consultas.getFollowersByPlatform.mockResolvedValue({ ...dosRedes, series: dosRedes.series.slice(0, 1) });
    consultas.getViewsByWeek.mockResolvedValue({ ...SEMANAS_POR_CONTENIDO, source: "account" });

    const { unmount } = render(await Graficos({ filtro: { days: 30, platform: "tiktok" } }));
    expect(screen.queryByText(/Una red nueva aparece en cero/)).not.toBeInTheDocument();
    // Etiquetas cortas en número, en el orden del locale: «20/9», no «20 sep».
    expect(screen.getAllByText("20/9").length).toBeGreaterThan(0);
    unmount();

    consultas.getFollowersByPlatform.mockResolvedValue(dosRedes);
    render(await Graficos({ filtro: FILTRO }));
    expect(screen.getByText("Una red nueva aparece en cero hasta su primera lectura.")).toBeInTheDocument();
  });
});

describe("el aviso de frescura", () => {
  const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });
  const base: ConnectionFreshness = {
    connectionId: "00000000-0000-4000-8000-000000000001",
    platformId: "instagram",
    handle: "revisor.csv",
    displayName: null,
    status: "active",
    accessMode: "manual_csv",
    lastSyncedAt: "2026-09-22T16:00:00Z",
    lastAccountDay: null,
    lastSyncedReadingDay: null,
    lastCsvDay: "2026-09-21",
    // Mediodía del 22 en Bogotá: lo que guarda un «exportado el 22».
    lastCsvExportAt: "2026-09-22T17:00:00Z",
    dataUntil: "2026-09-21",
    daysBehind: 0,
    tokenExpiringSoon: false,
  };

  it("una cuenta alimentada solo por CSV dice cuándo se exportó, no «Sin lecturas todavía»", () => {
    render(<FrescuraLista filas={[base]} f={f} />);
    const tarjeta = screen.getByText("@revisor.csv").closest("li")!;
    expect(within(tarjeta).queryByText("Sin lecturas todavía")).not.toBeInTheDocument();
    // La misma fecha que el creador escribió en el paso 2, no el día anterior de la regla del reloj.
    expect(within(tarjeta).getByText("CSV exportado el 22 sep")).toBeInTheDocument();
  });

  it("la fecha de exportación es la del calendario del creador, no la de UTC", () => {
    // Una exportación a las 21:55 en Bogotá son las 02:55 UTC del día
    // siguiente: para el creador sigue siendo el 11.
    render(<FrescuraLista filas={[{ ...base, lastCsvExportAt: "2026-09-12T02:55:00Z" }]} f={f} />);
    expect(screen.getByText("CSV exportado el 11 sep")).toBeInTheDocument();
    expect(screen.getByText("CSV exportado el 11 sep").closest("time")).toHaveAttribute("dateTime", "2026-09-12T02:55:00Z");
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
            lastSyncedReadingDay: "2026-09-15",
            daysBehind: 6,
          },
        ]}
        f={f}
      />,
    );
    // La de la API sigue diciendo el 15: el CSV de hoy no la tapa.
    expect(screen.getByText(/datos hasta el/).textContent).toBe("datos hasta el 15 sep · API");
    expect(screen.getByText("CSV exportado el 22 sep")).toBeInTheDocument();
  });

  it("dice una vez, con palabras de creador, hasta dónde llegan las cifras; sin «UTC»", () => {
    render(<FrescuraLista filas={[base, { ...base, connectionId: "x2", handle: "otra" }]} f={f} />);
    expect(screen.getAllByText("Las cifras llegan hasta el final del día anterior.")).toHaveLength(1);
    expect(screen.queryByText(/UTC/)).not.toBeInTheDocument();
  });

  it("sin ninguna lectura, lo dice", () => {
    render(<FrescuraLista filas={[{ ...base, lastCsvDay: null, lastCsvExportAt: null, dataUntil: null, daysBehind: null }]} f={f} />);
    expect(screen.getByText("Sin lecturas todavía")).toBeInTheDocument();
  });

  it("una conexión que no está sana lo dice con una pastilla, no solo con una fecha vieja", () => {
    render(<FrescuraLista filas={[{ ...base, status: "revoked" }, { ...base, connectionId: "x2", handle: "otra", status: "error" }]} f={f} />);
    expect(screen.getByText("Acceso revocado")).toBeInTheDocument();
    expect(screen.getByText("Con error")).toBeInTheDocument();
  });

  it("una sana y al día no lleva ninguna pastilla", () => {
    render(<FrescuraLista filas={[{ ...base, daysBehind: 2 }]} f={f} />);
    const tarjeta = screen.getByText("@revisor.csv").closest("li")!;
    expect(within(tarjeta).queryByText(/por detrás|Con error|Permiso/)).not.toBeInTheDocument();
  });

  it("la que va más de dos días por detrás del resto se señala, con los días", () => {
    render(<FrescuraLista filas={[{ ...base, daysBehind: 12 }]} f={f} />);
    expect(screen.getByText("12 días por detrás")).toBeInTheDocument();
  });

  it("con una sola conexión no hay celdas pintadas de gris: cada tarjeta lleva su borde", () => {
    render(<FrescuraLista filas={[base]} f={f} />);
    const lista = screen.getByText("@revisor.csv").closest("ul")!;
    expect(lista.className).not.toMatch(/bg-border/);
    expect(screen.getByText("@revisor.csv").closest("li")!.className).toMatch(/border/);
  });

  it("respeta el filtro por red: se lo pasa a la consulta", async () => {
    consultas.getFreshnessByConnection.mockResolvedValue([]);
    await Frescura({ filtro: { days: 30, platform: "tiktok" } });
    expect(consultas.getFreshnessByConnection).toHaveBeenCalledWith({}, { platform: "tiktok" });
  });
});
