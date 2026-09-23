import type { Metadata } from "next";
import { getCurrentRateCard, getPrimaryCreator, getRateCardInputs } from "@mc/db/queries/cotizar";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { withWorkspace } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { MESSAGES } from "../messages";
import { TarifarioTabla } from "../tarifario-tabla";
import { BASIS_VACIO, leerBasis } from "../_lib/tarifario";

export const metadata: Metadata = { title: "Cotizar" };
// Lee la base en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

export default async function CotizarPage() {
  const t = MESSAGES.tarifario;
  const ws = await getCurrentWorkspace();

  const datos = await withWorkspace(async (tx) => {
    const creador = await getPrimaryCreator(tx);
    if (!creador) return null;
    return {
      creatorId: creador.id,
      inputs: await getRateCardInputs(tx, creador.id),
      tarifario: await getCurrentRateCard(tx, creador.id),
    };
  });

  const cabecera = (
    <PageHeader
      eyebrow={t.eyebrow}
      title={t.title}
      description={t.description}
      aside={
        <div className="flex flex-wrap gap-2">
          <Button href="/cotizar/media-kit">{MESSAGES.navegacion.mediaKit}</Button>
          <Button variant="primary" href="/cotizar/cotizaciones">
            {MESSAGES.navegacion.cotizaciones}
          </Button>
        </div>
      }
    />
  );

  if (!datos?.inputs) {
    return (
      <>
        {cabecera}
        <EmptyState
          title={t.vacio.title}
          description={t.vacio.description}
          action={{ label: t.vacio.accion, href: "/conexiones" }}
        />
      </>
    );
  }

  const basis = datos.tarifario ? leerBasis(datos.tarifario.card.basis) : BASIS_VACIO;

  return (
    <>
      {cabecera}
      <TarifarioTabla
        creatorId={datos.creatorId}
        inputs={datos.inputs}
        basisInicial={basis}
        settings={ws}
        sinGuardar={datos.tarifario === null}
      />
    </>
  );
}
