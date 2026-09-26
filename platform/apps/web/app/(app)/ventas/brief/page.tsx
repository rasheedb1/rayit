import type { Metadata } from "next";
import Link from "next/link";
import { DELIVERABLES } from "@mc/core";
import {
  BRIEF_LIMITS,
  countHiddenSignals,
  getBrief,
  getBriefOwner,
  listBriefCompanyOptions,
  listCategorySuggestions,
} from "@mc/db/queries/brief";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { formatterFor } from "@/lib/format";
import { requirePagePermission } from "@/lib/permisos/modulo";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { ModuleTabs } from "../_componentes/pestanas";
import { withWorkspace } from "../_lib/db";
import { MESSAGES } from "../_lib/messages";
import { countryOptions } from "../_lib/paises";
import { BriefForm, type BriefFormValues } from "./form";

const t = MESSAGES.brief;

export const metadata: Metadata = { title: t.metaTitle };
// Lee la base en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

/**
 * El brief de outbound (VEN-7): qué busca el creador y qué no acepta.
 *
 * La puerta del módulo la pone ventas/layout.tsx; esta pantalla pide
 * además ver el radar (ventas.senal.ver), porque lo que se decide aquí
 * es qué entra en esa bandeja. Guardar pide ventas.senal.registrar, en
 * la Server Action.
 *
 * Arriba dice cuántas señales deja fuera hoy, con el enlace a verlas en
 * el radar: un filtro que no se ve es un filtro que se olvida.
 */
export default async function BriefPage() {
  await requirePagePermission("ventas.senal.ver");

  const workspace = await getCurrentWorkspace();
  const f = formatterFor(workspace);
  const { brief, owner, suggestions, companies, hidden } = await withWorkspace(async (tx) => ({
    brief: await getBrief(tx),
    owner: await getBriefOwner(tx),
    suggestions: await listCategorySuggestions(tx),
    companies: await listBriefCompanyOptions(tx),
    hidden: await countHiddenSignals(tx),
  }));

  const header = <PageHeader eyebrow={t.eyebrow} title={t.title} description={t.description} />;

  if (!owner) {
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

  const values: BriefFormValues = {
    title: brief?.title ?? t.defaultTitle,
    wantedCategories: brief?.wantedCategories ?? [],
    wantedCountries: (brief?.wantedCountries ?? []).map((c) => ({ value: c, label: countryName.get(c) ?? c })),
    minBudget: brief?.minBudget ?? "",
    currency: brief?.currency ?? workspace.currency,
    deliverables: brief?.deliverables ?? [],
    availabilityFrom: brief?.availabilityFrom ?? "",
    availabilityTo: brief?.availabilityTo ?? "",
    excludedCategories: brief?.excludedCategories ?? [],
    excludedCompanies: (brief?.excludedCompanies ?? []).map((c) => ({ value: c.id, label: c.name })),
    requiresDisclosure: brief?.requiresDisclosure ?? true,
    notes: brief?.notes ?? "",
    active: brief ? brief.status === "active" : true,
  };

  return (
    <>
      {header}
      <ModuleTabs active="/ventas/brief" />

      <div className="mb-6 flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <span className="font-medium text-ink">{t.of(owner.displayName)}</span>
        {brief && <Pill kind={brief.status === "active" ? "good" : "neutral"}>{t.status[brief.status]}</Pill>}
        <span className="text-muted">{brief ? t.savedAt(f.date(brief.updatedAt)) : t.none}</span>
      </div>

      {hidden.total > 0 && (
        <p role="status" className="mb-6 flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-ink-2">
          <span className="tabular-nums">{t.hidingNow(f.int(hidden.total), hidden.total)}</span>
          <Link href="/ventas?ocultas=1" className="text-ink underline underline-offset-4 hover:text-ink-2">
            {t.seeHidden}
          </Link>
        </p>
      )}

      <BriefForm
        values={values}
        deliverableOptions={deliverableOptions}
        categorySuggestions={suggestions}
        countries={countries}
        companies={companies.map((c) => ({ value: c.id, label: c.name }))}
        limits={BRIEF_LIMITS}
      />
    </>
  );
}
