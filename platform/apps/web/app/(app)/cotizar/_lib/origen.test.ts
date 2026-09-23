import { describe, expect, it } from "vitest";
import { origenDeLaPeticion, SIN_ORIGEN } from "./origen";

describe("origenDeLaPeticion", () => {
  it("toma la primera IP de x-forwarded-for, la del visitante", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1", "x-real-ip": "10.0.0.1" });
    expect(origenDeLaPeticion(h)).toBe("203.0.113.7");
  });

  it("sin x-forwarded-for, usa x-real-ip", () => {
    expect(origenDeLaPeticion(new Headers({ "x-real-ip": " 198.51.100.4 " }))).toBe("198.51.100.4");
  });

  it("sin ninguna de las dos, todos comparten un origen", () => {
    expect(origenDeLaPeticion(new Headers())).toBe(SIN_ORIGEN);
    expect(origenDeLaPeticion(new Headers({ "x-forwarded-for": " , " }))).toBe(SIN_ORIGEN);
  });

  it("una cabecera enorme no viaja entera a la base", () => {
    expect(origenDeLaPeticion(new Headers({ "x-forwarded-for": "a".repeat(500) }))).toHaveLength(64);
  });
});
