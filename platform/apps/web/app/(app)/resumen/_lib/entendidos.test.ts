import { describe, expect, it } from "vitest";
import { MAX_HIDDEN } from "@mc/db/queries/resumen-semana";
import { conEntendido, escribirEntendidos, leerEntendidos, sinEntendido } from "./entendidos";

/** RES-3 · la cookie del «Entendido» sin sesión: llega del navegador, así que se lee con desconfianza. */

const id = (i: number) => `0000000c-0000-4000-8000-${String(i).padStart(12, "0")}`;

describe("la cookie de los avisos entendidos en la demo", () => {
  it("solo lee uuids, sin repetir, en minúsculas", () => {
    expect(leerEntendidos(undefined)).toEqual([]);
    expect(leerEntendidos("")).toEqual([]);
    expect(leerEntendidos(`${id(1)}.basura.${id(1).toUpperCase()}.' OR 1=1.${id(2)}`)).toEqual([id(1), id(2)]);
  });

  it("guarda como mucho MAX_HIDDEN: al añadir, sale el más viejo", () => {
    let ids: string[] = [];
    for (let i = 0; i < MAX_HIDDEN + 3; i++) ids = conEntendido(ids, id(i));
    expect(ids).toHaveLength(MAX_HIDDEN);
    expect(ids[0]).toBe(id(3));
    expect(ids.at(-1)).toBe(id(MAX_HIDDEN + 2));
    const largo = escribirEntendidos(Array.from({ length: MAX_HIDDEN + 10 }, (_, i) => id(i)));
    expect(leerEntendidos(largo)).toHaveLength(MAX_HIDDEN);
  });

  it("entender dos veces no repite; deshacer lo quita", () => {
    const ids = conEntendido(conEntendido([], id(1)), id(1));
    expect(ids).toEqual([id(1)]);
    expect(sinEntendido(ids, id(1))).toEqual([]);
    expect(escribirEntendidos(conEntendido(ids, id(2)))).toBe(`${id(1)}.${id(2)}`);
  });
});
