import type { Metadata } from "next";
import Link from "next/link";
import { DELIVERABLES } from "@mc/core";
import {
  BRIEF_COMPANY_SEARCH_MIN,
  BRIEF_LIMITS,
  countHiddenSignals,
  getBrief,
  listBriefCreators,
  listCategorySuggestions,
  pickBriefCreator,
} from "@mc/db/queries/brief";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Select } from "@/components/ui/field";
import { Pill } from "@/components/ui/pill";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { ModuleTabs } from "../_componentes/pestanas";
import { withWorkspace } from "../_lib/db";
import { MESSAGES } from "../_lib/messages";
import { currencyOptions } from "../_lib/monedas";
import { countryOptions } from "../_lib/paises";
import { BriefForm, type BriefFormValues } from "./form";
import { puedeEditarElBrief } from "./permiso";

const t = MESSAGES.brief;

export const metadata: Metadata = { title: t.metaTitle };
// Lee la base en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

/**
 * El brief de outbound (VEN-7): qué busca el creador y qué no acepta.
 *
 * Un brief es de UN creador (uno activo por creador, 0064 §1), y así lo
 * leen el recomendador y el generador de cadencias. Con un solo creador
 * la pantalla es su brief y ya; en una agencia, un selector
 * (?creador=id) elige de quién es el que se ve y se guarda, y la página
 * dice cómo se combinan: el radar oculta solo lo que excluyen todos los
 * briefs activos, y las cadencias usan el del creador del negocio.
 *
 * La ve todo el equipo del espacio; la cambian owner y admin
 * (puedeEditarElBrief), porque lo que excluye se le oculta a todos y
 * frena las cadencias. A los demás se les enseña igual, sin «Guardar» y
 * diciendo por qué; la acción lo vuelve a mirar y la base lo impone
 * (0064 §5).
 *
 * Arriba dice cuántas señales deja fuera hoy, con el enlace a verlas en
 * el radar: un filtro que no se ve es un filtro que se olvida.
 */
export default async function BriefPage({ searchParams }: { searchParams: Promise<{ creador?: string }> }) {
  const params = await searchParams;
  const [workspace, editable] = await Promise.all([getCurrentWorkspace(), puedeEditarElBrief()]);
  const f = formatterFor(workspace);
  const { creators, creator, brief, suggestions, hidden } = await withWorkspace(async (tx) => {
    const { creators } = await listBriefCreators(tx);
    const creator = pickBriefCreator(creators, params.creador);
    return {
      creators,
      creator,
      brief: creator ? await getBrief(tx, creator.id) : null,
      suggestions: await listCategorySuggestions(tx),
      // Las marcas del CRM ya no se leen todas aquí: el formulario las busca
      // en el servidor al escribir (buscarMarcas, VEN-7 r4).
      hidden: await countHiddenSignals(tx),
    };
  });

  const header = <PageHeader eyebrow={t.eyebrow} title={t.title} description={t.description} />;

  if (!creator) {
    return (
      <>
        {header}
        <ModuleTabs active="/ventas/brief" />
        <EmptyState title={t.noCreator.title} description={t.noCreator.description} action={{ label: t.noCreator.action, href: "/conexiones" }} />
      </>
    );
  }

  const countries = countryOptions(f.locale);
  const countryName = new Map(countries.map((c) => [c.value, c.label]));
  const catalogo: string[] = [...DELIVERABLES];
  // Un formato guardado que no está en el catálogo se sigue viendo, con
  // su nombre tal cual, para no borrarlo sin querer al guardar.
  const extra = (brief?.deliverables ?? []).filter((k) => !catalogo.includes(k));
  const deliverableOptions = [...catalogo, ...extra].map((k) => ({
    value: k,
    label: (t.deliverables as Record<string, string>)[k] ?? k,
  }));
  // La moneda del mínimo: la del brief si ya tiene mínimo; si no, la del
  // workspace (que pudo cambiar desde que se creó el brief). Se puede
  // cambiar en el formulario.
  const currency = brief?.minBudget ? brief.currency : workspace.currency;
  const currencies = currencyOptions(f.locale, [workspace.currency, currency]);

  const values: BriefFormValues = {
    creatorId: creator.id,
    title: brief?.title ?? t.defaultTitle,
    wantedCategories: brief?.wantedCategories ?? [],
    wantedCountries: (brief?.wantedCountries ?? []).map((c) => ({ value: c, label: countryName.get(c) ?? c })),
    minBudget: brief?.minBudget ?? "",
    currency,
    deliverables: brief?.deliverables ?? [],
    availabilityFrom: brief?.availabilityFrom ?? "",
    availabilityTo: brief?.availabilityTo ?? "",
    excludedCategories: brief?.excludedCategories ?? [],
    excludedCompanies: (brief?.excludedCompanies ?? []).map((c) => ({ value: c.id, label: c.name })),
    requiresDisclosure: brief?.requiresDisclosure ?? true,
    notes: brief?.notes ?? "",
    active: brief ? brief.status === "active" : true,
  };

  // Los otros creadores con brief activo: el radar oculta solo lo que
  // excluyen TODOS, y eso hay que decirlo donde se edita la regla.
  const otros = creators.filter((c) => c.id !== creator.id && c.briefStatus === "active").map((c) => c.displayName);

  return (
    <>
      {header}
      <ModuleTabs active="/ventas/brief" />

      {creators.length > 1 && (
        <form method="get" className="mb-4 flex max-w-3xl flex-wrap items-end gap-2" aria-label={t.creator.label}>
          <Field label={t.creator.label} htmlFor="brief-creador" className="min-w-0 flex-1 sm:max-w-xs">
            <Select
              name="creador"
              defaultValue={creator.id}
              options={creators.map((c) => ({
                value: c.id,
                label: t.creator.option(c.displayName, c.briefStatus ? t.status[c.briefStatus] : null),
              }))}
            />
          </Field>
          <Button type="submit" variant="secondary">
            {t.creator.submit}
          </Button>
        </form>
      )}

      <div className="mb-6 flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <span className="font-medium text-ink">{t.of(creator.displayName)}</span>
        {brief && <Pill kind={brief.status === "active" ? "good" : "neutral"}>{t.status[brief.status]}</Pill>}
        <span className="text-muted">{brief ? t.savedAt(f.date(brief.updatedAt)) : t.none}</span>
      </div>

      {creators.length > 1 && (
        <div role="note" className="mb-6 flex max-w-3xl flex-col gap-1 text-xs leading-5 text-muted">
          {otros.length > 0 && <p>{t.others(t.joinNames(otros), otros.length)}</p>}
          <p>{t.cadencesRule}</p>
        </div>
      )}

      {hidden.total > 0 && (
        <p role="status" className="mb-6 flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-ink-2">
          <span className="tabular-nums">
            {otros.length > 0 ? t.hidingNowAll(f.int(hidden.total), hidden.total) : t.hidingNow(f.int(hidden.total), hidden.total)}
          </span>
          <Link href="/ventas?ocultas=1" className="text-ink underline underline-offset-4 hover:text-ink-2">
            {t.seeHidden}
          </Link>
        </p>
      )}

      <BriefForm
        // Cambiar de creador monta un formulario nuevo: los estados de
        // cliente (mínimo, fechas, casillas) no pasan de un brief a otro.
        key={creator.id}
        values={values}
        deliverableOptions={deliverableOptions}
        categorySuggestions={suggestions}
        countries={countries}
        currencies={currencies}
        locale={f.locale}
        companySearchMin={BRIEF_COMPANY_SEARCH_MIN}
        limits={BRIEF_LIMITS}
        editable={editable}
      />
    </>
  );
}
