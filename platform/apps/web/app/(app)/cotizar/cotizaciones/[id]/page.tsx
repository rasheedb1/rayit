import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getQuote, getQuoteStatus, type QuoteItemRow } from "@mc/db/queries/cotizar";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { Pill } from "@/components/ui/pill";
import { PlatformPill } from "@/components/ui/platform-pill";
import { withWorkspace } from "@/lib/db";
import { formatterFor } from "@/lib/format";
import { dealLabel } from "@/lib/negocio";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { aceptarCotizacion, crearCampanaDeCotizacion, rechazarCotizacion } from "../../actions";
import { CopiarEnlace } from "../../copiar-enlace";
import { MESSAGES, mensajeDeError } from "../../messages";
import { etiquetaImpuesto, lineasAcordado } from "../../_lib/acordado";
import { pillDeCotizacion, validezYaNoAplica } from "../../_lib/estado";
import { ConfirmarAccion } from "../../_ui/confirmar-accion";
import { EsqueletoLista } from "../../_ui/esqueleto-lista";
import { ResumenTotales } from "../../_ui/resumen-totales";
import { AvisoEnviada } from "./aviso-enviada";
import { EliminarBorrador } from "./eliminar";
import { EnviarCotizacion } from "./enviar";
import { VentanaCampana } from "./ventana";

export const metadata: Metadata = { title: "Cotización" };

/**
 * Una fila de «Lo acordado» y de «Historia»: el término arriba y el
 * valor debajo en el teléfono, y lado a lado desde sm. El mismo dibujo en
 * todas las filas; con flex-wrap unas se partían y otras no, y la de
 * «Aceptada» quedaba a la derecha cortada a mitad del nombre.
 */
const FILA_DL = "flex flex-col gap-0.5 px-4 py-2.5 text-sm sm:flex-row sm:items-baseline sm:justify-between sm:gap-4";
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; enviada?: string }>;
};

/**
 * Primero una sola fila —¿existe la cotización en este espacio?— y, si
 * no, notFound() antes de que salga nada: 404 de verdad, sin loading.tsx
 * por encima. Después, el detalle detrás de un esqueleto, para que al
 * llegar desde la lista se vea que carga (pulido r5).
 */
export default async function CotizacionPage({ params, searchParams }: Props) {
  const { id } = await params;
  if ((await withWorkspace((tx) => getQuoteStatus(tx, id))) === null) notFound();
  return (
    <Suspense fallback={<EsqueletoLista label={MESSAGES.loading.cotizacion} filas={4} />}>
      <CotizacionDetalle params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function CotizacionDetalle({ params, searchParams }: Props) {
  const t = MESSAGES.detalle;
  const { id } = await params;
  // ?error= lleva un CÓDIGO; el texto sale de messages.ts. Un código que
  // no conocemos se enseña como el genérico, nunca tal cual.
  const sp = await searchParams;
  const error = mensajeDeError(sp.error);
  // ?enviada= también es un código: el botón de enviar ya no existe
  // cuando la página vuelve pintada como enviada, así que el aviso de
  // «enlace copiado» lo da el detalle. Es de un solo uso: AvisoEnviada
  // quita el parámetro de la URL en cuanto se pinta.
  const enviada = sp.enviada === "copiado" || sp.enviada === "manual" ? sp.enviada : null;
  const ws = await getCurrentWorkspace();
  const f = formatterFor(ws);

  const quote = await withWorkspace((tx) => getQuote(tx, id));
  if (!quote) notFound();

  const pill = pillDeCotizacion(quote.status);
  const esBorrador = quote.status === "draft";
  const sePuedeCerrar = quote.status === "sent" || quote.status === "viewed";
  // Aceptada, rechazada o vencida, la validez ya no dice nada: como en
  // Stripe Quotes, desaparece en cuanto la cotización se cierra.
  const validezCerrada = validezYaNoAplica(quote.status);
  const enlace = `/cotizacion/${quote.slug}`;
  const vistaPrevia = `/cotizar/cotizaciones/${quote.id}/vista`;
  const dinero = (v: string) => f.money(v, quote.currency, { mode: "full" });

  // Dos columnas, como la factura alojada de Stripe y como el documento
  // que ve la marca (DocumentoCotizacion): qué es —con «cantidad ×
  // precio» debajo— y cuánto suma. Con cuatro columnas, a 400 px el total
  // de la línea quedaba detrás del scroll horizontal, y es justo lo que
  // se viene a mirar.
  const columnas: Column<QuoteItemRow>[] = [
    {
      key: "descripcion",
      header: MESSAGES.nueva.descripcion,
      render: (i) => (
        <span className="flex min-w-0 flex-col items-start gap-1 whitespace-normal">
          <CellMain sub={<span className="tabular-nums">{t.cantidadPorPrecio(f.int(i.quantity), dinero(i.unitPrice))}</span>}>
            <span className="break-words">{i.description}</span>
          </CellMain>
          {i.platformId && <PlatformPill platformId={i.platformId} />}
        </span>
      ),
    },
    { key: "total", header: t.totalLinea, align: "num", render: (i) => dinero(i.total) },
  ];

  const acordado = lineasAcordado(
    {
      metrics: quote.agreedMetrics,
      cutsHours: quote.reportCutsHours,
      usageRightsDays: quote.usageRightsDays,
      exclusivityDays: quote.exclusivityDays,
      exclusivityScope: quote.exclusivityScope,
      paymentTermsDays: quote.paymentTermsDays,
      campaignStartsOn: quote.campaignStartsOn,
      campaignEndsOn: quote.campaignEndsOn,
    },
    f,
  );

  // La historia de la cotización, una fecha por estado (Stripe Quotes).
  const historia: { termino: string; valor: string }[] = [
    { termino: t.fechas.creada, valor: f.dateTime(quote.createdAt) },
    ...(quote.sentAt ? [{ termino: t.fechas.enviada, valor: f.dateTime(quote.sentAt) }] : []),
    ...(quote.viewedAt ? [{ termino: t.fechas.vista, valor: f.dateTime(quote.viewedAt) }] : []),
    ...(quote.acceptedAt
      ? [
          {
            termino: t.fechas.aceptada,
            valor: quote.acceptedByName
              ? `${f.dateTime(quote.acceptedAt)} · ${t.aceptadaPor(quote.acceptedByName, quote.acceptedByEmail)}`
              : f.dateTime(quote.acceptedAt),
          },
        ]
      : []),
    ...(quote.rejectedAt ? [{ termino: t.fechas.rechazada, valor: f.dateTime(quote.rejectedAt) }] : []),
    ...(quote.expiredAt ? [{ termino: t.fechas.vencida, valor: f.dateTime(quote.expiredAt) }] : []),
  ];

  return (
    <>
      <PageHeader
        eyebrow={`${t.eyebrow} · ${quote.number}`}
        title={quote.companyName}
        description={dealLabel(quote.companyName, quote.dealName) ?? undefined}
        aside={
          <div className="flex flex-wrap items-center gap-2">
            <Pill kind={pill.kind}>{pill.text}</Pill>
            <Button href={vistaPrevia}>{t.verVistaPrevia}</Button>
            {esBorrador ? (
              <>
                <Button href={`/cotizar/cotizaciones/${quote.id}/editar`}>{t.editar}</Button>
                <EnviarCotizacion id={quote.id} />
              </>
            ) : (
              <CopiarEnlace path={enlace} size="md" />
            )}
          </div>
        }
      />

      {error && (
        <p role="alert" className="mb-6 rounded-md border border-bad/30 bg-bad-wash px-3 py-2 text-sm text-bad">
          {error}
        </p>
      )}
      {enviada && !esBorrador && <AvisoEnviada enviada={enviada} enlace={enlace} />}

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-8">
          <section aria-labelledby="entregables">
            <SectionTitle>
              <span id="entregables">{t.entregables}</span>
            </SectionTitle>
            <DataTable
              columns={columnas}
              rows={quote.items}
              rowKey={(i) => i.id}
              caption={`${t.entregables} · ${quote.number}`}
              emptyState={<span className="text-sm text-muted">—</span>}
            />
          </section>

          <section aria-labelledby="acordado">
            <SectionTitle>
              <span id="acordado">{t.acordado}</span>
            </SectionTitle>
            <dl className="divide-y divide-border rounded-md border border-border">
              {acordado.map((linea) => (
                <div key={linea.termino} className={FILA_DL}>
                  <dt className="text-ink-2">{linea.termino}</dt>
                  <dd className="min-w-0 sm:text-right [overflow-wrap:anywhere]">{linea.valor}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-labelledby="historia">
            <SectionTitle>
              <span id="historia">{t.historia}</span>
            </SectionTitle>
            <dl className="divide-y divide-border rounded-md border border-border">
              {historia.map((linea) => (
                <div key={linea.termino} className={FILA_DL}>
                  <dt className="text-ink-2">{linea.termino}</dt>
                  <dd className="min-w-0 tabular-nums sm:text-right [overflow-wrap:anywhere]">{linea.valor}</dd>
                </div>
              ))}
            </dl>
          </section>

          {esBorrador && (
            <div className="max-w-md">
              <EliminarBorrador id={quote.id} numero={quote.number} />
            </div>
          )}
        </div>

        <aside className="min-w-0 space-y-4 lg:sticky lg:top-8 lg:self-start">
          <div className="rounded-md border border-border p-4">
            <p className="text-xs text-muted">{MESSAGES.nueva.total}</p>
            <p className="mt-1 font-mono text-2xl font-medium tabular-nums">{dinero(quote.total)}</p>
            <div className="mt-4">
              <ResumenTotales
                totales={quote}
                currency={quote.currency}
                f={f}
                etiquetaImpuesto={etiquetaImpuesto(quote.taxRate, f)}
                destacarTotal={false}
              />
            </div>
          </div>

          {!esBorrador && (
            <div className="rounded-md border border-border p-4">
              <p className="text-xs font-medium text-ink-2">{t.enlace}</p>
              <p className="mt-1 break-all font-mono text-xs text-ink-2">{enlace}</p>
              <p className="mt-2 text-xs leading-4 text-muted">{t.enlaceAyuda}</p>
              <p className="mt-2 text-xs text-muted">
                {quote.viewCount > 0 ? t.visitas(quote.viewCount) : t.sinVisitas}
                {quote.validUntil && !validezCerrada ? ` · ${MESSAGES.publico.cotizacion.valida(f.date(quote.validUntil))}` : ""}
              </p>
            </div>
          )}

          {sePuedeCerrar && (
            // Aceptar y rechazar no se deshacen: cada uno pide su segundo
            // paso, y el de rechazar vive aparte, bajo su propia pregunta,
            // para que no quede pegado al de aceptar.
            <div className="space-y-4 rounded-md border border-border p-4">
              <ConfirmarAccion
                action={aceptarCotizacion.bind(null, quote.id)}
                label={t.aceptar}
                variant="primary"
                pregunta={t.confirmar.aceptar.pregunta(quote.number)}
                consecuencia={
                  quote.campaignStartsOn && quote.campaignEndsOn
                    ? t.confirmar.aceptar.consecuencia
                    : t.confirmar.aceptar.consecuenciaSinVentana
                }
                confirmar={t.confirmar.aceptar.boton}
                cancelar={t.confirmar.cancelar}
              />
              <div className="border-t border-border pt-4">
                <p className="mb-2 text-xs text-muted">{t.otraRespuesta}</p>
                <ConfirmarAccion
                  action={rechazarCotizacion.bind(null, quote.id)}
                  label={t.rechazar}
                  variant="danger"
                  pregunta={t.confirmar.rechazar.pregunta(quote.number)}
                  consecuencia={t.confirmar.rechazar.consecuencia}
                  confirmar={t.confirmar.rechazar.boton}
                  cancelar={t.confirmar.cancelar}
                />
              </div>
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
                  <p className="mt-1 text-xs leading-4 text-muted">
                    {quote.campaignStartsOn && quote.campaignEndsOn ? t.campanaPendienteAyuda : t.campanaSinFechas}
                  </p>
                  {quote.campaignStartsOn && quote.campaignEndsOn ? (
                    <form className="mt-3" action={crearCampanaDeCotizacion.bind(null, quote.id)}>
                      <Button size="sm" variant="primary" type="submit">
                        {t.crearCampana}
                      </Button>
                    </form>
                  ) : (
                    // Aceptada sin ventana: una aceptada ya no se edita, así
                    // que las fechas se dan aquí y CAM-2 crea la campaña.
                    <VentanaCampana id={quote.id} />
                  )}
                </>
              )}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
