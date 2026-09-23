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

  test("los caracteres que el parser de URL se come no abren una redirección (ronda 3)", () => {
    // El navegador y Node quitan el tabulador y el salto de línea antes
    // de interpretar la URL: '/\t/evil.com' terminaba siendo
    // '//evil.com'. Se comprobó con la app levantada: 307 a otro dominio.
    for (const malo of [
      "/\t/evil.com",
      "/\n/evil.com",
      "/\r/evil.com",
      decodeURIComponent("/%09/evil.com"),
      "/\u0000",
      "/\\evil.com",
      "/ /evil.com",
      "/ /evil.com",
      "/ /evil.com",
      "\t//evil.com",
    ]) {
      expect(destinoSeguro(malo)).toBe("/resumen");
    }
  });

  test("lo que se devuelve es lo que entendió el parser, no la cadena de entrada", () => {
    // Resolver contra un origen propio normaliza los '..' y deja la
    // query y el fragmento como estaban.
    expect(destinoSeguro("/finanzas/../resumen?x=1#arriba")).toBe("/resumen?x=1#arriba");
    // Sin decodificar, '%09' es un segmento más de la ruta, dentro de casa.
    expect(destinoSeguro("/%09/evil.com")).toBe("/%09/evil.com");
    expect(new URL(destinoSeguro("/%09/evil.com"), "https://on-cue-web.vercel.app").host).toBe("on-cue-web.vercel.app");
  });

  test("una ruta pública escondida tras '..' tampoco vale como destino", () => {
    expect(destinoSeguro("/resumen/../login")).toBe("/resumen");
  });

  test("sin next, o apuntando a una ruta pública, va al resumen", () => {
    expect(destinoSeguro(null)).toBe("/resumen");
    expect(destinoSeguro("")).toBe("/resumen");
    expect(destinoSeguro("/login")).toBe("/resumen");
    expect(destinoSeguro("/auth/callback")).toBe("/resumen");
  });
});
