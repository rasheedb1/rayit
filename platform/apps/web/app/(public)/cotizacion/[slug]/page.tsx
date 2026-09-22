import type { Metadata } from "next";
import Link from "next/link";
import { readPublicQuote } from "@mc/db/queries/cotizar";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { PlatformPill } from "@/components/ui/platform-pill";
import { withPublicShare } from "@/lib/db";
import { formatterFor } from "@/lib/format";
import { MESSAGES, nombreMetrica } from "@/app/(app)/cotizar/messages";
import { AceptarCotizacion } from "./aceptar";

export const metadata: Metadata = { title: "Cotización" };
// Cada visita se registra y el estado cambia: nada de caché.
export const dynamic = "force-dynamic";

/**
 * La cotización que abre la marca (COT-3 y COT-4), sin sesión.
 *
 * Lo que se ve es el snapshot congelado al enviarla —lo que se envió,
 * no lo que el creador haya editado después— más el estado de hoy, que
 * es lo único vivo. Lo entrega `public_quote(slug)` (migración 0022),
 * que además la marca como vista. Limpieza de referencia: la página
 * alojada de una factura de Stripe.
 */
export default async function CotizacionPublicaPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = MESSAGES.publico.cotizacion;
  const resultado = await withPublicShare((tx) => readPublicQuote(tx, slug));

  if (resultado.status !== "ok") {
    return <EmptyState title={t.noExiste.title} description={t.noExiste.description} />;
  }

  const q = resultado.quote;
  const f = formatterFor({ locale: q.locale, currency: q.currency, timezone: q.timezone });
  const sePuedeAceptar = q.status === "sent" || q.status === "viewed";

  const acordado: { termino: string; valor: string }[] = [
    {
      termino: MESSAGES.detalle.metricas,
      valor: q.acordado.metrics.length > 0 ? q.acordado.metrics.map(nombreMetrica).join(" · ") : MESSAGES.detalle.sinAcordar,
    },
    {
      termino: MESSAGES.detalle.cortes,
      valor:
        q.acordado.cutsHours.length > 0
          ? q.acordado.cutsHours.map((h) => MESSAGES.detalle.horas(h)).join(" · ")
          : MESSAGES.detalle.sinAcordar,
    },
    {
      termino: MESSAGES.detalle.derechos,
      valor: q.acordado.usageRightsDays === null ? MESSAGES.detalle.noAplica : MESSAGES.detalle.dias(q.acordado.usageRightsDays),
    },
    {
      termino: MESSAGES.detalle.exclusividad,
      valor:
        q.acordado.exclusivityDays === null
          ? MESSAGES.detalle.noAplica
          : `${MESSAGES.detalle.dias(q.acordado.exclusivityDays)}${q.acordado.exclusivityScope ? ` · ${q.acordado.exclusivityScope}` : ""}`,
    },
    { termino: MESSAGES.detalle.pago, valor: MESSAGES.detalle.dias(q.acordado.paymentTermsDays) },
    {
      termino: MESSAGES.detalle.ventana,
      valor:
        q.acordado.campaignStartsOn && q.acordado.campaignEndsOn
          ? f.dateRange(q.acordado.campaignStartsOn, q.acordado.campaignEndsOn)
          : MESSAGES.detalle.sinAcordar,
    },
  ];

  return (
    <article className="space-y-10">
      <header>
        <p className="font-mono text-xs uppercase tracking-wide text-muted">
          {t.title} · {q.number}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-balance">{q.company.name}</h1>
        <p className="mt-2 text-sm text-ink-2">
          {t.de} {q.creator.displayName}
          {q.creator.handle ? ` · ${q.creator.handle}` : ""}
        </p>
        <p className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted">
          {q.status === "accepted" && q.acceptedAt ? (
            <Pill kind="good">{t.aceptada(f.date(q.acceptedAt, "long"))}</Pill>
          ) : q.validUntil ? (
            <span>{t.valida(f.date(q.validUntil, "long"))}</span>
          ) : null}
        </p>
      </header>

      <section aria-labelledby="entregables">
        <h2 id="entregables" className="text-sm font-semibold">
          {t.entregables}
        </h2>
        <ul className="mt-3 divide-y divide-border rounded-md border border-border">
          {q.items.map((i, idx) => (
            <li key={`${i.description}-${idx}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-sm">{i.description}</span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {i.platformId && <PlatformPill platformId={i.platformId} />}
                  <span>
                    {t.cantidad} {f.int(i.quantity)} · {f.money(i.unitPrice, q.currency, { mode: "full" })}
                  </span>
                </span>
              </span>
              <span className="font-mono text-sm tabular-nums">{f.money(i.total, q.currency, { mode: "full" })}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label={t.total}>
        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-ink-2">{t.subtotal}</dt>
            <dd className="font-mono tabular-nums">{f.money(q.subtotal, q.currency, { mode: "full" })}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-ink-2">{t.descuento}</dt>
            <dd className="font-mono tabular-nums">−{f.money(q.discount, q.currency, { mode: "full" })}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-ink-2">{t.impuesto}</dt>
            <dd className="font-mono tabular-nums">{f.money(q.tax, q.currency, { mode: "full" })}</dd>
          </div>
          <div className="flex justify-between gap-3 border-t border-border pt-2 text-base">
            <dt className="font-medium">{t.total}</dt>
            <dd className="font-mono font-medium tabular-nums">{f.money(q.total, q.currency, { mode: "full" })}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="acordado">
        <h2 id="acordado" className="text-sm font-semibold">
          {t.acordado}
        </h2>
        <dl className="mt-3 divide-y divide-border rounded-md border border-border">
          {acordado.map((linea) => (
            <div key={linea.termino} className="flex flex-wrap justify-between gap-2 px-4 py-2.5 text-sm">
              <dt className="text-ink-2">{linea.termino}</dt>
              <dd className="text-right">{linea.valor}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-label={t.aceptar}>
        {sePuedeAceptar ? (
          <AceptarCotizacion slug={q.slug} />
        ) : q.status === "accepted" ? (
          <div role="status" className="rounded-md border border-good/30 bg-good-wash px-4 py-3">
            <p className="text-sm font-medium text-good">{t.graciasTitle}</p>
            <p className="mt-1 text-sm text-ink-2">{t.graciasDescription}</p>
          </div>
        ) : (
          <p className="text-sm text-ink-2">{q.status === "rejected" ? t.rechazada : t.vencida}</p>
        )}
      </section>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-xs text-muted">
        <span>{t.pie}</span>
        {q.mediaKitSlug && (
          <Link href={`/kit/${q.mediaKitSlug}`} className="underline-offset-2 hover:underline">
            {MESSAGES.publico.kit.title}
          </Link>
        )}
      </footer>
    </article>
  );
}
