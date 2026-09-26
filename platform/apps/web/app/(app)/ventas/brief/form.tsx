"use client";

import { startTransition, useActionState, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { BRIEF_LIMITS } from "@mc/db/queries/brief";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, Input, Textarea } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { Aviso } from "../../_lib/aviso";
import { MESSAGES } from "../_lib/messages";
import { guardarBrief, type BriefState } from "./actions";
import { ListaDeEtiquetas, type Etiqueta } from "./lista-de-etiquetas";

const t = MESSAGES.brief;
const INICIAL: BriefState = {};

/** Lo que el formulario necesita del brief guardado, ya en forma de pantalla. */
export interface BriefFormValues {
  title: string;
  wantedCategories: string[];
  wantedCountries: Etiqueta[];
  minBudget: string;
  currency: string;
  deliverables: string[];
  availabilityFrom: string;
  availabilityTo: string;
  excludedCategories: string[];
  excludedCompanies: Etiqueta[];
  requiresDisclosure: boolean;
  notes: string;
  active: boolean;
}

export interface BriefFormProps {
  values: BriefFormValues;
  /** Los formatos de entregable que se ofrecen, con su etiqueta. Incluye los guardados que no están en el catálogo. */
  deliverableOptions: Etiqueta[];
  categorySuggestions: string[];
  countries: Etiqueta[];
  companies: Etiqueta[];
  /**
   * Los topes de @mc/db (BRIEF_LIMITS), pasados por el servidor: un
   * componente de cliente no importa valores de @mc/db, que arrastraría
   * el cliente de Postgres al navegador.
   */
  limits: typeof BRIEF_LIMITS;
}

/**
 * Un bloque del formulario, como los de la configuración de Finanzas:
 * la misma caja a 400 px y en escritorio.
 */
function Bloque({ titulo, ayuda, children }: { titulo: string; ayuda: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="rounded-md border border-border p-4" aria-labelledby={id}>
      <h2 id={id} className="text-sm font-semibold text-ink">
        {titulo}
      </h2>
      <p className="mt-1 text-xs leading-4 text-muted">{ayuda}</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

/**
 * Una casilla con su etiqueta y su ayuda. Es la segunda vez que un
 * módulo la necesita (la primera es `Casilla` de finanzas/gastos/form.tsx);
 * el README del kit dice que a la segunda sube a components/ui/, y eso
 * es un PR de Nicolás. Mientras, vive aquí con la misma forma.
 */
function Casilla({
  name,
  label,
  help,
  checked,
  onChange,
}: {
  /** Sin nombre, la casilla no viaja en el formulario (los entregables mandan su valor aparte). */
  name?: string;
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
        <p id={helpId} className="pl-6 text-xs leading-4 text-muted">
          {help}
        </p>
      )}
    </div>
  );
}

/**
 * El brief: qué buscas, qué no aceptas y si el radar lo aplica.
 *
 * Se envía con onSubmit y no con action={…}: React 19 vacía un
 * formulario no controlado al terminar la acción, y quien corrige una
 * fecha perdería el nombre y las notas (el mismo motivo que
 * useVentasForm). Aquí nada se vacía: lo guardado es lo que queda en
 * pantalla.
 */
export function BriefForm({ values, deliverableOptions, categorySuggestions, countries, companies, limits }: BriefFormProps) {
  const [estado, dispatch, pendiente] = useActionState<BriefState, FormData>(guardarBrief, INICIAL);
  const formRef = useRef<HTMLFormElement>(null);
  const [minBudget, setMinBudget] = useState(values.minBudget);
  const [desde, setDesde] = useState(values.availabilityFrom);
  const [hasta, setHasta] = useState(values.availabilityTo);
  const [entregables, setEntregables] = useState<string[]>(values.deliverables);
  const [divulgacion, setDivulgacion] = useState(values.requiresDisclosure);
  const [activo, setActivo] = useState(values.active);
  const errors = estado.errors ?? {};
  const f = t.fields;

  // Foco al primer campo con error: a 400 px puede quedar fuera de la pantalla.
  useEffect(() => {
    if (estado.errors) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [estado]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => dispatch(data));
  }

  function alternar(kind: string, on: boolean) {
    setEntregables((cur) => (on ? [...cur, kind] : cur.filter((k) => k !== kind)));
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className="grid max-w-3xl gap-6">
      <Aviso message={estado.message} notice={estado.ok ? estado.notice : undefined} />

      <Bloque titulo={t.wants.title} ayuda={t.wants.help}>
        <Field label={f.title} help={f.titleHelp} error={errors.title} required htmlFor="brief-title" className="sm:col-span-2">
          <Input name="title" defaultValue={values.title} maxLength={limits.titleMax} autoComplete="off" />
        </Field>
        <div className="sm:col-span-2">
          <ListaDeEtiquetas
            name="wantedCategories"
            mode="free"
            label={f.wantedCategories}
            help={f.wantedCategoriesHelp}
            error={errors.wantedCategories}
            initial={values.wantedCategories.map((c) => ({ value: c, label: c }))}
            suggestions={categorySuggestions}
            max={limits.categories}
            maxLength={limits.categoryMax}
            placeholder={t.chips.categoryPlaceholder}
          />
        </div>
        <div className="sm:col-span-2">
          <ListaDeEtiquetas
            name="wantedCountries"
            mode="options"
            label={f.wantedCountries}
            help={f.wantedCountriesHelp}
            error={errors.wantedCountries}
            initial={values.wantedCountries}
            options={countries}
            max={limits.countries}
            placeholder={t.chips.countryPlaceholder}
          />
        </div>
        <Field label={f.minBudget} help={f.minBudgetHelp} error={errors.minBudget} htmlFor="brief-min-budget">
          <MoneyInput value={minBudget} currency={values.currency} onChange={(v) => setMinBudget(v)} />
          <input type="hidden" name="minBudget" value={minBudget} />
          <input type="hidden" name="currency" value={values.currency} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={f.availabilityFrom} error={errors.availabilityFrom} htmlFor="brief-desde">
            <DateInput name="availabilityFrom" value={desde} onChange={setDesde} />
          </Field>
          <Field label={f.availabilityTo} error={errors.availabilityTo} htmlFor="brief-hasta">
            <DateInput name="availabilityTo" value={hasta} onChange={setHasta} min={desde || undefined} />
          </Field>
        </div>
        <fieldset className="sm:col-span-2" aria-describedby="brief-entregables-help">
          <legend className="text-sm font-medium text-ink">{f.deliverables}</legend>
          <p id="brief-entregables-help" className="mt-1 text-xs text-muted">
            {f.deliverablesHelp}
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {deliverableOptions.map((d) => (
              <Casilla
                key={d.value}
                label={d.label}
                checked={entregables.includes(d.value)}
                onChange={(on) => alternar(d.value, on)}
              />
            ))}
          </div>
          {/* Una casilla solo sabe mandar "on": el formato elegido viaja en una entrada oculta por cada una. */}
          {entregables.map((k) => (
            <input key={k} type="hidden" name="deliverables" value={k} />
          ))}
          {errors.deliverables && (
            <p role="alert" className="mt-1 text-xs text-bad">
              {errors.deliverables}
            </p>
          )}
        </fieldset>
        <Field label={f.notes} help={f.notesHelp} error={errors.notes} htmlFor="brief-notes" className="sm:col-span-2">
          <Textarea name="notes" defaultValue={values.notes} rows={3} maxLength={limits.notesMax} />
        </Field>
      </Bloque>

      <Bloque titulo={t.rejects.title} ayuda={t.rejects.help}>
        <div className="sm:col-span-2">
          <ListaDeEtiquetas
            name="excludedCategories"
            mode="free"
            label={f.excludedCategories}
            help={f.excludedCategoriesHelp}
            error={errors.excludedCategories}
            initial={values.excludedCategories.map((c) => ({ value: c, label: c }))}
            suggestions={categorySuggestions}
            max={limits.categories}
            maxLength={limits.categoryMax}
            placeholder={t.chips.categoryPlaceholder}
          />
        </div>
        <div className="sm:col-span-2">
          <ListaDeEtiquetas
            name="excludedCompanies"
            mode="options"
            label={f.excludedCompanies}
            help={f.excludedCompaniesHelp}
            error={errors.excludedCompanies}
            initial={values.excludedCompanies}
            options={companies}
            emptyOptions={t.chips.noCompanies}
            max={limits.companies}
            placeholder={t.chips.companyPlaceholder}
          />
        </div>
        <div className="sm:col-span-2">
          <Casilla
            name="requiresDisclosure"
            label={f.requiresDisclosure}
            help={f.requiresDisclosureHelp}
            checked={divulgacion}
            onChange={setDivulgacion}
          />
        </div>
      </Bloque>

      <Bloque titulo={t.state.title} ayuda={t.state.help}>
        <div className="sm:col-span-2">
          <Casilla name="active" label={f.active} help={f.activeHelp} checked={activo} onChange={setActivo} />
        </div>
      </Bloque>

      <div>
        <Button type="submit" variant="primary" loading={pendiente}>
          {t.submit}
        </Button>
      </div>
    </form>
  );
}
