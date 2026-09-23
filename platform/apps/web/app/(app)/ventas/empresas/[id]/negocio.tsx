"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { crearNegocio } from "../../actions";
import { Aviso } from "../../_componentes/aviso";
import { MESSAGES } from "../../_lib/messages";
import { useVentasForm } from "../../_lib/use-ventas-form";

/**
 * «Nuevo negocio» en la ficha de una empresa: el camino que faltaba
 * para abrir un negocio sin pasar por el radar (una marca creada a
 * mano, un cliente que vuelve). Nace en «Nuevo» con «Enviar pitch» y
 * aparece en la lista de negocios de la ficha con su atajo a Cotizar.
 *
 * El botón abre el formulario en su sitio; al guardar se cierra y el
 * aviso queda a la vista.
 */
export function NuevoNegocio({ companyId, currency }: { companyId: string; currency: string }) {
  const t = MESSAGES.empresas.detail.newDeal;
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [notice, setNotice] = useState<string | undefined>();
  const { state, pending, formRef, onSubmit, errors } = useVentasForm(crearNegocio, (s) => {
    setAmount("");
    setNotice(s.notice);
    setOpen(false);
  });

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setNotice(undefined);
            setOpen(true);
          }}
          aria-expanded={false}
        >
          {t.open}
        </Button>
        <Aviso notice={notice} className="flex-1" />
      </div>
    );
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate aria-labelledby="nuevo-negocio" className="rounded-md border border-border bg-surface p-4">
      <h3 id="nuevo-negocio" className="text-sm font-semibold text-ink">
        {t.title}
      </h3>
      <p className="mt-1 text-xs leading-5 text-muted">{t.help}</p>
      <input type="hidden" name="companyId" value={companyId} />

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label={t.name} error={errors.name} required htmlFor="negocio-nombre">
          <Input name="name" maxLength={120} placeholder={t.namePlaceholder} autoFocus />
        </Field>
        <Field label={t.amount} error={errors.amount} htmlFor="negocio-monto">
          <MoneyInput value={amount} currency={currency} onChange={(v) => setAmount(v)} />
          <input type="hidden" name="amount" value={amount} />
        </Field>
      </div>

      <Aviso message={state.message} className="mt-4" />

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={pending}>
          {t.submit}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
          {MESSAGES.acciones.cancel}
        </Button>
      </div>
    </form>
  );
}
