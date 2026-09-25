import { notFound } from "next/navigation";
import {
  EDITABLE_CHANNELS, EDITABLE_STEP_TYPES, getSequenceDetail, listAngles, listEnrollableDeals, listSequenceTemplates,
  signalContacts, type ContactOption, type EnrollableDeal, type SequenceDetail,
} from "@mc/db/queries/cadencias";
import { PageHeader } from "@/components/page-header";
import { Pill } from "@/components/ui/pill";
import { formatterFor, type Formatter } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { ModuleTabs } from "../../../_componentes/pestanas";
import { withWorkspace } from "../../../_lib/db";
import { avisoDePolitica, esperaEntre, ESTADO_PILL, etiquetaCanal, etiquetaTipo, horaDePaso, resumenFlujo } from "../../_lib/vista";
import { IconoCanal } from "../../canal";
import { MESSAGES } from "../../messages";
import { Controles } from "../controles";
import { Enrolar, type NegocioVista } from "../enrolar";
import { LineaDeTiempo } from "../linea-de-tiempo";
import { Notas } from "../notas";
import { ProponerOtraVez } from "../proponer-otra-vez";
import type { PasoVista } from "../tarjeta-paso";

export const dynamic = "force-dynamic";

const CADENCIAS = "/ventas/cadencias";

/** Las direcciones de una persona, en palabras: «Correo, LinkedIn». */
function alcance(c: ContactOption): string {
  const t = MESSAGES.proponer;
  if (c.optedOut) return t.deBaja;
  const canales = [c.hasEmail && "email", c.hasLinkedin && "linkedin", c.hasInstagram && "instagram_dm"].filter(Boolean) as string[];
  return canales.length ? t.sinCanales(canales.map(etiquetaCanal).join(", ")) : t.sinDireccion;
}

/**
 * El texto del botón de activar. Dice «y escribir a X» solo si X de verdad
 * va a entrar al pulsarlo: nadie dentro todavía, el negocio de la
 * propuesta sigue abierto (está entre los enrolables) y X es de su marca,
 * con alguna dirección, sin baja y sin otra cadencia viva. En pausa es
 * «Reanudar», que pasa por la misma acción y enrola igual.
 */
function etiquetaActivar(d: SequenceDetail, negocios: readonly EnrollableDeal[]): string {
  const t = MESSAGES.estado;
  const negocio = d.proposal?.dealId ? negocios.find((n) => n.id === d.proposal!.dealId) : undefined;
  const c = d.proposalContact && d.enrollments.total === 0 ? negocio?.contacts.find((x) => x.id === d.proposalContact!.id) : undefined;
  const entra = c && !c.optedOut && !c.enrolled && !c.liveElsewhere && (c.hasEmail || c.hasLinkedin || c.hasInstagram);
  const persona = entra ? c.name : null;
  if (d.status === "paused") return persona ? t.reanudarPara(persona) : t.reanudar;
  return persona ? t.activarPara(persona) : t.activar;
}

function pasosVista(d: SequenceDetail, f: Formatter, angulos: ReadonlyMap<string, string>): PasoVista[] {
  const t = MESSAGES.paso;
  const sinTexto = ["linkedin_like", "instagram_like", "manual_task"];
  return d.steps.map((s, i) => ({
    id: s.id,
    numero: f.int(s.position),
    diaLabel: t.dia(f.int(s.dayOffset)),
    esperaLabel: esperaEntre(d.steps[i - 1], s, f),
    horaLabel: t.hora(horaDePaso(s.scheduledTime, f)),
    tipoLabel: s.stepType === "manual_task" ? `${etiquetaTipo(s.stepType)} · ${etiquetaCanal(s.channel)}` : etiquetaTipo(s.stepType),
    anguloLabel: s.angleLabel ?? (s.angleKey ? (angulos.get(s.angleKey) ?? s.angleKey) : null),
    guia: s.guidanceEs,
    modoLabel: sinTexto.includes(s.stepType) ? t.sinTexto : s.generateWithAi ? t.generacion : t.textoFijo,
    activoLabel: s.requiresAsset ? (t.activo[s.requiresAsset] ?? null) : null,
    aviso: avisoDePolitica(d, s.id, f),
    dayOffset: s.dayOffset,
    stepType: s.stepType,
    channel: s.channel,
    scheduledTime: s.scheduledTime,
    angleKey: s.angleKey,
    generateWithAi: s.generateWithAi,
    subjectTemplate: s.subjectTemplate,
    bodyTemplate: s.bodyTemplate,
    requiresAsset: s.requiresAsset,
  }));
}

/**
 * /ventas/cadencias/[id] (VEN-13): la línea de tiempo de una cadencia.
 *
 * Arriba, su nombre, su estado y sus acciones (Activar es el segundo
 * clic después de «Proponer cadencia»). Debajo, el resumen «Día 0: … →
 * Día 1: …» (el flow viewer de Chief), por qué el recomendador decidió
 * lo que decidió y lo que la política no dejará cumplir. Luego, los
 * pasos, editables en el sitio; al lado, proponer otra vez y enrolar.
 */
export default async function CadenciaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const datos = await withWorkspace(async (tx) => {
    const d = await getSequenceDetail(tx, id);
    if (!d) return null;
    const archivada = d.status === "archived";
    return {
      d,
      plantillas: await listSequenceTemplates(tx),
      angulos: await listAngles(tx),
      negocios: archivada ? [] : await listEnrollableDeals(tx, d.id),
      // Solo las personas de la marca: no el contexto entero del recomendador (plantillas y ángulos ya están arriba).
      personas: d.signal && !d.locked && !archivada ? await signalContacts(tx, d.signal.id) : [],
    };
  });
  if (!datos) notFound();
  const { d, plantillas, angulos, negocios, personas } = datos;
  const f = formatterFor(await getCurrentWorkspace());
  const t = MESSAGES;
  const archivada = d.status === "archived";
  const nombresPlantilla = new Map(plantillas.map((p) => [p.slug, p.nameEs]));
  const nombresAngulo = new Map(angulos.map((a) => [a.key, a.label]));

  const descripcion = d.signal
    ? t.detalle.desdeSenal(t.senalTipos[d.signal.kind], d.signal.headline, d.signal.companyName)
    : d.templateName
      ? t.detalle.plantilla(d.templateName)
      : undefined;
  const negociosVista: NegocioVista[] = negocios.map((n) => ({
    id: n.id,
    label: `${n.companyName} · ${n.name}`,
    personas: n.contacts.map((c) => ({
      id: c.id,
      nombre: c.name ?? t.proponer.sinPersona,
      detalle: [
        c.roleTitle,
        c.enrolled ? t.enrolar.yaDentro : c.liveElsewhere ? t.enrolar.enOtraDetalle(c.liveElsewhere) : alcance(c),
      ]
        .filter(Boolean)
        .join(" · "),
      disponible: !c.enrolled && !c.liveElsewhere && !c.optedOut && (c.hasEmail || c.hasLinkedin || c.hasInstagram),
      dentro: c.enrolled,
    })),
  }));

  return (
    <>
      <PageHeader
        eyebrow={t.header.title}
        title={d.name}
        description={descripcion}
        aside={
          <div className="flex flex-wrap items-center gap-2">
            <Pill kind={ESTADO_PILL[d.status]}>{t.estados[d.status] ?? d.status}</Pill>
            <span className="text-sm tabular-nums text-fg-2">{t.detalle.dentro(f.int(d.enrollments.live), d.enrollments.live)}</span>
          </div>
        }
      />
      <ModuleTabs active={CADENCIAS} />

      <Controles
        sequenceId={d.id}
        status={d.status}
        nombre={d.name}
        activarLabel={etiquetaActivar(d, negocios)}
        puedeActivar={d.steps.length > 0}
      />

      {d.steps.length > 0 && (
        <section aria-labelledby="resumen" className="mb-6">
          <h2 id="resumen" className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-3">
            {t.detalle.flujo}
          </h2>
          <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm tabular-nums">
            {resumenFlujo(d.steps, f).map((trozo, i) => (
              <li key={d.steps[i]!.id} className="flex items-center gap-2">
                {i > 0 && (
                  <span aria-hidden="true" className="text-fg-3">
                    →
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-fg-3">
                    <IconoCanal canal={d.steps[i]!.channel} tipo={d.steps[i]!.stepType} size={13} />
                  </span>
                  {trozo}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="mb-6">
        <Notas d={d} f={f} plantillas={nombresPlantilla} angulos={nombresAngulo} />
      </div>

      {(archivada || d.locked) && (
        <p className="mb-4 max-w-3xl rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-fg-2">
          {archivada ? t.detalle.archivada : t.detalle.bloqueada}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <LineaDeTiempo
          sequenceId={d.id}
          pasos={pasosVista(d, f, nombresAngulo)}
          estructura={!d.locked && !archivada}
          editable={!archivada}
          angulos={angulos.map((a) => ({ value: a.key, label: a.label }))}
          tipos={EDITABLE_STEP_TYPES.map((s) => ({ value: s, label: etiquetaTipo(s) }))}
          canales={EDITABLE_CHANNELS.map((c) => ({ value: c, label: etiquetaCanal(c) }))}
        />
        <aside className="grid content-start gap-4">
          {d.signal && !d.locked && !archivada && (
            <ProponerOtraVez
              sequenceId={d.id}
              signalId={d.signal.id}
              elegida={d.proposalContact?.id ?? null}
              personas={personas
                .filter((c) => !c.optedOut)
                .map((c) => ({ value: c.id, label: `${c.name ?? t.proponer.sinPersona} · ${alcance(c)}` }))}
            />
          )}
          {!archivada && (
            <Enrolar sequenceId={d.id} negocios={negociosVista} activa={d.status === "active"} inicial={d.proposal?.dealId ?? null} />
          )}
        </aside>
      </div>
    </>
  );
}
