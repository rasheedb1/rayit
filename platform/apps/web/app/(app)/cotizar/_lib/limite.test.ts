import { describe, expect, it } from "vitest";
import { LimiteDeIntentos } from "./limite";

describe("LimiteDeIntentos", () => {
  it("deja pasar hasta el máximo por ventana y vuelve a abrir cuando la ventana pasa", () => {
    let ahora = 1_000;
    const limite = new LimiteDeIntentos(3, 60_000, () => ahora);
    expect([1, 2, 3, 4].map(() => limite.permitir("kit|1.2.3.4"))).toEqual([true, true, true, false]);
    // Otra IP, u otro enlace, tienen su propia cuenta.
    expect(limite.permitir("kit|5.6.7.8")).toBe(true);
    ahora += 60_001;
    expect(limite.permitir("kit|1.2.3.4")).toBe(true);
  });
});
