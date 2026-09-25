import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { holdReasonText, noticeLang } from "@mc/core/outreach/messages";
import { loadPitchComposer } from "@mc/db/queries/outreach";
import { getCompany, listContacts } from "@mc/db/queries/ventas";
import { PageHeader } from "@/components/page-header";
import { formatterFor } from "@/lib/format";
import { dealLabel } from "@/lib/negocio";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../../../../_lib/db";
import { EditorDePitch, type EditorData } from "./editor";
import { PITCH } from "./messages";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const company = await withWorkspace((tx) => getCompany(tx, id));
  return { title: company ? PITCH.metaTitle(company.name) : PITCH.eyebrow };
}

/**
 * «Redactar pitch» (VEN-6 dentro de VEN-12): el editor abre el último
 * borrador de la empresa —el que redactó el generador, con el origen de
 * cada cifra, o uno que la persona guardó— o uno vacío. El layout de la
 * ficha ya comprobó que la empresa está en el CRM del espacio (404 si no).
 *
 * La redacción con IA la hace el worker (outbound.generate y
 * outbound.review); aquí no se llama al modelo. Sin la llave de Anthropic
 * el editor lo dice y funciona igual a mano.
 */
export default async function PitchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspace = await getCurrentWorkspace();
  const f = formatterFor(workspace);
  const data = await withWorkspace(async (tx) => {
    const company = await getCompany(tx, id);
    if (!company) return null;
    return {
      company,
      contacts: await listContacts(tx, id),
      composer: await loadPitchComposer(tx, id, workspace.locale),
    };
  });
  if (!data) notFound();
  const { company, contacts, composer } = data;
  const lang = noticeLang(f.locale);

  const editor: EditorData = {
    companyId: company.id,
    company: { name: company.name, industry: company.industry, city: company.city },
    contacts: contacts
      .filter((c) => c.email && !c.optedOut && !c.bounced)
      .map((c) => ({ id: c.id, fullName: c.fullName, roleTitle: c.roleTitle, email: c.email!, firstTouch: !composer.contactedIds.includes(c.id) })),
    deals: composer.deals.map((d) => ({ id: d.id, label: dealLabel(company.name, d.name) ?? d.name, signalHeadline: d.signalHeadline })),
    claims: composer.claims,
    creator: composer.creator,
    mediaKitPath: composer.mediaKitSlug ? `/kit/${composer.mediaKitSlug}` : null,
    draft: composer.draft
      ? {
          touchId: composer.draft.touchId,
          contactId: composer.draft.contactId,
          dealId: composer.draft.dealId,
          subject: composer.draft.subject ?? "",
          body: composer.draft.body,
          held: composer.draft.heldReason ? PITCH.revision.retenido(holdReasonText(lang, composer.draft.heldReason)) : null,
          generated: composer.draft.review !== null,
          score: composer.draft.review?.total != null ? f.decimal(composer.draft.review.total) : null,
          note: composer.draft.review?.note ?? null,
        }
      : null,
    aiConfigured: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    sendingOn: composer.policy.enabled,
  };

  return (
    <>
      <PageHeader eyebrow={PITCH.eyebrow} title={PITCH.title(company.name)} description={PITCH.description} />
      <p className="-mt-5 mb-6 text-sm">
        <Link href={`/ventas/empresas/${company.id}`} className="text-ink-2 underline underline-offset-4 hover:text-ink">
          {PITCH.back}
        </Link>
      </p>
      <EditorDePitch data={editor} />
    </>
  );
}
