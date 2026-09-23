import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { estadoDelEnlaceDeBaja } from "@/lib/db/baja";
import { MESSAGES } from "../messages";
import { Aviso } from "./aviso";
import { DejarDeRecibir } from "./boton";

export const metadata: Metadata = { title: MESSAGES.metaTitle, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

/**
 * /baja/<token> · la baja desde el pie de un correo del outreach (VEN-15).
 *
 * Sin sesión y sin trucos: una frase y un botón (referencia: la baja de
 * Substack). Abrir la página no da de baja a nadie —la abren también los
 * escáneres de enlaces—; el botón sí, con una server action. El POST de
 * un clic de Gmail (List-Unsubscribe-Post) va a ./un-clic.
 *
 * Antes de pintar el botón se comprueba el token (firma de la
 * plataforma) y que quien lo abre no sea del workspace que envió el
 * correo: ese enlace también está en su carpeta de enviados.
 */
export default async function BajaPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = MESSAGES;
  const estado = await estadoDelEnlaceDeBaja(token);

  return (
    <div className="py-10 md:py-16">
      {estado.status === "valid" && <DejarDeRecibir token={token} />}
      {estado.status === "not_found" && <Aviso title={t.noExiste.title} body={t.noExiste.body} />}
      {estado.status === "unavailable" && <Aviso title={t.noDisponible.title} body={t.noDisponible.body} />}
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
