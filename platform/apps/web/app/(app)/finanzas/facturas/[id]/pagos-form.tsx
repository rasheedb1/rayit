"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABEL_ES } from "@mc/core";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { formatMoney } from "@/lib/format";
import type { ActionState } from "@/lib/forms";
import { MESSAGES } from "../../_lib/messages";
import { registrarPago } from "../actions";

const M = MESSAGES.pagos.form;

export interface RegistrarPagoFormProps {
  invoiceId: string;
  /** La de la factura: el cobro va en ella, no se elige. */
  currency: string;
  /** El del espacio, para escribir las cifras como en el resto del producto. */
  locale: string;
  /** Lo que queda por cobrar. Es el valor sugerido del monto. */
  outstanding: string;
  /**
   * El `paid_amount` que ESTA pantalla vio. Viaja oculto y la consulta lo
   * compara dentro de la transacción: si ya no es ese, el cobro no entra.
   * Es la guardia del doble envío (docs/propuestas/FIN-2.md §0.5).
   */
  paidAmount: string;
  /** Hoy en la zona del espacio. Es el valor sugerido de la fecha y su tope. */
  today: string;
}

/**
 * El formulario de «Registrar pago». Solo se dibuja sobre una factura
 * que admite cobro; quién puede cobrarla lo decide la Server Action.
 *
 * Los valores sugeridos (el saldo, hoy) viven como `null` mientras nadie
 * los toca: así, cuando la acción termina y el servidor vuelve a
 * dibujar la pantalla con el saldo nuevo, el formulario lo toma solo en
 * vez de quedarse con el de antes.
 */
export function RegistrarPagoForm({ invoiceId, currency, locale, outstanding, paidAmount, today }: RegistrarPagoFormProps) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(registrarPago, {});
  const formRef = useRef<HTMLFormElement>(null);

  const [amountDraft, setAmountDraft] = useState<string | null>(null);
  const [dateDraft, setDateDraft] = useState<string | null>(null);
  /**
   * Cuántos cobros lleva registrados este formulario. Va en la `key` del
   * MoneyInput: el control guarda por dentro el TEXTO que se está
   * escribiendo y solo lo suelta al perder el foco, así que al enviar
   * con Enter seguía enseñando el monto anterior mientras el campo
   * oculto ya llevaba el saldo nuevo. Un segundo Enter habría cobrado
   * ese saldo sin que la pantalla lo dijera. Cambiar la key lo remonta.
   */
  const [cobros, setCobros] = useState(0);
  const [method, setMethod] = useState<string>(PAYMENT_METHODS[0]);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");

  const amount = amountDraft ?? outstanding;
  const receivedOn = dateDraft ?? today;
  const errors = state.errors ?? {};
  const money = (value: string) => formatMoney(value, currency, { mode: "full", locale });

  // Al registrarse el cobro, los campos vuelven a su valor sugerido: el
  // saldo ya es otro y la referencia del banco no se repite.
  useEffect(() => {
    if (!state.ok) return;
    setAmountDraft(null);
    setDateDraft(null);
    setReference("");
    setNotes("");
    setCobros((n) => n + 1);
  }, [state]);

  // Foco al primer campo con error cuando el servidor devuelve errores.
  useEffect(() => {
    if (!state.errors) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} noValidate className="mt-4 border-t border-line pt-4">
      <h3 className="text-sm font-medium">{M.title}</h3>

      <input type="hidden" name="invoiceId" value={invoiceId} />
      {/* Sobre qué estado de la factura se calculó este formulario. */}
      <input type="hidden" name="expectedPaidAmount" value={paidAmount} />

      {state.message && (
        <p role="alert" className="mt-3 rounded-md border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger">
          {state.message}
        </p>
      )}
      {state.ok && !state.message && (
        <p role="status" className="mt-3 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm">
          {M.ok}
        </p>
      )}

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <Field label={M.amount} required help={M.amountHelp(money(outstanding))} error={errors.amount} htmlFor="amount">
          <MoneyInput key={cobros} value={amount} currency={currency} onChange={(v) => setAmountDraft(v)} required />
          {/* El MoneyInput enseña "2.100.000"; al servidor viaja el decimal normalizado. */}
          <input type="hidden" name="amount" value={amount} />
        </Field>

        <Field label={M.date} required help={M.dateHelp} error={errors.receivedOn} htmlFor="receivedOn">
          <DateInput name="receivedOn" value={receivedOn} max={today} onChange={(v) => setDateDraft(v)} required />
        </Field>

        <Field label={M.method} required error={errors.method} htmlFor="method">
          <Select
            name="method"
            required
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            options={PAYMENT_METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABEL_ES[m] }))}
          />
        </Field>

        <Field label={M.reference} help={M.referenceHelp} error={errors.reference} htmlFor="reference">
          <Input name="reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} placeholder="TRF-260923" />
        </Field>

        <Field label={M.notes} help={M.notesHelp} error={errors.notes} htmlFor="notes" className="sm:col-span-2">
          <Textarea name="notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} rows={2} />
        </Field>
      </div>

      <div className="mt-4">
        {/* loading desactiva el botón: un doble clic no manda dos veces.
            La garantía de verdad es expectedPaidAmount, en el servidor. */}
        <Button type="submit" variant="primary" loading={pending}>
          {M.submit}
        </Button>
      </div>
    </form>
  );
}
