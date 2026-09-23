"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { addDays, computeInvoiceTotals, pctToRate, subtotalFromTotal, type InvoiceTotals } from "@mc/core";
import type { CampaignOption, CompanyOption } from "@mc/db/queries/finanzas";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, Input, Select } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { formatMoney } from "@/lib/format";
import { crearFactura, type CrearFacturaState } from "../actions";

export interface NuevaFacturaFormProps {
  companies: CompanyOption[];
  campaigns: CampaignOption[];
  /** Moneda y locale del workspace: el formulario no los adivina (ver lib/workspace/settings.ts). */
  workspace: { currency: string; locale: string };
  /**
   * Lo que trae la configuración financiera del workspace (FIN-8): con
   * qué porcentajes y con qué plazo nace la factura. Antes eran
   * DEFAULT_TAX_RATE y DEFAULT_WITHHOLDING_RATE de @mc/core y un 30
   * escrito a mano; Colombia es el valor por defecto de un workspace, no
   * una constante del producto.
   */
  defaults: {
    issuedOn: string;
    dueOn: string;
    campaignId?: string;
    /** Porcentaje, no fracción: "19". */
    taxPct: string;
    /** Porcentaje, no fracción: "11". */
    withholdingPct: string;
    plazoDias: number;
  };
  /** Mensaje que llega por la URL (p. ej. «Facturar» desde Campañas falló). */
  initialMessage?: string;
}

const CAMPAIGN_STATUS_ES: Record<string, string> = {
  planned: "planeada",
  live: "en curso",
  measuring: "midiendo",
  reported: "reportada",
  closed: "cerrada",
  cancelled: "cancelada",
};

/** Totales en vivo con la función de core; null mientras el formulario está incompleto. */
function liveTotals(subtotal: string, taxPct: string, withholdingPct: string): InvoiceTotals | null {
  if (!subtotal) return null;
  try {
    return computeInvoiceTotals({ subtotal, taxRate: pctToRate(taxPct), withholdingRate: pctToRate(withholdingPct) });
  } catch {
    return null;
  }
}

export function NuevaFacturaForm({ companies, campaigns, workspace, defaults, initialMessage }: NuevaFacturaFormProps) {
  const { currency, locale } = workspace;
  const money = (amount: string) => formatMoney(amount, currency, { mode: "full", locale });
  const [state, formAction, pending] = useActionState<CrearFacturaState, FormData>(crearFactura, {});
  const formRef = useRef<HTMLFormElement>(null);

  const initialCampaign = campaigns.find((c) => c.id === defaults.campaignId);
  const [campaignId, setCampaignId] = useState(initialCampaign?.id ?? "");
  const [companyId, setCompanyId] = useState(initialCampaign?.companyId ?? "");
  // Con la tasa CONFIGURADA, no con el 19 % que subtotalFromTotal pone
  // por omisión: en un workspace al 16 %, subtotal + IVA tiene que volver
  // a dar el monto acordado con la marca. pickCampaign ya lo hacía bien;
  // este camino —llegar con ?campana= desde el botón «Facturar»— se
  // quedó atrás.
  const [subtotal, setSubtotal] = useState(
    initialCampaign?.amount ? subtotalFromTotal(initialCampaign.amount, pctToRate(defaults.taxPct)) : "",
  );
  const [taxPct, setTaxPct] = useState(defaults.taxPct);
  const [withholdingPct, setWithholdingPct] = useState(defaults.withholdingPct);
  const [issuedOn, setIssuedOn] = useState(defaults.issuedOn);
  const [dueOn, setDueOn] = useState(defaults.dueOn);
  const [dueTouched, setDueTouched] = useState(false);
  const [externalRef, setExternalRef] = useState("");

  const errors = state.errors ?? {};
  const totals = useMemo(() => liveTotals(subtotal, taxPct, withholdingPct), [subtotal, taxPct, withholdingPct]);

  // Foco al primer campo con error cuando el servidor devuelve errores.
  useEffect(() => {
    if (!state.errors) return;
    const first = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    first?.focus();
  }, [state]);

  function pickCampaign(id: string) {
    setCampaignId(id);
    const c = campaigns.find((x) => x.id === id);
    if (!c) return;
    // Prellena empresa y monto. El amount de la campaña es lo acordado
    // con IVA incluido: se descompone en subtotal + IVA con la tasa actual.
    setCompanyId(c.companyId);
    if (c.amount) setSubtotal(subtotalFromTotal(c.amount, pctToRate(taxPct)));
  }

  function changeIssuedOn(v: string) {
    setIssuedOn(v);
    // Vencimiento = emisión + el plazo CONFIGURADO, mientras la persona
    // no lo haya tocado. El 30 estaba escrito a mano aquí y en la
    // página; ahora los dos leen defaults.plazoDias (FIN-8).
    if (!dueTouched && /^\d{4}-\d{2}-\d{2}$/.test(v)) setDueOn(addDays(v, defaults.plazoDias));
  }

  const message = state.message ?? initialMessage;

  return (
    <form ref={formRef} action={formAction} noValidate className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-6">
        {message && (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger">
            {message}
          </p>
        )}

        <section className="rounded-md border border-line p-4" aria-labelledby="desde-campana">
          <h2 id="desde-campana" className="text-sm font-semibold">
            Desde una campaña
          </h2>
          <p className="mt-1 text-xs text-fg-3">Opcional. Prellena la empresa y el monto acordado; la factura queda enlazada a la campaña.</p>
          <div className="mt-3">
            <Field label="Campaña" htmlFor="campaignId">
              <Select
                name="campaignId"
                value={campaignId}
                onChange={(e) => pickCampaign(e.target.value)}
                placeholder="Sin campaña · factura a mano"
                options={campaigns.map((c) => ({
                  value: c.id,
                  label: `${c.companyName} · ${c.name}${c.amount ? ` · ${formatMoney(c.amount, c.currency, { mode: "full", locale })}` : ""} · ${CAMPAIGN_STATUS_ES[c.status] ?? c.status}`,
                }))}
              />
            </Field>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2" aria-label="Datos de la factura">
          <Field label="Empresa" required error={errors.companyId} htmlFor="companyId" className="sm:col-span-2">
            <Select
              name="companyId"
              required
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              placeholder="Elige la marca"
              options={companies.map((c) => ({ value: c.id, label: c.name }))}
            />
          </Field>

          <Field label="Subtotal" required help="Sin IVA. El total se calcula abajo." error={errors.subtotal} htmlFor="subtotal">
            <MoneyInput value={subtotal} currency={currency} onChange={(v) => setSubtotal(v)} required />
            {/* El MoneyInput muestra "2.605.042,02"; al servidor viaja el decimal normalizado. */}
            <input type="hidden" name="subtotal" value={subtotal} />
          </Field>

          {/* La moneda es la del workspace: se muestra, no se elige (CIM-2 r4). */}
          <Field label="Moneda" help="La del workspace. Se cambia en sus ajustes." htmlFor="currency">
            <Input name="currency" value={currency} disabled readOnly />
          </Field>

          <Field label="IVA %" required error={errors.taxPct} htmlFor="taxPct">
            <Input name="taxPct" inputMode="decimal" value={taxPct} onChange={(e) => setTaxPct(e.target.value)} required />
          </Field>

          <Field
            label="Retención en la fuente %"
            required
            help="Lo que la marca retiene al pagar. No se resta del total."
            error={errors.withholdingPct}
            htmlFor="withholdingPct"
          >
            <Input name="withholdingPct" inputMode="decimal" value={withholdingPct} onChange={(e) => setWithholdingPct(e.target.value)} required />
          </Field>

          <Field label="Emisión" required error={errors.issuedOn} htmlFor="issuedOn">
            <DateInput name="issuedOn" value={issuedOn} onChange={changeIssuedOn} required />
          </Field>

          <Field
            label="Vencimiento"
            required
            help={
              defaults.plazoDias === 0
                ? "Tu configuración dice pago contra entrega: vence el mismo día."
                : `Por defecto, ${defaults.plazoDias} días después de la emisión (tu configuración).`
            }
            error={errors.dueOn}
            htmlFor="dueOn"
          >
            <DateInput
              name="dueOn"
              value={dueOn}
              min={issuedOn || undefined}
              onChange={(v) => {
                setDueTouched(true);
                setDueOn(v);
              }}
              required
            />
          </Field>

          <Field
            label="Número de factura electrónica (DIAN)"
            help="Opcional. Se puede agregar después, cuando la DIAN la valide."
            error={errors.externalRef}
            htmlFor="externalRef"
            className="sm:col-span-2"
          >
            <Input name="externalRef" value={externalRef} onChange={(e) => setExternalRef(e.target.value)} placeholder="FE-26-0012" maxLength={80} />
          </Field>
        </section>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={pending}>
            Guardar borrador
          </Button>
          <Button variant="ghost" href="/finanzas">
            Cancelar
          </Button>
        </div>
      </div>

      <aside className="lg:sticky lg:top-8 lg:self-start" aria-live="polite" aria-label="Total en vivo">
        <div className="rounded-md border border-line p-4">
          <p className="text-xs text-fg-3">Total de la factura</p>
          <p className="mt-1 font-mono text-2xl font-medium tabular-nums">
            {totals ? money(totals.total) : `${currency} —`}
          </p>
          <dl className="mt-4 space-y-1.5 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-fg-2">Subtotal</dt>
              <dd className="font-mono tabular-nums">{totals ? money(totals.subtotal) : "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-fg-2">IVA {taxPct || "0"} %</dt>
              <dd className="font-mono tabular-nums">{totals ? money(totals.tax) : "—"}</dd>
            </div>
            <div className="flex justify-between gap-3 border-t border-line pt-1.5">
              <dt className="font-medium">Total</dt>
              <dd className="font-mono font-medium tabular-nums">{totals ? money(totals.total) : "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-fg-2">Retención {withholdingPct || "0"} %</dt>
              <dd className="font-mono tabular-nums text-fg-2">{totals ? `−${money(totals.withholding)}` : "—"}</dd>
            </div>
            <div className="flex justify-between gap-3 border-t border-line pt-1.5">
              <dt className="text-fg-2">Neto que entra al banco</dt>
              <dd className="font-mono tabular-nums">{totals ? money(totals.net) : "—"}</dd>
            </div>
          </dl>
          <p className="mt-4 text-xs leading-4 text-fg-3">Calculado en el navegador con la misma función que usa el servidor al guardar.</p>
        </div>
      </aside>
    </form>
  );
}
