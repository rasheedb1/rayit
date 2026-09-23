import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompany, listContacts, listPipeline } from "@mc/db/queries/ventas";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Pill } from "@/components/ui/pill";
import { formatterFor } from "@/lib/format";
import { dealLabel } from "@/lib/negocio";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { ModuleTabs } from "../../_componentes/pestanas";
import { withWorkspace } from "../../_lib/db";
import { RELATIONSHIP_META, pillForDue } from "../../_lib/estado";
import { MESSAGES } from "../../_lib/messages";
import { quoteHref } from "../../_pipeline/vista";
import { Contactos } from "./contactos";
import { NuevoNegocio } from "./negocio";
import { RelacionForm } from "./relacion";

export const metadata: Metadata = { title: MESSAGES.empresas.detail.metaTitle };
export const dynamic = "force-dynamic";

/**
 * La ficha de una empresa: sus datos, la relación con ella, sus
 * negocios y sus contactos (VEN-1).
 *
 * Desde aquí se abre un negocio a mano («Nuevo negocio») y se cotiza
 * cada negocio abierto («Cotizar» lleva a la nueva cotización con el
 * negocio ya elegido). La línea de tiempo, «lo que sabemos» y la cadena
 * negocio → cotización → campaña → factura son VEN-5 y llegan en el
 * sprint 3; esta ficha es la base sobre la que se montan.
 */
export default async function EmpresaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = MESSAGES.empresas;

  const { company, contacts, deals } = await withWorkspace(async (tx) => {
    const company = await getCompany(tx, id);
    if (!company) return { company: null, contacts: [], deals: [] };
    const [contacts, pipeline] = [await listContacts(tx, id), await listPipeline(tx)];
    return { company, contacts, deals: pipeline.filter((d) => d.companyId === id) };
  });

  // Una empresa que no existe (o de otro espacio: RLS la esconde igual)
  // es un 404 de verdad: lo pinta not-found.tsx, con la salida a Empresas.
  if (!company) notFound();

  const workspace = await getCurrentWorkspace();
  const f = formatterFor(workspace);
  const rel = RELATIONSHIP_META[company.relationship];
  const location = [company.city, company.country].filter(Boolean).join(", ");

  return (
    <>
      <nav aria-label={t.detail.breadcrumb} className="mb-2 text-xs text-muted">
        <Link href="/ventas/empresas" className="hover:text-ink hover:underline">
          ← {t.back}
        </Link>
      </nav>
      <PageHeader eyebrow={MESSAGES.header.eyebrow} title={company.name} description={company.domain ?? undefined} aside={<Pill kind={rel.kind}>{rel.label}</Pill>} />
      <ModuleTabs active="/ventas/empresas" />

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-10">
          <section aria-labelledby="negocios">
            <SectionTitle
              meta={
                company.openDealCount > 0 ? (
                  <span className="whitespace-nowrap tabular-nums">{f.money(company.openDealAmount, undefined, { mode: "short" })}</span>
                ) : undefined
              }
            >
              <span id="negocios">{t.columns.deals}</span>
            </SectionTitle>
            <div className="mb-3">
              <NuevoNegocio companyId={company.id} currency={workspace.currency} />
            </div>
            {deals.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted">{t.noDeals}</p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {deals.map((d) => {
                  const due = d.isWon || d.isLost ? null : pillForDue(d.dueState);
                  return (
                    <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink">{dealLabel(company.name, d.name) ?? MESSAGES.radar.pendingDealName}</p>
                        <p className="mt-0.5 text-xs text-ink-2">
                          {d.stageLabel}
                          {due && d.nextAction && (
                            <>
                              {" · "}
                              {d.nextAction}
                              {d.nextActionDue && <span className="text-muted"> · {f.date(d.nextActionDue)}</span>}
                            </>
                          )}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {due && <Pill kind={due.kind}>{due.text}</Pill>}
                        <span className="whitespace-nowrap text-sm tabular-nums text-ink">
                          {d.amount ? f.money(d.amount, d.currency, { mode: "short" }) : <span className="text-muted">{MESSAGES.pipeline.noAmount}</span>}
                        </span>
                        {!d.isWon && !d.isLost && (
                          <Link
                            href={quoteHref(d.id)}
                            aria-label={t.detail.quoteLabel(d.name)}
                            className="text-sm text-ink underline underline-offset-4 hover:text-ink-2"
                          >
                            {t.detail.quote}
                          </Link>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <Contactos companyId={company.id} contacts={contacts} />
        </div>

        <aside className="space-y-6" aria-label={t.detail.data}>
          <RelacionForm companyId={company.id} relationship={company.relationship} />
          <dl className="space-y-3 rounded-md border border-border p-4 text-sm">
            <Dato label={t.detail.domain} value={company.domain} />
            <Dato label={t.detail.location} value={location || null} />
            <Dato label={t.detail.industry} value={company.industry} />
            <Dato label={t.detail.owner} value={company.ownerName ?? t.detail.noOwner} />
            <Dato label={t.detail.openDeals} value={f.int(company.openDealCount)} />
            <Dato label={t.detail.lastActivity} value={company.lastActivityAt ? f.date(company.lastActivityAt) : t.neverContacted} />
            {company.pendingSignalCount > 0 && (
              <div>
                <dt className="sr-only">{MESSAGES.tabs.radar}</dt>
                <dd>
                  <Link href="/ventas" className="text-xs text-ink underline underline-offset-4 hover:text-ink-2">
                    {t.pendingSignals(company.pendingSignalCount)}
                  </Link>
                </dd>
              </div>
            )}
          </dl>
          <div>
            <h2 className="mb-1.5 text-sm font-semibold">{t.detail.notes}</h2>
            <p className="whitespace-pre-line text-sm leading-6 text-ink-2">{company.notes ?? <span className="text-muted">{t.detail.noNotes}</span>}</p>
          </div>
        </aside>
      </div>
    </>
  );
}

function Dato({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right text-ink">{value ?? MESSAGES.empresas.detail.empty}</dd>
    </div>
  );
}
