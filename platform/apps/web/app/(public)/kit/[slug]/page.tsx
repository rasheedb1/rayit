import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { readPublicMediaKit } from "@mc/db/queries/cotizar";
import { EmptyState } from "@/components/ui/empty-state";
import { withPublicShare } from "@/lib/db";
import { MESSAGES } from "@/app/(app)/cotizar/messages";
import { esRobotDePrevisualizacion } from "@/app/(app)/cotizar/_lib/robots";
import { MediaKitVista } from "@/app/(app)/cotizar/_ui/media-kit-vista";
import { MediaKitProtegido } from "./protegido";

export const metadata: Metadata = { title: "Media kit" };
// Cada visita cuenta y cada visita puede ver algo distinto: nada de caché.
export const dynamic = "force-dynamic";

/**
 * El media kit público (COT-2). Se abre SIN sesión y sin workspace: lo
 * único que se sabe de quien entra es que tiene el enlace.
 *
 * La lectura pasa por `public_media_kit(slug)` (migraciones 0022 y
 * 0023), que decide si hay algo que enseñar, valida el vencimiento y
 * suma la visita — salvo si quien pide es el robot de un chat pintando
 * la vista previa del enlace. Esta página no consulta ninguna tabla.
 * Un enlace que no existe es un 404 de verdad (not-found.tsx).
 */
export default async function MediaKitPublicoPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = MESSAGES.publico.kit;
  const robot = esRobotDePrevisualizacion((await headers()).get("user-agent"));
  const kit = await withPublicShare((tx) => readPublicMediaKit(tx, slug, null, { count: !robot }));

  switch (kit.status) {
    case "ok":
      return <MediaKitVista snapshot={kit.snapshot} />;
    case "password_required":
    case "password_invalid":
      return <MediaKitProtegido slug={slug} />;
    case "locked":
      return <MediaKitProtegido slug={slug} bloqueadoHasta={kit.lockedUntil} />;
    case "expired":
      return <EmptyState title={t.vencido.title} description={t.vencido.description} />;
    default:
      notFound();
  }
}
