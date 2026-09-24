import { headers } from "next/headers";
import { bajaIdioma, bajaTexts } from "../messages";

/**
 * Esqueleto de la baja mientras la base responde (la sesión y la vista
 * previa del enlace): la marca, el título, dos frases y el botón, del
 * tamaño de la página real. El patrón de ventas/politica/loading.tsx.
 *
 * Todavía no se sabe quién escribe, así que el idioma es el del
 * navegador (r5): la etiqueta es lo único que dice algo.
 */
export default async function BajaLoading() {
  const idioma = bajaIdioma(null, (await headers()).get("accept-language"));
  return (
    <div lang={idioma} className="py-10 md:py-16" aria-busy="true" aria-label={bajaTexts(idioma).loading}>
      <div className="mb-8 flex items-center gap-2.5">
        <span className="h-7 w-7 animate-pulse rounded-md bg-hover" />
        <span className="h-4 w-16 animate-pulse rounded-sm bg-hover" />
      </div>
      <span className="block h-7 w-3/4 animate-pulse rounded-sm bg-hover" />
      <span className="mt-4 block h-4 w-2/3 animate-pulse rounded-sm bg-hover" />
      <span className="mt-2 block h-4 w-full animate-pulse rounded-sm bg-hover" />
      <span className="mt-6 block h-9 w-56 animate-pulse rounded-md bg-hover" />
    </div>
  );
}
