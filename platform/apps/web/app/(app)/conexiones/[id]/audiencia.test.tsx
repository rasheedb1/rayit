import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AccountAudience } from "@mc/db";
import { formatterFor } from "@/lib/format";
import { MESSAGES } from "../_lib/messages";
import { Audiencia, barrasDe, etiquetaDeTramo } from "./audiencia";

const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "UTC" });
const t = MESSAGES.ficha.audiencia;

/** Lo que dejó el worker el 5-oct para @nicolasduartea (cifras reales, redondeadas). */
const AUDIENCIA: AccountAudience = {
  connectionId: "00000002-0000-4000-8000-0000000000a1",
  platformId: "instagram",
  handle: "nicolasduartea",
  day: "2026-10-05",
  dimensions: [
    {
      population: "followers", dimension: "city", day: "2026-10-05",
      buckets: [
        ["Bogotá, Distrito Especial", 986], ["Medellín, Antioquia", 78], ["Mexico City, Distrito Federal", 66], ["Madrid, Comunidad de Madrid", 59],
        ["Santiago de Cali, Valle del Cauca", 50], ["New York, New York", 47], ["Barranquilla, Atlantico", 24], ["Miami, Florida", 23],
        ["Chía, Cundinamarca", 21], ["London, England", 20], ["Barcelona, Cataluña", 19], ["Rionegro, Antioquia", 15],
      ].map(([bucket, absolute]) => ({ bucket: bucket as string, absolute: absolute as number, share: null })),
    },
    {
      population: "followers", dimension: "age", day: "2026-10-05",
      buckets: [["13-17", 3], ["18-24", 71], ["25-34", 1368], ["35-44", 402], ["45-54", 102], ["55-64", 66], ["65+", 19]]
        .map(([bucket, absolute]) => ({ bucket: bucket as string, absolute: absolute as number, share: null })),
    },
    { population: "followers", dimension: "gender", day: "2026-10-04", buckets: [{ bucket: "F", absolute: 1210, share: null }, { bucket: "M", absolute: 790, share: null }, { bucket: "U", absolute: 31, share: null }] },
    { population: "viewers", dimension: "country", day: "2026-10-05", buckets: [{ bucket: "CO", absolute: null, share: 0.71 }, { bucket: "MX", absolute: null, share: 0.09 }] },
  ],
  gaps: [],
};

describe("etiquetas de los tramos", () => {
  it("género por su palabra, país por su nombre, ciudad sin la región, edad tal cual", () => {
    expect(etiquetaDeTramo("gender", "F", f)).toBe("Mujeres");
    expect(etiquetaDeTramo("gender", "male", f)).toBe("Hombres");
    expect(etiquetaDeTramo("country", "CO", f)).toBe("Colombia");
    expect(etiquetaDeTramo("city", "Bogotá, Distrito Especial", f)).toBe("Bogotá");
    expect(etiquetaDeTramo("age", "25-34", f)).toBe("25-34");
    expect(etiquetaDeTramo("age_gender", "25-34|F", f)).toBe("25-34 · Mujeres");
  });
});

describe("las barras de una dimensión", () => {
  it("en personas cuando la red dio absolutos, en porcentaje cuando solo dio proporciones, y a lo sumo diez barras", () => {
    const ciudad = barrasDe(AUDIENCIA.dimensions[0]!, f);
    expect(ciudad.format).toBe("int");
    expect(ciudad.cats).toHaveLength(10);
    expect(ciudad.cats[0]).toBe("Bogotá");
    expect(ciudad.data[0]).toBe(986);
    expect(ciudad.fuera).toBe(2);

    const pais = barrasDe(AUDIENCIA.dimensions[3]!, f);
    expect(pais.format).toBe("pct");
    expect(pais.data).toEqual([0.71, 0.09]);
    expect(pais.fuera).toBe(0);
  });
});

describe("la sección de audiencia", () => {
  it("una tarjeta por dimensión, en el orden quién → dónde, con su «datos hasta» y cuántos tramos quedaron fuera", () => {
    render(<Audiencia audiencia={AUDIENCIA} autorizada f={f} />);
    const seccion = screen.getByRole("region", { name: t.titulo });
    const titulos = within(seccion).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titulos.map((x) => x?.split(" ·")[0])).toEqual(["Edad", "Género", "País", "Ciudad"]);
    expect(within(seccion).getByText(t.masDe(2))).toBeInTheDocument();
    // Edad y género suman las mismas 2.031 personas; el país va en porcentaje y no suma.
    expect(within(seccion).getAllByText(new RegExp(t.personas(f.int(2031))))).toHaveLength(2);
    // La fecha de la sección es la más reciente; la del género, la suya.
    expect(screen.getByText(t.subtitulo(f.date("2026-10-05")))).toBeInTheDocument();
    expect(within(seccion).getAllByRole("img", { name: /de la audiencia/ })).toHaveLength(4);
  });

  it("sin dimensiones explica por qué, distinto para una autorizada y una por @", () => {
    const vacia: AccountAudience = { ...AUDIENCIA, day: null, dimensions: [] };
    const { unmount } = render(<Audiencia audiencia={vacia} autorizada f={f} />);
    expect(screen.getByText(t.vacioAutorizada)).toBeInTheDocument();
    unmount();
    render(<Audiencia audiencia={vacia} autorizada={false} f={f} />);
    expect(screen.getByText(t.vacioPorArroba)).toBeInTheDocument();
  });

  it("los huecos de la red van con su frase y su enlace", () => {
    const conHueco: AccountAudience = {
      ...AUDIENCIA, dimensions: [],
      gaps: [{ metricGroup: "demografia_de_cuenta", requirementId: "ig.min_followers", requirement: "min_followers_100", messageEs: "Instagram entrega la audiencia a partir de 100 seguidores.", fixUrl: "https://help.instagram.com/", day: "2026-10-05", detectedAt: "2026-10-05T05:20:00Z" }],
    };
    render(<Audiencia audiencia={conHueco} autorizada f={f} />);
    expect(screen.getByText(/a partir de 100 seguidores/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: MESSAGES.tabla.comoArreglarlo })).toHaveAttribute("href", "https://help.instagram.com/");
  });
});
