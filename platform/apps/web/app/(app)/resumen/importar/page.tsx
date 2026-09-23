import type { Metadata } from "next";
import { listImportableAccounts } from "@mc/db/queries/resumen";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { withWorkspace } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { MESSAGES } from "../messages";
import { Asistente } from "./asistente";

export const metadata: Metadata = { title: "Importar un CSV" };
// Lee la base en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

/**
 * La importación por CSV (RES-2): la vía que no depende de ninguna
 * aprobación de plataforma.
 *
 * El servidor solo aporta dos cosas: a qué cuentas se puede pegar un
 * archivo y cómo formatea fechas y cifras este workspace. Leer el
 * archivo, mapearlo y revisarlo pasa en el navegador; escribir, en la
 * server action, que vuelve a validar.
 */
export default async function ImportarPage() {
  const [cuentas, ws] = await Promise.all([
    withWorkspace((tx) => listImportableAccounts(tx)),
    getCurrentWorkspace(),
  ]);
  const t = MESSAGES.importar;

  return (
    <>
      <PageHeader
        eyebrow={t.eyebrow}
        title={t.title}
        description={t.description}
        aside={
          <Button href="/resumen" variant="secondary">
            {t.volver}
          </Button>
        }
      />
      <Asistente
        cuentas={cuentas}
        workspace={{ locale: ws.locale, currency: ws.currency, timezone: ws.timezone }}
      />
    </>
  );
}
