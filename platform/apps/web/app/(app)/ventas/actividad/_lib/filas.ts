/**
 * De una fila de outbound_queue a lo que pinta la lista: todo formateado
 * con el formateador del espacio (fechas en su zona, cifras en su
 * idioma) y los códigos convertidos en frases. Puro, con pruebas.
 */
import type { QueueRow } from "@mc/db/queries/actividad";
import type { Formatter } from "@/lib/format";
import { etiquetaTipo } from "../../cadencias/_lib/vista";
import type { FilaVista } from "../lista";
import { MESSAGES } from "../messages";
import { detalleDeMotivo, ESTADO_PILL, motivoDe } from "./vista";

const T = MESSAGES.fila;

/** Cuándo, en una frase: lo que va a salir, cuándo sale; lo que salió, cuándo salió; lo demás, cuándo cambió. */
function cuando(r: QueueRow, f: Formatter): string {
  if (r.status === "sent" && r.sentAt) return T.salio(f.dateTime(r.sentAt.toISOString()));
  if (r.status === "scheduled" || r.status === "draft" || r.status === "held") {
    if (!r.dueAt) return T.sinHora;
    const hora = f.dateTime(r.dueAt.toISOString());
    return r.retrying ? T.reintento(hora) : T.toca(hora);
  }
  return T.cambio(f.dateTime(r.statusChangedAt.toISOString()));
}

export function filaVista(r: QueueRow, f: Formatter): FilaVista {
  const tipo = r.stepType ? etiquetaTipo(r.stepType) : null;
  const paso = r.stepPosition !== null && tipo ? T.paso(f.int(r.stepPosition), tipo) : (tipo ?? T.sinPaso);
  const titulo = r.subject?.trim() || (r.channel === "email" && r.stepType !== "email_reply" ? T.sinAsunto : paso);
  const marcas: string[] = [];
  if (r.status === "sent" && r.openedAt) marcas.push(T.abierto);
  if (r.status === "sent" && r.repliedAt) marcas.push(T.respondido);
  const conIntentos = r.attemptCount > 0 && (r.status === "failed" || r.retrying);
  return {
    id: r.touchId,
    estado: MESSAGES.estados[r.status],
    estadoKind: ESTADO_PILL[r.status],
    titulo,
    contacto: r.contactName ?? r.contactEmail ?? T.sinContacto,
    contexto: [r.companyName, r.sequenceName ?? T.sinCadencia].filter(Boolean).join(" · "),
    paso,
    cuando: cuando(r, f),
    cuandoTitulo: r.accountName ? T.desde(r.accountName) : null,
    motivo: motivoDe(r.status, r.reason, f.locale),
    motivoDetalle: detalleDeMotivo(r.status, r.reason, f.locale),
    motivoTono: r.status === "failed" ? "bad" : r.status === "held" ? "warn" : "muted",
    marcas,
    intentos: conIntentos ? T.intentos(f.int(r.attemptCount), r.attemptCount) : null,
    reintentable: r.retryable,
    noReintentable: r.status === "failed" && !r.retryable,
    cancelable: r.cancelable,
    enviando: r.status === "processing",
    fichaHref: `/ventas/empresas/${r.companyId}`,
  };
}
