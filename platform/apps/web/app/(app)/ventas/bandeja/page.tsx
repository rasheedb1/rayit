import type { Metadata } from "next";
import { BANDEJA_CHANNELS, listInboxThreads, loadInboxConversation, outreachClassifierStatus } from "@mc/db/queries/bandejas";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { formatterFor } from "@/lib/format";
import { UUID_RE } from "@/lib/forms";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { ModuleTabs } from "../_componentes/pestanas";
import { withWorkspace } from "../_lib/db";
import { AtajosBandeja, FiltroVista } from "./acciones";
import { Conversacion } from "./conversacion";
import { ListaHilos } from "./lista";
import { MESSAGES } from "./messages";
import { conversacionVista, FILTRO, hiloVista, listaHref, vistaDe } from "./vista";

export const metadata: Metadata = { title: MESSAGES.metaTitle };
export const dynamic = "force-dynamic";

/** La pestaña de esta pantalla en la tira de Ventas. */
const RUTA_BANDEJA = "/ventas/bandeja";
const CANALES: ReadonlySet<string> = new Set(BANDEJA_CHANNELS);

/**
 * /ventas/bandeja · la bandeja unificada (VEN-14).
 *
 * A la izquierda, los hilos (una ficha por un canal) con al menos una
 * respuesta, sin leer primero, filtrados por «Pendientes» (lo que espera a
 * la persona), «Hechas» o «Todas»; a la derecha, la conversación abierta
 * completa con la intención de cada respuesta y la caja para responder.
 * Sin un hilo en la URL, en escritorio se abre el primero sin leer (Front
 * y Superhuman); en un teléfono se ve una cosa a la vez: la lista, o la
 * conversación que se eligió con su enlace de vuelta. El hilo abierto y la
 * vista van en la URL (?contacto=…&canal=…&vista=…).
 */
export default async function BandejaPage({
  searchParams,
}: { searchParams: Promise<{ contacto?: string; canal?: string; vista?: string }> }) {
  const sp = await searchParams;
  const vista = vistaDe(sp.vista);
  const contacto = sp.contacto && UUID_RE.test(sp.contacto) ? sp.contacto : null;
  const canal = sp.canal && CANALES.has(sp.canal) ? sp.canal : null;
  const { hilos, conversacion, clasificador, implicita } = await withWorkspace(async (tx) => {
    const hilos = await listInboxThreads(tx, { filter: FILTRO[vista] });
    // Sin hilo elegido, el primero sin leer (o el primero) se abre en escritorio.
    const primero = contacto && canal ? null : (hilos.find((h) => h.unread > 0) ?? hilos[0] ?? null);
    const conversacion = contacto && canal
      ? await loadInboxConversation(tx, contacto, canal)
      : primero
      ? await loadInboxConversation(tx, primero.contactId, primero.channel)
      : null;
    return { hilos, conversacion, clasificador: await outreachClassifierStatus(tx), implicita: !(contacto && canal) };
  });
  const f = formatterFor(await getCurrentWorkspace());
  const t = MESSAGES;
  const abierto = conversacion ? `${conversacion.contactId}:${conversacion.channel}` : null;
  const vistas = hilos.map((h) => hiloVista(h, f, `${h.contactId}:${h.channel}` === abierto, vista));
  const sinLeer = vistas.find((h) => h.activo)?.sinLeer ?? 0;
  const volver = listaHref(vista);
  // Elegida a mano, en un teléfono se ve la conversación; abierta sola, la lista.
  const conversacionVisible = conversacion !== null && !implicita;

  const vacio =
    vista === "pendientes"
      ? { ...t.lista.alDia, action: { label: t.lista.alDia.action, href: listaHref("todas") } }
      : vista === "hechas"
      ? { ...t.lista.sinHechas, action: { label: t.lista.sinHechas.action, href: listaHref("pendientes") } }
      : { ...t.lista.vacio, action: { label: t.lista.vacio.action, href: "/ventas/cadencias" } };

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

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className={conversacionVisible ? "hidden min-w-0 lg:grid lg:content-start lg:gap-3" : "grid min-w-0 content-start gap-3"}>
          <FiltroVista vista={vista} />
          <AtajosBandeja hrefs={vistas.map((h) => h.href)} activo={vistas.findIndex((h) => h.activo)} listaHref={volver} />
          {hilos.length === 0 ? (
            <EmptyState title={vacio.title} description={vacio.description} action={vacio.action} />
          ) : (
            <ListaHilos hilos={vistas} />
          )}
        </div>
        <div className={conversacionVisible ? "min-w-0" : "hidden min-w-0 lg:block"}>
          {conversacion ? (
            <Conversacion
              c={conversacionVista(conversacion, f, { sinLeer, clasificador, implicita })}
              volverHref={volver}
            />
          ) : (
            <EmptyState title={t.conversacion.elige.title} description={t.conversacion.elige.description} />
          )}
        </div>
      </div>
    </>
  );
}
