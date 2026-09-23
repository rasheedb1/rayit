"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { anotarSenal, cargarLista } from "../actions";
import { Aviso } from "../_componentes/aviso";
import type { CsvLineError } from "../_lib/csv";
import { MESSAGES } from "../_lib/messages";
import { useVentasForm } from "../_lib/use-ventas-form";

/**
 * «Anotar una marca»: una señal escrita a mano. Solo pide lo que hace
 * falta para decidir después (la marca y qué se vio); el resto es
 * opcional y viaja a la empresa si la señal se acepta.
 */
export function NuevaSenalForm({ currency, onCancel }: { currency: string; onCancel: () => void }) {
  const t = MESSAGES.radar.form;
  const [budget, setBudget] = useState("");
  const { state, pending, formRef, onSubmit, errors } = useVentasForm(anotarSenal, () => setBudget(""));

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate aria-labelledby="nueva-senal" className="rounded-md border border-border bg-surface p-4">
      <h3 id="nueva-senal" className="text-sm font-semibold text-ink">
        {t.title}
      </h3>
      <p className="mt-1 text-xs leading-5 text-muted">{t.help}</p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label={t.company} help={t.companyHelp} error={errors.companyName} htmlFor="senal-company">
          <Input name="companyName" autoComplete="off" maxLength={200} />
        </Field>
        <Field label={t.domain} help={t.domainHelp} error={errors.domain} htmlFor="senal-domain">
          <Input name="domain" autoComplete="off" inputMode="url" placeholder={MESSAGES.empresas.form.domainPlaceholder} maxLength={253} />
        </Field>
        <Field label={t.headline} help={t.headlineHelp} error={errors.headline} required htmlFor="senal-headline" className="sm:col-span-2">
          <Input name="headline" maxLength={280} />
        </Field>
        <Field label={t.evidence} error={errors.evidenceUrl} htmlFor="senal-evidence" className="sm:col-span-2">
          <Input name="evidenceUrl" type="url" inputMode="url" placeholder={MESSAGES.contacto.urlPlaceholder} />
        </Field>
        <Field label={t.fit} help={t.fitHelp} error={errors.fit} htmlFor="senal-fit">
          <Input name="fit" inputMode="decimal" maxLength={5} />
        </Field>
        <Field label={t.budget} error={errors.budget} htmlFor="senal-budget">
          <MoneyInput value={budget} currency={currency} onChange={(v) => setBudget(v)} />
          <input type="hidden" name="budget" value={budget} />
        </Field>
        <Field label={t.country} help={t.countryHelp} error={errors.country} htmlFor="senal-country">
          <Input name="country" maxLength={2} autoComplete="off" className="uppercase" />
        </Field>
        <Field label={t.industry} error={errors.industry} htmlFor="senal-industry">
          <Input name="industry" maxLength={120} />
        </Field>
        <Field label={t.note} error={errors.note} htmlFor="senal-note" className="sm:col-span-2">
          <Textarea name="note" rows={2} maxLength={1000} />
        </Field>
      </div>

      <Aviso message={state.message} notice={state.notice} className="mt-4" />
      {state.link && (
        <Link href={state.link.href} className="mt-2 inline-block text-sm text-ink underline underline-offset-4 hover:text-ink-2">
          {state.link.label}
        </Link>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={pending}>
          {t.submit}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {MESSAGES.acciones.close}
        </Button>
      </div>
    </form>
  );
}

/** Las filas de un CSV con algo que decir, cada una con su línea del archivo. */
function LineasCsv({ title, lines }: { title: string; lines: CsvLineError[] | undefined }) {
  const t = MESSAGES.radar.csv;
  if (!lines || lines.length === 0) return null;
  return (
    <div className="mt-3 rounded-md border border-border px-3 py-2">
      <p className="text-xs font-medium text-ink">{title}</p>
      <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-xs text-ink-2">
        {lines.map((e) => (
          <li key={`${e.line}:${e.message}`}>
            <span className="tabular-nums text-muted">{t.line(e.line)}</span> · {e.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * «Cargar una lista»: un CSV subido o pegado. Lo que ya estaba en el
 * radar no se repite, y las filas que no se pudieron leer se listan con
 * su línea para arreglarlas en el archivo.
 */
export function CargarListaForm({ onCancel }: { onCancel: () => void }) {
  const t = MESSAGES.radar.csv;
  const { state, pending, formRef, onSubmit, errors } = useVentasForm(cargarLista);

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate aria-labelledby="cargar-lista" className="rounded-md border border-border bg-surface p-4">
      <h3 id="cargar-lista" className="text-sm font-semibold text-ink">
        {t.title}
      </h3>
      <p className="mt-1 text-xs leading-5 text-muted">{t.help}</p>

      <div className="mt-4 grid gap-4">
        <Field label={t.file} error={errors.file} htmlFor="csv-file">
          <input
            id="csv-file"
            name="file"
            type="file"
            accept=".csv,text/csv,text/plain"
            aria-invalid={errors.file ? true : undefined}
            aria-describedby={errors.file ? "csv-file-error" : undefined}
            className="block w-full text-sm text-ink-2 file:mr-3 file:rounded-md file:border file:border-border file:bg-surface-2 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink hover:file:bg-hover"
          />
        </Field>
        <Field label={t.paste} htmlFor="csv-pasted">
          <Textarea name="pasted" rows={4} placeholder={t.pastePlaceholder} className="font-mono text-xs" />
        </Field>
      </div>

      <Aviso message={state.message} notice={state.notice} className="mt-4" />
      <LineasCsv title={t.lineErrors} lines={state.lineErrors} />
      <LineasCsv title={t.lineWarnings} lines={state.lineWarnings} />

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={pending}>
          {t.submit}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {MESSAGES.acciones.close}
        </Button>
      </div>
    </form>
  );
}
