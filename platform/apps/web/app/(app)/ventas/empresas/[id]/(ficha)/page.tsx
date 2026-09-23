import Link from "next/link";
import { notFound } from "next/navigation";
import { listInvoices } from "@mc/db/queries/finanzas";
import { getCompany, listContacts, listOwnerOptions, listPipeline } from "@mc/db/queries/ventas";
import {
  getCompanyChain,
  getLocalDates,
  listCompanyActivity,
  listCompanySignals,
  listNextActions,
  listNicheNames,
} from "@mc/db/queries/ventas-ficha";
import { PageHeader } from "@/components/page-header";
import { Pill } from "@/components/ui/pill";
import { formatterFor } from "@/lib/format";
import { dealLabel } from "@/lib/negocio";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { ModuleTabs } from "../../../_componentes/pestanas";
import { withWorkspace } from "../../../_lib/db";
import { RELATIONSHIP_META, lostReasonText } from "../../../_lib/estado";
import { MESSAGES } from "../../../_lib/messages";
import { countryOptions } from "../../../_lib/paises";
import { quoteHref } from "../../../_pipeline/vista";
import { opcionesDeResponsable, siguienteAccionData, type SeguimientoContexto } from "../../../_seguimiento/datos";
import { SiguienteAccion } from "../../../_seguimiento/siguiente-accion";
import { FICHA } from "../../messages";
import { Bloque } from "../bloque";
import { Cadena } from "../cadena";
import { Contactos } from "../contactos";
import { DatosEmpresa } from "../datos";
import { LineaDeTiempo } from "../linea-de-tiempo";
import { NuevoNegocio } from "../negocio";
import { RegistroRapido } from "../registro";
import { RelacionForm } from "../relacion";
import { LoQueSabemos } from "../sabemos";

// El título de la pestaña lo pone layout.tsx con el nombre de la empresa
// (generateMetadata): uno estático aquí lo pisaría (pulido r8).
export const dynamic = "force-dynamic";

/**
 * La ficha de una empresa (VEN-1, VEN-4, VEN-5), como la de Attio: todo
 * lo de una marca en una pantalla, en bloques que se pliegan.
 *
 *   · Cabecera: nombre, dominio, relación, nicho, sector y responsable.
 *   · Negocios: cada uno con su siguiente acción editable en una línea
 *     (VEN-4) y lo que salió de él: cotización → campaña → factura.
 *   · Actividad: el registro rápido (nota, llamada, correo, reunión, con
 *     teclado) y la línea de tiempo, donde lo que escribe la persona y lo
 *     que deja el producto son la misma historia.
 *   · Contactos, con su procedencia y su baja a la vista.
 *   · A un lado: la relación y su responsable, los datos de la empresa y
 *     «lo que sabemos» (su ficha enriquecida y sus señales).
 *
 * Carga en dos tiempos. Primero, layout.tsx: una sola fila —¿está esta
 * empresa en el CRM del espacio?— y, si no (no existe, o es de otro
 * espacio: RLS la esconde igual), notFound() antes de que salga nada: un
 * 404 de verdad (../not-found.tsx). Después, esta página, con el
 * esqueleto de loading.tsx mientras lee, en UNA transacción.
 */
export default async function EmpresaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = MESSAGES.empresas;
  const x = FICHA;

  const data = await withWorkspace(async (tx) => {
    const company = await getCompany(tx, id);
    if (!company) return null;
    const pipeline = await listPipeline(tx);
    return {
      company,
      contacts: await listContacts(tx, id),
      deals: pipeline.filter((d) => d.companyId === id),
      owners: await listOwnerOptions(tx),
      nextActions: await listNextActions(tx, { companyId: id }),
      activity: await listCompanyActivity(tx, id),
      signals: await listCompanySignals(tx, id),
      chain: await getCompanyChain(tx, id),
      invoices: (await listInvoices(tx, { companyId: id, limit: 200 })).rows,
      niches: await listNicheNames(tx, company.nicheSlugs),
      dates: await getLocalDates(tx),
    };
  });
  // Se desvinculó entre la primera lectura y esta.
  if (!data) notFound();
  const { company, contacts, deals, owners, nextActions, activity, signals, chain, invoices, niches, dates } = data;

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
  const ctx: SeguimientoContexto = { owners: opcionesDeResponsable(owners, nextActions), ...dates };
  const acciones = new Map(nextActions.map((r) => [r.dealId, r]));
  const facturas = new Map(invoices.map((i) => [i.id, i]));
  // El nicho en el idioma del espacio, si el catálogo lo tiene; si no, en español.
  const ingles = f.locale.toLowerCase().startsWith("en");
  const nicho = niches.map((n) => (ingles && n.nameEn ? n.nameEn : n.nameEs));
  const sueltos = [chain.loose.quotes, chain.loose.campaigns, chain.loose.invoices].some((l) => l.length > 0);

  const cabecera: { label: string; value: string | null }[] = [
    { label: x.cabecera.niche, value: nicho.length > 0 ? new Intl.ListFormat(f.locale, { type: "conjunction" }).format(nicho) : null },
    { label: x.cabecera.industry, value: company.industry },
    { label: x.cabecera.owner, value: company.ownerName ?? x.cabecera.noOwner },
  ];

  return (
    <>
      <PageHeader eyebrow={MESSAGES.header.eyebrow} title={company.name} description={company.domain ?? undefined} aside={<Pill kind={rel.kind}>{rel.label}</Pill>} />
      <dl aria-label={x.cabecera.label} className="-mt-5 mb-8 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {cabecera.flatMap((c) => (c.value === null ? [] : [{ label: c.label, value: c.value }])).map((c) => (
          <div key={c.label} className="flex min-w-0 gap-1.5">
            <dt className="text-muted">{c.label}</dt>
            <dd className="min-w-0 break-words text-ink">{c.value}</dd>
          </div>
        ))}
      </dl>
      <ModuleTabs active="/ventas/empresas" />

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-10">
          <Bloque
            id="negocios"
            title={x.bloques.deals}
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
            <div className="mb-3">
              <NuevoNegocio companyId={company.id} currency={workspace.currency} />
            </div>
            {deals.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted">{t.noDeals}</p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {deals.map((d) => {
                  const abierto = !d.isWon && !d.isLost;
                  const motivo = lostReasonText(d.lostReason);
                  const negocio = dealLabel(company.name, d.name) ?? MESSAGES.radar.pendingDealName;
                  const accion = abierto ? acciones.get(d.id) : undefined;
                  return (
                    <li key={d.id} className="space-y-3 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-ink">{negocio}</p>
                          <p className="mt-0.5 text-xs text-ink-2">
                            {d.stageLabel}
                            {motivo && <span className="text-muted"> · {motivo}</span>}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="whitespace-nowrap text-sm tabular-nums text-ink">
                            {d.amount ? f.money(d.amount, d.currency, { mode: "short" }) : <span className="text-muted">{MESSAGES.pipeline.noAmount}</span>}
                          </span>
                          {abierto && (
                            <Link
                              href={quoteHref(d.id)}
                              aria-label={t.detail.quoteLabel(d.name)}
                              className="text-sm text-ink underline underline-offset-4 hover:text-ink-2"
                            >
                              {t.detail.quote}
                            </Link>
                          )}
                        </div>
                      </div>
                      {accion && <SiguienteAccion data={siguienteAccionData(accion, f, ctx, `${company.name} · ${negocio}`)} ctx={ctx} />}
                      <Cadena links={chain.byDeal[d.id]} invoices={facturas} f={f} label={x.cadena.label(negocio)} />
                    </li>
                  );
                })}
              </ul>
            )}
            {sueltos && (
              <div className="mt-3 rounded-md border border-dashed border-border p-3">
                <p className="text-xs font-medium text-ink">{x.cadena.loose}</p>
                <p className="mb-2 text-xs text-muted">{x.cadena.looseHelp}</p>
                <Cadena links={chain.loose} invoices={facturas} f={f} label={x.cadena.loose} />
              </div>
            )}
          </Bloque>

          <Bloque id="actividad" title={x.bloques.activity}>
            <RegistroRapido
              companyId={company.id}
              today={dates.today}
              deals={[...deals]
                .sort((a, b) => Number(a.isWon || a.isLost) - Number(b.isWon || b.isLost))
                .map((d) => ({ id: d.id, label: `${dealLabel(company.name, d.name) ?? MESSAGES.radar.pendingDealName} · ${d.stageLabel}`, open: !d.isWon && !d.isLost }))}
              contacts={contacts
                .filter((c) => !c.optedOut)
                .map((c) => ({ id: c.id, label: c.fullName ?? c.email ?? (c.instagramHandle ? `@${c.instagramHandle}` : MESSAGES.contacto.noName) }))}
            />
            <LineaDeTiempo rows={activity.rows} hasMore={activity.hasMore} companyName={company.name} f={f} />
          </Bloque>

          <Contactos companyId={company.id} contacts={contacts} />
        </div>

        <aside className="min-w-0 space-y-8" aria-label={t.detail.data}>
          <RelacionForm companyId={company.id} relationship={company.relationship} ownerUserId={company.ownerUserId} owners={ownerOptions} />
          <DatosEmpresa
            countries={countryOptions(f.locale)}
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
              // El sector y el responsable van en la cabecera (VEN-5): aquí no se repiten.
              { label: t.detail.openDeals, value: f.int(company.openDealCount) },
              { label: t.detail.lastActivity, value: company.lastActivityAt ? f.date(company.lastActivityAt) : t.neverContacted },
            ]}
            signalsLink={company.pendingSignalCount > 0 ? t.pendingSignals(company.pendingSignalCount) : null}
          />
          <Bloque id="sabemos" title={x.bloques.known}>
            <LoQueSabemos company={company} signals={signals} f={f} />
          </Bloque>
        </aside>
      </div>
    </>
  );
}
