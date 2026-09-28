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
import { puedeOperarVentas, puedeVerBandejas } from "../_lib/permiso";
import { FiltroVista } from "./acciones";
import { Conversacion } from "./conversacion";
import { ListaEnOrden, OrdenBandeja } from "./orden-bandeja";
import { MESSAGES } from "./messages";
import { columnaListaClase, conversacionVista, FILTRO, hiloVista, listaHref, siguienteTrasHecha, vistaDe } from "./vista";

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
  const t = MESSAGES;
  // Un 'client' (en una agencia, la marca misma) no lee los hilos con otras marcas: ni se cargan.
  if (!(await puedeVerBandejas())) return <SinAcceso />;
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
  // Un 'viewer' lee los hilos; responder, corregir y marcar es de quien opera (las acciones lo vuelven a mirar).
  const puedeOperar = await puedeOperarVentas();
  const abierto = conversacion ? `${conversacion.contactId}:${conversacion.channel}` : null;
  // La abierta sola (la primera sin leer) solo se ve en escritorio: en un
  // teléfono la lista no la marca como elegida (hiloVista, ListaHilos).
  const vistas = hilos.map((h) => hiloVista(h, f, `${h.contactId}:${h.channel}` === abierto, vista, implicita));
  const volver = listaHref(vista);
  // «Marcar como hecha» en pendientes pasa a la siguiente conversación (la marcada sale de la lista).
  const trasHecha = siguienteTrasHecha(vistas, vista, volver);
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
      <Cabecera />

      {/* El orden de la lista no se mueve mientras dura la visita (pulido r6): la lista, j y k y «hecha» lo leen. */}
      <OrdenBandeja hilos={vistas} vista={vista} listaHref={volver}>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <div data-columna="lista" className={columnaListaClase(conversacionVisible)}>
            <FiltroVista vista={vista} />
            <ListaEnOrden activoSoloEscritorio={implicita} puedeOperar={puedeOperar} />
            {hilos.length === 0 ? <EmptyState title={vacio.title} description={vacio.description} action={vacio.action} /> : null}
          </div>
          <div className={conversacionVisible ? "min-w-0" : "hidden min-w-0 lg:block"}>
            {conversacion ? (
              <Conversacion
                key={abierto}
                c={conversacionVista(conversacion, f, { clasificador, implicita, puedeOperar, vista })}
                volverHref={volver}
                trasHecha={trasHecha}
              />
            ) : (
              <EmptyState title={t.conversacion.elige.title} description={t.conversacion.elige.description} />
            )}
          </div>
        </div>
      </OrdenBandeja>
    </>
  );
}

/** El título y la tira de Ventas, iguales con o sin acceso. */
function Cabecera() {
  const t = MESSAGES;
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
    </>
  );
}

/** Lo que ve un rol sin acceso a las bandejas (PUEDEN_VER_BANDEJAS): nada de los hilos. */
function SinAcceso() {
  const t = MESSAGES;
  return (
    <>
      <Cabecera />
      <EmptyState title={t.sinPermisoVer.title} description={t.sinPermisoVer.description} />
    </>
  );
}
