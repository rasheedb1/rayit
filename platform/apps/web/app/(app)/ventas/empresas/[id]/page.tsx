import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { companyInCrm, getCompany, listContacts, listOwnerOptions, listPipeline } from "@mc/db/queries/ventas";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Pill } from "@/components/ui/pill";
import { formatterFor } from "@/lib/format";
import { dealLabel } from "@/lib/negocio";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { ModuleTabs } from "../../_componentes/pestanas";
import { withWorkspace } from "../../_lib/db";
import { RELATIONSHIP_META, lostReasonText, pillForDue } from "../../_lib/estado";
import { MESSAGES } from "../../_lib/messages";
import { quoteHref } from "../../_pipeline/vista";
import { Contactos } from "./contactos";
import { DatosEmpresa } from "./datos";
import { EsqueletoFicha } from "./esqueleto";
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
 *
 * Carga en dos tiempos. Primero, una sola fila: ¿está esta empresa en
 * el CRM del espacio? Si no (no existe, o es de otro espacio: RLS la
 * esconde igual), notFound() antes de que salga nada, y la respuesta es
 * un 404 de verdad (not-found.tsx; por eso no hay loading.tsx encima).
 * Después, la ficha entera detrás de un esqueleto: al llegar desde la
 * lista se ve que carga en vez de quedarse la pantalla anterior quieta.
 */
export default async function EmpresaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const existe = await withWorkspace((tx) => companyInCrm(tx, id));
  if (!existe) notFound();

  return (
    <>
      <nav aria-label={MESSAGES.empresas.detail.breadcrumb} className="mb-2 text-xs text-muted">
        <Link href="/ventas/empresas" className="hover:text-ink hover:underline">
          ← {MESSAGES.empresas.back}
        </Link>
      </nav>
      <Suspense fallback={<EsqueletoFicha />}>
        <Ficha id={id} />
      </Suspense>
    </>
  );
}

async function Ficha({ id }: { id: string }) {
  const t = MESSAGES.empresas;

  const { company, contacts, deals, owners } = await withWorkspace(async (tx) => {
    const company = await getCompany(tx, id);
    if (!company) return { company: null, contacts: [], deals: [], owners: [] };
    const contacts = await listContacts(tx, id);
    const pipeline = await listPipeline(tx);
    const owners = await listOwnerOptions(tx);
    return { company, contacts, deals: pipeline.filter((d) => d.companyId === id), owners };
  });
  // Se desvinculó entre la primera lectura y esta.
  if (!company) notFound();

  const workspace = await getCurrentWorkspace();
  const f = formatterFor(workspace);
  const rel = RELATIONSHIP_META[company.relationship];
  // «Colombia · Bogotá»: el país por su nombre, en el idioma del espacio.
  const location = [company.country ? f.country(company.country) : null, company.city].filter(Boolean).join(" · ");
  // El responsable de hoy, aunque ya no esté en el espacio: si no, el
  // selector no lo mostraría y guardar la relación lo borraría.
  const ownerOptions =
    company.ownerUserId && !owners.some((o) => o.userId === company.ownerUserId)
      ? [...owners, { userId: company.ownerUserId, label: company.ownerName ?? t.detail.noOwner }]
      : owners;

  return (
    <>
      <PageHeader eyebrow={MESSAGES.header.eyebrow} title={company.name} description={company.domain ?? undefined} aside={<Pill kind={rel.kind}>{rel.label}</Pill>} />
      <ModuleTabs active="/ventas/empresas" />

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-10">
          <section aria-labelledby="negocios">
            <SectionTitle
              meta={
                company.openDealCount > 0 ? (
                  <span className="whitespace-nowrap tabular-nums">
                    {company.openDealAmount !== null ? (
                      f.money(company.openDealAmount, undefined, { mode: "short" })
                    ) : (
                      <span className="text-muted">{MESSAGES.pipeline.noAmount}</span>
                    )}
                  </span>
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
                  const motivo = lostReasonText(d.lostReason);
                  return (
                    <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink">{dealLabel(company.name, d.name) ?? MESSAGES.radar.pendingDealName}</p>
                        <p className="mt-0.5 text-xs text-ink-2">
                          {d.stageLabel}
                          {motivo && <span className="text-muted"> · {motivo}</span>}
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
          <RelacionForm companyId={company.id} relationship={company.relationship} ownerUserId={company.ownerUserId} owners={ownerOptions} />
          <DatosEmpresa
            company={{
              id: company.id,
              name: company.name,
              domain: company.domain,
              country: company.country,
              city: company.city,
              industry: company.industry,
              notes: company.notes,
              isOwn: company.isOwn,
            }}
            filas={[
              { label: t.detail.domain, value: company.domain },
              { label: t.detail.location, value: location || null },
              { label: t.detail.industry, value: company.industry },
              { label: t.detail.owner, value: company.ownerName ?? t.detail.noOwner },
              { label: t.detail.openDeals, value: f.int(company.openDealCount) },
              { label: t.detail.lastActivity, value: company.lastActivityAt ? f.date(company.lastActivityAt) : t.neverContacted },
            ]}
            signalsLink={company.pendingSignalCount > 0 ? t.pendingSignals(company.pendingSignalCount) : null}
          />
        </aside>
      </div>
    </>
  );
}
