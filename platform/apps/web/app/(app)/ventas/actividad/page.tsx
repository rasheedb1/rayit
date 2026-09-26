import type { Metadata } from "next";
import Link from "next/link";
import { getQueueFacets, listOutboundQueue, QUEUE_PAGE_SIZE, type QueueBucket } from "@mc/db/queries/actividad";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/field";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { ModuleTabs } from "../_componentes/pestanas";
import { withWorkspace } from "../_lib/db";
import { etiquetaTipo } from "../cadencias/_lib/vista";
import { filaVista } from "./_lib/filas";
import { ACTIVIDAD_URL, filtrosDe, hayFiltros, hrefDe, type Filtros } from "./_lib/vista";
import { ListaActividad } from "./lista";
import { MESSAGES } from "./messages";
import { ReintentarPorTipo } from "./reintentar";

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
            href={hrefDe({ ...filtros, vista: it.vista })}
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
          <Button variant="ghost" href={hrefDe({ vista: filtros.vista, cadencia: null, tipo: null, contacto: null })}>{t.limpiar}</Button>
        )}
      </div>
    </form>
  );
}

/**
 * /ventas/actividad (VEN-16): la cola visible del outreach y su historial.
 *
 * Referencia: la Outreach Activity y la pestaña Queue de Chief, y la lista
 * de eventos de Stripe. Arriba, las dos pestañas con su número y los
 * filtros (cadencia, tipo de paso, contacto); en la cola, el reintento por
 * tipo de paso y la cancelación en masa; cada fila con su estado, su paso,
 * a quién, cuándo y su motivo (cortado, entero al pasar el cursor).
 */
export default async function ActividadPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filtros = filtrosDe(await searchParams);
  const base = { sequenceId: filtros.cadencia, stepType: filtros.tipo, contact: filtros.contacto };
  const { cola, facets } = await withWorkspace(async (tx) => ({
    cola: await listOutboundQueue(tx, { bucket: filtros.vista, ...base }),
    facets: await getQueueFacets(tx, base),
  }));
  const f = formatterFor(await getCurrentWorkspace());
  const filas = cola.rows.map((r) => filaVista(r, f));
  const enCola = filtros.vista === "queue";
  const vacio = hayFiltros(filtros) ? MESSAGES.vacio.filtrado : enCola ? MESSAGES.vacio.cola : MESSAGES.vacio.historial;

  return (
    <>
      <PageHeader eyebrow={MESSAGES.header.eyebrow} title={MESSAGES.header.title} description={MESSAGES.header.description} />
      <ModuleTabs active={ACTIVIDAD_URL} />
      <div className="flex flex-col gap-5">
        <Pestanas filtros={filtros} counts={facets.counts} int={f.int} />
        <Filtrar filtros={filtros} cadencias={facets.sequences} tipos={facets.stepTypes} />
        {enCola && (
          <ReintentarPorTipo
            tipos={facets.retryableByStepType.map((x) => ({
              stepType: x.stepType,
              label: MESSAGES.reintentar.boton(etiquetaTipo(x.stepType), f.int(x.count)),
            }))}
            sequenceId={filtros.cadencia}
            contact={filtros.contacto}
          />
        )}
        {filas.length === 0 ? (
          <EmptyState
            title={vacio.titulo}
            description={vacio.descripcion}
            action={!hayFiltros(filtros) && enCola ? { label: MESSAGES.vacio.cola.accion, href: "/ventas/cadencias" } : undefined}
          />
        ) : (
          <ListaActividad
            // Otra pestaña u otros filtros empiezan con la selección vacía.
            key={hrefDe(filtros)}
            filas={filas}
            seleccionable={enCola}
            caption={MESSAGES.fila.lista(enCola ? MESSAGES.pestanas.cola : MESSAGES.pestanas.historial)}
            locale={f.locale}
          />
        )}
        {cola.hasMore && <p className="text-xs text-fg-3">{MESSAGES.masFilas(f.int(QUEUE_PAGE_SIZE))}</p>}
      </div>
    </>
  );
}
