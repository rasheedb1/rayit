import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { ModuleTabs } from "../../_componentes/pestanas";
import { MESSAGES } from "../../_lib/messages";
import { countryOptions } from "../../_lib/paises";
import { NuevaEmpresaForm } from "./form";

export const metadata: Metadata = { title: MESSAGES.empresas.form.metaTitle };

export default async function NuevaEmpresaPage() {
  const t = MESSAGES.empresas.form;
  // Los países con el nombre en el idioma del espacio, armados aquí para
  // que el <Select> no dependa del ICU del navegador.
  const { locale } = await getCurrentWorkspace();
  return (
    <>
      <PageHeader eyebrow={MESSAGES.header.eyebrow} title={t.title} description={t.help} />
      <ModuleTabs active="/ventas/empresas" />
      <NuevaEmpresaForm countries={countryOptions(locale)} />
    </>
  );
}
