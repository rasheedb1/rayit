import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/permisos";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { MESSAGES } from "../_lib/messages";
import { ImportarForm } from "./form";

export const metadata: Metadata = { title: "Importar ingresos de plataformas" };
export const dynamic = "force-dynamic";

export default async function ImportarIngresosPage() {
  // Quien no puede escribir tampoco ve el formulario: la Server Action
  // lo vuelve a comprobar, pero una pantalla que se pinta y falla al
  // enviar es una promesa rota.
  await requirePermission("finanzas.pago.registrar");
  const { currency } = await getCurrentWorkspace();
  const t = MESSAGES.importar;
  return (
    <>
      <PageHeader
        eyebrow={t.eyebrow}
        title={t.title}
        description={t.description}
        aside={
          <Button variant="ghost" href="/finanzas/ingresos">
            {MESSAGES.acciones.volver}
          </Button>
        }
      />
      <ImportarForm currency={currency} />
    </>
  );
}
