import type { Metadata } from "next";
import { getPerfilComercial, getPrimaryCreator, readPerfilDataAsOf } from "@mc/db/queries/perfil-comercial";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { ModuleTabs } from "../_componentes/pestanas";
import { withWorkspace } from "../_lib/db";
import { cifrasVista } from "./cifras";
import { MESSAGES } from "./messages";
import { Narrativa } from "./narrativa";
import { Recalcular } from "./recalcular";
import { Audiencia, Desempeno, Formatos, Identidad, PruebaSocial, Seccion, Tarifas } from "./secciones";

export const metadata: Metadata = { title: MESSAGES.metaTitle };
export const dynamic = "force-dynamic";

const RUTA_PERFIL = "/ventas/perfil";

/**
 * /ventas/perfil · el perfil comercial del creador (VEN-11,
 * docs/ventas-outreach.md §5.4).
 *
 * Una columna, como un media kit de Beacons o Passionfroot: quién eres,
 * la narrativa, qué te funciona (la mediana por red y los cinco mejores
 * videos con su porqué), a quién llegas, qué haces y cómo hablas, con
 * quién trabajaste y cuánto cobras. Cada cifra dice de dónde sale al
 * pasar el cursor y lleva a su post, a su campaña o al tarifario (la
 * regla del perfil de Stripe Atlas).
 *
 * La página solo lee lo guardado (creator_profile.media_kit →
 * perfil_comercial): calcular y redactar lo hace «Recalcular», que es
 * una acción, porque escribe y puede llamar al modelo.
 */
export default async function PerfilPage() {
  const datos = await withWorkspace(async (tx) => {
    const creador = await getPrimaryCreator(tx);
    if (!creador) return null;
    return {
      guardado: await getPerfilComercial(tx, creador.id),
      datosAl: await readPerfilDataAsOf(tx, creador.id),
    };
  });
  const f = formatterFor(await getCurrentWorkspace());
  const t = MESSAGES;

  const cabecera = (
    <>
      <PageHeader eyebrow={t.header.eyebrow} title={t.header.title} description={t.header.description} />
      <ModuleTabs active={RUTA_PERFIL} />
    </>
  );

  if (!datos) {
    return (
      <>
        {cabecera}
        <EmptyState title={t.sinCreador.title} description={t.sinCreador.description} />
      </>
    );
  }

  const { guardado, datosAl } = datos;
  if (!guardado) {
    return (
      <>
        {cabecera}
        <EmptyState title={t.vacio.title} description={t.vacio.description} />
        <div className="mt-4 flex justify-center">
          <Recalcular primera />
        </div>
      </>
    );
  }

  const { perfil, narrative } = guardado;
  const cifras = cifrasVista(perfil.claims, f);
  // Comparar dos instantes no es aritmética de métricas: dice si hay lecturas posteriores al cálculo.
  const hayDatosNuevos = datosAl !== null && Date.parse(datosAl) > Date.parse(guardado.computedAt);
  const fuente =
    narrative.source === "llm" && narrative.model
      ? t.narrativa.fuente.llm(narrative.model)
      : narrative.source === "edited"
        ? t.narrativa.fuente.edited
        : t.narrativa.fuente.template;

  return (
    <>
      {cabecera}
      <div className="mb-8 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="text-xs text-fg-3">
          <p>
            <time dateTime={guardado.computedAt}>{t.calculado(f.dateTime(guardado.computedAt))}</time>
          </p>
          {hayDatosNuevos && <p className="mt-1 text-warn">{t.datosNuevos}</p>}
        </div>
        <Recalcular editada={narrative.source === "edited"} />
      </div>

      <div className="max-w-3xl space-y-10">
        <Identidad perfil={perfil} cifras={cifras} f={f} />

        <Seccion id="perfil-narrativa" title={t.narrativa.title} meta={t.narrativa.meta}>
          <Narrativa
            key={narrative.writtenAt}
            texto={narrative.text}
            escritaEl={narrative.writtenAt}
            fuente={fuente}
            aviso={narrative.fallback ? t.narrativa.fallback[narrative.fallback] : null}
            cifras={cifras}
          />
        </Seccion>

        <Desempeno perfil={perfil} cifras={cifras} f={f} />
        <Audiencia perfil={perfil} cifras={cifras} f={f} />
        <Formatos perfil={perfil} cifras={cifras} />
        <PruebaSocial perfil={perfil} cifras={cifras} />
        <Tarifas perfil={perfil} cifras={cifras} />
      </div>
    </>
  );
}
