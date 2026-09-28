"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { CATEGORIAS_GASTO, RECURRENCIAS } from "@mc/core";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import type { ActionState } from "@/lib/forms";
import { MESSAGES } from "../_lib/messages";
import { guardarGasto } from "./actions";
import type { GastoCrudo } from "./_lib/vista";

const T = MESSAGES.gastos.form;

/**
 * Una casilla. El kit no tiene `Checkbox` todavía y cambiar su API
 * después cuesta dos PR (components/ui/README.md), así que vive aquí
 * hasta que un segundo módulo la necesite; entonces sube al kit con su
 * entrada en /kit y su prueba. Es una casilla nativa con su etiqueta: el
 * teclado y el lector de pantalla no necesitan nada más.
 */
function Casilla({
  name,
  label,
  help,
  checked,
  onChange,
}: {
  name: string;
  label: string;
  help?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  const helpId = help ? `${id}-help` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id={id}
          name={name}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby={helpId}
          className="size-4 rounded-sm border-border accent-ink"
        />
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
        </label>
      </div>
      {help && (
        <p id={helpId} className="text-xs leading-4 text-muted">
          {help}
        </p>
      )}
    </div>
  );
}

export interface GastoFormProps {
  /** Moneda del espacio: el formulario no la elige, la muestra. */
  currency: string;
  /** Fecha de hoy según la base, 'YYYY-MM-DD'. */
  hoy: string;
  /** Con gasto, es «Corregir el gasto»; sin él, «Nuevo gasto». */
  gasto?: { id: string; crudo: GastoCrudo };
  onCancel: () => void;
  /** Se llama cuando la acción terminó bien, con la frase que se muestra arriba. */
  onSaved: (aviso: string) => void;
}

/**
 * El formulario de un gasto: el mismo para registrar y para corregir.
 * Si sale bien, quien lo monta cierra el panel y la lista ya viene
 * revalidada por la acción.
 */
export function GastoForm({ currency, hoy, gasto, onCancel, onSaved }: GastoFormProps) {
  const editando = gasto !== undefined;
  const [state, formAction, pending] = useActionState<ActionState, FormData>(guardarGasto, {});
  const formRef = useRef<HTMLFormElement>(null);
  const tituloId = useId();

  const c = gasto?.crudo;
  const [category, setCategory] = useState(c?.category ?? "");
  const [vendor, setVendor] = useState(c?.vendor ?? "");
  const [description, setDescription] = useState(c?.description ?? "");
  const [amount, setAmount] = useState(c?.amount ?? "");
  const [incurredOn, setIncurredOn] = useState(c?.incurredOn ?? hoy);
  const [isRecurring, setIsRecurring] = useState(c?.isRecurring ?? false);
  const [recurrence, setRecurrence] = useState(c?.recurrence ?? RECURRENCIAS[0]?.id ?? "");
  const [deductible, setDeductible] = useState(c?.deductible ?? true);
  const [receiptUrl, setReceiptUrl] = useState(c?.receiptUrl ?? "");

  const errors = state.errors ?? {};

  // Foco al primer campo con error cuando el servidor devuelve errores;
  // y cerrar cuando guardó.
  useEffect(() => {
    if (state.ok) {
      onSaved(state.message ?? (editando ? T.editado : T.guardado));
      return;
    }
    if (!state.errors) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state, editando, onSaved]);

  return (
    <form
      ref={formRef}
      action={formAction}
      noValidate
      aria-labelledby={tituloId}
      className="rounded-md border border-border bg-surface p-4"
    >
      <h3 id={tituloId} className="text-sm font-semibold text-ink">
        {editando ? T.tituloEditar : T.tituloNuevo}
      </h3>
      {editando && <p className="mt-1 text-xs leading-4 text-muted">{T.ayudaEditar}</p>}

      {/* El error general (una regla de la base) va arriba; los de campo, en su campo. */}
      {!state.ok && state.message && (
        <p role="alert" className="mt-3 rounded-md border border-bad/30 bg-bad-wash px-3 py-2 text-sm text-ink">
          {state.message}
        </p>
      )}

      <input type="hidden" name="gastoId" value={gasto?.id ?? ""} />

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label={T.categoria} required error={errors.category} className="sm:col-span-1">
          <Select
            name="category"
            required
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder={T.categoriaPlaceholder}
            options={CATEGORIAS_GASTO.map((x) => ({ value: x.id, label: x.labelEs }))}
          />
        </Field>

        <Field label={T.fecha} required error={errors.incurredOn}>
          <DateInput name="incurredOn" value={incurredOn} onChange={setIncurredOn} required />
        </Field>

        <Field label={T.monto} required error={errors.amount}>
          <MoneyInput value={amount} currency={currency} onChange={(v) => setAmount(v)} required />
          {/* Al servidor viaja el decimal normalizado, no "1.500.000,50". */}
          <input type="hidden" name="amount" value={amount} />
        </Field>

        <Field label={T.moneda} help={T.monedaHelp}>
          <Input value={currency} disabled readOnly />
        </Field>

        <Field label={T.proveedor} help={T.proveedorHelp} error={errors.vendor} className="sm:col-span-2">
          <Input name="vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} maxLength={200} autoComplete="off" />
        </Field>

        <Field label={T.descripcion} help={T.descripcionHelp} error={errors.description} className="sm:col-span-2">
          <Textarea name="description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={500} />
        </Field>

        <Field label={T.recibo} help={T.reciboHelp} error={errors.receiptUrl} className="sm:col-span-2">
          <Input
            name="receiptUrl"
            value={receiptUrl}
            onChange={(e) => setReceiptUrl(e.target.value)}
            inputMode="url"
            placeholder="https://"
            maxLength={2000}
            autoComplete="off"
          />
        </Field>

        <div className="flex flex-col gap-3 sm:col-span-2">
          <Casilla name="isRecurring" label={T.recurrente} help={T.recurrenteHelp} checked={isRecurring} onChange={setIsRecurring} />
          {isRecurring && (
            <Field label={T.recurrencia} required error={errors.recurrence} className="max-w-xs">
              <Select
                name="recurrence"
                required
                value={recurrence}
                onChange={(e) => setRecurrence(e.target.value)}
                options={RECURRENCIAS.map((r) => ({ value: r.id, label: r.labelEs }))}
              />
            </Field>
          )}
          <Casilla name="deductible" label={T.deducible} checked={deductible} onChange={setDeductible} />
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={pending}>
          {editando ? T.guardarCambio : T.guardar}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {T.cancelar}
        </Button>
      </div>
    </form>
  );
}
