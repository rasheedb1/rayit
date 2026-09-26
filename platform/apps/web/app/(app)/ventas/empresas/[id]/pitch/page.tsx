import { notFound } from "next/navigation";
import { holdReasonText, noticeLang } from "@mc/core/outreach/messages";
import { loadPitchComposer, outreachWriterStatus } from "@mc/db/queries/outreach";
import { getCompany, listContacts } from "@mc/db/queries/ventas";
import { PageHeader } from "@/components/page-header";
import { origenDeLaPeticion } from "@/lib/auth/origen";
import { getDbMode } from "@/lib/db";
import { formatterFor } from "@/lib/format";
import { dealLabel } from "@/lib/negocio";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../../../_lib/db";
import type { EditorData } from "./editor";
import { PITCH } from "./messages";
import { MontajeDelEditor } from "./montaje";
import { editorKey } from "./vista";

export const dynamic = "force-dynamic";

/**
 * «Redactar pitch» (VEN-6 dentro de VEN-12): el editor abre el último
 * borrador de la empresa —el que redactó la IA o el que la persona
 * guardó, con el origen de cada cifra— o uno vacío. El layout de al lado
 * ya comprobó que la empresa está en el CRM del espacio (404 si no).
 *
 * La redacción con IA la hace el worker (outbound.generate y
 * outbound.review); aquí no se llama al modelo ni se lee su llave: si el
 * worker redacta lo dice su última corrida (outreachWriterStatus). En la
 * demo embebida no hay worker: redacta el redactor falso dentro del
 * proceso (redactarPitchEnLaDemo), así que la IA está «encendida». Los
 * enlaces del media kit y de la cotización los arma el servidor con el
 * origen de la app.
 */
export default async function PitchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspace = await getCurrentWorkspace();
  const f = formatterFor(workspace);
  const appUrl = await origenDeLaPeticion().catch(() => null);
  const demo = (await getDbMode()) === "embedded";
  const data = await withWorkspace(async (tx) => {
    const company = await getCompany(tx, id);
    if (!company) return null;
    return {
      company,
      contacts: await listContacts(tx, id),
      composer: await loadPitchComposer(tx, id, workspace.locale, { appUrl }),
      writer: demo ? ("fake" as const) : await outreachWriterStatus(tx),
    };
  });
  if (!data) notFound();
  const { company, contacts, composer, writer } = data;
  const lang = noticeLang(f.locale);
  const draft = composer.draft;

  const editor: EditorData = {
    companyId: company.id,
    company: { name: company.name, industry: company.industry, city: company.city },
    contacts: contacts
      .filter((c) => c.email && !c.optedOut && !c.bounced)
      .map((c) => ({ id: c.id, fullName: c.fullName, roleTitle: c.roleTitle, email: c.email!, firstTouch: !composer.contactedIds.includes(c.id) })),
    deals: composer.deals.map((d) => ({ id: d.id, label: dealLabel(company.name, d.name) ?? d.name, signalHeadline: d.signalHeadline })),
    variants: composer.variants,
    draft: draft
      ? {
          touchId: draft.touchId,
          contactId: draft.contactId,
          dealId: draft.dealId,
          subject: draft.subject ?? "",
          body: draft.body,
          held: draft.heldReason ? PITCH.revision.retenido(holdReasonText(lang, draft.heldReason)) : null,
          generated: draft.review !== null,
          score: draft.review?.total != null ? f.decimal(draft.review.total) : null,
          note: draft.review?.note ?? null,
          pending: draft.pending ? { stage: draft.pending.stage, hint: draft.pending.hint, error: draft.pending.lastError } : null,
          failed: draft.failed,
          copiedUnsourced: draft.unsourcedCopy,
        }
      : null,
    ai: writer === "anthropic" || writer === "fake" ? "on" : writer,
    sendingOn: composer.policy.enabled,
    policy: { hasPostalAddress: composer.policy.hasPostalAddress, hasEmailAccount: composer.policy.hasEmailAccount },
  };
  // El editor se vuelve a montar solo cuando la IA trae un borrador nuevo (montaje.tsx): ni en cada refresco
  // mientras redacta, ni cuando la persona guarda, copia o programa (se perderían el texto, el aviso y su foco).
  const aiKey = editorKey(draft);

  return (
    <>
      <PageHeader eyebrow={PITCH.eyebrow} title={PITCH.title(company.name)} description={PITCH.description} />
      <MontajeDelEditor key={company.id} data={editor} aiKey={aiKey} />
    </>
  );
}
