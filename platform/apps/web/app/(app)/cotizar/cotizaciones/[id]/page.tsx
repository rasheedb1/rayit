import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getQuote, type QuoteItemRow } from "@mc/db/queries/cotizar";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { Pill } from "@/components/ui/pill";
import { PlatformPill } from "@/components/ui/platform-pill";
import { withWorkspace } from "@/lib/db";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { aceptarCotizacion, crearCampanaDeCotizacion, enviarCotizacion, rechazarCotizacion } from "../../actions";
import { CopiarEnlace } from "../../copiar-enlace";
import { MESSAGES, nombreMetrica } from "../../messages";
import { pillDeCotizacion } from "../../_lib/estado";

export const metadata: Metadata = { title: "Cotización" };
export const dynamic = "force-dynamic";

export default async function CotizacionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const t = MESSAGES.detalle;
  const { id } = await params;
  const { error } = await searchParams;
  const ws = await getCurrentWorkspace();
  const f = formatterFor(ws);

  const quote = await withWorkspace((tx) => getQuote(tx, id));
  if (!quote) notFound();

  const pill = pillDeCotizacion(quote.status);
  const esBorrador = quote.status === "draft";
  const sePuedeCerrar = quote.status === "sent" || quote.status === "viewed";
  const enlace = `/cotizacion/${quote.slug}`;

  const columnas: Column<QuoteItemRow>[] = [
    {
      key: "descripcion",
      header: MESSAGES.nueva.descripcion,
      render: (i) => (
        <span className="flex flex-col gap-1">
          <CellMain>{i.description}</CellMain>
          {i.platformId && <PlatformPill platformId={i.platformId} />}
        </span>
      ),
    },
    { key: "cantidad", header: MESSAGES.nueva.cantidad, align: "num", render: (i) => f.int(i.quantity) },
    {
      key: "precio",
      header: MESSAGES.nueva.precio,
      align: "num",
      render: (i) => f.money(i.unitPrice, quote.currency, { mode: "full" }),
    },
    {
      key: "total",
      header: MESSAGES.nueva.total,
      align: "num",
      render: (i) => f.money(i.total, quote.currency, { mode: "full" }),
    },
  ];

  const acordado: { termino: string; valor: string }[] = [
    {
      termino: t.metricas,
      valor: quote.agreedMetrics.length > 0 ? quote.agreedMetrics.map(nombreMetrica).join(" · ") : t.sinAcordar,
    },
    {
      termino: t.cortes,
      valor: quote.reportCutsHours.length > 0 ? quote.reportCutsHours.map((h) => t.horas(h)).join(" · ") : t.sinAcordar,
    },
    { termino: t.derechos, valor: quote.usageRightsDays === null ? t.noAplica : t.dias(quote.usageRightsDays) },
    {
      termino: t.exclusividad,
      valor:
        quote.exclusivityDays === null
          ? t.noAplica
          : `${t.dias(quote.exclusivityDays)}${quote.exclusivityScope ? ` · ${quote.exclusivityScope}` : ""}`,
    },
    { termino: t.pago, valor: t.dias(quote.paymentTermsDays) },
    {
      termino: t.ventana,
      valor:
        quote.campaignStartsOn && quote.campaignEndsOn
          ? f.dateRange(quote.campaignStartsOn, quote.campaignEndsOn)
          : t.sinAcordar,
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow={`${t.eyebrow} · ${quote.number}`}
        title={quote.companyName}
        description={quote.dealName ?? undefined}
        aside={
          <div className="flex flex-wrap items-center gap-2">
            <Pill kind={pill.kind}>{pill.text}</Pill>
            {esBorrador ? (
              <form action={enviarCotizacion.bind(null, quote.id)}>
                <Button type="submit" variant="primary">
                  {t.enviar}
                </Button>
              </form>
            ) : (
              <>
                <CopiarEnlace path={enlace} size="md" />
                <Button href={enlace}>{t.abrir}</Button>
              </>
            )}
          </div>
        }
      />

      {error && (
        <p role="alert" className="mb-6 rounded-md border border-bad/30 bg-bad-wash px-3 py-2 text-sm text-bad">
          {error}
        </p>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-8">
          <section aria-labelledby="entregables">
            <SectionTitle>
              <span id="entregables">{t.entregables}</span>
            </SectionTitle>
            <DataTable
              columns={columnas}
              rows={quote.items}
              rowKey={(i) => i.id}
              caption={`${t.entregables} de ${quote.number}`}
              emptyState={<span className="text-sm text-muted">—</span>}
            />
          </section>

          <section aria-labelledby="acordado">
            <SectionTitle>
              <span id="acordado">{t.acordado}</span>
            </SectionTitle>
            <dl className="divide-y divide-border rounded-md border border-border">
              {acordado.map((linea) => (
                <div key={linea.termino} className="flex flex-wrap justify-between gap-2 px-4 py-2.5 text-sm">
                  <dt className="text-ink-2">{linea.termino}</dt>
                  <dd className="text-right">{linea.valor}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-8 lg:self-start">
          <div className="rounded-md border border-border p-4">
            <p className="text-xs text-muted">{MESSAGES.nueva.total}</p>
            <p className="mt-1 font-mono text-2xl font-medium tabular-nums">
              {f.money(quote.total, quote.currency, { mode: "full" })}
            </p>
            <dl className="mt-4 space-y-1.5 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-ink-2">{MESSAGES.nueva.subtotal}</dt>
                <dd className="font-mono tabular-nums">{f.money(quote.subtotal, quote.currency, { mode: "full" })}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-2">{MESSAGES.nueva.descuento}</dt>
                <dd className="font-mono tabular-nums">−{f.money(quote.discount, quote.currency, { mode: "full" })}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-2">{MESSAGES.nueva.impuesto}</dt>
                <dd className="font-mono tabular-nums">{f.money(quote.tax, quote.currency, { mode: "full" })}</dd>
              </div>
            </dl>
          </div>

          {!esBorrador && (
            <div className="rounded-md border border-border p-4">
              <p className="text-xs font-medium text-ink-2">{t.enlace}</p>
              <p className="mt-1 break-all font-mono text-xs text-ink-2">{enlace}</p>
              <p className="mt-2 text-xs leading-4 text-muted">{t.enlaceAyuda}</p>
              <p className="mt-2 text-xs text-muted">
                {quote.viewCount > 0 ? t.visitas(quote.viewCount) : t.sinVisitas}
                {quote.validUntil ? ` · ${MESSAGES.publico.cotizacion.valida(f.date(quote.validUntil))}` : ""}
              </p>
            </div>
          )}

          {sePuedeCerrar && (
            <div className="flex flex-wrap gap-2">
              <form action={aceptarCotizacion.bind(null, quote.id)}>
                <Button type="submit" variant="primary">
                  {t.aceptar}
                </Button>
              </form>
              <form action={rechazarCotizacion.bind(null, quote.id)}>
                <Button type="submit" variant="danger">
                  {t.rechazar}
                </Button>
              </form>
            </div>
          )}

          {quote.status === "accepted" && (
            <div className="rounded-md border border-border p-4">
              {quote.campaignId ? (
                <>
                  <p className="text-sm font-medium text-good">{t.campanaCreada}</p>
                  <p className="mt-1 text-sm text-ink-2">{quote.campaignName}</p>
                  <div className="mt-3">
                    <Button size="sm" href={`/campanas/${quote.campaignId}`}>
                      {t.verCampana}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium">{t.campanaPendiente}</p>
                  <p className="mt-1 text-xs leading-4 text-muted">{t.campanaPendienteAyuda}</p>
                  <form className="mt-3" action={crearCampanaDeCotizacion.bind(null, quote.id)}>
                    <Button size="sm" variant="primary" type="submit">
                      {t.crearCampana}
                    </Button>
                  </form>
                </>
              )}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
