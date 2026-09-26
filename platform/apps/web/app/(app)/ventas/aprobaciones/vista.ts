/**
 * La fila de la bandeja de aprobación tal como la pinta el cliente: solo
 * texto ya formateado y banderas (VEN-14). La arma la página con los datos
 * de @mc/db (listApprovalQueue), el formateador del workspace y los textos
 * de messages.ts; aquí no se consulta nada ni se formatea nada.
 */
import type { ApprovalItem } from "@mc/db/queries/bandejas";
import { channelLabel, noticeLang } from "@mc/core/outreach/messages";
import type { Formatter } from "@/lib/format";
import { MESSAGES } from "./messages";
import { motivoDe, reglasDe, riesgosDe, type Motivo } from "./motivo";

export interface JuezVista {
  total: string | null;
  dimensiones: Array<{ key: string; label: string; valor: string }>;
  nota: string | null;
  intentos: string | null;
  riesgos: string[];
  reglas: string[];
}

export interface FilaVista {
  touchId: string;
  persona: string;
  empresa: string;
  fichaHref: string;
  paso: string;
  canal: string;
  /** «Sale el 24 sep, 10:30». */
  sale: string | null;
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
}

const DIMENSIONES = ["relevance", "quality", "structure", "voice"] as const;

export function filaVista(item: ApprovalItem, f: Formatter): FilaVista {
  const t = MESSAGES;
  const n = item.stepIndex === null ? null : f.int(item.stepIndex);
  const paso = item.sequenceName && n
    ? item.stepCount
      ? t.fila.paso(item.sequenceName, n, f.int(item.stepCount))
      : t.fila.pasoSinTotal(item.sequenceName, n)
    : t.fila.pasoSuelto;
  const esRespuesta = item.stepType === "email_reply";
  const r = item.review;
  return {
    touchId: item.touchId,
    persona: item.contactName ?? t.fila.sinNombre,
    empresa: item.companyName,
    fichaHref: `/ventas/empresas/${item.companyId}#cadencia`,
    paso,
    canal: channelLabel(noticeLang(f.locale), item.channel),
    sale: item.scheduledFor ? t.fila.sale(f.dateTime(item.scheduledFor.toISOString())) : null,
    subject: item.subject,
    body: item.body,
    hilo: esRespuesta ? (item.threadSubject ? t.fila.enElHilo(item.threadSubject) : t.fila.enElHiloSinAsunto) : null,
    conAsunto: item.channel === "email" && !esRespuesta,
    regenerando: item.regenerating,
    regenerado: item.status === "draft" && !item.regenerating,
    motivo: motivoDe(item.heldReason, f.locale, item.regenerable),
    juez: r
      ? {
          total: r.totalScore === null ? null : t.porque.total(f.decimal(r.totalScore, 1)),
          dimensiones: DIMENSIONES.filter((d) => r.scores[d] !== undefined).map((d) => ({
            key: d, label: t.porque.dimensiones[d], valor: f.decimal(r.scores[d]!, 1),
          })),
          nota: r.judgeNote,
          intentos: r.attempts > 1 ? t.porque.intentos(f.int(r.attempts), r.attempts) : null,
          riesgos: riesgosDe(r.riskTriggers, f.locale),
          reglas: reglasDe(r.preflight),
        }
      : null,
    regenerable: item.regenerable,
  };
}
