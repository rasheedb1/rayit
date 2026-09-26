/**
 * La fila de la bandeja de aprobación tal como la pinta el cliente: solo
 * texto ya formateado y banderas (VEN-14). La arma la página con los datos
 * de @mc/db (listApprovalQueue), el formateador del workspace y los textos
 * de messages.ts; aquí no se consulta nada ni se formatea nada.
 */
import type { ApprovalItem } from "@mc/db/queries/bandejas";
import { channelLabel, noticeLang } from "@mc/core/outreach/messages";
import { FIGURE_RISK_CODES, type PreflightCode } from "@mc/core/outreach/preflight";
import type { Formatter } from "@/lib/format";
import { SOURCE_META } from "../_lib/estado";
import { MESSAGES } from "./messages";
import { motivoDe, reglasDe, riesgosDe, type Motivo } from "./motivo";

export interface JuezVista {
  /** «7,4 de 10 · mínimo 8». */
  total: string | null;
  /** La nota total no llega al mínimo de la rúbrica. */
  totalBajo: boolean;
  /** Cada dimensión; `bajo`: la que queda por debajo del mínimo (la que tiró la nota). */
  dimensiones: Array<{ key: string; label: string; valor: string; bajo: boolean }>;
  nota: string | null;
  intentos: string | null;
  riesgos: string[];
  reglas: string[];
}

export interface FilaVista {
  touchId: string;
  /** La etiqueta de la fila para un lector de pantalla: persona, marca, paso y canal. */
  etiqueta: string;
  persona: string;
  empresa: string;
  fichaHref: string;
  paso: string;
  canal: string;
  /** «Sale el 24 sep, 10:30». */
  sale: string | null;
  /** «Procedencia del contacto: Web de la empresa» (§8, decisión 5); null si el mensaje no tiene ficha. */
  procedencia: string | null;
  subject: string | null;
  body: string;
  /** Una respuesta en el hilo: en qué hilo responde (sin campo de asunto). */
  hilo: string | null;
  /** Un correo nuevo: el asunto se edita. */
  conAsunto: boolean;
  regenerando: boolean;
  regenerado: boolean;
  motivo: Motivo | null;
  juez: JuezVista | null;
  regenerable: boolean;
  /** La nota del juez no llega al mínimo: «Aprobar» pregunta antes, con la nota y el mínimo. */
  aprobarBajo: { pregunta: string; consecuencia: string } | null;
  /**
   * Las cifras que el pre-vuelo marcó sin origen en el perfil («23 %»), o
   * null. Con ellas el texto tal cual no se puede aprobar (releaseHeldTouch
   * lo rechaza): la fila no ofrece «Aprobar», sino «Editar y aprobar» con
   * las cifras señaladas en el editor.
   */
  cifrasSinOrigen: string[] | null;
  /** «Por qué quedó retenido», o, en una versión nueva, «La revisión de la versión nueva». */
  porqueTitulo: string;
}

const DIMENSIONES = ["relevance", "quality", "structure", "voice"] as const;

export function filaVista(item: ApprovalItem, f: Formatter): FilaVista {
  const t = MESSAGES;
  const n = item.stepIndex === null ? null : f.int(item.stepIndex);
  const paso = item.inboxReply
    ? t.fila.respuestaBandeja
    : item.sequenceName && n
    ? item.stepCount
      ? t.fila.paso(item.sequenceName, n, f.int(item.stepCount))
      : t.fila.pasoSinTotal(item.sequenceName, n)
    : t.fila.pasoSuelto;
  // Una respuesta en el hilo: el paso email_reply o la escrita en la bandeja (sin asunto propio: sale como «Re: …»).
  const esRespuesta = item.stepType === "email_reply" || item.inboxReply;
  const r = item.review;
  const persona = item.contactName ?? t.fila.sinNombre;
  const canal = channelLabel(noticeLang(f.locale), item.channel);
  const minimo = r?.threshold ?? null;
  const regenerado = item.status === "draft" && !item.regenerating;
  const nota = r?.totalScore ?? null;
  const bajo = nota !== null && minimo !== null && nota < minimo;
  const cifras = cifrasSinOrigenDe(r?.preflight ?? []);
  return {
    touchId: item.touchId,
    etiqueta: t.fila.label(item.companyName, persona, paso, canal),
    persona,
    empresa: item.companyName,
    fichaHref: `/ventas/empresas/${item.companyId}#cadencia`,
    paso,
    canal,
    sale: item.scheduledFor ? t.fila.sale(f.dateTime(item.scheduledFor.toISOString())) : null,
    procedencia: item.contactSource ? t.fila.procedencia(SOURCE_META[item.contactSource].label) : null,
    subject: item.subject,
    body: item.body,
    hilo: esRespuesta ? (item.threadSubject ? t.fila.enElHilo(item.threadSubject) : t.fila.enElHiloSinAsunto) : null,
    conAsunto: item.channel === "email" && !esRespuesta,
    regenerando: item.regenerating,
    regenerado,
    motivo: motivoDe(item.heldReason, f.locale, item.regenerable),
    juez: r
      ? {
          total: r.totalScore === null ? null : t.porque.total(f.decimal(r.totalScore, 1), minimo === null ? null : f.decimal(minimo, 1)),
          totalBajo: bajo,
          // La rúbrica tiene un mínimo para la nota; una dimensión por debajo de él es la que la tiró.
          dimensiones: DIMENSIONES.filter((d) => r.scores[d] !== undefined).map((d) => ({
            key: d, label: t.porque.dimensiones[d], valor: f.decimal(r.scores[d]!, 1), bajo: minimo !== null && r.scores[d]! < minimo,
          })),
          nota: r.judgeNote,
          intentos: r.attempts > 1 ? t.porque.intentos(f.int(r.attempts), r.attempts) : null,
          riesgos: riesgosDe(r.riskTriggers, f.locale),
          reglas: reglasDe(r.preflight),
        }
      : null,
    regenerable: item.regenerable,
    cifrasSinOrigen: cifras,
    // Con una cifra sin origen no hay «Aprobar» que preguntar: la nota ya no decide.
    aprobarBajo:
      !cifras && bajo && nota !== null && minimo !== null
        ? { pregunta: t.acciones.aprobarBajoPregunta(f.decimal(nota, 1)), consecuencia: t.acciones.aprobarBajoConsecuencia(f.decimal(minimo, 1)) }
        : null,
    porqueTitulo: regenerado ? t.porque.titleRegenerado : t.porque.title,
  };
}

/** Las cifras de las reglas del pre-vuelo que impiden aprobar el texto tal cual, sin repetir; null si no hay. */
function cifrasSinOrigenDe(issues: ReadonlyArray<{ code: string; detail: string | null }>): string[] | null {
  const cifras = [
    ...new Set(
      issues
        .filter((i) => (FIGURE_RISK_CODES as readonly string[]).includes(i.code as PreflightCode))
        .map((i) => i.detail?.trim() ?? "")
        .filter(Boolean),
    ),
  ];
  return cifras.length > 0 ? cifras : null;
}
