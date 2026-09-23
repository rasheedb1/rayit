import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hoyEnZona, rateToPct, INVOICE_STATUS_LABEL_ES } from "@mc/core";
import { getInvoice, listPayments } from "@mc/db/queries/finanzas";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { formatterFor, type Formatter } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../../_lib/db";
import { MESSAGES } from "../../_lib/messages";
import { pillForInvoice } from "../../_lib/estado";
import { cambiarEstadoFactura } from "../actions";
import { SeccionPagos } from "./pagos";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const invoice = await withWorkspace((tx) => getInvoice(tx, id));
  return { title: invoice ? `Factura ${invoice.number}` : "Factura" };
}

function Row({ label, value, strong = false, muted = false }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className={`text-sm ${strong ? "font-medium text-fg" : "text-fg-2"}`}>{label}</dt>
      <dd className={`font-mono text-sm tabular-nums ${strong ? "font-medium" : ""} ${muted ? "text-fg-3" : ""}`}>{value}</dd>
    </div>
  );
}

/** Un monto de la factura, en la moneda con la que se emitió y el locale del workspace. */
function monto(f: Formatter, amount: string, currency: string): string {
  return f.money(amount, currency, { mode: "full" });
}

/** Tasa efectiva a partir de los montos guardados, para mostrar "IVA 19 %". */
function pctOf(part: string, base: string): string | null {
  const cents = (s: string) => {
    const [i = "0", f = ""] = s.split(".");
    return BigInt(i) * 100n + BigInt((f + "00").slice(0, 2));
  };
  const b = cents(base);
  if (b === 0n) return null;
  // Tasa en diezmilésimas (0.1900 → 1900), redondeada half-up, sin float.
  const permyriad = (cents(part) * 10000n + b / 2n) / b;
  const rate = `${permyriad / 10000n}.${(permyriad % 10000n).toString().padStart(4, "0")}`;
  return rateToPct(rate);
}

export default async function FacturaPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  // Una sola transacción para la factura y sus cobros: dos withWorkspace
  // seguidos podrían leer estados distintos si entra un pago en medio.
  const { invoice, pagos } = await withWorkspace(async (tx) => ({
    invoice: await getInvoice(tx, id),
    pagos: await listPayments(tx, id),
  }));
  if (!invoice) notFound();
  // Locale, moneda y zona horaria del workspace, atados: esta pantalla
  // formateaba con es-CO fijo mientras la lista de facturas ya usaba el
  // del workspace, así que un workspace en MXN/en-US veía dos formatos
  // de número en el mismo flujo.
  const ws = await getCurrentWorkspace();
  const f = formatterFor(ws);
  // El día de hoy EN LA ZONA DEL ESPACIO: es el que propone el
  // formulario y su tope. new Date() en el servidor está en la zona del
  // proceso, que en Vercel es UTC y no la del creador.
  const hoy = hoyEnZona(ws.timezone);

  const pill = pillForInvoice(invoice);
  const puedeEnviar = invoice.status === "draft";
  const puedeAnular = invoice.status === "draft" || invoice.status === "sent";
  const ivaPct = pctOf(invoice.tax, invoice.subtotal);
  const retPct = pctOf(invoice.withholding, invoice.subtotal);

  return (
    <>
      <PageHeader
        eyebrow="Finanzas · facturas"
        title={`Factura ${invoice.number}`}
        description={`${invoice.companyName}${invoice.campaignName ? ` · ${invoice.campaignName}` : " · sin campaña"}`}
        aside={
          <Button variant="ghost" href="/finanzas">
            Volver a facturas
          </Button>
        }
      />

      {error && (
        <p role="alert" className="mb-6 rounded-md border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-8">
          <section className="rounded-md border border-line p-4" aria-labelledby="montos">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="montos" className="text-sm font-semibold">
                Montos
              </h2>
              <Pill kind={pill.kind}>{pill.text}</Pill>
            </div>
            <dl className="mt-3 divide-y divide-line">
              <Row label="Subtotal" value={monto(f, invoice.subtotal, invoice.currency)} />
              <Row label={`IVA${ivaPct ? ` ${ivaPct} %` : ""}`} value={monto(f, invoice.tax, invoice.currency)} />
              <Row label="Total de la factura" value={monto(f, invoice.total, invoice.currency)} strong />
              <Row label={`Retención en la fuente${retPct ? ` ${retPct} %` : ""}`} value={`−${monto(f, invoice.withholding, invoice.currency)}`} muted />
              <Row label="Neto que entra al banco" value={monto(f, invoice.net, invoice.currency)} />
              <Row label="Pagado" value={monto(f, invoice.paidAmount, invoice.currency)} muted />
              <Row label="Pendiente por cobrar" value={monto(f, invoice.outstanding, invoice.currency)} strong />
              {pagos.rows.length > 0 && (
                <Row
                  label={pagos.reserveRate ? MESSAGES.pagos.reservedWith(rateToPct(pagos.reserveRate)) : MESSAGES.pagos.reserved}
                  value={monto(f, pagos.reservedTotal, invoice.currency)}
                  muted
                />
              )}
            </dl>
          </section>

          <section className="rounded-md border border-line p-4" aria-labelledby="datos">
            <h2 id="datos" className="text-sm font-semibold">
              Datos
            </h2>
            <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-fg-3">Empresa</dt>
                <dd className="text-sm">{invoice.companyName}</dd>
              </div>
              <div>
                <dt className="text-xs text-fg-3">Campaña</dt>
                <dd className="text-sm">{invoice.campaignName ?? <span className="text-fg-3">Sin campaña</span>}</dd>
              </div>
              <div>
                <dt className="text-xs text-fg-3">Emisión</dt>
                <dd className="text-sm">{f.date(invoice.issuedOn, "long")}</dd>
              </div>
              <div>
                <dt className="text-xs text-fg-3">Vencimiento</dt>
                <dd className="text-sm">
                  {f.date(invoice.dueOn, "long")}
                  {invoice.bucket !== "pagada" && invoice.bucket !== "anulada" && invoice.bucket !== "borrador" && (
                    <span className="text-fg-3"> · {f.daysRelative(invoice.daysToDue)}</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-fg-3">Número de factura electrónica (DIAN)</dt>
                <dd className="font-mono text-sm">{invoice.externalRef ?? <span className="font-sans text-fg-3">Sin registrar</span>}</dd>
              </div>
              <div>
                <dt className="text-xs text-fg-3">Estado</dt>
                <dd className="text-sm">
                  {INVOICE_STATUS_LABEL_ES[invoice.derivedStatus]}
                  {invoice.derivedStatus !== invoice.status && (
                    <span className="text-fg-3"> · derivado del vencimiento; guardada como {INVOICE_STATUS_LABEL_ES[invoice.status].toLowerCase()}</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-fg-3">Recordatorios enviados</dt>
                <dd className="text-sm">
                  {invoice.remindersSent}
                  {invoice.lastReminderAt && <span className="text-fg-3"> · último el {f.date(invoice.lastReminderAt)}</span>}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-fg-3">Pagada el</dt>
                <dd className="text-sm">
                  {invoice.paidAt ? (
                    f.date(invoice.paidAt, "long")
                  ) : (
                    <span className="text-fg-3">Todavía no se ha cobrado por completo</span>
                  )}
                </dd>
              </div>
            </dl>
          </section>

          <SeccionPagos invoice={invoice} pagos={pagos} f={f} workspace={{ locale: ws.locale }} today={hoy} />
        </div>

        <aside className="lg:sticky lg:top-8 lg:self-start">
          <div className="rounded-md border border-line p-4">
            <SectionTitle>Acciones</SectionTitle>
            <div className="flex flex-col gap-2">
              {puedeEnviar && (
                <form action={cambiarEstadoFactura.bind(null, invoice.id, "sent")}>
                  <Button type="submit" variant="primary" className="w-full">
                    Marcar enviada
                  </Button>
                </form>
              )}
              {puedeAnular && (
                <form action={cambiarEstadoFactura.bind(null, invoice.id, "void")}>
                  <Button type="submit" variant="danger" className="w-full">
                    Anular
                  </Button>
                </form>
              )}
              {!puedeEnviar && !puedeAnular && (
                <p className="text-xs text-fg-3">
                  Una factura {INVOICE_STATUS_LABEL_ES[invoice.status].toLowerCase()} no admite más cambios de estado desde aquí.
                </p>
              )}
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}
