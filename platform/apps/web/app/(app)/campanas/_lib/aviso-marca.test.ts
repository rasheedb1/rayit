import { describe, expect, it } from "vitest";
import { leerAvisoMarca, queryDeMarca } from "./aviso-marca";

describe("el resultado de «Actualizar ahora» en la URL", () => {
  it("ida y vuelta: códigos en la URL, frases en la página", () => {
    const q = queryDeMarca({ ok: true, resultado: "guardada", avisos: [{ code: "transitorio", platformId: "youtube" }] });
    expect(q).toBe("marca=guardada&aviso=transitorio.youtube");
    const p = new URLSearchParams(q);
    expect(leerAvisoMarca(p.get("marca") ?? undefined, p.get("aviso") ?? undefined)).toEqual({
      resultado: "guardada",
      mensajes: ["YouTube no respondió; inténtalo de nuevo en unos minutos."],
    });
  });

  it("un error con avisos: la frase del error primero; sin credencial no nombra la variable", () => {
    const q = queryDeMarca({ ok: false, code: "lectura", avisos: [{ code: "sin_credencial", platformId: "instagram" }] });
    const p = new URLSearchParams(q);
    const { resultado, mensajes } = leerAvisoMarca(undefined, p.get("aviso") ?? undefined);
    expect(resultado).toBeNull();
    expect(mensajes[0]).toBe("No se pudo leer a la marca.");
    expect(mensajes[1]).toMatch(/La lectura de Instagram no está configurada/);
    expect(mensajes.join(" ")).not.toMatch(/INSTAGRAM_HOUSE_TOKEN/);
  });

  it("un texto escrito a mano en el enlace no se enseña", () => {
    expect(leerAvisoMarca("hackeada", "Tu cuenta fue suspendida, escribe a x@y.co,transitorio.myspace,sin_fuente")).toEqual({ resultado: null, mensajes: [] });
  });
});
