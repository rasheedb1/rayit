"use client";

import { startTransition, useActionState, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { BRIEF_LIMITS } from "@mc/db/queries/brief";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DateInput } from "@/components/ui/date-input";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { Aviso } from "../../_lib/aviso";
import { MESSAGES } from "../_lib/messages";
import { buscarMarcas, guardarBrief, type BriefState } from "./actions";
import { ListaDeEtiquetas, type Etiqueta } from "./lista-de-etiquetas";

const t = MESSAGES.brief;
const INICIAL: BriefState = {};

/** Lo que el formulario necesita del brief guardado, ya en forma de pantalla. */
export interface BriefFormValues {
  /** De quién es el brief: viaja en una entrada oculta y saveBrief comprueba que sea del espacio. */
  creatorId: string;
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
  /** Las monedas del mínimo (ISO 4217, con su nombre en el idioma del workspace). */
  currencies: Etiqueta[];
  /** El locale del workspace: las cifras de la búsqueda de marcas van con Intl. */
  locale: string;
  /** Cuántas letras pide la búsqueda de marcas (BRIEF_COMPANY_SEARCH_MIN, pasado por el servidor). */
  companySearchMin: number;
  /**
   * Los topes de @mc/db (BRIEF_LIMITS), pasados por el servidor: un
   * componente de cliente no importa valores de @mc/db, que arrastraría
   * el cliente de Postgres al navegador.
   */
  limits: typeof BRIEF_LIMITS;
  /**
   * Si quien mira puede cambiar el brief (owner o admin, puedeEditarElBrief).
   * Si no, lo ve entero, sin «Guardar», y la pantalla dice por qué.
   */
  editable?: boolean;
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
 * El brief: qué buscas, qué no aceptas y si el radar lo aplica.
 *
 * Se envía con onSubmit y no con action={…}: React 19 vacía un
 * formulario no controlado al terminar la acción, y quien corrige una
 * fecha perdería el nombre y las notas (el mismo motivo que
 * useVentasForm). Aquí nada se vacía: lo guardado es lo que queda en
 * pantalla.
 */
export function BriefForm({
  values,
  deliverableOptions,
  categorySuggestions,
  countries,
  currencies,
  locale,
  companySearchMin,
  limits,
  editable = true,
}: BriefFormProps) {
  const [estado, dispatch, pendiente] = useActionState<BriefState, FormData>(guardarBrief, INICIAL);
  const formRef = useRef<HTMLFormElement>(null);
  const [minBudget, setMinBudget] = useState(values.minBudget);
  const [moneda, setMoneda] = useState(values.currency);
  const [desde, setDesde] = useState(values.availabilityFrom);
  const [hasta, setHasta] = useState(values.availabilityTo);
  const [entregables, setEntregables] = useState<string[]>(values.deliverables);
  const [divulgacion, setDivulgacion] = useState(values.requiresDisclosure);
  const [activo, setActivo] = useState(values.active);
  const errors = estado.errors ?? {};
  const f = t.fields;

  const avisoRef = useRef<HTMLDivElement>(null);

  // Después de guardar, el foco va a lo que hay que leer (VEN-7 r4):
  //   · con errores de campo, al primero, que a 400 px puede quedar arriba;
  //   · si no, al aviso, que va junto a «Guardar el brief». Hasta la ronda
  //     3 el «Guardado» se pintaba arriba de un formulario de ~2 000 px: en
  //     el móvil quedaba a −1 115 px y quien pulsaba Guardar no veía nada.
  useEffect(() => {
    if (estado.errors) {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    if (!estado.message && !(estado.ok && estado.notice)) return;
    const aviso = avisoRef.current;
    // scrollIntoView no existe en todos los entornos (jsdom): opcional.
    aviso?.scrollIntoView?.({ block: "nearest" });
    aviso?.focus({ preventScroll: true });
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
    <form ref={formRef} onSubmit={onSubmit} noValidate className="max-w-3xl">
      <input type="hidden" name="creatorId" value={values.creatorId} />
      {/* Sin permiso, todo se ve y nada se toca: un fieldset apagado, como la política de envío. */}
      <fieldset disabled={!editable} className="grid min-w-0 gap-6">
        {!editable && (
          <p role="note" className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-ink-2">
            {t.sinPermiso}
          </p>
        )}
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
              disabled={!editable}
              saved={estado.stamp}
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
              disabled={!editable}
              saved={estado.stamp}
            />
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,9rem)] gap-3 sm:col-span-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)]">
            <Field label={f.minBudget} help={f.minBudgetHelp} error={errors.minBudget} htmlFor="brief-min-budget">
              <MoneyInput value={minBudget} currency={moneda} onChange={(v) => setMinBudget(v)} />
              <input type="hidden" name="minBudget" value={minBudget} />
            </Field>
            {/* La moneda se elige: si el workspace cambia de moneda, el mínimo no queda atado a la vieja. */}
            <Field label={f.currency} error={errors.currency} htmlFor="brief-moneda">
              <Select name="currency" value={moneda} onChange={(e) => setMoneda(e.target.value)} options={currencies} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:col-span-2">
            <Field label={f.availabilityFrom} help={f.availabilityHelp} error={errors.availabilityFrom} htmlFor="brief-desde">
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
                <Checkbox
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
              disabled={!editable}
              saved={estado.stamp}
            />
          </div>
          <div className="sm:col-span-2">
            <ListaDeEtiquetas
              name="excludedCompanies"
              mode="search"
              label={f.excludedCompanies}
              help={f.excludedCompaniesHelp}
              error={errors.excludedCompanies}
              initial={values.excludedCompanies}
              search={buscarMarcas}
              minChars={companySearchMin}
              locale={locale}
              max={limits.companies}
              placeholder={t.chips.companyPlaceholder}
              disabled={!editable}
              saved={estado.stamp}
            />
          </div>
          {/*
            Una condición no negociable, como en Passionfroot: va con las
            demás reglas (VEN-7 r4). No filtra marcas; la cumplen las cadencias
            al escribir, y el juez rechaza el mensaje que no la lleva.
          */}
          <div className="sm:col-span-2">
            <Checkbox
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
            <Checkbox name="active" label={f.active} help={f.activeHelp} checked={activo} onChange={setActivo} />
          </div>
        </Bloque>

        {/*
          El resultado, pegado al botón: se lee donde se pulsó. El contenedor
          recibe el foco (tabIndex -1) y el Aviso de dentro se anuncia solo
          (role="status" o, si es un error, role="alert").
        */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {editable && (
            <Button type="submit" variant="primary" loading={pendiente} className="self-start">
              {t.submit}
            </Button>
          )}
          <div ref={avisoRef} tabIndex={-1} data-testid="brief-aviso" className="min-w-0 flex-1 rounded-md focus:outline-none">
            <Aviso message={estado.message} notice={estado.ok ? estado.notice : undefined} />
          </div>
        </div>
      </fieldset>
    </form>
  );
}
