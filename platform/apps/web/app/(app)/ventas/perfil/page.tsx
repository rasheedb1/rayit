import type { Metadata } from "next";
import { NARRATIVE_MAX_CHARS, narrativeLanguage, verifierContext } from "@mc/core/outreach/narrativa";
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
import { puedeEditarElPerfil } from "./permiso";
import { CalcularPrimero, Recalcular } from "./recalcular";
import { Audiencia, Desempeno, Formatos, Fuentes, Identidad, PruebaSocial, Seccion, Tarifas } from "./secciones";

export const metadata: Metadata = { title: MESSAGES.metaTitle };
export const dynamic = "force-dynamic";
/**
 * «Recalcular» es una server action de esta página y hereda este tope:
 * dos intentos del modelo de a lo sumo 25 s cada uno (lib/llm/narrativa.ts)
 * más las lecturas y el guardado caben en 60 s, el máximo del plan Hobby
 * de Vercel. Si la función se cortara, cada llamada ya pagada quedó en
 * outbound_llm_call apenas respondió (actions.ts).
 */
export const maxDuration = 60;

const RUTA_PERFIL = "/ventas/perfil";

/** El nombre de un idioma en el del workspace («español», «Spanish»), o su código si Intl no lo conoce. */
function nombreDeIdioma(codigo: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(codigo) ?? codigo;
  } catch {
    return codigo;
  }
}

/**
 * /ventas/perfil · el perfil comercial del creador (VEN-11,
 * docs/ventas-outreach.md §5.4).
 *
 * Una columna, como un media kit de Beacons o Passionfroot: quién eres,
 * la narrativa, qué te funciona (la mediana por red y los cinco mejores
 * videos con lo que los distingue), a quién llegas, qué haces y cómo
 * hablas, con quién trabajaste y cuánto cobras. Cada cifra dice qué es y
 * de dónde sale (tabla, red y fecha) al tocarla o pasar el cursor, y
 * lleva a su post, a su campaña, al tarifario, a Resumen o a su fila en
 * «De dónde sale cada cifra», al final (la regla del perfil de Stripe
 * Atlas).
 *
 * La página solo lee lo guardado (creator_profile.media_kit →
 * perfil_comercial): calcular y redactar lo hace «Recalcular», que es
 * una acción, porque escribe y puede llamar al modelo. Solo se ofrece a
 * quien puede usarla (puedeEditarElPerfil).
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
  const [ws, editable] = await Promise.all([getCurrentWorkspace(), puedeEditarElPerfil()]);
  const f = formatterFor(ws);
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
        {editable ? <CalcularPrimero /> : <EmptyState title={t.vacio.title} description={t.vacio.soloLectura} />}
      </>
    );
  }

  const { perfil, narrative } = guardado;
  const cifras = cifrasVista(perfil.claims, f);
  const lengua = narrativeLanguage(f.locale);
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
          {hayDatosNuevos && editable && <p className="mt-1 text-warn">{t.datosNuevos}</p>}
        </div>
        {editable && <Recalcular editada={narrative.source === "edited"} />}
      </div>

      <div className="max-w-3xl space-y-10">
        <Identidad perfil={perfil} cifras={cifras} f={f} />

        <Seccion id="perfil-narrativa" title={t.narrativa.title} meta={t.narrativa.meta}>
          {/* Sin key: al guardar, la narrativa nueva llega por props y el aviso de guardado no se pierde (narrativa.tsx). */}
          <Narrativa
            texto={narrative.text}
            escritaEl={narrative.writtenAt}
            fuente={fuente}
            aviso={narrative.fallback ? t.narrativa.fallback[narrative.fallback] : null}
            idioma={t.narrativa.idioma(nombreDeIdioma(lengua, f.locale))}
            cifras={cifras}
            editable={editable}
            verificador={verifierContext(perfil, lengua)}
            maxTexto={f.int(NARRATIVE_MAX_CHARS)}
          />
        </Seccion>

        <Desempeno perfil={perfil} cifras={cifras} f={f} />
        <Audiencia perfil={perfil} cifras={cifras} f={f} />
        <Formatos perfil={perfil} cifras={cifras} />
        <PruebaSocial perfil={perfil} cifras={cifras} />
        <Tarifas perfil={perfil} cifras={cifras} />
        <Fuentes perfil={perfil} cifras={cifras} f={f} />
      </div>
    </>
  );
}
