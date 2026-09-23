import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BarChart } from "@/components/ui/bar-chart";
import { etiquetasDelEje } from "./eje";

/**
 * Las etiquetas del gráfico semanal, contra el BarChart DE VERDAD: si el
 * kit cambia su regla de etiquetado, esto falla aquí y no a 400 px en
 * producción.
 */

/** Los índices de las barras que el BarChart deja con una etiqueta visible. */
function etiquetadas(n: number): number[] {
  const nombres = Array.from({ length: n }, (_, i) => `${i + 1}/9`);
  const { container, unmount } = render(
    <BarChart
      cats={nombres.map((x) => `semana ${x}`)}
      axisLabels={etiquetasDelEje(nombres)}
      series={[{ name: "TikTok", data: nombres.map(() => 10) }]}
      ariaLabel="prueba"
    />,
  );
  // Las del eje x van abajo (y = alto − 8); las del eje y, a la izquierda.
  const abajo = [...container.querySelectorAll("svg text")].filter((t) => t.getAttribute("y") === String(260 - 8));
  const visibles = abajo.map((t) => t.textContent ?? "").filter((t) => t.length > 0);
  unmount();
  return visibles.map((t) => nombres.indexOf(t));
}

describe("las etiquetas del gráfico semanal", () => {
  it("con doce semanas se ven 0, 2, 4, 6, 8 y la última: la 10 no se pisa con la 11", () => {
    expect(etiquetadas(12)).toEqual([0, 2, 4, 6, 8, 11]);
  });

  it("con cualquier número de semanas, ninguna etiqueta visible queda pegada a otra, y la última siempre se ve", () => {
    for (let n = 1; n <= 16; n++) {
      const i = etiquetadas(n);
      expect(i.at(-1), `con ${n} barras falta la última`).toBe(n - 1);
      expect(i[0], `con ${n} barras falta la primera`).toBe(0);
      if (n > 8) {
        for (let k = 1; k < i.length; k++) expect(i[k]! - i[k - 1]!, `con ${n} barras se pisan ${i[k - 1]} y ${i[k]}`).toBeGreaterThan(1);
      }
    }
  });

  it("con ocho o menos no quita ninguna: caben todas", () => {
    expect(etiquetasDelEje(["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(etiquetasDelEje([])).toEqual([]);
  });
});
