import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";
import { notFound } from "next/navigation";
import { CAMPAIGN_STATUS_META, CAMPAIGN_TRANSITIONS, canEditCampaign, deliverableLabel, INVOICE_STATUS_LABEL_ES, type InvoiceStatus } from "@mc/core";
import { getCampaign, listCampaignPosts, listLinkablePosts, suggestPosts, type CampaignDetail, type CampaignPostRow } from "@mc/db";
import { facturarCampana } from "@/app/(app)/finanzas";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { DataAsOf } from "@/components/ui/data-as-of";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { PlatformPill } from "@/components/ui/platform-pill";
import { formatDate, formatDateRange, formatInt, formatMoney } from "@/lib/format";
import { withWorkspace } from "@/lib/db";
import { UUID_RE } from "@/lib/forms";
import { pillForCampaign } from "../_lib/estado";
import { cambiarEstadoCampana, marcarPrincipal, quitarPost } from "./actions";
import { LinkPosts } from "./asociar";
import { CopyButton } from "./copiar";
import { DetailsForm, TrackingForm } from "./editar-form";
import { TransitionButton } from "./transicion";

export const dynamic = "force-dynamic";

/**
 * Todo lo que pinta la ficha, en una transacción. cache() lo comparte
 * entre generateMetadata y la página dentro de la misma petición.
 */
const loadCampaign = cache(async (id: string) =>
  withWorkspace(async (tx) => {
    const campaign = await getCampaign(tx, id);
    if (!campaign) return null;
    const editable = canEditCampaign(campaign.status);
    return {
      campaign,
      editable,
      posts: await listCampaignPosts(tx, id),
      suggestions: editable ? await suggestPosts(tx, id) : [],
      linkable: editable ? await listLinkablePosts(tx, { campaignId: id }) : [],
    };
  }),
);

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  if (!UUID_RE.test(id)) return { title: "Campaña" };
  const data = await loadCampaign(id);
  return { title: data ? `${data.campaign.companyName} · ${data.campaign.name}` : "Campaña" };
}

function Section({ id, title, meta, children }: { id: string; title: string; meta?: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-md border border-line p-4" aria-labelledby={id}>
      <SectionTitle meta={meta}>
        <span id={id}>{title}</span>
      </SectionTitle>
      {children}
    </section>
  );
}

function DataItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-fg-3">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

const None = ({ children = "—" }: { children?: string }) => <span className="text-fg-3">{children}</span>;

/** «24 h», «7 días», «30 días» a partir de los cortes en horas de la cotización. */
function cutLabel(hours: number): string {
  const HOURS_PER_DAY = 24;
  return hours < HOURS_PER_DAY * 2 ? `${hours} h` : `${Math.round(hours / HOURS_PER_DAY)} días`;
}

function dateRange(c: Pick<CampaignDetail, "startsOn" | "endsOn">): string | null {
  if (c.startsOn && c.endsOn) return formatDateRange(c.startsOn, c.endsOn);
  if (c.startsOn) return `desde el ${formatDate(c.startsOn)}`;
  return null;
}

function Thumbnail({ post }: { post: CampaignPostRow }) {
  if (post.coverUrl) {
    // Las portadas vienen de las plataformas (dominios que no controlamos):
    // next/image exigiría declararlos y no aporta nada a 40 px.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={post.coverUrl} alt="" width={40} height={40} loading="lazy" className="h-10 w-10 shrink-0 rounded-sm object-cover" />;
  }
  return (
    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-surface-2 text-xs font-medium uppercase text-fg-3" aria-hidden="true">
      {post.platformId.slice(0, 1)}
    </span>
  );
}

function postColumns(campaign: CampaignDetail, editable: boolean): Column<CampaignPostRow>[] {
  const cols: Column<CampaignPostRow>[] = [
    {
      key: "post",
      header: "Post",
      render: (p) => (
        <span className="flex min-w-0 items-center gap-3">
          <Thumbnail post={p} />
          <span className="min-w-0">
            <span className="block max-w-xs truncate font-medium text-ink">
              {p.url ? (
                <a href={p.url} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">
                  {p.title ?? p.caption ?? "Sin título"}
                </a>
              ) : (
                (p.title ?? p.caption ?? "Sin título")
              )}
            </span>
            <span className="mt-1 block">
              <PlatformPill platformId={p.platformId} />
            </span>
          </span>
        </span>
      ),
    },
    { key: "published", header: "Publicado", render: (p) => (p.publishedAt ? formatDate(p.publishedAt) : <None>Sin fecha</None>) },
    {
      key: "views",
      header: "Views",
      align: "num",
      render: (p) => (p.views === null ? <None>Sin datos</None> : <CellMain sub={p.dataAsOf ? `hasta el ${formatDate(p.dataAsOf)}` : undefined}>{formatInt(p.views)}</CellMain>),
    },
    { key: "reach", header: "Alcance", align: "num", render: (p) => (p.reach === null ? <None>Sin datos</None> : formatInt(p.reach)) },
    { key: "saves", header: "Guardados", align: "num", render: (p) => (p.saves === null ? <None>Sin datos</None> : formatInt(p.saves)) },
    {
      key: "primary",
      header: "Principal",
      render: (p) =>
        p.isPrimary ? (
          <Pill kind="good">Principal</Pill>
        ) : editable ? (
          <form action={marcarPrincipal.bind(null, campaign.id, p.postId)}>
            <Button type="submit" size="sm" variant="ghost">
              Marcar principal
            </Button>
          </form>
        ) : (
          <None />
        ),
    },
    { key: "deliverable", header: "Entregable", render: (p) => deliverableLabel(p.deliverable) ?? <None>Sin entregable</None> },
  ];
  if (editable) {
    cols.push({
      key: "remove",
      header: "Acción",
      render: (p) => (
        <form action={quitarPost.bind(null, campaign.id, p.postId)}>
          <Button type="submit" size="sm" variant="danger">
            Quitar
          </Button>
        </form>
      ),
    });
  }
  return cols;
}

const CONFIRM: Record<string, string> = {
  live: "¿Iniciar la campaña? Desde hoy se mide a la marca (línea base desde 14 días antes del inicio).",
  measuring: "¿Pasar a medición? Los posts ya están publicados y empiezan los cortes de métricas.",
  reported: "¿Marcar el reporte como listo?",
  closed: "¿Cerrar la campaña? Después no admite cambios.",
  cancelled: "¿Cancelar la campaña? No se puede deshacer.",
};

export default async function CampanaPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  if (!UUID_RE.test(id)) notFound();

  const data = await loadCampaign(id);
  if (!data) notFound();
  const { campaign, editable, posts, suggestions, linkable } = data;

  const pill = pillForCampaign(campaign.status);
  const invoice = campaign.invoices.find((i) => i.status !== "void") ?? null;
  const transitions = CAMPAIGN_TRANSITIONS[campaign.status];
  const rango = dateRange(campaign);
  const brandHandle = (campaign.brandAccounts as { handle?: unknown }[]).map((a) => (typeof a?.handle === "string" ? a.handle : null)).find(Boolean) ?? null;

  return (
    <>
      <PageHeader
        eyebrow={`Campañas · ${campaign.companyName}`}
        title={campaign.name}
        description={[rango ?? "Sin fechas", campaign.amount ? formatMoney(campaign.amount, campaign.currency, { mode: "full" }) : "Sin monto acordado"].join(" · ")}
        aside={
          <div className="flex flex-wrap gap-2">
            {invoice ? (
              <Button variant="primary" href={`/finanzas/facturas/${invoice.id}`}>
                Ver factura {invoice.number}
              </Button>
            ) : campaign.status === "cancelled" ? null : (
              <form action={facturarCampana.bind(null, campaign.id)}>
                <Button type="submit" variant="primary">
                  Facturar
                </Button>
              </form>
            )}
            <Button variant="ghost" href="/campanas">
              Volver a campañas
            </Button>
          </div>
        }
      />

      {error && (
        <p role="alert" className="mb-6 rounded-md border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-8">
          <Section id="acordado" title="Acordado antes de publicar" meta={campaign.agreed ? `Cotización ${campaign.agreed.quoteNumber}` : undefined}>
            {campaign.agreed ? (
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                <DataItem label="Métricas acordadas">{campaign.agreed.agreedMetrics.length > 0 ? campaign.agreed.agreedMetrics.join(", ") : <None>Sin métricas acordadas</None>}</DataItem>
                <DataItem label="Cortes del reporte">{campaign.agreed.reportCutsHours.length > 0 ? campaign.agreed.reportCutsHours.map(cutLabel).join(" · ") : <None />}</DataItem>
                <DataItem label="Derechos de uso">{campaign.agreed.usageRightsDays === null ? <None>Sin derechos de uso</None> : `${formatInt(campaign.agreed.usageRightsDays)} días`}</DataItem>
                <DataItem label="Exclusividad">
                  {campaign.agreed.exclusivityDays === null ? (
                    <None>Sin exclusividad</None>
                  ) : (
                    `${formatInt(campaign.agreed.exclusivityDays)} días${campaign.agreed.exclusivityScope ? ` · ${campaign.agreed.exclusivityScope}` : ""}`
                  )}
                </DataItem>
                <DataItem label="Plazo de pago">{formatInt(campaign.agreed.paymentTermsDays)} días</DataItem>
              </dl>
            ) : (
              <EmptyState
                title="Sin cotización: esta campaña se creó a mano"
                description="Las métricas, los cortes, los derechos, la exclusividad y el plazo llegan copiados de la cotización cuando la marca la acepta."
              />
            )}
            {campaign.brief && (
              <div className="mt-4">
                <p className="text-xs text-fg-3">Brief</p>
                <p className="mt-1 whitespace-pre-line text-sm leading-6 text-fg-2">{campaign.brief}</p>
              </div>
            )}
          </Section>

          <Section
            id="entregables"
            title="Entregables"
            meta={campaign.deliverablesSource === "quote" ? "Desde la cotización" : campaign.deliverablesSource === "posts" ? "Según los posts asociados" : undefined}
          >
            {campaign.deliverables.length === 0 ? (
              <p className="text-sm text-fg-3">Sin entregables registrados. Asocia los posts con su entregable y aparecen aquí.</p>
            ) : (
              <ul className="divide-y divide-line">
                {campaign.deliverables.map((d, i) => (
                  <li key={`${d.deliverable}-${i}`} className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
                    <span>
                      {formatInt(d.quantity)} × {deliverableLabel(d.deliverable)}
                      {d.description && <span className="text-fg-3"> · {d.description}</span>}
                    </span>
                    {d.platformId && <PlatformPill platformId={d.platformId} />}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section id="seguimiento" title="Seguimiento">
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <DataItem label="Código">
                {campaign.trackingCode ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-sm">{campaign.trackingCode}</code>
                    <CopyButton value={campaign.trackingCode} label="Código" />
                  </span>
                ) : (
                  <None>Sin código</None>
                )}
              </DataItem>
              <DataItem label="Enlace rastreado">
                {campaign.trackingUrl ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <a href={campaign.trackingUrl} target="_blank" rel="noopener noreferrer" className="min-w-0 max-w-full break-all font-mono text-xs underline-offset-2 hover:underline">
                      {campaign.trackingUrl}
                    </a>
                    <CopyButton value={campaign.trackingUrl} label="Enlace" />
                  </span>
                ) : (
                  <None>Sin enlace</None>
                )}
              </DataItem>
            </dl>
            {editable && (
              <div className="mt-3">
                <TrackingForm campaignId={campaign.id} trackingCode={campaign.trackingCode} trackingUrl={campaign.trackingUrl} />
              </div>
            )}
          </Section>

        </div>

        <aside className="space-y-6 lg:sticky lg:top-8 lg:self-start">
          <div className="rounded-md border border-line p-4">
            <SectionTitle>Estado</SectionTitle>
            <Pill kind={pill.kind}>{pill.text}</Pill>
            <div className="mt-3 flex flex-col gap-2">
              {transitions.map((to) => (
                <TransitionButton
                  key={to}
                  action={cambiarEstadoCampana.bind(null, campaign.id, to)}
                  label={CAMPAIGN_STATUS_META[to].action}
                  confirmText={CONFIRM[to] ?? `¿Pasar la campaña a «${CAMPAIGN_STATUS_META[to].label}»?`}
                  variant={to === "cancelled" ? "danger" : "secondary"}
                />
              ))}
              {transitions.length === 0 && <p className="text-xs text-fg-3">Una campaña {pill.text.toLowerCase()} no cambia de estado.</p>}
            </div>
          </div>

          <div className="rounded-md border border-line p-4">
            <SectionTitle>Datos</SectionTitle>
            <dl className="grid gap-3">
              <DataItem label="Marca">{campaign.companyName}</DataItem>
              <DataItem label="Fechas">{rango ?? <None>Sin fechas</None>}</DataItem>
              <DataItem label="Monto acordado">{campaign.amount ? formatMoney(campaign.amount, campaign.currency, { mode: "full" }) : <None>Sin monto</None>}</DataItem>
              <DataItem label="Línea base de la marca desde">{campaign.brandBaselineFrom ? formatDate(campaign.brandBaselineFrom, "long") : <None>Se fija al iniciar</None>}</DataItem>
              <DataItem label="Creada">{formatDate(campaign.createdAt, "long")}</DataItem>
            </dl>
            {editable && (
              <div className="mt-3">
                <DetailsForm campaignId={campaign.id} name={campaign.name} startsOn={campaign.startsOn} endsOn={campaign.endsOn} brief={campaign.brief} />
              </div>
            )}
          </div>

          <div className="rounded-md border border-line p-4">
            <SectionTitle>Facturas</SectionTitle>
            {campaign.invoices.length === 0 ? (
              <p className="text-xs text-fg-3">
                {campaign.status === "cancelled" ? "Una campaña cancelada no se factura." : "Sin factura todavía. «Facturar» la crea en borrador con el monto acordado."}
              </p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {campaign.invoices.map((i) => (
                  <li key={i.id} className="flex items-baseline justify-between gap-3">
                    <Link href={`/finanzas/facturas/${i.id}`} className="font-mono underline-offset-2 hover:underline">
                      {i.number}
                    </Link>
                    <span className="text-xs text-fg-3">
                      {INVOICE_STATUS_LABEL_ES[i.status as InvoiceStatus] ?? i.status} · {formatMoney(i.total, i.currency, { mode: "full" })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>

      <div className="mt-8 min-w-0 space-y-8">
        <Section id="posts" title="Posts asociados" meta={`${posts.length} ${posts.length === 1 ? "post" : "posts"}`}>
          <DataTable
            columns={postColumns(campaign, editable)}
            rows={posts}
            rowKey={(p) => p.postId}
            caption="Posts de la campaña con sus métricas actuales"
            emptyState={
              <EmptyState
                title="Sin posts asociados"
                description={editable ? "Asocia los posts que publicaste para esta campaña: abajo están los sugeridos por fecha y mención." : "Esta campaña cerró sin posts asociados."}
              />
            }
          />
          {campaign.dataAsOf && <DataAsOf date={campaign.dataAsOf} source="último snapshot de métricas" className="mt-2" />}
        </Section>

        {editable && (
          <Section id="asociar" title="Asociar post">
            <LinkPosts campaignId={campaign.id} suggestions={suggestions} initial={linkable} />
          </Section>
        )}
      </div>

      <div className="mt-8 grid min-w-0 gap-8 lg:grid-cols-2">
        <Section id="resultado" title="Resultado">
          <EmptyState
            title="Llega con la medición"
            description="Alcance, views, clics, canjes, seguidores para la marca, CPM y CPA se calculan desde los snapshots y lo que aporta la marca. Hasta entonces no hay cifras que mostrar."
          />
        </Section>

        <Section id="seguidores" title="Seguidores de la marca">
          <EmptyState
            title="Llega con la medición"
            description={`La curva de seguidores${brandHandle ? ` de @${brandHandle}` : " de la marca"}${
              campaign.brandBaselineFrom ? ` desde el ${formatDate(campaign.brandBaselineFrom, "long")}` : ""
            } se toma del snapshot público diario. Todavía no hay serie que dibujar.`}
          />
        </Section>
      </div>
    </>
  );
}
