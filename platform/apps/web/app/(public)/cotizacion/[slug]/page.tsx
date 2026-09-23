import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { readPublicQuote } from "@mc/db/queries/cotizar";
import { withPublicShare } from "@/lib/db";
import { MESSAGES } from "@/app/(app)/cotizar/messages";
import { esRobotDePrevisualizacion } from "@/app/(app)/cotizar/_lib/robots";
import { DocumentoCotizacion } from "@/app/(app)/cotizar/_ui/documento-cotizacion";
import { AceptarCotizacion } from "./aceptar";

export const metadata: Metadata = { title: "Cotización" };
// Cada visita se registra y el estado cambia: nada de caché.
export const dynamic = "force-dynamic";

/**
 * La cotización que abre la marca (COT-3 y COT-4), sin sesión.
 *
 * Lo que se ve es el snapshot congelado al enviarla —lo que se envió,
 * no lo que el creador haya editado después— más el estado de hoy, que
 * es lo único vivo. Lo entrega `public_quote(slug)` (0022 y 0023), que
 * además la marca como vista… salvo si quien pide es el robot de
 * WhatsApp o Slack pintando la vista previa del enlace: eso no es la
 * marca. Un enlace que no existe es un 404 (not-found.tsx).
 */
export default async function CotizacionPublicaPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = MESSAGES.publico.cotizacion;
  const robot = esRobotDePrevisualizacion((await headers()).get("user-agent"));
  const resultado = await withPublicShare((tx) => readPublicQuote(tx, slug, { count: !robot }));
  if (resultado.status !== "ok") notFound();

  const q = resultado.quote;
  const accion =
    q.status === "sent" || q.status === "viewed" ? (
      <AceptarCotizacion slug={q.slug} />
    ) : q.status === "accepted" ? (
      <div role="status" className="rounded-md border border-good/30 bg-good-wash px-4 py-3">
        <p className="text-sm font-medium text-good">{t.graciasTitle}</p>
        <p className="mt-1 text-sm text-ink-2">{t.graciasDescription}</p>
      </div>
    ) : (
      <p className="text-sm text-ink-2">{q.status === "rejected" ? t.rechazada : t.vencida}</p>
    );

  return <DocumentoCotizacion q={q} accion={accion} enlaceKit={q.mediaKitSlug ? `/kit/${q.mediaKitSlug}` : null} />;
}
