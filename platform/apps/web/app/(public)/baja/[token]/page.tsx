import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Marca } from "@/components/marca";
import { Button } from "@/components/ui/button";
import { estadoDelEnlaceDeBaja, type EstadoEnlace } from "@/lib/db/baja";
import { correoDeSoporte } from "@/lib/soporte";
import { bajaIdioma, bajaTexts, type BajaIdioma } from "../messages";
import { Aviso } from "./aviso";
import { DejarDeRecibir } from "./boton";

export const dynamic = "force-dynamic";

/**
 * El idioma de la página (r5): el del espacio que envió el correo, que es
 * el del pie que trajo hasta aquí; si no se sabe, el del navegador.
 */
async function idiomaDe(estado: EstadoEnlace): Promise<BajaIdioma> {
  const locale = estado.status === "valid" ? estado.locale : null;
  return bajaIdioma(locale, locale ? null : (await headers()).get("accept-language"));
}

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const t = bajaTexts(await idiomaDe(await estadoDelEnlaceDeBaja(token)));
  return { title: t.metaTitle, referrer: "no-referrer" };
}

/**
 * /baja/<token> · la baja desde el pie de un correo del outreach (VEN-15).
 *
 * Sin sesión y sin trucos (referencia: la baja de Substack): la marca de
 * On Cue, para qué dirección es («v•••@marca.com», enmascarada) y de
 * quién, una frase y un botón. Abrir la página no da de baja a nadie —la
 * abren también los escáneres de enlaces—; el botón sí, con una server
 * action. El POST de un clic de Gmail (List-Unsubscribe-Post) va a
 * ./un-clic.
 *
 * Antes de pintar el botón se pregunta a la base por el sha256 del token
 * (public_optout_preview): si el enlace es de un correo que salió, y si
 * quien lo abre es del workspace que lo envió, porque ese enlace también
 * está en su carpeta de enviados. La misma respuesta trae el idioma del
 * espacio que escribe, y la página habla ese idioma (también en `lang`).
 *
 * Un token que no es de ningún correo enviado responde 404 de verdad
 * (notFound() y ./not-found.tsx, con los mismos textos por idioma): un
 * monitor, o el proveedor que prueba el enlace, distingue uno roto de uno
 * bueno. Para que el estado llegue como 404 el segmento no tiene
 * loading.tsx: su límite de Suspense mandaba el esqueleto con un 200 antes
 * de saber que el enlace no existe (el mismo motivo que en el resto de
 * (public); lo comprueba no-existe.test.tsx).
 */
export default async function BajaPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const estado = await estadoDelEnlaceDeBaja(token);
  if (estado.status === "not_found") notFound();
  const idioma = await idiomaDe(estado);
  const t = bajaTexts(idioma);

  return (
    <div lang={idioma} className="py-10 md:py-16">
      <Marca />
      {estado.status === "valid" &&
        (estado.alreadyOptedOut ? (
          <Aviso title={t.yaEstaba.title} body={t.yaEstaba.body(estado.senderName)} />
        ) : (
          <DejarDeRecibir
            token={token}
            direccion={estado.maskedAddress}
            quien={estado.senderName}
            idioma={idioma}
            soporte={correoDeSoporte()}
          />
        ))}
      {estado.status === "sender" && (
        <Aviso
          title={t.remitente.title}
          body={t.remitente.body}
          accion={
            <Button variant="secondary" href="/ventas">
              {t.remitente.accion}
            </Button>
          }
        />
      )}
    </div>
  );
}
