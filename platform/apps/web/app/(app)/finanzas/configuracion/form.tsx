"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { FINANCE_PLAZO_MAX, FINANCE_TEXT_MAX, type FinanceSettings } from "@mc/core";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { MESSAGES } from "../_lib/messages";
import { guardarConfiguracion, type ConfiguracionState } from "./actions";

const t = MESSAGES.configuracion;
const ESTADO: ConfiguracionState = {};

export interface ConfiguracionFormProps {
  settings: FinanceSettings;
  /** La moneda actual del workspace (workspace.currency), en mayúsculas. */
  currency: string;
  /** Facturas vivas que ya están en esa moneda: cuántas se quedarían atrás si se cambia. */
  facturasVivas: number;
}

/**
 * Un bloque del formulario. Los cuatro son la misma caja para que a 400
 * px se lean como una lista y en escritorio como una ficha.
 */
function Bloque({ titulo, ayuda, children }: { titulo: string; ayuda: string; children: React.ReactNode }) {
  const id = titulo.toLowerCase().replace(/[^a-z]+/g, "-");
  return (
    <section className="rounded-md border border-line p-4" aria-labelledby={id}>
      <h2 id={id} className="text-sm font-semibold">
        {titulo}
      </h2>
      <p className="mt-1 text-xs leading-4 text-fg-3">{ayuda}</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

/**
 * La configuración financiera, por bloques: porcentajes y plazo, moneda,
 * datos para la factura, y cómo te pagan.
 *
 * El formulario NO calcula nada: los porcentajes se guardan tal cual y
 * quien multiplica dinero es @mc/core (pctToRate + mulRateHalfUp) en el
 * servidor. Aquí solo se escriben y se validan.
 */
export function ConfiguracionForm({ settings, currency, facturasVivas }: ConfiguracionFormProps) {
  const [estado, action, pendiente] = useActionState<ConfiguracionState, FormData>(guardarConfiguracion, ESTADO);
  const formRef = useRef<HTMLFormElement>(null);
  const [moneda, setMoneda] = useState(currency);

  const errors = estado.errors ?? {};

  // Foco al primer campo con error cuando el servidor devuelve errores:
  // a 400 px el error puede quedar fuera de la pantalla.
  useEffect(() => {
    if (!estado.errors) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [estado]);

  // El aviso de moneda se pinta mientras se escribe otra distinta, no
  // después de guardar: advertir antes es la mitad del punto.
  const cambiaMoneda = moneda.trim().toUpperCase() !== currency && moneda.trim().length === 3;

  return (
    <form ref={formRef} action={action} noValidate className="grid max-w-3xl gap-6">
      {estado.message && (
        <p role="alert" className="rounded-md border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger">
          {estado.message}
        </p>
      )}

      <Bloque titulo={t.porcentajes.titulo} ayuda={t.porcentajes.ayuda}>
        <Field label={t.porcentajes.iva} help={t.porcentajes.ivaAyuda} required error={errors.ivaPct} htmlFor="ivaPct">
          <Input name="ivaPct" inputMode="decimal" defaultValue={settings.ivaPct} required />
        </Field>
        <Field
          label={t.porcentajes.retencion}
          help={t.porcentajes.retencionAyuda}
          required
          error={errors.retencionPct}
          htmlFor="retencionPct"
        >
          <Input name="retencionPct" inputMode="decimal" defaultValue={settings.retencionPct} required />
        </Field>
        <Field
          label={t.porcentajes.reserva}
          help={t.porcentajes.reservaAyuda}
          required
          error={errors.reservaPct}
          htmlFor="reservaPct"
        >
          <Input name="reservaPct" inputMode="decimal" defaultValue={settings.reservaPct} required />
        </Field>
        <Field
          label={t.porcentajes.plazo}
          help={t.porcentajes.plazoAyuda}
          required
          error={errors.plazoDias}
          htmlFor="plazoDias"
        >
          <Input
            name="plazoDias"
            inputMode="numeric"
            defaultValue={String(settings.plazoDias)}
            max={FINANCE_PLAZO_MAX}
            required
          />
        </Field>
      </Bloque>

      <Bloque titulo={t.moneda.titulo} ayuda={t.moneda.ayuda}>
        <Field label={t.moneda.campo} help={t.moneda.campoAyuda} required error={errors.currency} htmlFor="currency">
          <Input
            name="currency"
            value={moneda}
            onChange={(e) => setMoneda(e.target.value.toUpperCase())}
            maxLength={3}
            autoCapitalize="characters"
            autoComplete="off"
            required
          />
        </Field>
        {cambiaMoneda && facturasVivas > 0 && (
          <p role="status" className="self-end rounded-md border border-warn/40 bg-warn-wash px-3 py-2 text-xs leading-4 text-ink-2 sm:mb-1">
            {t.moneda.aviso(facturasVivas, currency)}
          </p>
        )}
      </Bloque>

      <Bloque titulo={t.fiscales.titulo} ayuda={t.fiscales.ayuda}>
        <Field label={t.fiscales.razonSocial} help={t.fiscales.razonSocialAyuda} error={errors.razonSocial} htmlFor="razonSocial" className="sm:col-span-2">
          <Input name="razonSocial" defaultValue={settings.razonSocial ?? ""} maxLength={FINANCE_TEXT_MAX} />
        </Field>
        <Field label={t.fiscales.identificacion} error={errors.identificacion} htmlFor="identificacion">
          <Input name="identificacion" defaultValue={settings.identificacion ?? ""} maxLength={FINANCE_TEXT_MAX} />
        </Field>
        <Field label={t.fiscales.regimen} help={t.fiscales.regimenAyuda} error={errors.regimen} htmlFor="regimen">
          <Input name="regimen" defaultValue={settings.regimen ?? ""} maxLength={FINANCE_TEXT_MAX} />
        </Field>
        <Field label={t.fiscales.direccion} error={errors.direccion} htmlFor="direccion" className="sm:col-span-2">
          <Input name="direccion" defaultValue={settings.direccion ?? ""} maxLength={FINANCE_TEXT_MAX} />
        </Field>
        <Field
          label={t.fiscales.correo}
          help={t.fiscales.correoAyuda}
          error={errors.correoFacturacion}
          htmlFor="correoFacturacion"
          className="sm:col-span-2"
        >
          <Input
            name="correoFacturacion"
            type="email"
            inputMode="email"
            autoComplete="email"
            defaultValue={settings.correoFacturacion ?? ""}
            maxLength={FINANCE_TEXT_MAX}
          />
        </Field>
      </Bloque>

      <Bloque titulo={t.pago.titulo} ayuda={t.pago.ayuda}>
        <Field label={t.pago.banco} error={errors.banco} htmlFor="banco">
          <Input name="banco" defaultValue={settings.banco ?? ""} maxLength={FINANCE_TEXT_MAX} />
        </Field>
        <Field label={t.pago.cuenta} help={t.pago.cuentaAyuda} error={errors.cuenta} htmlFor="cuenta">
          <Input name="cuenta" defaultValue={settings.cuenta ?? ""} maxLength={FINANCE_TEXT_MAX} />
        </Field>
        <Field label={t.pago.enlace} help={t.pago.enlaceAyuda} error={errors.enlacePago} htmlFor="enlacePago" className="sm:col-span-2">
          <Input
            name="enlacePago"
            type="url"
            inputMode="url"
            placeholder="https://"
            defaultValue={settings.enlacePago ?? ""}
            maxLength={FINANCE_TEXT_MAX}
          />
        </Field>
      </Bloque>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" loading={pendiente}>
          {pendiente ? t.guardando : t.guardar}
        </Button>
        <Button variant="ghost" href="/finanzas">
          {t.volver}
        </Button>
        {estado.ok && (
          <p role="status" className="text-sm text-good">
            {estado.moneda && estado.monedaAnterior && estado.moneda !== estado.monedaAnterior
              ? t.guardadoConMoneda(estado.moneda)
              : t.guardado}
          </p>
        )}
      </div>

      {estado.ok && (estado.facturasEnOtraMoneda ?? 0) > 0 && (
        // La moneda del aviso es la ANTERIOR: es la que tienen esas
        // facturas. `currency` ya es la nueva cuando la pantalla se
        // repinta sin JavaScript.
        <p role="status" className="rounded-md border border-warn/40 bg-warn-wash px-3 py-2 text-sm leading-5 text-ink-2">
          {t.moneda.aviso(estado.facturasEnOtraMoneda ?? 0, estado.monedaAnterior ?? currency)}
        </p>
      )}
    </form>
  );
}
