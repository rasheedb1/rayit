import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { ModuleTabs } from "../../_componentes/pestanas";
import { MESSAGES } from "../messages";

/** Una cadencia que no existe o que es de otro espacio (la RLS la esconde igual): un 404 con salida a la lista. */
export default function CadenciaNoEncontrada() {
  return (
    <>
      <PageHeader eyebrow={MESSAGES.header.eyebrow} title={MESSAGES.header.title} />
      <ModuleTabs active="/ventas/cadencias" />
      <EmptyState
        title={MESSAGES.errores.not_found!}
        action={{ label: MESSAGES.detalle.volver, href: "/ventas/cadencias" }}
      />
    </>
  );
}
