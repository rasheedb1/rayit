// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aMonto, aPeriodo, analizar, detectarFormato, revisar, ultimoDiaDelMes, ErrorCsv } from "./csv";

const PLATAFORMAS = ["tiktok", "instagram", "facebook", "youtube"];
const OPTS = { currency: "COP", plataformas: PLATAFORMAS };

const fixture = (nombre: string) =>
  readFileSync(join(__dirname, "../../../../../test/fixtures/csv/ingresos", nombre));

const leer = (nombre: string, opts = OPTS) => {
  const { tabla, deteccion, codificacion } = analizar(fixture(nombre));
  return { ...revisar(tabla, deteccion, opts), deteccion, codificacion };
};

describe("periodos: columnas date, sin zona horaria", () => {
  it("lee el mes entero en las formas que escriben las plataformas", () => {
    expect(aPeriodo("2026-09")).toEqual({ inicio: "2026-09-01", fin: "2026-09-30", granularidad: "mes" });
    expect(aPeriodo("09/2026")).toEqual({ inicio: "2026-09-01", fin: "2026-09-30", granularidad: "mes" });
    expect(aPeriodo("2026/09")).toEqual({ inicio: "2026-09-01", fin: "2026-09-30", granularidad: "mes" });
    expect(aPeriodo("septiembre de 2026")?.inicio).toBe("2026-09-01");
    expect(aPeriodo("Sep 2026")?.fin).toBe("2026-09-30");
    expect(aPeriodo("sept 2026")?.fin).toBe("2026-09-30");
  });

  it("un día es un día, y su granularidad lo dice", () => {
    expect(aPeriodo("2026-08-15")).toEqual({ inicio: "2026-08-15", fin: "2026-08-15", granularidad: "dia" });
  });

  it("el último día de febrero conoce los años bisiestos", () => {
    expect(ultimoDiaDelMes(2024, 2)).toBe(29);
    expect(ultimoDiaDelMes(2026, 2)).toBe(28);
    expect(ultimoDiaDelMes(2100, 2)).toBe(28);
    expect(ultimoDiaDelMes(2000, 2)).toBe(29);
    expect(aPeriodo("2024-02")?.fin).toBe("2024-02-29");
  });

  it("no adivina el orden día/mes ni acepta fechas imposibles", () => {
    expect(aPeriodo("09/10/2026")).toBeNull();
    expect(aPeriodo("2026-02-30")).toBeNull();
    expect(aPeriodo("2026-13")).toBeNull();
    expect(aPeriodo("el mes pasado")).toBeNull();
    expect(aPeriodo("")).toBeNull();
  });
});

describe("montos: string decimal, nunca double", () => {
  it("lee los separadores de cualquier hoja de cálculo", () => {
    expect(aMonto("1.234.567,89")?.monto).toBe("1234567.89");
    expect(aMonto("1,234,567.89")?.monto).toBe("1234567.89");
    expect(aMonto("900000")?.monto).toBe("900000.00");
    expect(aMonto("$ 480.000,00")?.monto).toBe("480000.00");
    expect(aMonto(",5")?.monto).toBe("0.50");
  });

  it("saca el código de moneda que venga pegado a la celda", () => {
    expect(aMonto("USD 210.40")).toEqual({ monto: "210.40", moneda: "USD" });
    expect(aMonto("415250,75 COP")).toEqual({ monto: "415250.75", moneda: "COP" });
    expect(aMonto("900.000,00")?.moneda).toBeNull();
  });

  it("un céntimo no se pierde por el camino de un double", () => {
    // 0,07 y 0,01 en double suman 0,08000000000000002.
    expect(aMonto("9007199254740993")?.monto).toBe("9007199254740993.00");
    expect(aMonto("no fue nada")).toBeNull();
    expect(aMonto("")).toBeNull();
  });
});

describe("detección por cabecera", () => {
  it("reconoce AdSense por la columna de ingresos estimados y su moneda entre paréntesis", () => {
    const d = detectarFormato(["Month", "Page views", "Impressions", "Page RPM (COP)", "Estimated earnings (COP)"]);
    expect(d.formato).toBe("adsense");
    expect(d.columnas.periodo).toBe("Month");
    expect(d.columnas.monto).toBe("Estimated earnings (COP)");
    expect(d.monedaDelEncabezado).toBe("COP");
  });

  it("«Page RPM» no se confunde con el monto aunque también lleve moneda", () => {
    expect(detectarFormato(["Month", "Page RPM (COP)"]).formato).toBeNull();
  });

  it("reconoce Creator Rewards por «recompensas»", () => {
    const d = detectarFormato(["Mes", "Vistas cualificadas", "Recompensas estimadas", "Moneda"]);
    expect(d.formato).toBe("tiktok_rewards");
    expect(d.columnas.moneda).toBe("Moneda");
  });

  it("con columna de plataforma es el genérico, aunque el monto se llame «ingresos»", () => {
    expect(detectarFormato(["plataforma", "inicio", "fin", "monto", "moneda"]).formato).toBe("generico");
    expect(detectarFormato(["Red", "Inicio", "Fin", "Ingresos"]).formato).toBe("generico");
  });

  it("«Fecha fin» no se queda con el papel de periodo", () => {
    const d = detectarFormato(["Plataforma", "Fecha inicio", "Fecha fin", "Monto"]);
    expect(d.columnas.inicio).toBe("Fecha inicio");
    expect(d.columnas.fin).toBe("Fecha fin");
  });

  it("sin periodo o sin monto no hay formato", () => {
    expect(detectarFormato(["Referencia", "Cantidad", "Observacion"]).formato).toBeNull();
    expect(detectarFormato(["Mes"]).formato).toBeNull();
  });
});

describe("los fixtures, uno por formato", () => {
  it("AdSense mensual: tres meses en youtube, con los decimales intactos", () => {
    const r = leer("adsense-mensual.csv");
    expect(r.formato).toBe("adsense");
    expect(r.listas).toEqual([
      { platformId: "youtube", creatorId: null, periodStart: "2026-08-01", periodEnd: "2026-08-31", amount: "1101500.50", currency: "COP", source: "csv_import" },
      { platformId: "youtube", creatorId: null, periodStart: "2026-07-01", periodEnd: "2026-07-31", amount: "770000.00", currency: "COP", source: "csv_import" },
      { platformId: "youtube", creatorId: null, periodStart: "2026-06-01", periodEnd: "2026-06-30", amount: "900000.00", currency: "COP", source: "csv_import" },
    ]);
    expect(r.problemas).toEqual([]);
    expect(r.monedaSupuesta).toBe(false);
  });

  it("AdSense diario: las filas de un mes se suman en su mes, y la de totales se descarta", () => {
    const r = leer("adsense-diario.csv");
    expect(r.formato).toBe("adsense");
    // Tres filas cayeron en un grupo que ya existía: dos de agosto y una de septiembre.
    expect(r.filasAgrupadas).toBe(3);
    expect(r.listas).toEqual([
      { platformId: "youtube", creatorId: null, periodStart: "2026-09-01", periodEnd: "2026-09-30", amount: "61250.25", currency: "COP", source: "csv_import" },
      { platformId: "youtube", creatorId: null, periodStart: "2026-08-01", periodEnd: "2026-08-31", amount: "110835.50", currency: "COP", source: "csv_import" },
    ]);
    expect(r.problemas.map((p) => p.codigo)).toEqual(["filaTotal"]);
  });

  it("Creator Rewards: punto y coma, meses en español y columna de moneda", () => {
    const r = leer("tiktok-creator-rewards.csv");
    expect(r.formato).toBe("tiktok_rewards");
    expect(r.listas.map((l) => [l.platformId, l.periodStart, l.amount])).toEqual([
      ["tiktok", "2026-09-01", "480000.00"],
      ["tiktok", "2026-08-01", "415250.75"],
      ["tiktok", "2026-07-01", "372000.00"],
    ]);
    expect(r.listas.every((l) => l.periodEnd === `${l.periodStart.slice(0, 7)}-${l.periodStart.slice(0, 7) === "2026-09" ? "30" : "31"}`)).toBe(true);
    expect(r.problemas).toEqual([]);
  });

  it("genérico: cada fila trae su red y su periodo exacto, sin agrupar", () => {
    const r = leer("ingresos-generico.csv");
    expect(r.formato).toBe("generico");
    expect(r.filasAgrupadas).toBe(0);
    expect(r.listas.map((l) => l.platformId).sort()).toEqual(["instagram", "tiktok", "youtube"]);
    expect(r.listas.find((l) => l.platformId === "tiktok")).toMatchObject({
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      amount: "372000.00",
    });
  });

  it("moneda distinta: fuera, con su aviso, y lo que sí es del espacio entra", () => {
    const r = leer("moneda-distinta.csv");
    expect(r.listas).toHaveLength(1);
    expect(r.listas[0]).toMatchObject({ platformId: "tiktok", currency: "COP" });
    expect(r.problemas.filter((p) => p.codigo === "monedaDistinta").map((p) => p.valor)).toEqual(["USD", "EUR"]);
    expect(r.problemas.every((p) => p.gravedad === "aviso")).toBe(true);
  });

  it("sucio: cada fila mala sale con su código y su número de fila, y las buenas entran", () => {
    const r = leer("sucio.csv");
    expect(r.problemas).toEqual([
      { fila: 1, gravedad: "error", codigo: "periodoIlegible", valor: "el mes pasado" },
      { fila: 2, gravedad: "error", codigo: "montoIlegible", valor: "no fue nada" },
      { fila: 3, gravedad: "error", codigo: "montoNegativo", valor: "-120.000,00" },
      { fila: 4, gravedad: "error", codigo: "sinPeriodo" },
      { fila: 5, gravedad: "error", codigo: "sinMonto" },
      { fila: 6, gravedad: "aviso", codigo: "montoCero", valor: "2026-05" },
    ]);
    expect(r.listas).toEqual([
      { platformId: "youtube", creatorId: null, periodStart: "2026-06-01", periodEnd: "2026-06-30", amount: "812400.00", currency: "COP", source: "csv_import" },
    ]);
  });

  it("desconocido: no hay formato y no se escribe nada", () => {
    const r = leer("desconocido.csv");
    expect(r.formato).toBeNull();
    expect(r.listas).toEqual([]);
  });
});

describe("la moneda cuando el archivo no la dice", () => {
  it("se toma la del espacio y queda marcado para que la pantalla lo avise", () => {
    const { tabla, deteccion } = analizar(Buffer.from("Mes,Recompensas\n2026-08,415250.75\n", "utf8"));
    const r = revisar(tabla, deteccion, OPTS);
    expect(r.monedaSupuesta).toBe(true);
    expect(r.listas[0]?.currency).toBe("COP");
  });

  it("con un espacio en otra moneda, el mismo archivo entra en la suya", () => {
    const { tabla, deteccion } = analizar(Buffer.from("Mes,Recompensas\n2026-08,210.40\n", "utf8"));
    const r = revisar(tabla, deteccion, { currency: "MXN", plataformas: PLATAFORMAS });
    expect(r.listas[0]?.currency).toBe("MXN");
  });
});

describe("archivos que no se pueden ni empezar a revisar", () => {
  it("vacío, sin encabezados y demasiado largo lanzan ErrorCsv con su código", () => {
    expect(() => analizar(Buffer.from("", "utf8"))).toThrow(ErrorCsv);
    const largo = ["Mes,Monto", ...Array.from({ length: 1001 }, (_, i) => `2026-${String((i % 12) + 1).padStart(2, "0")},1`)].join("\n");
    try {
      analizar(Buffer.from(largo, "utf8"));
      expect.unreachable("tenía que lanzar");
    } catch (err) {
      expect(err).toBeInstanceOf(ErrorCsv);
      expect((err as ErrorCsv).codigo).toBe("demasiadasFilas");
    }
  });

  it("un CSV guardado con Excel para Windows se lee sin romper las tildes", () => {
    // «Recompensas estimadas (últimos meses)» guardado en Windows-1252:
    // la «u» con tilde es el byte 0xFA, que no forma UTF-8 válido. Leído
    // a la fuerza como UTF-8 saldría «\uFFFD» y el alias no casaría.
    const bytes = Buffer.from(
      "Mes;Vistas del último mes;Recompensas estimadas\r\n2026-08;2.115.400;415.250,75\r\n",
      "latin1",
    );
    expect(bytes.includes(0xfa)).toBe(true);
    const { codificacion, tabla, deteccion } = analizar(bytes);
    expect(codificacion).toBe("windows-1252");
    expect(tabla.encabezados[1]).toBe("Vistas del último mes");
    expect(deteccion.formato).toBe("tiktok_rewards");
    expect(revisar(tabla, deteccion, OPTS).listas[0]?.amount).toBe("415250.75");
  });
});

describe("una red desconocida no se inventa", () => {
  it("la fila queda fuera con su código", () => {
    const { tabla, deteccion } = analizar(Buffer.from("plataforma,inicio,monto\ntwitch,2026-08-01,100000\n", "utf8"));
    const r = revisar(tabla, deteccion, OPTS);
    expect(r.listas).toEqual([]);
    expect(r.problemas).toEqual([{ fila: 1, gravedad: "error", codigo: "plataformaDesconocida", valor: "twitch" }]);
  });

  it("los nombres que escribe la gente se traducen al id del catálogo", () => {
    const { tabla, deteccion } = analizar(
      Buffer.from("plataforma,inicio,monto\nAdSense,2026-08-01,100000\nTik Tok,2026-08-01,50000\nIG,2026-08-01,25000\n", "utf8"),
    );
    const r = revisar(tabla, deteccion, OPTS);
    expect(r.listas.map((l) => l.platformId).sort()).toEqual(["instagram", "tiktok", "youtube"]);
  });
});

describe("un periodo que todavía no ha cerrado no es un pago", () => {
  const conHoy = (texto: string, hoy: string) => {
    const { tabla, deteccion } = analizar(Buffer.from(texto, "utf8"));
    return revisar(tabla, deteccion, { ...OPTS, hoy });
  };

  it("el mes en curso queda fuera, con su aviso y su frase", () => {
    const r = conHoy("Mes,Recompensas\n2026-08,415250.75\n2026-09,200000.00\n", "2026-09-23");
    expect(r.listas.map((l) => l.periodStart)).toEqual(["2026-08-01"]);
    expect(r.problemas).toEqual([{ fila: 2, gravedad: "aviso", codigo: "periodoNoCerrado", valor: "2026-09" }]);
  });

  it("el último día del mes todavía cuenta como abierto; el día siguiente ya no", () => {
    expect(conHoy("Mes,Recompensas\n2026-09,200000.00\n", "2026-09-29").listas).toHaveLength(0);
    expect(conHoy("Mes,Recompensas\n2026-09,200000.00\n", "2026-09-30").listas).toHaveLength(1);
  });

  it("sin `hoy` no se filtra nada: el lector sigue siendo puro", () => {
    const { tabla, deteccion } = analizar(Buffer.from("Mes,Recompensas\n2026-09,200000.00\n", "utf8"));
    expect(revisar(tabla, deteccion, OPTS).listas).toHaveLength(1);
  });

  it("las filas diarias se suman ANTES de mirar si el mes cerró", () => {
    // Tres días de septiembre con hoy dentro del mes: el mes entero
    // queda fuera de una vez, no tres avisos por tres días.
    const r = conHoy(
      "Fecha,Ingresos estimados\n2026-09-01,100\n2026-09-02,100\n2026-09-03,100\n",
      "2026-09-23",
    );
    expect(r.listas).toHaveLength(0);
    expect(r.problemas.filter((p) => p.codigo === "periodoNoCerrado")).toHaveLength(1);
  });
});

describe("un año imposible no revienta el lector", () => {
  it("una fila diaria con un año fuera de rango sale como periodo ilegible", () => {
    // El regex de ISO acepta 0001-01-15; la subida al mes no. Antes
    // lanzaba un TypeError que salía sin frase por la Server Action.
    const { tabla, deteccion } = analizar(Buffer.from("Fecha,Ingresos estimados\n0001-01-15,100000\n", "utf8"));
    const r = revisar(tabla, deteccion, OPTS);
    expect(r.listas).toEqual([]);
    expect(r.problemas).toEqual([
      { fila: 1, gravedad: "error", codigo: "periodoIlegible", valor: "0001-01-15" },
    ]);
  });

  it("aPeriodo lo rechaza en la rama del día, no solo en la del mes", () => {
    expect(aPeriodo("0001-01-15")).toBeNull();
    expect(aPeriodo("1969-12-31")).toBeNull();
    expect(aPeriodo("1970-01-01")).not.toBeNull();
  });
});
