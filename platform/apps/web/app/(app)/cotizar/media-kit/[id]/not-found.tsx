import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { MESSAGES } from "../../messages";

/**
 * La vista previa de un media kit que no existe o es de otro espacio de
 * trabajo. Sale a la lista de media kits, no al plan (el 404 genérico
 * de (app)). Mismo patrón que cotizaciones/[id]/not-found.tsx.
 */
export default function MediaKitNoEncontrado() {
  const t = MESSAGES.noEncontrado.mediaKit;
  return (
    <>
      <PageHeader eyebrow={t.eyebrow} title={MESSAGES.mediaKit.title} />
      <EmptyState title={t.title} description={t.description} action={{ label: t.accion, href: "/cotizar/media-kit" }} />
    </>
  );
}
