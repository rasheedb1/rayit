"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { BRAND_INPUT_KIND_LABEL_ES, isMoneyBrandInputKind, MANUAL_BRAND_INPUT_KINDS, type DateWindow, type ManualBrandInputKind } from "@mc/core";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, Input, Select } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { formatDate } from "@/lib/format";
import { MESSAGES } from "../_lib/messages";
import { importarCsvVentas, registrarAporte, type AporteState, type ImportacionState } from "./actions";

const t = MESSAGES.aporte;

/**
 * Los dos formularios de «Lo que aportó la marca»: «Registrar aporte»
 * (un total acumulado a una fecha) e «Importar CSV de ventas» (una fila
 * por día). Cada uno abre en su sitio con un botón y se cierra al
 * guardar; los errores por campo vienen del servidor (zod), en español.
 * El resumen de la importación se queda a la vista hasta que la
 * persona pide importar otro archivo. Solo se montan si la campaña
 * admite cambios: la página lo decide.
 */

function Alert({ message, tone = "danger" }: { message?: string; tone?: "danger" | "info" }) {
  if (!message) return null;
  const cls = tone === "danger" ? "border-danger/30 bg-danger-bg text-danger" : "border-line bg-surface-2 text-fg-2";
  return (
    <p role={tone === "danger" ? "alert" : "status"} className={`rounded-md border px-3 py-2 text-sm ${cls}`}>
      {message}
    </p>
  );
}

function focusFirstInvalid(form: HTMLFormElement | null) {
  form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
}

// ---------------------------------------------------------------------
// Registrar aporte
// ---------------------------------------------------------------------

export function RegistrarAporteForm({ campaignId, currency, today }: { campaignId: string; currency: string; today: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<AporteState, FormData>(registrarAporte, {});
  const [kind, setKind] = useState<ManualBrandInputKind | "">("");
  const [day, setDay] = useState(today);
  const [amount, setAmount] = useState("");
  const [inputCurrency, setInputCurrency] = useState(currency);
  const [notice, setNotice] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const errors = state.errors ?? {};

  useEffect(() => {
    if (state.ok) {
      setNotice(state.notice ?? t.form.saved);
      setOpen(false);
      setKind("");
      setAmount("");
      setDay(today);
    } else if (state.errors) focusFirstInvalid(formRef.current);
    // today cambia solo con la petición; lo que importa es state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const money = kind !== "" && isMoneyBrandInputKind(kind);

  if (!open) {
    return (
      <div className="space-y-2">
        <Button size="sm" onClick={() => setOpen(true)}>
          {t.form.open}
        </Button>
        <Alert message={notice ?? undefined} tone="info" />
      </div>
    );
  }
  return (
    <form ref={formRef} action={formAction} noValidate aria-busy={pending || undefined} className="rounded-md border border-line bg-surface-2 p-3" role="group" aria-label={t.form.title}>
      <input type="hidden" name="campaignId" value={campaignId} />
      <p className="mb-3 text-xs text-fg-3">{t.form.help}</p>
      <Alert message={state.message} />
      <div className={`grid gap-3 sm:grid-cols-2 ${state.message ? "mt-3" : ""}`}>
        <Field label={t.form.kind} required error={errors.kind} htmlFor="aporte-kind">
          <Select
            name="kind"
            required
            value={kind}
            onChange={(e) => setKind(e.target.value as ManualBrandInputKind | "")}
            placeholder={t.form.kindPlaceholder}
            options={MANUAL_BRAND_INPUT_KINDS.map((k) => ({ value: k, label: BRAND_INPUT_KIND_LABEL_ES[k] }))}
          />
        </Field>
        <Field label={t.form.day} required error={errors.day} htmlFor="aporte-day">
          <DateInput name="day" required value={day} max={today} onChange={setDay} />
        </Field>
        <Field label={t.form.value} required help={money ? t.form.valueHelpMoney : t.form.valueHelpCount} error={errors.value} htmlFor="aporte-value">
          {money ? (
            <>
              <MoneyInput value={amount} currency={inputCurrency} onChange={setAmount} required />
              <input type="hidden" name="value" value={amount} />
            </>
          ) : (
            <Input name="value" required inputMode="numeric" pattern="[0-9]*" autoComplete="off" maxLength={14} />
          )}
        </Field>
        {money ? (
          <Field label={t.form.currency} required error={errors.currency} htmlFor="aporte-currency">
            <Input name="currency" required value={inputCurrency} onChange={(e) => setInputCurrency(e.target.value.toUpperCase())} maxLength={3} autoComplete="off" className="font-mono uppercase" />
          </Field>
        ) : (
          <input type="hidden" name="currency" value="" />
        )}
        <Field label={t.form.notes} help={t.form.notesHelp} error={errors.notes} htmlFor="aporte-notes" className="sm:col-span-2">
          <Input name="notes" maxLength={500} autoComplete="off" />
        </Field>
      </div>
      <div className="mt-3 flex gap-2">
        <Button type="submit" variant="primary" size="sm" loading={pending}>
          {t.form.submit}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          {t.form.cancel}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------
// Importar CSV de ventas
// ---------------------------------------------------------------------

function Resumen({ resumen, onAnother }: { resumen: NonNullable<ImportacionState["resumen"]>; onAnother: () => void }) {
  const s = t.csv.summary;
  const nothing = resumen.days === 0;
  return (
    <div className="rounded-md border border-line bg-surface-2 p-3" role="status" aria-label={s.title}>
      <p className="text-sm font-medium text-ink">{s.title}</p>
      {nothing ? (
        <p className="mt-1 text-sm text-fg-2">{s.nothing}</p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-fg-2">
          <li>{s.days(resumen.days)}</li>
          <li>{s.inserted(resumen.inserted)}</li>
          {resumen.unchanged > 0 && <li>{s.unchanged(resumen.unchanged)}</li>}
          {resumen.replaced > 0 && <li>{s.replaced(resumen.replaced)}</li>}
        </ul>
      )}
      {resumen.rejected.length > 0 && (
        <div className="mt-2">
          <p className="text-sm text-warn">{s.rejected(resumen.rejected.length)}</p>
          <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-xs text-fg-3">
            {resumen.rejected.map((r) => (
              <li key={r.line}>
                {s.row(r.line)}: {t.csv.reason[r.reason]}
                {r.value && <span className="font-mono"> ({r.value})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {resumen.codificacion === "windows-1252" && <p className="mt-2 text-xs text-fg-3">{s.encoding}</p>}
      <div className="mt-3">
        <Button size="sm" onClick={onAnother}>
          {s.another}
        </Button>
      </div>
    </div>
  );
}

export function ImportarCsvForm({ campaignId, window }: { campaignId: string; window: DateWindow | null }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<ImportacionState, FormData>(importarCsvVentas, {});
  const [shown, setShown] = useState<ImportacionState["resumen"] | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const errors = state.errors ?? {};

  useEffect(() => {
    if (state.ok && state.resumen) {
      setShown(state.resumen);
      setOpen(false);
    } else if (state.errors) focusFirstInvalid(formRef.current);
  }, [state]);

  if (shown) {
    return (
      <Resumen
        resumen={shown}
        onAnother={() => {
          setShown(null);
          setOpen(true);
        }}
      />
    );
  }
  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        {t.csv.open}
      </Button>
    );
  }
  return (
    <form ref={formRef} action={formAction} noValidate aria-busy={pending || undefined} className="rounded-md border border-line bg-surface-2 p-3" role="group" aria-label={t.csv.title}>
      <input type="hidden" name="campaignId" value={campaignId} />
      <p className="mb-1 text-xs text-fg-3">{t.csv.help}</p>
      <p className="mb-3 text-xs text-fg-3">{window ? t.csv.window(formatDate(window.from), formatDate(window.to)) : t.csv.noDates}</p>
      <Alert message={state.message} />
      <Field label={t.csv.file} required error={errors.archivo} htmlFor="aporte-archivo" className={state.message ? "mt-3" : ""}>
        <Input name="archivo" type="file" accept=".csv,text/csv" required disabled={!window} className="h-auto py-1.5 file:mr-3 file:rounded-sm file:border-0 file:bg-surface file:px-2 file:py-1 file:text-xs file:text-ink" />
      </Field>
      <div className="mt-3 flex gap-2">
        <Button type="submit" variant="primary" size="sm" loading={pending} disabled={!window}>
          {pending ? t.csv.importing : t.csv.submit}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          {t.csv.cancel}
        </Button>
      </div>
    </form>
  );
}
