import { headers } from "next/headers";
import { Marca } from "@/components/marca";
import { bajaIdioma, bajaTexts } from "../messages";
import { Aviso } from "./aviso";

/**
 * /baja/<token> con un token que no es de ningún correo enviado: 404 de
 * verdad (notFound() en page.tsx). No usa el 404 de (public), que es de
 * Cotizar y habla de documentos: quien llega aquí quiere dejar de recibir
 * correos, y la salida que siempre funciona es responder al mensaje.
 *
 * Sin enlace válido no se sabe quién escribe, así que habla el idioma del
 * navegador, como la página cuando no sabe el del espacio.
 */
export default async function BajaNoExiste() {
  const idioma = bajaIdioma(null, (await headers()).get("accept-language"));
  const t = bajaTexts(idioma).noExiste;
  return (
    <div lang={idioma} className="py-10 md:py-16">
      <Marca />
      <Aviso title={t.title} body={t.body} />
    </div>
  );
}
