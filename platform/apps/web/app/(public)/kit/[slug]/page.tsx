import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { readPublicMediaKit } from "@mc/db/queries/cotizar";
import { EmptyState } from "@/components/ui/empty-state";
import { withPublicShare } from "@/lib/db";
import { MESSAGES } from "@/app/(app)/cotizar/messages";
import { origenDeLaPeticion } from "@/app/(app)/cotizar/_lib/origen";
import { esRobotDePrevisualizacion } from "@/app/(app)/cotizar/_lib/robots";
import { MediaKitVista } from "@/app/(app)/cotizar/_ui/media-kit-vista";
import { MediaKitProtegido } from "./protegido";

// Cada visita cuenta y cada visita puede ver algo distinto: nada de caché.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

/**
 * UNA lectura por petición, compartida entre generateMetadata y la
 * página (React cache, por petición): public_media_kit() suma la visita,
 * y el título no puede contarla otra vez.
 */
const leerKit = cache(async (slug: string) => {
  const h = await headers();
  const robot = esRobotDePrevisualizacion(h.get("user-agent"));
  const origin = origenDeLaPeticion(h);
  return withPublicShare((tx) => readPublicMediaKit(tx, slug, null, { count: !robot, origin }));
});

/**
 * «Media kit · Laura Ríos» en la pestaña. Solo con el kit abierto:
 * detrás de una contraseña, vencido o bloqueado no se dice de quién es.
 * Nunca se indexa.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const kit = await leerKit(slug);
  const m = MESSAGES.meta;
  return {
    title: kit.status === "ok" ? m.kitPublico(kit.snapshot.creator.displayName) : m.kitPublicoSinDatos,
    robots: { index: false, follow: false },
  };
}

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
export default async function MediaKitPublicoPage({ params }: Props) {
  const { slug } = await params;
  const t = MESSAGES.publico.kit;
  const kit = await leerKit(slug);

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
