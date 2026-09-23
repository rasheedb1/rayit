"use client";

import Link from "next/link";
import { useActionState, useId, useMemo, useRef, useState, useTransition, type FormEvent } from "react";
import {
  calcularTotalesCotizacion, compareDecimal, pctToRate, plazoConIncluido, terminosDeModificadores, type PlatformId,
} from "@mc/core";
import type { MediaKitAdjuntable, QuotableDeal, RateCardItem } from "@mc/db/queries/cotizar";
import { Button } from "@/components/ui/button";
import { FechaInput } from "../../_ui/fecha";
import { Field, Input, Select } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { Pill } from "@/components/ui/pill";
import { PlatformPill } from "@/components/ui/platform-pill";
import { formatterFor, type FormatSettings } from "@/lib/format";
import { dealLabel } from "@/lib/negocio";
import type { ActionState } from "@/lib/forms";
import { MESSAGES, nombreMetrica, nombreModificador } from "../../messages";
import { etiquetaImpuesto } from "../../_lib/acordado";
import { precioPropuesto, rangoPropuesto } from "../../_lib/precio";
import { ResumenTotales } from "../../_ui/resumen-totales";

/** Una línea como la escribe el formulario. La cantidad es TEXTO: se tiene que poder vaciar. */
export interface LineaInicial {
  deliverable: string;
  platformId: PlatformId | null;
  description: string;
  quantity: number;
  unitPrice: string;
}

interface Linea extends Omit<LineaInicial, "quantity"> {
  key: string;
  /** El ítem del tarifario del que sale, o "" si es otro entregable. */
  tarifaId: string;
  quantity: string;
}

/** Lo que el formulario muestra al abrirse: vacío para una nueva, el borrador para editar. */
export interface ValoresCotizacion {
  dealId: string;
  lineas: LineaInicial[];
  discount: string;
  /** Porcentaje como lo escribe una persona: «19», «19,5». */
  taxPct: string;
  validUntil: string;
  metricas: string[];
  cortes: number[];
  usageRightsDays: string;
  exclusivityDays: string;
  exclusivityScope: string;
  paymentTermsDays: string;
  campaignStartsOn: string;
  campaignEndsOn: string;
  /** El media kit que la acompaña, o "" si ninguno. */
  mediaKitId: string;
}

export interface CotizacionFormProps {
  /** La Server Action: crearCotizacion, o editarCotizacion ya atada a su id. */
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  creatorId: string;
  /** Solo al crear: el negocio no cambia una vez creada la cotización. */
  deals?: QuotableDeal[];
  /** Los entregables del tarifario vigente (paquetes incluidos). */
  tarifas: RateCardItem[];
  /** Los media kits que la marca puede abrir hoy (públicos y sin vencer), el más reciente primero. */
  mediaKits: MediaKitAdjuntable[];
  settings: FormatSettings;
  currency: string;
  iniciales: ValoresCotizacion;
  textoGuardar: string;
  cancelarHref: string;
}

const METRICAS = ["views", "reach", "interactions", "saves", "shares", "link_clicks", "code_redemptions"];
const CORTES = [24, 168, 720];
const OTRO = "";

/**
 * Un plazo del formulario («30», o "" si no se acordó) subido hasta lo
 * que el precio del tarifario ya incluye. Nunca lo baja.
 */
function subirPlazo(actual: string, incluido: number | null): string {
  const r = plazoConIncluido(actual === "" ? null : Number(actual), incluido);
  return r === null ? "" : String(r);
}

/** Los modificadores de un ítem del tarifario (los fixtures antiguos pueden no traerlos). */
const modificadoresDe = (tarifa: RateCardItem | undefined): string[] => tarifa?.modifierIds ?? [];

/** La tasa del formulario («19,5») como fracción, o null mientras no es un porcentaje válido. */
function tasaDe(pct: string): string | null {
  try {
    const r = pctToRate(pct || "0");
    return Number(r) <= 1 ? r : null;
  } catch {
    return null;
  }
}

/**
 * El formulario de la cotización, para crearla y para editar un
 * borrador: el negocio, los entregables (elegidos del tarifario) y lo
 * que se acuerda antes de publicar.
 *
 * Los totales se calculan aquí con `calcularTotalesCotizacion` de
 * @mc/core, la misma función que el servidor usa al guardar: lo que se
 * ve mientras se escribe es exactamente lo que queda en la base.
 *
 * Un entregable del tarifario cuyo precio ya lleva derechos de uso o
 * exclusividad sube esos plazos en «Lo acordado» al elegirlo (nunca los
 * baja), y la línea dice qué incluye: la marca no puede pagar un 50 % de
 * exclusividad en un documento que dice «Exclusividad: no aplica». El
 * creador puede cambiarlos después; lo que escriba es lo que se guarda.
 *
 * Los ids de los campos salen de useId() y de la posición de la línea:
 * iguales en el servidor y en el navegador, así que la hidratación no
 * choca, y cada `<label>` apunta a su campo (también el del precio). La
 * key de React es un contador del propio componente, que no llega al
 * DOM.
 */
export function CotizacionForm({
  action, creatorId, deals, tarifas, mediaKits, settings, currency, iniciales, textoGuardar, cancelarHref,
}: CotizacionFormProps) {
  const t = MESSAGES.nueva;
  const f = useMemo(() => formatterFor(settings), [settings]);
  const [state, formAction, pendingAccion] = useActionState<ActionState, FormData>(action, {});
  const [pendingEnvio, startTransition] = useTransition();
  const pending = pendingAccion || pendingEnvio;
  const errors = state.errors ?? {};

  const base = useId();
  const n = useRef(0);
  const nuevaKey = () => `${base}linea-${++n.current}`;
  const porId = useMemo(() => new Map(tarifas.map((x) => [x.id, x])), [tarifas]);

  function lineaDesde(tarifa: RateCardItem | undefined): Linea {
    return {
      key: nuevaKey(),
      tarifaId: tarifa?.id ?? OTRO,
      deliverable: tarifa?.deliverable ?? "otro",
      platformId: tarifa?.platformId ?? null,
      description: tarifa?.labelEs ?? "",
      quantity: "1",
      unitPrice: precioPropuesto(tarifa),
    };
  }

  const [dealId, setDealId] = useState(iniciales.dealId);
  const [lineas, setLineas] = useState<Linea[]>(() =>
    iniciales.lineas.length > 0
      ? iniciales.lineas.map((l) => ({
          ...l,
          key: nuevaKey(),
          tarifaId: tarifas.find((x) => x.deliverable === l.deliverable)?.id ?? OTRO,
          quantity: String(l.quantity),
        }))
      : [lineaDesde(tarifas[0])],
  );
  const [discount, setDiscount] = useState(iniciales.discount);
  const [taxPct, setTaxPct] = useState(iniciales.taxPct);
  const [validUntil, setValidUntil] = useState(iniciales.validUntil);
  const [metricas, setMetricas] = useState<string[]>(iniciales.metricas);
  const [cortes, setCortes] = useState<number[]>(iniciales.cortes);
  // Una cotización nueva arranca con el primer entregable del tarifario:
  // sus condiciones incluidas ya cuentan. Un borrador que se edita
  // conserva lo que se guardó.
  const incluidosIniciales = terminosDeModificadores(iniciales.lineas.length > 0 ? [] : modificadoresDe(tarifas[0]));
  const [usageRightsDays, setUsageRightsDays] = useState(() =>
    subirPlazo(iniciales.usageRightsDays, incluidosIniciales.usageRightsDays),
  );
  const [exclusivityDays, setExclusivityDays] = useState(() =>
    subirPlazo(iniciales.exclusivityDays, incluidosIniciales.exclusivityDays),
  );
  const [exclusivityScope, setExclusivityScope] = useState(iniciales.exclusivityScope);
  const [paymentTermsDays, setPaymentTermsDays] = useState(iniciales.paymentTermsDays);
  const [campaignStartsOn, setCampaignStartsOn] = useState(iniciales.campaignStartsOn);
  const [campaignEndsOn, setCampaignEndsOn] = useState(iniciales.campaignEndsOn);
  const [mediaKitId, setMediaKitId] = useState(iniciales.mediaKitId);

  const kitElegido = mediaKits.find((k) => k.id === mediaKitId);
  const tasa = tasaDe(taxPct);
  const totales = useMemo(() => {
    try {
      return calcularTotalesCotizacion({
        items: lineas.map((l) => ({ quantity: Number(l.quantity || "0"), unitPrice: l.unitPrice || "0" })),
        discount: discount || "0",
        taxRate: tasa ?? undefined,
        currency,
      });
    } catch {
      return null;
    }
  }, [lineas, discount, tasa, currency]);

  const payload = {
    dealId,
    items: lineas.map((l) => ({
      deliverable: l.deliverable,
      platformId: l.platformId,
      description: l.description,
      // En blanco cuenta como 0 y lo rechaza la validación (mínimo 1).
      quantity: Number(l.quantity || "0"),
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
    mediaKitId,
  };

  function cambiar(key: string, cambio: Partial<Linea>) {
    setLineas((ls) => ls.map((l) => (l.key === key ? { ...l, ...cambio } : l)));
  }

  /** Sube derechos y exclusividad hasta lo que el precio de esa tarifa ya cobra. */
  function aplicarIncluidos(tarifa: RateCardItem | undefined) {
    const incluidos = terminosDeModificadores(modificadoresDe(tarifa));
    setUsageRightsDays((v) => subirPlazo(v, incluidos.usageRightsDays));
    setExclusivityDays((v) => subirPlazo(v, incluidos.exclusivityDays));
  }

  function elegirTarifa(key: string, tarifaId: string) {
    const tarifa = porId.get(tarifaId);
    if (!tarifa) {
      cambiar(key, { tarifaId: OTRO, deliverable: "otro", platformId: null });
      return;
    }
    cambiar(key, {
      tarifaId,
      deliverable: tarifa.deliverable,
      platformId: tarifa.platformId,
      description: tarifa.labelEs,
      unitPrice: precioPropuesto(tarifa),
    });
    aplicarIncluidos(tarifa);
  }

  function agregarLinea() {
    setLineas((ls) => [...ls, lineaDesde(tarifas[0])]);
    aplicarIncluidos(tarifas[0]);
  }

  /**
   * Enviar sin el reinicio automático de React 19 (`<form action>`): si
   * la acción devuelve un error, el reinicio desmarcaba en el DOM las
   * casillas de métricas y cortes sin que el estado cambiara, igual que
   * en el tarifario.
   */
  function enviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const datos = new FormData(e.currentTarget);
    startTransition(() => formAction(datos));
  }

  function alternar<T>(lista: T[], valor: T, set: (v: T[]) => void) {
    set(lista.includes(valor) ? lista.filter((x) => x !== valor) : [...lista, valor]);
  }

  const opcionesTarifa = [
    ...tarifas.map((x) => ({ value: x.id, label: x.labelEs })),
    { value: OTRO, label: t.otro },
  ];

  return (
    // Tres piezas en la rejilla: el formulario, el total y los botones.
    // En escritorio el total va a la derecha, fijo; en el teléfono va
    // ANTES de «Guardar borrador», para que nadie guarde sin haberlo visto.
    <form
      onSubmit={enviar}
      noValidate
      className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-x-8"
    >
      <input type="hidden" name="creatorId" value={creatorId} />
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />

      <div className="min-w-0 space-y-6 lg:col-start-1 lg:row-start-1">
        {state.message && (
          <p role="alert" className="rounded-md border border-bad/30 bg-bad-wash px-3 py-2 text-sm text-bad">
            {state.message}
          </p>
        )}

        {deals && (
          <Field label={t.negocio} required help={t.negocioAyuda} error={errors.dealId} htmlFor={`${base}deal`}>
            <Select
              name="dealId"
              required
              value={dealId}
              onChange={(e) => setDealId(e.target.value)}
              placeholder={t.sinNegocio}
              options={deals.map((d) => ({
                value: d.id,
                label: [d.companyName, dealLabel(d.companyName, d.name), d.stageLabel].filter(Boolean).join(" · "),
              }))}
            />
          </Field>
        )}

        <section aria-labelledby={`${base}entregables`} className="min-w-0 rounded-md border border-border p-4">
          <h2 id={`${base}entregables`} className="text-sm font-semibold">
            {t.entregables}
          </h2>
          {tarifas.length === 0 && (
            <p className="mt-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-ink-2" data-aviso="sin-tarifario">
              {t.sinTarifario.texto}{" "}
              <Link href="/cotizar" className="font-medium text-ink underline underline-offset-2">
                {t.sinTarifario.accion}
              </Link>
            </p>
          )}
          {errors.items && (
            <p role="alert" className="mt-2 text-sm text-bad">
              {errors.items}
            </p>
          )}
          <ul className="mt-3 space-y-4">
            {lineas.map((l, idx) => {
              // El id del DOM sale de useId y de la posición: igual en el
              // servidor y en el navegador. La key de React es aparte.
              const idLinea = `${base}l${idx}`;
              const tarifa = porId.get(l.tarifaId);
              // El rango tal como lo propone el tarifario (a tres cifras,
              // salvo un precio escrito a mano): el mismo con el que se
              // precarga el precio, así que precargar nunca sale «fuera».
              const rango = rangoPropuesto(tarifa);
              const fuera =
                rango && l.unitPrice
                  ? compareDecimal(l.unitPrice, rango.low) < 0 || compareDecimal(l.unitPrice, rango.high) > 0
                  : false;
              return (
                // Dos filas: qué es (entregable y descripción, a lo ancho) y
                // cuánto (cantidad, precio, quitar). En una sola fila de cinco
                // campos, a 1280 px el selector y la descripción se cortaban
                // («TikTok de…»). El orden del DOM es el visual: el tabulador
                // recorre lo mismo que se lee.
                <li key={l.key} className="space-y-3 border-b border-border pb-4 last:border-b-0 last:pb-0" data-linea={idx}>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label={t.entregable} htmlFor={`${idLinea}-t`}>
                      <Select
                        value={l.tarifaId}
                        onChange={(e) => elegirTarifa(l.key, e.target.value)}
                        options={opcionesTarifa}
                      />
                    </Field>
                    <Field label={t.descripcion} htmlFor={`${idLinea}-d`}>
                      <Input
                        value={l.description}
                        maxLength={200}
                        placeholder={t.descripcionVacia}
                        onChange={(e) => cambiar(l.key, { description: e.target.value })}
                      />
                      {l.platformId && (
                        <span className="mt-1 inline-flex">
                          <PlatformPill platformId={l.platformId} />
                        </span>
                      )}
                    </Field>
                  </div>
                  <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3 sm:grid-cols-[5rem_minmax(0,16rem)_minmax(0,1fr)] sm:items-start">
                    <Field label={t.cantidad} htmlFor={`${idLinea}-q`}>
                      <Input
                        inputMode="numeric"
                        className="text-right font-mono tabular-nums"
                        value={l.quantity}
                        onChange={(e) => cambiar(l.key, { quantity: e.target.value.replace(/\D/g, "").slice(0, 3) })}
                      />
                    </Field>
                    <Field label={t.precio} htmlFor={`${idLinea}-p`}>
                      <MoneyInput
                        id={`${idLinea}-p`}
                        value={l.unitPrice}
                        currency={currency}
                        onChange={(v) => cambiar(l.key, { unitPrice: v })}
                      />
                      {rango && (
                        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                          <span className="tabular-nums">
                            {t.rangoTarifario(
                              f.money(rango.low, currency, { mode: "full" }),
                              f.money(rango.high, currency, { mode: "full" }),
                            )}
                          </span>
                          {fuera && <Pill kind="warn">{t.fueraDeRango}</Pill>}
                        </span>
                      )}
                      {modificadoresDe(tarifa).length > 0 && (
                        <span className="mt-1 block text-xs leading-4 text-muted" data-testid={`incluye-${idx}`}>
                          {t.incluye(modificadoresDe(tarifa).map(nombreModificador))}
                        </span>
                      )}
                    </Field>
                    <div className="col-span-2 sm:col-span-1 sm:justify-self-end sm:pt-6">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setLineas((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : ls))}
                      >
                        {t.quitar}
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="mt-4">
            <Button size="sm" onClick={agregarLinea}>
              {t.agregar}
            </Button>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-3" aria-label={t.total}>
          <Field label={t.descuento} htmlFor={`${base}discount`}>
            <MoneyInput value={discount} currency={currency} onChange={setDiscount} />
          </Field>
          <Field label={t.impuesto} help={t.impuestoAyuda} error={errors.taxPct} htmlFor={`${base}taxPct`}>
            <Input inputMode="decimal" value={taxPct} onChange={(e) => setTaxPct(e.target.value)} />
          </Field>
          <Field label={t.validez} help={t.validezAyuda} error={errors.validUntil} htmlFor={`${base}validUntil`}>
            <FechaInput value={validUntil} onChange={setValidUntil} />
          </Field>
        </section>

        <Field
          label={t.mediaKit}
          help={
            mediaKits.length === 0
              ? t.sinKitsAyuda
              : kitElegido?.hasPassword
                ? t.mediaKitConPassword
                : t.mediaKitAyuda
          }
          error={errors.mediaKitId}
          htmlFor={`${base}mediaKit`}
        >
          <Select
            value={mediaKitId}
            disabled={mediaKits.length === 0 && mediaKitId === ""}
            onChange={(e) => setMediaKitId(e.target.value)}
            options={[
              { value: "", label: t.sinMediaKit },
              ...mediaKits.map((k) => ({
                value: k.id,
                label: t.mediaKitOpcion(f.date(k.createdAt), f.time(k.createdAt), k.hasPassword),
              })),
            ]}
          />
        </Field>

        <section aria-labelledby={`${base}acordado`} className="min-w-0 rounded-md border border-border p-4">
          <h2 id={`${base}acordado`} className="text-sm font-semibold">
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

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t.derechos} htmlFor={`${base}usage`}>
              <Input
                inputMode="numeric"
                value={usageRightsDays}
                onChange={(e) => setUsageRightsDays(e.target.value.replace(/\D/g, ""))}
                placeholder="0"
              />
            </Field>
            <Field label={t.pago} htmlFor={`${base}payment`}>
              <Input
                inputMode="numeric"
                value={paymentTermsDays}
                onChange={(e) => setPaymentTermsDays(e.target.value.replace(/\D/g, ""))}
              />
            </Field>
            <Field label={t.exclusividad} htmlFor={`${base}exclusivity`}>
              <Input
                inputMode="numeric"
                value={exclusivityDays}
                onChange={(e) => setExclusivityDays(e.target.value.replace(/\D/g, ""))}
                placeholder="0"
              />
            </Field>
            <Field label={t.exclusividadAmbito} htmlFor={`${base}scope`}>
              <Input
                value={exclusivityScope}
                maxLength={120}
                onChange={(e) => setExclusivityScope(e.target.value)}
                placeholder={t.exclusividadEjemplo}
              />
            </Field>
          </div>

          <div className="mt-4">
            <p className="text-xs font-medium text-ink-2">{t.ventana}</p>
            <p className="mt-1 text-xs leading-4 text-muted">{t.ventanaAyuda}</p>
            <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t.desde} error={errors.campaignStartsOn} htmlFor={`${base}starts`}>
                <FechaInput value={campaignStartsOn} onChange={setCampaignStartsOn} />
              </Field>
              <Field label={t.hasta} error={errors.campaignEndsOn} htmlFor={`${base}ends`}>
                <FechaInput value={campaignEndsOn} min={campaignStartsOn || undefined} onChange={setCampaignEndsOn} />
              </Field>
            </div>
          </div>
        </section>

      </div>

      <aside
        className="min-w-0 lg:sticky lg:top-8 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start"
        aria-live="polite"
        aria-label={t.total}
      >
        <div className="rounded-md border border-border p-4">
          <p className="text-xs text-muted">{t.total}</p>
          <p className="mt-1 font-mono text-2xl font-medium tabular-nums">
            {totales ? f.money(totales.total, currency, { mode: "full" }) : `${currency} —`}
          </p>
          <div className="mt-4">
            <ResumenTotales
              totales={totales}
              currency={currency}
              f={f}
              etiquetaImpuesto={etiquetaImpuesto(tasa, f)}
              destacarTotal={false}
            />
          </div>
        </div>
      </aside>

      <div className="flex flex-wrap gap-2 lg:col-start-1 lg:row-start-2" data-acciones-formulario>
        <Button type="submit" variant="primary" loading={pending}>
          {textoGuardar}
        </Button>
        <Button variant="ghost" href={cancelarHref}>
          {t.cancelar}
        </Button>
      </div>
    </form>
  );
}
