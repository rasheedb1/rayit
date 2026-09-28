// @vitest-environment node
/**
 * ACC-5: cada pantalla de un módulo con permiso cierra ELLA MISMA, no
 * solo el layout del módulo. En una navegación parcial (petición RSC
 * con la cabecera Next-Router-State-Tree) Next no vuelve a ejecutar los
 * layouts que el cliente dice tener, y esa cabecera la manda el
 * navegador: el layout es la puerta de la URL directa, la página es la
 * que protege los datos.
 *
 * Por cada page.tsx de los módulos de la lista, toda función exportada
 * que pinta o lee (la página y generateMetadata) tiene que llamar a
 * `await requireModuleAccess("<su módulo>")`. Al adoptar la regla en un
 * módulo, se agrega a la lista (Resumen, Ventas y Cotizar son de
 * Rasheed: docs/propuestas/ACC-5.md §3).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const APP = join(__dirname, "..", "..", "app", "(app)");
const MODULOS_CON_PUERTA_EN_PAGINA = ["campanas", "finanzas", "conexiones"] as const;

function paginas(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const ruta = join(dir, f);
    if (statSync(ruta).isDirectory()) return paginas(ruta);
    return f === "page.tsx" ? [ruta] : [];
  });
}

describe("cada página de un módulo con permiso abre con requireModuleAccess", () => {
  for (const modulo of MODULOS_CON_PUERTA_EN_PAGINA) {
    const archivos = paginas(join(APP, modulo));
    test(`${modulo}: hay páginas que revisar`, () => {
      expect(archivos.length).toBeGreaterThan(0);
    });
    for (const archivo of archivos) {
      test(`${relative(APP, archivo)}`, () => {
        const codigo = readFileSync(archivo, "utf8");
        const exportadas = [...codigo.matchAll(/export (?:default )?async function (\w+)/g)].map((m) => m[1]);
        const puertas = codigo.split(`await requireModuleAccess("${modulo}")`).length - 1;
        expect(exportadas.length, "la página exporta al menos una función").toBeGreaterThan(0);
        expect(puertas, `una puerta por función exportada (${exportadas.join(", ")})`).toBe(exportadas.length);
      });
    }
  }
});
