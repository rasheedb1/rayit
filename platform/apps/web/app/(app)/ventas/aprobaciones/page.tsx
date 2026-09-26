import type { Metadata } from "next";
import { OUTREACH_URLS } from "@mc/core/outreach/messages";
import { listApprovalQueue } from "@mc/db/queries/bandejas";
import { getOutboundPolicy } from "@mc/db/queries/entregabilidad";
import { outreachWriterStatus } from "@mc/db/queries/outreach";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { Aviso } from "../../_lib/aviso";
import { ModuleTabs } from "../_componentes/pestanas";
import { withWorkspace } from "../_lib/db";
import { puedeOperarVentas } from "../_lib/permiso";
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
  const { cola, policy, writer } = await withWorkspace(async (tx) => ({
    cola: await listApprovalQueue(tx),
    policy: await getOutboundPolicy(tx),
    writer: await outreachWriterStatus(tx),
  }));
  const f = formatterFor(await getCurrentWorkspace());
  // Un 'viewer' o un 'client' ve la cola; aprobar, editar, regenerar y saltar es de quien opera (las acciones lo vuelven a mirar).
  const puedeOperar = await puedeOperarVentas();
  const t = MESSAGES;
  const filas = cola.items.map((i) => filaVista(i, f));
  const contador =
    cola.total > filas.length ? t.contadorParcial(f.int(filas.length), f.int(cola.total)) : t.contador(f.int(filas.length), filas.length);
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

      {/* La cola está siempre montada, también vacía: el aviso de lo último que se aprobó (y su «Deshacer») sigue ahí. */}
      <div className="grid gap-4">
        {filas.length > 0 ? <p className="text-sm text-ink-2 tabular-nums">{contador}</p> : null}
        {filas.length > 0 && !puedeOperar ? <Aviso info={t.sinPermiso} /> : null}
        {filas.length > 0 && puedeOperar && !policy.enabled ? (
          <div className="flex flex-wrap items-center gap-3">
            <Aviso info={t.avisos.envioApagado} className="flex-1" />
            <Button size="sm" variant="secondary" href={OUTREACH_URLS.policySwitch}>
              {t.avisos.irAPolitica}
            </Button>
          </div>
        ) : null}
        {regenerables && puedeOperar && writer === "off" ? <Aviso warning={t.avisos.iaApagada} /> : null}
        <Cola filas={filas} puedeOperar={puedeOperar} />
      </div>
    </>
  );
}
