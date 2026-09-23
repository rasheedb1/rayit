import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { ModuleTabs } from "../../_componentes/pestanas";
import { MESSAGES } from "../../_lib/messages";

/**
 * Una empresa que no existe, o que es de otro espacio de trabajo (RLS
 * la esconde igual). Antes la ficha pintaba este mismo aviso por su
 * cuenta y respondía 200; desde el pulido r4 llama a notFound() y la
 * respuesta es un 404 de verdad (app/(app)/no-existe.test.tsx). La
 * salida es la lista de Empresas, no el plan.
 */
export default function EmpresaNoEncontrada() {
  const t = MESSAGES.empresas;
  return (
    <>
      <PageHeader eyebrow={MESSAGES.header.eyebrow} title={t.title} />
      <ModuleTabs active="/ventas/empresas" />
      <EmptyState
        title={t.detail.notFound.title}
        description={t.detail.notFound.description}
        action={{ label: t.detail.notFound.action, href: "/ventas/empresas" }}
      />
    </>
  );
}
