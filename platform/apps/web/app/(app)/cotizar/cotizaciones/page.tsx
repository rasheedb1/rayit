import type { Metadata } from "next";
import Link from "next/link";
import { listAcceptanceNotices, listQuotes, type QuoteListRow } from "@mc/db/queries/cotizar";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { withWorkspace } from "@/lib/db";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { marcarAvisoVisto } from "../actions";
import { MESSAGES } from "../messages";
import { pillDeCotizacion } from "../_lib/estado";

export const metadata: Metadata = { title: "Cotizaciones" };
export const dynamic = "force-dynamic";

export default async function CotizacionesPage() {
  const t = MESSAGES.cotizaciones;
  const ws = await getCurrentWorkspace();
  const f = formatterFor(ws);
  // Las cotizaciones y los avisos de «la marca aceptó» en la misma
  // transacción: el aviso que promete la página pública es este.
  const { quotes, avisos } = await withWorkspace(async (tx) => ({
    quotes: await listQuotes(tx),
    avisos: await listAcceptanceNotices(tx),
  }));
  const ta = MESSAGES.avisos;

  const columnas: Column<QuoteListRow>[] = [
    {
      key: "numero",
      header: t.columnas.numero,
      render: (q) => (
        <Link href={`/cotizar/cotizaciones/${q.id}`} className="font-mono text-sm underline-offset-2 hover:underline">
          {q.number}
        </Link>
      ),
    },
    {
      key: "marca",
      header: t.columnas.marca,
      render: (q) => <CellMain sub={q.dealName ?? undefined}>{q.companyName}</CellMain>,
    },
    {
      key: "total",
      header: t.columnas.total,
      align: "num",
      render: (q) => f.money(q.total, q.currency, { mode: "full" }),
    },
    {
      key: "estado",
      header: t.columnas.estado,
      render: (q) => {
        const p = pillDeCotizacion(q.status);
        return <Pill kind={p.kind}>{p.text}</Pill>;
      },
    },
    {
      key: "enviada",
      header: t.columnas.enviada,
      render: (q) =>
        q.sentAt ? (
          <CellMain sub={q.viewCount > 0 ? MESSAGES.detalle.visitas(q.viewCount) : MESSAGES.detalle.sinVisitas}>
            {f.date(q.sentAt)}
          </CellMain>
        ) : (
          <span className="text-muted">{t.sinEnviar}</span>
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
            <Button variant="primary" href="/cotizar/cotizaciones/nueva">
              {t.nueva}
            </Button>
          </div>
        }
      />

      {avisos.length > 0 && (
        <section aria-labelledby="avisos" className="mb-8">
          <SectionTitle meta={f.int(avisos.length)}>
            <span id="avisos">{ta.title}</span>
          </SectionTitle>
          <ul className="divide-y divide-border rounded-md border border-good/30 bg-good-wash">
            {avisos.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0 text-sm">
                  <p className="font-medium text-ink">{ta.aceptada(a.companyName, a.quoteNumber)}</p>
                  <p className="mt-0.5 text-xs text-ink-2">
                    {[
                      f.dateTime(a.createdAt),
                      a.signerName ? ta.firmo(a.signerName) : null,
                      a.campaignName ? ta.campana(a.campaignName) : ta.campanaPendiente,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" href={`/cotizar/cotizaciones/${a.quoteId}`}>
                    {ta.ver}
                  </Button>
                  <form action={marcarAvisoVisto.bind(null, a.id)}>
                    <Button size="sm" variant="ghost" type="submit">
                      {ta.entendido}
                    </Button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="cotizaciones">
        <SectionTitle meta={f.int(quotes.length)}>
          <span id="cotizaciones">{MESSAGES.navegacion.cotizaciones}</span>
        </SectionTitle>
        <DataTable
          columns={columnas}
          rows={quotes}
          rowKey={(q) => q.id}
          caption={t.tabla}
          emptyState={
            <EmptyState
              title={t.vacio.title}
              description={t.vacio.description}
              action={{ label: t.vacio.accion, href: "/cotizar/cotizaciones/nueva" }}
            />
          }
        />
      </section>
    </>
  );
}
