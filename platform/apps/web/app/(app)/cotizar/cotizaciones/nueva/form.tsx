"use client";

import { useActionState, useMemo, useState } from "react";
import { calcularTotalesCotizacion } from "@mc/core";
import type { QuotableDeal, RateCardItem } from "@mc/db/queries/cotizar";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, Input, Select } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { PlatformPill } from "@/components/ui/platform-pill";
import { formatterFor, type FormatSettings } from "@/lib/format";
import type { ActionState } from "@/lib/forms";
import { crearCotizacion } from "../../actions";
import { MESSAGES, nombreMetrica } from "../../messages";

type PlatformId = "tiktok" | "instagram" | "facebook" | "youtube";

interface Linea {
  key: string;
  deliverable: string;
  platformId: PlatformId | null;
  description: string;
  quantity: number;
  unitPrice: string;
}

export interface NuevaCotizacionFormProps {
  creatorId: string;
  deals: QuotableDeal[];
  /** Los entregables del tarifario vigente, para arrancar con precios que ya se explicaron. */
  tarifas: RateCardItem[];
  settings: FormatSettings;
  currency: string;
  /** Por defecto: hoy + 14 y la ventana de campaña sugerida. */
  fechas: { validUntil: string; campaignStartsOn: string; campaignEndsOn: string };
}

const METRICAS = ["views", "reach", "interactions", "saves", "shares", "link_clicks", "code_redemptions"];
const CORTES = [24, 168, 720];

let contador = 0;
const nuevaKey = () => `linea-${++contador}`;

/** Una línea a partir de un entregable del tarifario, o vacía si todavía no hay. */
function lineaDesde(tarifa?: RateCardItem): Linea {
  return {
    key: nuevaKey(),
    deliverable: tarifa?.deliverable ?? "otro",
    platformId: tarifa?.platformId ?? null,
    description: tarifa?.labelEs ?? "",
    quantity: 1,
    unitPrice: tarifa?.priceLow ?? "0",
  };
}

/**
 * Nueva cotización: el negocio, los entregables (que arrancan del
 * tarifario) y lo que se acuerda antes de publicar.
 *
 * Los totales se calculan aquí con `calcularTotalesCotizacion` de
 * @mc/core, la misma función que el servidor usa al guardar: lo que se
 * ve mientras se escribe es exactamente lo que queda en la base.
 */
export function NuevaCotizacionForm({ creatorId, deals, tarifas, settings, currency, fechas }: NuevaCotizacionFormProps) {
  const t = MESSAGES.nueva;
  const f = useMemo(() => formatterFor(settings), [settings]);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(crearCotizacion, {});
  const errors = state.errors ?? {};

  const [dealId, setDealId] = useState("");
  // Siempre arranca con una línea: sin tarifario guardado, vacía.
  const [lineas, setLineas] = useState<Linea[]>(() => [lineaDesde(tarifas[0])]);
  const [discount, setDiscount] = useState("0");
  const [taxPct, setTaxPct] = useState("19");
  const [validUntil, setValidUntil] = useState(fechas.validUntil);
  const [metricas, setMetricas] = useState<string[]>(["views", "reach", "saves"]);
  const [cortes, setCortes] = useState<number[]>(CORTES);
  const [usageRightsDays, setUsageRightsDays] = useState("30");
  const [exclusivityDays, setExclusivityDays] = useState("");
  const [exclusivityScope, setExclusivityScope] = useState("");
  const [paymentTermsDays, setPaymentTermsDays] = useState("30");
  const [campaignStartsOn, setCampaignStartsOn] = useState(fechas.campaignStartsOn);
  const [campaignEndsOn, setCampaignEndsOn] = useState(fechas.campaignEndsOn);

  const totales = useMemo(() => {
    try {
      return calcularTotalesCotizacion({
        items: lineas.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice || "0" })),
        discount: discount || "0",
        taxRate: (Number(taxPct.replace(",", ".")) / 100).toFixed(6),
      });
    } catch {
      return null;
    }
  }, [lineas, discount, taxPct]);

  const payload = {
    dealId,
    items: lineas.map((l) => ({
      deliverable: l.deliverable,
      platformId: l.platformId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice || "0",
    })),
    discount,
    taxPct,
    validUntil,
    agreedMetrics: metricas,
    reportCutsHours: cortes,
    usageRightsDays: usageRightsDays === "" ? null : Number(usageRightsDays),
    exclusivityDays: exclusivityDays === "" ? null : Number(exclusivityDays),
    exclusivityScope,
    paymentTermsDays: Number(paymentTermsDays || "0"),
    campaignStartsOn,
    campaignEndsOn,
  };

  function agregar() {
    setLineas((ls) => [...ls, lineaDesde(tarifas[ls.length % Math.max(tarifas.length, 1)])]);
  }

  function cambiar(key: string, campo: keyof Linea, valor: string | number) {
    setLineas((ls) => ls.map((l) => (l.key === key ? { ...l, [campo]: valor } : l)));
  }

  function alternar<T>(lista: T[], valor: T, set: (v: T[]) => void) {
    set(lista.includes(valor) ? lista.filter((x) => x !== valor) : [...lista, valor]);
  }

  return (
    <form action={formAction} noValidate className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
      <input type="hidden" name="creatorId" value={creatorId} />
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />

      <div className="space-y-6">
        {state.message && (
          <p role="alert" className="rounded-md border border-bad/30 bg-bad-wash px-3 py-2 text-sm text-bad">
            {state.message}
          </p>
        )}

        <Field label={t.negocio} required help={t.negocioAyuda} error={errors.dealId} htmlFor="dealId">
          <Select
            name="dealId"
            required
            value={dealId}
            onChange={(e) => setDealId(e.target.value)}
            placeholder={t.sinNegocio}
            options={deals.map((d) => ({
              value: d.id,
              label: `${d.companyName} · ${d.name} · ${d.stageLabel}`,
            }))}
          />
        </Field>

        <section aria-labelledby="entregables" className="rounded-md border border-border p-4">
          <h2 id="entregables" className="text-sm font-semibold">
            {t.entregables}
          </h2>
          {errors.items && (
            <p role="alert" className="mt-2 text-sm text-bad">
              {errors.items}
            </p>
          )}
          <ul className="mt-3 space-y-4">
            {lineas.map((l) => (
              <li key={l.key} className="grid gap-3 border-b border-border pb-4 last:border-b-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_5rem_10rem_auto] sm:items-end">
                <Field label={t.descripcion} htmlFor={`d-${l.key}`}>
                  <Input
                    id={`d-${l.key}`}
                    value={l.description}
                    maxLength={200}
                    placeholder={t.descripcionVacia}
                    onChange={(e) => cambiar(l.key, "description", e.target.value)}
                  />
                  {l.platformId && (
                    <span className="mt-1 inline-flex">
                      <PlatformPill platformId={l.platformId} />
                    </span>
                  )}
                </Field>
                <Field label={t.cantidad} htmlFor={`q-${l.key}`}>
                  <Input
                    id={`q-${l.key}`}
                    inputMode="numeric"
                    className="text-right font-mono tabular-nums"
                    value={String(l.quantity)}
                    onChange={(e) => cambiar(l.key, "quantity", Math.max(1, Number(e.target.value.replace(/\D/g, "")) || 1))}
                  />
                </Field>
                <Field label={t.precio} htmlFor={`p-${l.key}`}>
                  <MoneyInput value={l.unitPrice} currency={currency} onChange={(v) => cambiar(l.key, "unitPrice", v)} />
                </Field>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setLineas((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : ls))}
                >
                  {t.quitar}
                </Button>
              </li>
            ))}
          </ul>
          <div className="mt-4">
            <Button size="sm" onClick={agregar}>
              {t.agregar}
            </Button>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-3" aria-label={t.total}>
          <Field label={t.descuento} htmlFor="discount">
            <MoneyInput value={discount} currency={currency} onChange={setDiscount} />
          </Field>
          <Field label={t.impuesto} help={t.impuestoAyuda} error={errors.taxPct} htmlFor="taxPct">
            <Input inputMode="decimal" value={taxPct} onChange={(e) => setTaxPct(e.target.value)} />
          </Field>
          <Field label={t.validez} help={t.validezAyuda} error={errors.validUntil} htmlFor="validUntil">
            <DateInput value={validUntil} onChange={setValidUntil} />
          </Field>
        </section>

        <section aria-labelledby="acordado" className="rounded-md border border-border p-4">
          <h2 id="acordado" className="text-sm font-semibold">
            {t.acordado}
          </h2>
          <p className="mt-1 text-xs leading-4 text-muted">{t.acordadoAyuda}</p>

          <fieldset className="mt-4">
            <legend className="text-xs font-medium text-ink-2">{t.metricas}</legend>
            <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
              {METRICAS.map((m) => (
                <li key={m}>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[var(--accent)]"
                      checked={metricas.includes(m)}
                      onChange={() => alternar(metricas, m, setMetricas)}
                    />
                    {nombreMetrica(m)}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>

          <fieldset className="mt-4">
            <legend className="text-xs font-medium text-ink-2">{t.cortes}</legend>
            <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
              {CORTES.map((c) => (
                <li key={c}>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[var(--accent)]"
                      checked={cortes.includes(c)}
                      onChange={() => alternar(cortes, c, setCortes)}
                    />
                    {MESSAGES.detalle.horas(c)}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label={t.derechos} htmlFor="usageRightsDays">
              <Input
                inputMode="numeric"
                value={usageRightsDays}
                onChange={(e) => setUsageRightsDays(e.target.value.replace(/\D/g, ""))}
                placeholder="0"
              />
            </Field>
            <Field label={t.pago} htmlFor="paymentTermsDays">
              <Input
                inputMode="numeric"
                value={paymentTermsDays}
                onChange={(e) => setPaymentTermsDays(e.target.value.replace(/\D/g, ""))}
              />
            </Field>
            <Field label={t.exclusividad} htmlFor="exclusivityDays">
              <Input
                inputMode="numeric"
                value={exclusivityDays}
                onChange={(e) => setExclusivityDays(e.target.value.replace(/\D/g, ""))}
                placeholder="0"
              />
            </Field>
            <Field label={t.exclusividadAmbito} htmlFor="exclusivityScope">
              <Input
                value={exclusivityScope}
                maxLength={120}
                onChange={(e) => setExclusivityScope(e.target.value)}
                placeholder="Café de especialidad"
              />
            </Field>
          </div>

          <div className="mt-4">
            <p className="text-xs font-medium text-ink-2">{t.ventana}</p>
            <p className="mt-1 text-xs leading-4 text-muted">{t.ventanaAyuda}</p>
            <div className="mt-2 grid gap-4 sm:grid-cols-2">
              <Field label={t.desde} error={errors.campaignStartsOn} htmlFor="campaignStartsOn">
                <DateInput value={campaignStartsOn} onChange={setCampaignStartsOn} />
              </Field>
              <Field label={t.hasta} error={errors.campaignEndsOn} htmlFor="campaignEndsOn">
                <DateInput value={campaignEndsOn} min={campaignStartsOn || undefined} onChange={setCampaignEndsOn} />
              </Field>
            </div>
          </div>
        </section>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={pending}>
            {t.guardar}
          </Button>
          <Button variant="ghost" href="/cotizar/cotizaciones">
            {t.cancelar}
          </Button>
        </div>
      </div>

      <aside className="lg:sticky lg:top-8 lg:self-start" aria-live="polite" aria-label={t.total}>
        <div className="rounded-md border border-border p-4">
          <p className="text-xs text-muted">{t.total}</p>
          <p className="mt-1 font-mono text-2xl font-medium tabular-nums">
            {totales ? f.money(totales.total, currency, { mode: "full" }) : `${currency} —`}
          </p>
          <dl className="mt-4 space-y-1.5 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-ink-2">{t.subtotal}</dt>
              <dd className="font-mono tabular-nums">{totales ? f.money(totales.subtotal, currency, { mode: "full" }) : "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-2">{t.descuento}</dt>
              <dd className="font-mono tabular-nums">{totales ? `−${f.money(totales.discount, currency, { mode: "full" })}` : "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-2">{t.impuestoAplicado(taxPct || "0")}</dt>
              <dd className="font-mono tabular-nums">{totales ? f.money(totales.tax, currency, { mode: "full" }) : "—"}</dd>
            </div>
            <div className="flex justify-between gap-3 border-t border-border pt-1.5">
              <dt className="font-medium">{t.total}</dt>
              <dd className="font-mono font-medium tabular-nums">{totales ? f.money(totales.total, currency, { mode: "full" }) : "—"}</dd>
            </div>
          </dl>
        </div>
      </aside>
    </form>
  );
}
