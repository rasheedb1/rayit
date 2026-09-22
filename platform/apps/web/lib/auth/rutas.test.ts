// @vitest-environment node
import { describe, expect, test } from "vitest";
import { destinoSeguro, esRutaPublica, RUTAS_PUBLICAS } from "./rutas";

describe("esRutaPublica", () => {
  test("lo declarado público, y lo que cuelga de ello", () => {
    for (const ruta of RUTAS_PUBLICAS) {
      expect(esRutaPublica(ruta)).toBe(true);
      expect(esRutaPublica(`${ruta}/algo`)).toBe(true);
      expect(esRutaPublica(`${ruta}/`)).toBe(true);
    }
  });

  test("la aplicación entera pide sesión", () => {
    for (const ruta of ["/", "/resumen", "/finanzas", "/finanzas/facturas/abc", "/conexiones", "/cuenta", "/campanas"]) {
      expect(esRutaPublica(ruta)).toBe(false);
    }
  });

  test("un prefijo parecido no cuela", () => {
    // /kite no es /kit, y /loginfalso no es /login.
    expect(esRutaPublica("/kite")).toBe(false);
    expect(esRutaPublica("/loginfalso")).toBe(false);
    expect(esRutaPublica("/api/otra-cosa")).toBe(false);
  });
});

describe("destinoSeguro", () => {
  test("una ruta de esta aplicación se respeta", () => {
    expect(destinoSeguro("/finanzas")).toBe("/finanzas");
    expect(destinoSeguro("/finanzas/facturas/abc?x=1")).toBe("/finanzas/facturas/abc?x=1");
  });

  test("todo lo que sea absoluto vuelve al destino por defecto", () => {
    // Un `next=` que apunte fuera convertiría /login en un redirector
    // abierto: la forma más barata de hacer phishing con un dominio
    // legítimo.
    for (const malo of ["https://evil.test", "//evil.test", "/\\evil.test", "http://x", "javascript:alert(1)"]) {
      expect(destinoSeguro(malo)).toBe("/resumen");
    }
  });

  test("sin next, o apuntando a una ruta pública, va al resumen", () => {
    expect(destinoSeguro(null)).toBe("/resumen");
    expect(destinoSeguro("")).toBe("/resumen");
    expect(destinoSeguro("/login")).toBe("/resumen");
    expect(destinoSeguro("/auth/callback")).toBe("/resumen");
  });
});
