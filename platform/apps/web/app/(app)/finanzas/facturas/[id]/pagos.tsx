import { rateToPct, PAYMENT_METHOD_LABEL_ES, isPaymentMethod, type InvoiceStatus } from "@mc/core";
import type { InvoiceDetail, InvoicePayments, PaymentRow } from "@mc/db/queries/finanzas";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import type { Formatter } from "@/lib/format";
import { MESSAGES } from "../../_lib/messages";
import { RegistrarPagoForm } from "./pagos-form";

const M = MESSAGES.pagos;

/**
 * Por qué esta factura no admite cobros, o null si sí los admite. Mira
 * el estado PERSISTIDO y no el derivado: `overdue` no se guarda, y una
 * factura vencida es justo la que más falta hace cobrar.
 */
function motivoSinCobro(status: InvoiceStatus): string | null {
  if (status === "draft") return M.notPayable.draft;
  if (status === "paid") return M.notPayable.paid;
  if (status === "void") return M.notPayable.void;
  return null;
}

/** El método con su nombre en español; si viniera uno de antes, se enseña tal cual. */
function metodo(value: string | null): string {
  if (!value) return M.noReference;
  return isPaymentMethod(value) ? PAYMENT_METHOD_LABEL_ES[value] : value;
}

const columnas = (f: Formatter): Column<PaymentRow>[] => [
  {
    key: "receivedOn",
    header: M.columns.date,
    render: (p) => f.date(p.receivedOn, "long"),
  },
  {
    key: "amount",
    header: M.columns.amount,
    align: "num",
    render: (p) => (
      <CellMain
        sub={
          p.reserved && p.reserveRate
            ? M.reservedOf(f.money(p.reserved, p.currency, { mode: "full" }), rateToPct(p.reserveRate))
            : undefined
        }
      >
        {f.money(p.amount, p.currency, { mode: "full" })}
      </CellMain>
    ),
  },
  { key: "method", header: M.columns.method, render: (p) => metodo(p.method) },
  {
    key: "reference",
    header: M.columns.reference,
    render: (p) =>
      p.reference ? <span className="font-mono text-xs">{p.reference}</span> : <span className="text-fg-3">{M.noReference}</span>,
  },
];

export interface SeccionPagosProps {
  invoice: InvoiceDetail;
  pagos: InvoicePayments;
  /** El del espacio: ninguna cifra ni fecha se formatea a mano aquí. */
  f: Formatter;
  /** Moneda y locale del espacio, para el formulario (que corre en el cliente). */
  workspace: { locale: string };
  /** Hoy en la zona del espacio. */
  today: string;
}

/**
 * La sección «Pagos» del detalle: lo que ya se cobró y, si la factura lo
 * admite, el formulario para registrar un cobro más.
 *
 * Sin botón «Anular pago»: no existe en el MVP. Anular un cobro obliga a
 * decidir qué pasa con su apartado de impuestos y a dejar rastro de la
 * anulación; es fase 2 y se dice en vez de esconderlo.
 */
export function SeccionPagos({ invoice, pagos, f, workspace, today }: SeccionPagosProps) {
  const motivo = motivoSinCobro(invoice.status);
  const hayPagos = pagos.rows.length > 0;

  return (
    <section className="rounded-md border border-line p-4" aria-labelledby="pagos">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="pagos" className="text-sm font-semibold">
          {M.title}
        </h2>
        {hayPagos && (
          <p className="text-xs text-fg-3">
            {pagos.reserveRate
              ? `${M.reservedWith(rateToPct(pagos.reserveRate))}: ${f.money(pagos.reservedTotal, invoice.currency, { mode: "full" })}`
              : M.noReserve}
          </p>
        )}
      </div>

      {hayPagos ? (
        <DataTable
          className="mt-3"
          columns={columnas(f)}
          rows={pagos.rows}
          rowKey={(p) => p.id}
          caption={`Cobros de la factura ${invoice.number}`}
          emptyState={M.empty}
        />
      ) : (
        <p className="mt-2 text-sm text-fg-2">
          {M.empty} {motivo === null && M.emptyPayable}
        </p>
      )}

      {motivo === null ? (
        <RegistrarPagoForm
          invoiceId={invoice.id}
          currency={invoice.currency}
          locale={workspace.locale}
          outstanding={invoice.outstanding}
          paidAmount={invoice.paidAmount}
          today={today}
        />
      ) : (
        <p className="mt-4 border-t border-line pt-4 text-sm text-fg-3">{motivo}</p>
      )}

      {hayPagos && <p className="mt-3 text-xs text-fg-3">{M.noVoid}</p>}
    </section>
  );
}
