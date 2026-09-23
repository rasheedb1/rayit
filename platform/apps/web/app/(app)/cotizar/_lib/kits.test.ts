import { describe, expect, it } from "vitest";
import type { MediaKitAdjuntable } from "@mc/db/queries/cotizar";
import { mediaKitPorDefecto } from "./kits";

const kit = (id: string, hasPassword: boolean): MediaKitAdjuntable => ({
  id, slug: `kit-${id}`, createdAt: "2026-09-20T15:00:00Z", hasPassword, expiresAt: null,
});

describe("mediaKitPorDefecto", () => {
  it("elige el más reciente sin contraseña, aunque haya uno más nuevo con ella", () => {
    expect(mediaKitPorDefecto([kit("nuevo", true), kit("medio", false), kit("viejo", false)])).toBe("medio");
  });

  it("si todos piden contraseña, o no hay ninguno, no preselecciona nada", () => {
    expect(mediaKitPorDefecto([kit("a", true), kit("b", true)])).toBe("");
    expect(mediaKitPorDefecto([])).toBe("");
  });
});
