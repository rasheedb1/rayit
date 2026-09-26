import type { Metadata } from "next";
import { listInboxThreads, loadInboxConversation } from "@mc/db/queries/bandejas";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { formatterFor } from "@/lib/format";
import { UUID_RE } from "@/lib/forms";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { ModuleTabs } from "../_componentes/pestanas";
import { withWorkspace } from "../_lib/db";
import { Conversacion } from "./conversacion";
import { ListaHilos } from "./lista";
import { MESSAGES } from "./messages";
import { conversacionVista, hiloVista } from "./vista";

export const metadata: Metadata = { title: MESSAGES.metaTitle };
export const dynamic = "force-dynamic";

/** La pestaña de esta pantalla en la tira de Ventas. */
const RUTA_BANDEJA = "/ventas/bandeja";
const CANALES = new Set(["email", "linkedin", "instagram_dm", "whatsapp"]);

/**
 * /ventas/bandeja · la bandeja unificada (VEN-14).
 *
 * A la izquierda, los hilos (una ficha por un canal) con al menos una
 * respuesta, sin leer primero; a la derecha, la conversación abierta
 * completa con la intención de cada respuesta y la caja para responder.
 * En un teléfono se ve una cosa a la vez: la lista, o la conversación con
 * su enlace de vuelta. El hilo abierto va en la URL (?contacto=…&canal=…).
 */
export default async function BandejaPage({ searchParams }: { searchParams: Promise<{ contacto?: string; canal?: string }> }) {
  const sp = await searchParams;
  const contacto = sp.contacto && UUID_RE.test(sp.contacto) ? sp.contacto : null;
  const canal = sp.canal && CANALES.has(sp.canal) ? sp.canal : null;
  const { hilos, conversacion } = await withWorkspace(async (tx) => ({
    hilos: await listInboxThreads(tx),
    conversacion: contacto && canal ? await loadInboxConversation(tx, contacto, canal) : null,
  }));
  const f = formatterFor(await getCurrentWorkspace());
  const t = MESSAGES;
  const abierto = conversacion ? `${conversacion.contactId}:${conversacion.channel}` : null;
  const vistas = hilos.map((h) => hiloVista(h, f, `${h.contactId}:${h.channel}` === abierto));
  const sinLeer = vistas.find((h) => h.activo)?.sinLeer ?? 0;

  return (
    <>
      <PageHeader
        eyebrow={t.header.eyebrow}
        title={t.header.title}
        description={t.header.description}
        aside={
          <Button variant="ghost" href="/ventas">
            {t.header.back}
          </Button>
        }
      />
      <ModuleTabs active={RUTA_BANDEJA} />

      {hilos.length === 0 && !conversacion ? (
        <EmptyState
          title={t.lista.vacio.title}
          description={t.lista.vacio.description}
          action={{ label: t.lista.vacio.action, href: "/ventas/cadencias" }}
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <div className={conversacion ? "hidden lg:block" : ""}>
            <ListaHilos hilos={vistas} />
          </div>
          <div className={conversacion ? "" : "hidden lg:block"}>
            {conversacion ? (
              <Conversacion c={conversacionVista(conversacion, f, sinLeer)} />
            ) : (
              <EmptyState title={t.conversacion.elige.title} description={t.conversacion.elige.description} />
            )}
          </div>
        </div>
      )}
    </>
  );
}
