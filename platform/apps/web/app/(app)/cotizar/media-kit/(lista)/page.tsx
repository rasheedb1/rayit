import type { Metadata } from "next";
import { getPrimaryCreator, listMediaKitLockNotices, listMediaKits, type MediaKitRow } from "@mc/db/queries/cotizar";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { withWorkspace } from "@/lib/db";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { cambiarPublicacionMediaKit, desbloquearMediaKit } from "../../actions";
import { CopiarEnlace } from "../../copiar-enlace";
import { MESSAGES, mensajeDeError } from "../../messages";
import { AvisosBloqueo } from "../../_ui/avisos-bloqueo";
import { GenerarMediaKitForm } from "../generar-form";

export const metadata: Metadata = { title: "Media kit" };
export const dynamic = "force-dynamic";

function estadoDe(kit: MediaKitRow, ahora: number): { kind: "good" | "warn" | "bad" | "neutral"; text: string } {
  const t = MESSAGES.mediaKit;
  if (!kit.isPublic) return { kind: "neutral", text: t.privado };
  if (kit.expiresAt && new Date(kit.expiresAt).getTime() <= ahora) return { kind: "warn", text: t.vencido };
  // lockedUntil llega solo si el bloqueo sigue vigente (queries/cotizar).
  if (kit.lockedUntil) return { kind: "bad", text: t.bloqueado };
  return { kind: "good", text: t.publico };
}

/** Hay algo que «Desbloquear»: el enlace entero o algún origen. */
function tieneBloqueo(kit: MediaKitRow): boolean {
  return kit.lockedUntil !== null || kit.lockedOrigins > 0;
}

export default async function MediaKitPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const t = MESSAGES.mediaKit;
  // ?error= lleva un código, no texto: messages.ts decide qué se lee.
  const error = mensajeDeError((await searchParams).error);
  const ws = await getCurrentWorkspace();
  const f = formatterFor(ws);
  const ahora = Date.now();

  const { creador, kits, avisos } = await withWorkspace(async (tx) => ({
    creador: await getPrimaryCreator(tx),
    kits: await listMediaKits(tx),
    avisos: await listMediaKitLockNotices(tx),
  }));

  const columnas: Column<MediaKitRow>[] = [
    {
      key: "creado",
      header: t.columnas.creado,
      render: (k) => (
        // Con la hora: dos media kits del mismo día se distinguen sin
        // leer el slug.
        <CellMain sub={k.snapshot.creator.displayName}>{f.dateTime(k.createdAt)}</CellMain>
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
        return (
          <span className="flex flex-col items-start gap-1">
            <Pill kind={e.kind}>{e.text}</Pill>
            {k.lockedUntil ? (
              <span className="text-xs text-muted">{t.bloqueadoHasta(f.time(k.lockedUntil))}</span>
            ) : k.lockedOrigins > 0 ? (
              <span className="text-xs text-muted">{t.origenesBloqueados(k.lockedOrigins)}</span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: "acciones",
      header: t.columnas.acciones,
      render: (k) => (
        <span className="flex flex-wrap items-center gap-2">
          <CopiarEnlace path={`/kit/${k.slug}`} label={t.copiar} />
          {/* La vista previa es del panel: abrir el enlace público sumaría una visita. */}
          <Button size="sm" variant="ghost" href={`/cotizar/media-kit/${k.id}`}>
            {t.abrir}
          </Button>
          <form action={cambiarPublicacionMediaKit.bind(null, k.id, !k.isPublic)}>
            <Button size="sm" variant="ghost" type="submit">
              {k.isPublic ? t.despublicar : t.publicar}
            </Button>
          </form>
          {tieneBloqueo(k) && (
            <form action={desbloquearMediaKit.bind(null, k.id)}>
              <Button size="sm" variant="ghost" type="submit" aria-label={t.desbloquearAria}>
                {t.desbloquear}
              </Button>
            </form>
          )}
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

      {error && (
        <p role="alert" className="mb-6 rounded-md border border-bad/30 bg-bad-wash px-3 py-2 text-sm text-bad">
          {error}
        </p>
      )}

      <AvisosBloqueo avisos={avisos} f={f} vuelta="/cotizar/media-kit" />

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
