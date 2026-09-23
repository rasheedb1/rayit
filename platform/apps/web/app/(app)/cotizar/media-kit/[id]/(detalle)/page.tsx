import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getMediaKitById } from "@mc/db/queries/cotizar";
import { Button } from "@/components/ui/button";
import { withWorkspace } from "@/lib/db";
import { MESSAGES } from "../../../messages";
import { MediaKitVista } from "../../../_ui/media-kit-vista";

export const metadata: Metadata = { title: "Vista previa del media kit" };
export const dynamic = "force-dynamic";

/**
 * El media kit como lo ve la marca, dentro del panel. Lee el snapshot
 * con la sesión del creador y no pasa por public_media_kit(): revisar
 * tu propio kit no suma una visita al contador que le enseñas a la
 * marca, ni pide la contraseña que tú mismo pusiste.
 *
 * Que exista lo comprueba layout.tsx, fuera del esqueleto de
 * loading.tsx (pulido r7); aquí se repite solo por si se borró entre
 * las dos lecturas.
 */
export default async function VistaPreviaMediaKitPage({ params }: { params: Promise<{ id: string }> }) {
  const t = MESSAGES.mediaKit.vistaPrevia;
  const { id } = await params;
  const kit = await withWorkspace((tx) => getMediaKitById(tx, id));
  if (!kit) notFound();

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-4 py-3">
        <p className="min-w-0 text-sm text-ink-2">{t.aviso}</p>
        <Button size="sm" href="/cotizar/media-kit">
          {t.volver}
        </Button>
      </div>
      <MediaKitVista snapshot={kit.snapshot} />
    </div>
  );
}
