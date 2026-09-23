import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { ModuleTabs } from "../../_componentes/pestanas";
import { MESSAGES } from "../../_lib/messages";
import { NuevaEmpresaForm } from "./form";

export const metadata: Metadata = { title: "Nueva empresa · Ventas" };

export default function NuevaEmpresaPage() {
  const t = MESSAGES.empresas.form;
  return (
    <>
      <PageHeader eyebrow={MESSAGES.header.eyebrow} title={t.title} description={t.help} />
      <ModuleTabs active="/ventas/empresas" />
      <NuevaEmpresaForm />
    </>
  );
}
