import type { Metadata } from "next";
import Link from "next/link";
import { MIN_SEARCH, RELATIONSHIPS, listCompanies, searchTerm, type CompanyListRow, type Relationship } from "@mc/db/queries/ventas";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { ModuleTabs } from "../../_componentes/pestanas";
import { withWorkspace } from "../../_lib/db";
import { RELATIONSHIP_META } from "../../_lib/estado";
import { MESSAGES } from "../../_lib/messages";
import { Buscador } from "../buscador";

export const metadata: Metadata = { title: MESSAGES.empresas.metaTitle };
export const dynamic = "force-dynamic";

/**
 * Las empresas del workspace (VEN-1): las que aceptó el radar y las que
 * se anotaron a mano. Cada fila trae ya contados sus contactos, sus
 * negocios abiertos y la suma de estos, desde SQL.
 */
export default async function EmpresasPage({ searchParams }: { searchParams: Promise<{ q?: string; rel?: string }> }) {
  const params = await searchParams;
  const q = searchTerm(params.q);
  const rel = RELATIONSHIPS.includes(params.rel as Relationship) ? (params.rel as Relationship) : null;

  const companies = await withWorkspace((tx) => listCompanies(tx, { search: q, relationship: rel, limit: 200 }));
  const f = formatterFor(await getCurrentWorkspace());
  const t = MESSAGES.empresas;
  const filtered = q !== null || rel !== null;

  const columns: Column<CompanyListRow>[] = [
    {
      key: "name",
      header: t.columns.name,
      render: (c) => (
        <CellMain sub={c.domain ?? undefined}>
          <Link href={`/ventas/empresas/${c.id}`} className="hover:underline">
            {c.name}
          </Link>
        </CellMain>
      ),
    },
    {
      key: "relationship",
      header: t.columns.relationship,
      render: (c) => <Pill kind={RELATIONSHIP_META[c.relationship].kind}>{RELATIONSHIP_META[c.relationship].label}</Pill>,
    },
    {
      key: "contacts",
      header: t.columns.contacts,
      align: "num",
      render: (c) =>
        c.contactCount === 0 ? (
          <CeldaVacia texto={t.noContacts} />
        ) : (
          <CellMain sub={c.optedOutCount > 0 ? <Texto>{t.optedOut(c.optedOutCount)}</Texto> : undefined}>{f.int(c.contactCount)}</CellMain>
        ),
    },
    {
      key: "deals",
      header: t.columns.deals,
      align: "num",
      render: (c) =>
        c.openDealCount === 0 ? (
          <CeldaVacia texto={t.noDeals} />
        ) : (
          <CellMain
            sub={
              // Abiertos sin monto (una señal aceptada sin presupuesto):
              // «Sin monto», como en el pipeline, y no «COP 0».
              c.openDealAmount !== null ? f.money(c.openDealAmount, undefined, { mode: "short" }) : <Texto>{MESSAGES.pipeline.noAmount}</Texto>
            }
          >
            {f.int(c.openDealCount)}
          </CellMain>
        ),
    },
    {
      key: "lastActivity",
      header: t.columns.lastActivity,
      align: "num",
      render: (c) => (c.lastActivityAt ? f.date(c.lastActivityAt) : <CeldaVacia texto={t.neverContacted} />),
    },
  ];

  return (
    <>
      <PageHeader eyebrow={MESSAGES.header.eyebrow} title={t.title} description={t.form.help} aside={<Button variant="primary" href="/ventas/empresas/nueva">{t.new}</Button>} />
      <ModuleTabs active="/ventas/empresas" />

      <div className="mb-6">
        <Buscador minSearch={MIN_SEARCH} />
      </div>

      <section aria-labelledby="empresas">
        <SectionTitle meta={t.meta(companies.length)}>
          <span id="empresas">{t.title}</span>
        </SectionTitle>
        <DataTable
          columns={columns}
          rows={companies}
          rowKey={(c) => c.id}
          caption={t.title}
          emptyState={
            filtered ? (
              <EmptyState title={t.emptySearch.title} description={t.emptySearch.description} action={{ label: t.emptySearch.action, href: "/ventas/empresas" }} />
            ) : (
              <EmptyState title={t.empty.title} description={t.empty.description} action={{ label: t.empty.action, href: "/ventas/empresas/nueva" }} />
            )
          }
        />
      </section>
    </>
  );
}

/**
 * Una celda de cifra sin valor: una raya, no una frase en la letra
 * monoespaciada de las cifras, que se leía como un dato y rompía la
 * columna. La frase («Sin negocios abiertos») sigue ahí para el lector
 * de pantalla.
 */
function CeldaVacia({ texto }: { texto: string }) {
  return (
    <>
      <span aria-hidden="true" className="text-muted">
        {MESSAGES.empresas.emptyCell}
      </span>
      <span className="sr-only">{texto}</span>
    </>
  );
}

/** Un texto dentro de una columna de cifras: con la letra del texto, no con la de los números. */
function Texto({ children }: { children: string }) {
  return <span className="font-sans">{children}</span>;
}
