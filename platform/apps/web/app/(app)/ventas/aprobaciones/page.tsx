import type { Metadata } from "next";
import { OUTREACH_URLS } from "@mc/core/outreach/messages";
import { listApprovalQueue } from "@mc/db/queries/bandejas";
import { getOutboundPolicy } from "@mc/db/queries/entregabilidad";
import { outreachWriterStatus } from "@mc/db/queries/outreach";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { Aviso } from "../../_lib/aviso";
import { ModuleTabs } from "../_componentes/pestanas";
import { withWorkspace } from "../_lib/db";
import { Cola } from "./cola";
import { MESSAGES } from "./messages";
import { filaVista } from "./vista";

export const metadata: Metadata = { title: MESSAGES.metaTitle };
export const dynamic = "force-dynamic";

/** La pestaña de esta pantalla en la tira de Ventas. */
const RUTA_APROBACIONES = "/ventas/aprobaciones";

/**
 * /ventas/aprobaciones · la bandeja de aprobación (VEN-14).
 *
 * Los mensajes retenidos, uno por fila, con todo lo que hace falta para
 * decidir sin abrir otra pantalla: a quién va, en qué paso, el mensaje
 * completo y por qué quedó retenido (la regla, la nota del juez, los
 * riesgos). Se aprueba, se edita, se pide otra versión o se salta, también
 * con el teclado.
 */
export default async function AprobacionesPage() {
  const { items, policy, writer } = await withWorkspace(async (tx) => ({
    items: await listApprovalQueue(tx),
    policy: await getOutboundPolicy(tx),
    writer: await outreachWriterStatus(tx),
  }));
  const f = formatterFor(await getCurrentWorkspace());
  const t = MESSAGES;
  const filas = items.map((i) => filaVista(i, f));
  const regenerables = filas.some((x) => x.regenerable || x.regenerando);

  return (
    <>
      <PageHeader
        eyebrow={t.header.eyebrow}
        title={t.header.title}
        description={t.header.description}
        aside={
          <Button variant="ghost" href="/ventas">
            {t.header.back}
          </Button>
        }
      />
      <ModuleTabs active={RUTA_APROBACIONES} />

      {filas.length === 0 ? (
        <EmptyState title={t.vacio.title} description={t.vacio.description} action={{ label: t.vacio.action, href: "/ventas/cadencias" }} />
      ) : (
        <div className="grid gap-4">
          <p className="text-sm text-ink-2 tabular-nums">{t.contador(f.int(filas.length), filas.length)}</p>
          {!policy.enabled ? (
            <div className="flex flex-wrap items-center gap-3">
              <Aviso info={t.avisos.envioApagado} className="flex-1" />
              <Button size="sm" variant="secondary" href={OUTREACH_URLS.policySwitch}>
                {t.avisos.irAPolitica}
              </Button>
            </div>
          ) : null}
          {regenerables && writer === "off" ? <Aviso warning={t.avisos.iaApagada} /> : null}
          <Cola filas={filas} />
        </div>
      )}
    </>
  );
}
