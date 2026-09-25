import type { Metadata } from "next";
import Link from "next/link";
import { listProposableSignals, listSequences, listSequenceTemplates, type SequenceListRow } from "@mc/db/queries/cadencias";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { CeldaVacia } from "../../_componentes/celda-vacia";
import { ModuleTabs } from "../../_componentes/pestanas";
import { withWorkspace } from "../../_lib/db";
import { ESTADO_PILL } from "../_lib/vista";
import { MESSAGES } from "../messages";
import { PlantillaForm } from "../plantilla-form";
import { ProponerBoton } from "../proponer-boton";

export const metadata: Metadata = { title: MESSAGES.metaTitle };
export const dynamic = "force-dynamic";

const CADENCIAS = "/ventas/cadencias";

/**
 * /ventas/cadencias (VEN-13): de dónde sale una cadencia y cuáles hay.
 *
 * Arriba, las señales aceptadas con negocio abierto y su «Proponer
 * cadencia» (el primer clic; el segundo es «Activar» en la línea de
 * tiempo). En medio, las cadencias con su estado, sus personas dentro y
 * su tasa de respuesta, todo contado en SQL. Abajo, empezar desde una
 * plantilla sin señal.
 */
export default async function CadenciasPage({ searchParams }: { searchParams: Promise<{ archivadas?: string }> }) {
  const conArchivadas = (await searchParams).archivadas === "1";
  const { senales, cadencias, plantillas } = await withWorkspace(async (tx) => ({
    senales: await listProposableSignals(tx, 6),
    cadencias: await listSequences(tx, { includeArchived: conArchivadas }),
    plantillas: await listSequenceTemplates(tx),
  }));
  const f = formatterFor(await getCurrentWorkspace());
  const t = MESSAGES;

  const columns: Column<SequenceListRow>[] = [
    {
      key: "cadencia",
      header: t.lista.columnas.cadencia,
      render: (c) => (
        <CellMain sub={c.signalHeadline ? t.lista.desde(c.companyName ? `${c.companyName} · ${c.signalHeadline}` : c.signalHeadline) : undefined}>
          <Link href={`${CADENCIAS}/${c.id}`} className="hover:underline">
            {c.name}
          </Link>
        </CellMain>
      ),
    },
    {
      key: "estado",
      header: t.lista.columnas.estado,
      render: (c) => <Pill kind={ESTADO_PILL[c.status]}>{t.estados[c.status] ?? c.status}</Pill>,
    },
    { key: "pasos", header: t.lista.columnas.pasos, align: "num", render: (c) => f.int(c.steps) },
    { key: "enrolados", header: t.lista.columnas.enrolados, align: "num", render: (c) => f.int(c.enrolledLive) },
    {
      key: "respuesta",
      header: t.lista.columnas.respuesta,
      align: "num",
      render: (c) =>
        c.replyRate === null ? <CeldaVacia texto={t.lista.sinContactar} /> : t.lista.respuestaDe(f.pct(c.replyRate), f.int(c.contacted)),
    },
  ];

  return (
    <>
      <PageHeader eyebrow={t.header.eyebrow} title={t.header.title} description={t.header.description} />
      <ModuleTabs active={CADENCIAS} />

      <section aria-labelledby="senales" className="mb-10">
        <SectionTitle>
          <span id="senales">{t.senales.titulo}</span>
        </SectionTitle>
        <p className="mb-4 max-w-2xl text-sm text-fg-2">{t.senales.descripcion}</p>
        {senales.length === 0 ? (
          <EmptyState
            title={t.senales.vacio.titulo}
            description={t.senales.vacio.descripcion}
            action={{ label: t.senales.vacio.accion, href: "/ventas" }}
          />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {senales.map((s) => (
              <li key={s.signalId} className="flex min-w-0 flex-col gap-3 rounded-md border border-line bg-surface p-4">
                <div className="min-w-0">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <Pill kind="neutral">{t.senalTipos[s.signalKind]}</Pill>
                    <time dateTime={s.detectedAt} className="text-xs text-fg-3 tabular-nums">
                      {f.date(s.detectedAt)}
                    </time>
                  </div>
                  <p className="text-sm font-medium break-words">{s.companyName ?? s.dealName}</p>
                  <p className="text-sm text-fg-2 break-words">{s.headline}</p>
                  <p className="mt-1 text-xs text-fg-3 break-words">{t.senales.negocio(s.dealName)}</p>
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  {s.sequenceId ? (
                    <>
                      <Button href={`${CADENCIAS}/${s.sequenceId}`} size="sm" variant="secondary">
                        {t.senales.verCadencia}
                      </Button>
                      <ProponerBoton signalId={s.signalId} variant="ghost" />
                    </>
                  ) : (
                    <ProponerBoton signalId={s.signalId} />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="lista" className="mb-10">
        <SectionTitle
          meta={
            <Link href={conArchivadas ? CADENCIAS : `${CADENCIAS}?archivadas=1`} className="hover:underline">
              {conArchivadas ? t.lista.ocultarArchivadas : t.lista.verArchivadas}
            </Link>
          }
        >
          <span id="lista">{t.lista.titulo}</span>
        </SectionTitle>
        <DataTable
          columns={columns}
          rows={cadencias}
          rowKey={(c) => c.id}
          caption={t.lista.caption}
          emptyState={<EmptyState title={t.lista.vacio.titulo} description={t.lista.vacio.descripcion} />}
        />
      </section>

      <section aria-labelledby="plantillas" className="max-w-2xl">
        <SectionTitle>
          <span id="plantillas">{t.plantillas.titulo}</span>
        </SectionTitle>
        <p className="mb-4 text-sm text-fg-2">{t.plantillas.descripcion}</p>
        <PlantillaForm opciones={plantillas.map((p) => ({ value: p.slug, label: p.nameEs }))} />
      </section>
    </>
  );
}
