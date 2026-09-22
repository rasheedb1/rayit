import type { Metadata } from "next";
import { getPrimaryCreator, listMediaKits, type MediaKitRow } from "@mc/db/queries/cotizar";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { withWorkspace } from "@/lib/db";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { cambiarPublicacionMediaKit } from "../actions";
import { CopiarEnlace } from "../copiar-enlace";
import { MESSAGES } from "../messages";
import { GenerarMediaKitForm } from "./generar-form";

export const metadata: Metadata = { title: "Media kit" };
export const dynamic = "force-dynamic";

function estadoDe(kit: MediaKitRow, ahora: number): { kind: "good" | "warn" | "neutral"; text: string } {
  const t = MESSAGES.mediaKit;
  if (!kit.isPublic) return { kind: "neutral", text: t.privado };
  if (kit.expiresAt && new Date(kit.expiresAt).getTime() <= ahora) return { kind: "warn", text: t.vencido };
  return { kind: "good", text: t.publico };
}

export default async function MediaKitPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const t = MESSAGES.mediaKit;
  const params = await searchParams;
  const ws = await getCurrentWorkspace();
  const f = formatterFor(ws);
  const ahora = Date.now();

  const { creador, kits } = await withWorkspace(async (tx) => ({
    creador: await getPrimaryCreator(tx),
    kits: await listMediaKits(tx),
  }));

  const columnas: Column<MediaKitRow>[] = [
    {
      key: "creado",
      header: t.columnas.creado,
      render: (k) => (
        <CellMain sub={k.snapshot.creator.displayName}>{f.date(k.createdAt, "long")}</CellMain>
      ),
    },
    {
      key: "enlace",
      header: t.columnas.enlace,
      render: (k) => (
        <span className="flex flex-col gap-1">
          <code className="font-mono text-xs text-ink-2">/kit/{k.slug}</code>
          {(k.hasPassword || k.expiresAt) && (
            <span className="text-xs text-muted">
              {k.hasPassword && t.conPassword}
              {k.hasPassword && k.expiresAt && " · "}
              {k.expiresAt && `${t.vence} ${f.date(k.expiresAt)}`}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "visitas",
      header: t.columnas.visitas,
      align: "num",
      render: (k) => f.int(k.viewCount),
    },
    {
      key: "estado",
      header: t.columnas.estado,
      render: (k) => {
        const e = estadoDe(k, ahora);
        return <Pill kind={e.kind}>{e.text}</Pill>;
      },
    },
    {
      key: "acciones",
      header: " ",
      render: (k) => (
        <span className="flex flex-wrap items-center gap-2">
          <CopiarEnlace path={`/kit/${k.slug}`} label={t.copiar} />
          <Button size="sm" variant="ghost" href={`/kit/${k.slug}`}>
            {t.abrir}
          </Button>
          <form action={cambiarPublicacionMediaKit.bind(null, k.id, !k.isPublic)}>
            <Button size="sm" variant="ghost" type="submit">
              {k.isPublic ? t.despublicar : t.publicar}
            </Button>
          </form>
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow={t.eyebrow}
        title={t.title}
        description={t.description}
        aside={
          <div className="flex flex-wrap gap-2">
            <Button href="/cotizar">{MESSAGES.navegacion.tarifario}</Button>
            <Button href="/cotizar/cotizaciones">{MESSAGES.navegacion.cotizaciones}</Button>
          </div>
        }
      />

      {params.error && (
        <p role="alert" className="mb-6 rounded-md border border-bad/30 bg-bad-wash px-3 py-2 text-sm text-bad">
          {params.error}
        </p>
      )}

      {creador && <GenerarMediaKitForm creatorId={creador.id} />}

      <section className="mt-10" aria-labelledby="kits">
        <SectionTitle meta={`${f.int(kits.length)}`}>
          <span id="kits">{MESSAGES.navegacion.mediaKit}</span>
        </SectionTitle>
        <DataTable
          columns={columnas}
          rows={kits}
          rowKey={(k) => k.id}
          caption={t.tabla}
          emptyState={<EmptyState title={t.vacio.title} description={t.vacio.description} />}
        />
      </section>
    </>
  );
}
