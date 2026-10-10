import type { Metadata } from "next";
import Link from "next/link";
import { getQueueBlockers, getQueueFacets, listOutboundQueue, type QueueBucket } from "@mc/db/queries/actividad";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { ModuleTabs } from "../_componentes/pestanas";
import { withWorkspace } from "../_lib/db";
import { etiquetaTipo } from "../cadencias/_lib/vista";
import { filaVista } from "./_lib/filas";
import { puedeOperarLaCola } from "./_lib/permiso";
import { ACTIVIDAD_URL, filtrosDe, hayFiltros, hrefDe, type Filtros } from "./_lib/vista";
import { AvisoApagado } from "./aviso-apagado";
import { MESSAGES } from "./messages";
import { PanelActividad, type VacioVista } from "./panel";
import { requireModuleAccess } from "@/lib/permisos/modulo";

export const metadata: Metadata = { title: MESSAGES.metaTitle };
// Lee la base en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

/** Las dos pestañas, como los filtros de Finanzas: enlaces con su URL y su número. */
function Pestanas({ filtros, counts, int }: { filtros: Filtros; counts: Record<QueueBucket, number>; int: (n: number) => string }) {
  const t = MESSAGES.pestanas;
  const items: { vista: QueueBucket; label: string; ayuda: string }[] = [
    { vista: "queue", label: t.cola, ayuda: t.colaAyuda },
    { vista: "history", label: t.historial, ayuda: t.historialAyuda },
  ];
  return (
    <nav aria-label={t.label} className="flex flex-wrap gap-1.5">
      {items.map((it) => {
        const on = it.vista === filtros.vista;
        return (
          <Link
            key={it.vista}
            href={hrefDe({ ...filtros, vista: it.vista, pagina: null })}
            aria-current={on ? "page" : undefined}
            title={it.ayuda}
            className={`rounded-full border px-3 py-1 text-xs tabular-nums transition-colors ${on ? "border-fg bg-fg text-bg" : "border-line text-fg-2 hover:border-line-2 hover:text-fg"}`}
          >
            {t.conCifra(it.label, int(counts[it.vista]))}
          </Link>
        );
      })}
    </nav>
  );
}

/** Los filtros, en un formulario GET: la URL es el estado y se puede compartir. */
function Filtrar({ filtros, cadencias, tipos }: { filtros: Filtros; cadencias: { id: string; name: string }[]; tipos: string[] }) {
  const t = MESSAGES.filtros;
  return (
    <form action={ACTIVIDAD_URL} method="get" aria-label={t.label} className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
      {filtros.vista === "history" && <input type="hidden" name="vista" value="historial" />}
      <Field label={t.cadencia} htmlFor="filtro-cadencia">
        <Select
          id="filtro-cadencia"
          name="cadencia"
          defaultValue={filtros.cadencia ?? ""}
          options={[{ value: "", label: t.todasCadencias }, ...cadencias.map((c) => ({ value: c.id, label: c.name }))]}
        />
      </Field>
      <Field label={t.tipo} htmlFor="filtro-tipo">
        <Select
          id="filtro-tipo"
          name="tipo"
          defaultValue={filtros.tipo ?? ""}
          options={[{ value: "", label: t.todosTipos }, ...tipos.map((x) => ({ value: x, label: etiquetaTipo(x) }))]}
        />
      </Field>
      <Field label={t.contacto} htmlFor="filtro-contacto">
        <Input id="filtro-contacto" name="contacto" type="search" defaultValue={filtros.contacto ?? ""} placeholder={t.contactoPlaceholder} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="secondary">{t.aplicar}</Button>
        {hayFiltros(filtros) && (
          <Button variant="ghost" href={hrefDe({ vista: filtros.vista, cadencia: null, tipo: null, contacto: null, pagina: null })}>{t.limpiar}</Button>
        )}
      </div>
    </form>
  );
}

/**
 * Las páginas, debajo de la lista, como la lista de eventos de Stripe:
 * enlaces con el cursor en la URL (la página se puede compartir y el
 * botón de atrás del navegador funciona). El historial va hacia atrás en
 * el tiempo («Más antiguos»); la cola, hacia lo que sale después.
 */
function Paginas({ filtros, next, prev }: { filtros: Filtros; next: string | null; prev: string | null }) {
  const t = MESSAGES.paginas;
  const textos = filtros.vista === "history" ? t.historial : t.cola;
  if (!next && !prev && !filtros.pagina) return null;
  const enlace = "inline-flex h-8 items-center rounded-md border border-line px-3 text-xs font-medium text-fg-2 hover:border-line-2 hover:text-fg";
  return (
    <nav aria-label={t.label} className="flex flex-wrap items-center justify-between gap-2">
      <span className="flex flex-wrap gap-2">
        {filtros.pagina && (
          <Link href={hrefDe({ ...filtros, pagina: null })} className={enlace}>{t.principio}</Link>
        )}
        {prev && (
          <Link href={hrefDe({ ...filtros, pagina: { direction: "prev", token: prev } })} className={enlace} rel="prev">
            {textos.anterior}
          </Link>
        )}
      </span>
      {next && (
        <Link href={hrefDe({ ...filtros, pagina: { direction: "next", token: next } })} className={enlace} rel="next">
          {textos.siguiente}
        </Link>
      )}
    </nav>
  );
}

/**
 * /ventas/actividad (VEN-16): la cola visible del outreach y su historial.
 *
 * Referencia: la Outreach Activity y la pestaña Queue de Chief, y la lista
 * de eventos de Stripe. Arriba, las dos pestañas con su número y los
 * filtros (cadencia, tipo de paso, contacto); en la cola, el reintento por
 * tipo de paso y la cancelación en masa; cada fila con su estado, su paso,
 * a quién, cuándo y su motivo (cortado, entero al desplegarlo); debajo,
 * las páginas por cursor.
 *
 * Quien no puede operar la cola (un 'viewer' o un 'client':
 * puedeOperarLaCola) la ve igual, sin casillas ni botones de reintentar:
 * no se le ofrece lo que las acciones le van a negar.
 */
export default async function ActividadPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireModuleAccess("ventas");
  const filtros = filtrosDe(await searchParams);
  const base = { sequenceId: filtros.cadencia, stepType: filtros.tipo, contact: filtros.contacto };
  const { cola, facets, bloqueos } = await withWorkspace(async (tx) => ({
    cola: await listOutboundQueue(tx, { bucket: filtros.vista, ...base, cursor: filtros.pagina }),
    facets: await getQueueFacets(tx, base),
    bloqueos: await getQueueBlockers(tx),
  }));
  const f = formatterFor(await getCurrentWorkspace());
  const opera = await puedeOperarLaCola();
  const filas = cola.rows.map((r) => {
    const fila = filaVista(r, f, { bloqueos });
    // Sin permiso, la fila no lleva «Reintentar» ni «Hecho»: la acción lo negaría.
    return opera ? fila : { ...fila, reintentable: false, hecho: false };
  });
  const enCola = filtros.vista === "queue";
  // La casilla de «todo» marca solo esta página: con más de una, lo dice y cuenta cuánto hay que cancelar con estos filtros.
  const paginada = enCola && opera && Boolean(cola.next || cola.prev);
  const enPagina = filas.filter((x) => x.cancelable).length;
  const v = MESSAGES.vacio;
  const vacio: VacioVista = filtros.pagina
    ? { titulo: v.pagina.titulo, descripcion: v.pagina.descripcion }
    : hayFiltros(filtros)
      ? { titulo: v.filtrado.titulo, descripcion: v.filtrado.descripcion }
      : enCola
        ? { titulo: v.cola.titulo, descripcion: v.cola.descripcion, accion: { label: v.cola.accion, href: "/ventas/cadencias" } }
        : { titulo: v.historial.titulo, descripcion: v.historial.descripcion };

  return (
    <>
      <PageHeader eyebrow={MESSAGES.header.eyebrow} title={MESSAGES.header.title} description={MESSAGES.header.description} />
      <ModuleTabs active={ACTIVIDAD_URL} />
      <div className="flex flex-col gap-5">
        {!bloqueos.outreachEnabled && <AvisoApagado />}
        <Pestanas filtros={filtros} counts={facets.counts} int={f.int} />
        <Filtrar filtros={filtros} cadencias={facets.sequences} tipos={facets.stepTypes} />
        <PanelActividad
          // Otra pestaña, otros filtros u otra página empiezan con la selección y el aviso vacíos.
          key={hrefDe(filtros)}
          tipos={enCola && opera
            ? facets.retryableByStepType.map((x) => ({
              stepType: x.stepType,
              label: MESSAGES.reintentar.boton(etiquetaTipo(x.stepType), f.int(x.count)),
              pregunta: MESSAGES.reintentar.pregunta(etiquetaTipo(x.stepType), f.int(x.count), x.count),
            }))
            : null}
          ayudaReintento={bloqueos.outreachEnabled ? MESSAGES.reintentar.ayuda : MESSAGES.reintentar.ayudaApagado}
          consecuenciaReintento={bloqueos.outreachEnabled ? MESSAGES.reintentar.consecuencia : MESSAGES.reintentar.consecuenciaApagado}
          sequenceId={filtros.cadencia}
          contact={filtros.contacto}
          filas={filas}
          seleccionable={enCola && opera}
          caption={MESSAGES.fila.lista(enCola ? MESSAGES.pestanas.cola : MESSAGES.pestanas.historial)}
          locale={f.locale}
          soloPagina={paginada ? MESSAGES.seleccion.soloPagina(f.int(enPagina), enPagina, f.int(facets.cancelable)) : null}
          vacio={vacio}
        />
        <Paginas filtros={filtros} next={cola.next} prev={cola.prev} />
      </div>
    </>
  );
}
