import { EmptyState } from "@/components/ui/empty-state";
import { MESSAGES } from "@/app/(app)/cotizar/messages";

/**
 * El 404 de los enlaces públicos: un slug que no existe, un media kit
 * despublicado o una cotización que sigue en borrador. Responde 404 de
 * verdad (notFound() en las páginas), no un 200 con un aviso, y no
 * distingue entre los tres casos: el enlace es la credencial, y decir
 * «existe pero no puedes verlo» ya es dar información.
 */
export default function PublicoNotFound() {
  const t = MESSAGES.publico.noExiste;
  return (
    <div className="py-16">
      <EmptyState title={t.title} description={t.description} />
    </div>
  );
}
