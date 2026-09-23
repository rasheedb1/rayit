import { describe, expect, it } from "vitest";
import { proyectarGastos } from "@mc/core";
import type { ExpenseRow } from "@mc/db/queries/finanzas";
import { formatterFor } from "@/lib/format";
import { barrasProyeccion, categoriasVista, gastoVista, mesesVecinos } from "./vista";

/**
 * Lo que la pantalla convierte, sin base y sin React: el mes vecino de la
 * navegación, el concepto que se lee en la tabla y las barras que recibe
 * el gráfico. El formateador es el del espacio del seed.
 */
const f = formatterFor({ currency: "COP", locale: "es-CO", timezone: "America/Bogota" });
const TEXTOS = { sinProveedor: "Sin proveedor", sinDescripcion: "Sin descripción" };

function fila(over: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    id: "00000003-0000-4000-8000-0009a5090001",
    category: "edicion",
    vendor: "Mateo R. (freelance)",
    description: "Edición de video · septiembre",
    amount: "1800000.00",
    currency: "COP",
    incurredOn: "2026-09-01",
    isRecurring: true,
    recurrence: "monthly",
    receiptUrl: null,
    deductible: true,
    createdAt: "2026-09-01T00:00:00Z",
    ...over,
  };
}

describe("mesesVecinos", () => {
  it("el anterior y el siguiente, cruzando el año", () => {
    expect(mesesVecinos("2026-09")).toEqual({ anterior: "2026-08", siguiente: "2026-10" });
    expect(mesesVecinos("2026-01")).toEqual({ anterior: "2025-12", siguiente: "2026-02" });
    expect(mesesVecinos("2026-12")).toEqual({ anterior: "2026-11", siguiente: "2027-01" });
  });
});

describe("gastoVista", () => {
  it("formatea con el formateador del espacio y traduce la categoría", () => {
    const v = gastoVista(fila(), f, TEXTOS);
    expect(v.categoria).toBe("Edición");
    expect(v.monto).toBe("COP 1.800.000");
    expect(v.fecha).toBe("1 sep");
    expect(v.recurrencia).toBe("Cada mes");
    expect(v.recurrente).toBe(true);
  });

  it("una categoría que no está en la lista se muestra tal cual, no se pierde", () => {
    expect(gastoVista(fila({ category: "importada" }), f, TEXTOS).categoria).toBe("importada");
  });

  it("sin descripción, el concepto es el proveedor; sin ninguno de los dos, la categoría, y se pinta apagado", () => {
    const soloProveedor = gastoVista(fila({ description: null }), f, TEXTOS);
    expect(soloProveedor.concepto).toBe("Mateo R. (freelance)");
    expect(soloProveedor.conceptoEsRelleno).toBe(false);

    const ninguno = gastoVista(fila({ description: "   ", vendor: null }), f, TEXTOS);
    expect(ninguno.concepto).toBe("Edición");
    expect(ninguno.conceptoEsRelleno).toBe(true);
    // Ausencia con frase, nunca un guion mudo ni un vacío.
    expect(ninguno.proveedor).toBe("Sin proveedor");
    expect(ninguno.sinProveedor).toBe(true);
  });

  it("lo deducible viaja al formulario: corregir un gasto no deducible no lo vuelve deducible", () => {
    expect(gastoVista(fila({ deductible: false }), f, TEXTOS).crudo.deductible).toBe(false);
    expect(gastoVista(fila({ deductible: true }), f, TEXTOS).crudo.deductible).toBe(true);
  });

  it("un puntual no dice una recurrencia que no tiene", () => {
    const v = gastoVista(fila({ isRecurring: false, recurrence: null }), f, TEXTOS);
    expect(v.recurrencia).toBeNull();
    expect(v.crudo.recurrence).toBe("");
  });

  it("lo crudo vuelve al formulario tal como está en la base", () => {
    const v = gastoVista(fila({ receiptUrl: "https://drive.example.com/r" }), f, TEXTOS);
    expect(v.crudo).toEqual({
      category: "edicion",
      vendor: "Mateo R. (freelance)",
      description: "Edición de video · septiembre",
      amount: "1800000.00",
      incurredOn: "2026-09-01",
      isRecurring: true,
      recurrence: "monthly",
      deductible: true,
      receiptUrl: "https://drive.example.com/r",
    });
  });
});

describe("categoriasVista", () => {
  it("etiqueta en español y monto en la moneda del espacio", () => {
    expect(categoriasVista([{ category: "software", total: "380000.00", count: 2 }], "COP", f)).toEqual([
      { category: "software", label: "Software y suscripciones", total: "COP 380.000", count: 2 },
    ]);
  });

  it("sin filas no inventa un cero", () => {
    expect(categoriasVista([], "COP", f)).toEqual([]);
  });
});

describe("barrasProyeccion", () => {
  const gastos = [
    { id: "a", label: "Edición", amount: "1800000.00", currency: "COP", incurredOn: "2026-08-01", serie: "edicion|mateo" },
  ];
  const input = (g: typeof gastos) => ({ today: "2026-09-23", currency: "COP", gastos: g });

  it("ocho barras, la etiqueta corta bajo la barra y el rango entero en el tooltip", () => {
    const b = barrasProyeccion(proyectarGastos(input(gastos)), f);
    expect(b.cats).toHaveLength(8);
    expect(b.axisLabels).toHaveLength(8);
    expect(b.data).toHaveLength(8);
    expect(b.axisLabels[0]).toBe("21/9");
    expect(b.cats[0]).toContain("21");
    expect(b.cats[0]).toContain("27/9");
    // Cada barra es el ritmo semanal de core (1,8 M × 12 / 52), el mismo del flujo.
    expect(b.data.every((v) => v === 415384.62)).toBe(true);
  });

  it("sin nada que proyectar, ocho barras en cero: la página lo explica con su estado vacío", () => {
    const b = barrasProyeccion(proyectarGastos(input([])), f);
    expect(b.data).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});
