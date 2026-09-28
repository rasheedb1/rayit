import { describe, expect, test } from "vitest";
import { FrenoDeFallos } from "./freno";

describe("FrenoDeFallos (reporte público, CAM-6)", () => {
  test("se agota al llegar al tope de fallos y se vacía al pasar la ventana", () => {
    let ahora = 1_000;
    const f = new FrenoDeFallos(3, 60_000, () => ahora);
    expect(f.agotado("ip")).toBe(false);
    f.fallo("ip");
    f.fallo("ip");
    expect(f.agotado("ip")).toBe(false);
    f.fallo("ip");
    expect(f.agotado("ip")).toBe(true);
    expect(f.agotado("otra-ip")).toBe(false);
    ahora += 60_000;
    expect(f.agotado("ip")).toBe(false);
  });

  test("mirar no cuenta: consultar mil veces no agota", () => {
    const f = new FrenoDeFallos(1, 60_000, () => 0);
    for (let i = 0; i < 1_000; i++) expect(f.agotado("marca")).toBe(false);
  });
});
