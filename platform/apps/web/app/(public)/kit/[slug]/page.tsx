import type { Metadata } from "next";
import { readPublicMediaKit } from "@mc/db/queries/cotizar";
import { EmptyState } from "@/components/ui/empty-state";
import { withPublicShare } from "@/lib/db";
import { MESSAGES } from "@/app/(app)/cotizar/messages";
import { MediaKitProtegido } from "./protegido";
import { MediaKitVista } from "./vista";

export const metadata: Metadata = { title: "Media kit" };
// Cada visita cuenta y cada visita puede ver algo distinto: nada de caché.
export const dynamic = "force-dynamic";

/**
 * El media kit público (COT-2). Se abre SIN sesión y sin workspace: lo
 * único que se sabe de quien entra es que tiene el enlace.
 *
 * La lectura pasa por `public_media_kit(slug)` (migración 0022), que es
 * la que decide si hay algo que enseñar, valida el vencimiento y suma
 * la visita. Esta página no consulta ninguna tabla.
 */
export default async function MediaKitPublicoPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = MESSAGES.publico.kit;
  const kit = await withPublicShare((tx) => readPublicMediaKit(tx, slug));

  if (kit.status === "ok") return <MediaKitVista snapshot={kit.snapshot} />;
  if (kit.status === "password_required" || kit.status === "password_invalid") {
    return <MediaKitProtegido slug={slug} />;
  }
  if (kit.status === "expired") {
    return <EmptyState title={t.vencido.title} description={t.vencido.description} />;
  }
  return <EmptyState title={t.noExiste.title} description={t.noExiste.description} />;
}
