import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { readPublicMediaKit } from "@mc/db/queries/cotizar";
import { EmptyState } from "@/components/ui/empty-state";
import { withPublicShare } from "@/lib/db";
import { MESSAGES } from "@/app/(app)/cotizar/messages";
import { origenDeLaPeticion } from "@/app/(app)/cotizar/_lib/origen";
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
 * La lectura pasa por `public_media_kit(slug)` (migración 0030), que
 * decide si hay algo que enseñar, valida el vencimiento y
 * suma la visita — salvo si quien pide es el robot de un chat pintando
 * la vista previa del enlace. Esta página no consulta ninguna tabla.
 * Con contraseña, el bloqueo por fallos es POR ORIGEN: la página pasa
 * el suyo, así que solo ve «bloqueado» quien falló (o todos, si el
 * enlace llegó a su techo; ver la cabecera de 0030).
 * Un enlace que no existe es un 404 de verdad (not-found.tsx).
 */
export default async function MediaKitPublicoPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = MESSAGES.publico.kit;
  const h = await headers();
  const robot = esRobotDePrevisualizacion(h.get("user-agent"));
  const origin = origenDeLaPeticion(h);
  const kit = await withPublicShare((tx) => readPublicMediaKit(tx, slug, null, { count: !robot, origin }));

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
