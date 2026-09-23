"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, Input, Select } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { crearIngreso, type NuevoIngresoState } from "../actions";
import { MESSAGES } from "../_lib/messages";

const T = MESSAGES.nuevo;

export interface NuevoIngresoFormProps {
  plataformas: { id: string; name: string }[];
  /** La moneda del espacio: el formulario no la adivina ni la deja elegir. */
  currency: string;
  /** El último mes cerrado, según la base: la propuesta por defecto. */
  mesPorDefecto: string;
}

export function NuevoIngresoForm({ plataformas, currency, mesPorDefecto }: NuevoIngresoFormProps) {
  const [state, formAction, pending] = useActionState<NuevoIngresoState, FormData>(crearIngreso, {});
  const formRef = useRef<HTMLFormElement>(null);
  const [platformId, setPlatformId] = useState("");
  const [mes, setMes] = useState(mesPorDefecto);
  const [periodoPropio, setPeriodoPropio] = useState(false);
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [amount, setAmount] = useState("");

  const errors = state.errors ?? {};

  // Foco al primer campo con error cuando el servidor devuelve errores.
  useEffect(() => {
    if (!state.errors) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  // Tras guardar, el formulario queda limpio para el siguiente pago:
  // quien carga uno a mano casi siempre carga varios seguidos.
  useEffect(() => {
    if (state.ok) setAmount("");
  }, [state.ok]);

  const aviso = state.conflicto
    ? T.choca(state.conflicto.red, state.conflicto.periodo, state.conflicto.guardado)
    : state.message;
  const exito = state.duplicado
    ? T.yaEstaba(state.duplicado.red, state.duplicado.periodo)
    : state.guardado
      ? T.guardado(state.guardado.red, state.guardado.periodo)
      : null;

  return (
    <form ref={formRef} action={formAction} className="flex max-w-lg flex-col gap-4">
      <Field label={T.campos.plataforma.label} help={T.campos.plataforma.ayuda} error={errors.platformId} required>
        <Select
          name="platformId"
          value={platformId}
          onChange={(e) => setPlatformId(e.target.value)}
          placeholder="Elige la red"
          options={plataformas.map((p) => ({ value: p.id, label: p.name }))}
          invalid={Boolean(errors.platformId)}
          required
        />
      </Field>

      {periodoPropio ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={T.campos.inicio.label} error={errors.periodStart} required>
            <DateInput name="periodStart" value={periodStart} onChange={setPeriodStart} invalid={Boolean(errors.periodStart)} required />
          </Field>
          <Field label={T.campos.fin.label} error={errors.periodEnd} required>
            <DateInput name="periodEnd" value={periodEnd} onChange={setPeriodEnd} invalid={Boolean(errors.periodEnd)} required />
          </Field>
        </div>
      ) : (
        <Field label={T.campos.mes.label} help={T.campos.mes.ayuda} error={errors.mes} required>
          {/* type="month" donde el navegador lo tiene; donde no, es un
              campo de texto y el patrón dice qué se espera. */}
          <Input
            type="month"
            name="mes"
            value={mes}
            onChange={(e) => setMes(e.target.value)}
            pattern="\d{4}-\d{2}"
            placeholder="2026-09"
            invalid={Boolean(errors.mes)}
            required
          />
        </Field>
      )}

      <label className="flex w-fit items-center gap-2 text-sm text-ink-2">
        <input
          type="checkbox"
          checked={periodoPropio}
          onChange={(e) => setPeriodoPropio(e.target.checked)}
          className="h-4 w-4 rounded-sm border-border accent-[var(--accent)]"
        />
        {T.periodoPropio}
      </label>

      <Field label={T.campos.monto.label} error={errors.amount} required>
        <MoneyInput name="amount" value={amount} currency={currency} onChange={(v) => setAmount(v)} invalid={Boolean(errors.amount)} required />
      </Field>

      {aviso && (
        <p role="alert" className="rounded-md border border-warn/40 bg-warn-wash px-3 py-2 text-sm leading-5 text-ink">
          {aviso}
        </p>
      )}
      {exito && (
        <p role="status" className="rounded-md border border-good/40 bg-good-wash px-3 py-2 text-sm leading-5 text-ink">
          {exito}
        </p>
      )}

      <div>
        <Button type="submit" variant="primary" loading={pending}>
          {pending ? T.enviando : T.enviar}
        </Button>
      </div>
    </form>
  );
}
