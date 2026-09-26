/**
 * De una fila de outbound_queue a lo que pinta la lista: todo formateado
 * con el formateador del espacio (fechas en su zona, cifras en su
 * idioma) y los códigos convertidos en frases. Puro, con pruebas.
 */
import type { QueueRow } from "@mc/db/queries/actividad";
import type { Formatter } from "@/lib/format";
import { etiquetaTipo } from "../../cadencias/_lib/vista";
import { canalHref } from "../../canales/_lib/foco";
import type { FilaVista } from "../lista";
import { MESSAGES } from "../messages";
import { codigoDeMotivo, ESTADO_PILL, motivoDe } from "./vista";

const T = MESSAGES.fila;

/**
 * Cuándo, en una frase corta (la fila cabe a 400 px), y la fecha larga
 * para el detalle y el title: lo que va a salir, cuándo sale; lo demás,
 * cuándo salió o cuándo cambió.
 *
 * La frase corta va al lado de la pastilla del estado. Cuando la pastilla
 * ya dice el verbo («Falló», «Enviado», «Cancelado», «Saltado»), la corta
 * es solo la fecha: «Falló · Falló 24 de sept» repetía lo mismo dos veces.
 * El verbo sigue en la larga, que se lee en el title y en el detalle.
 * «Sale …», «Reintento …» y «Desde …» sí dicen algo que la pastilla no.
 *
 * La hora de lo programado es la que el despachador va a usar: un
 * reintento hecho fuera de la ventana ya viene corrido a su apertura
 * (retryScheduledFor), así que «Sale» no promete un envío inmediato que
 * no ocurre.
 */
function cuando(r: QueueRow, f: Formatter): { corto: string; largo: string | null } {
  const con = (d: Date, corta: (cuando: string) => string, larga: (cuando: string) => string = corta) => ({
    corto: corta(f.dateTimeShort(d.toISOString())),
    largo: larga(f.dateTime(d.toISOString())),
  });
  const soloFecha = (cuando: string) => cuando;
  if (r.status === "sent" && r.sentAt) return con(r.sentAt, soloFecha, T.salio);
  if (r.status === "scheduled" || r.status === "draft" || r.status === "held") {
    if (!r.dueAt) return { corto: T.sinHora, largo: null };
    return con(r.dueAt, r.retrying ? T.reintento : T.toca);
  }
  if (r.status === "processing") return con(r.statusChangedAt, T.desdeCorto, T.cambio.processing);
  const verbo: (cuando: string) => string = r.status in T.cambio ? T.cambio[r.status as keyof typeof T.cambio] : T.cambioGenerico;
  return con(r.statusChangedAt, soloFecha, verbo);
}

export function filaVista(r: QueueRow, f: Formatter): FilaVista {
  const tipo = r.stepType ? etiquetaTipo(r.stepType) : null;
  // Sin paso, el contexto ya dice «Sin cadencia»: la fila no repite «Fuera de una cadencia».
  const paso = r.stepPosition !== null && tipo ? T.paso(f.int(r.stepPosition), tipo) : tipo;
  const titulo = r.subject?.trim()
    || (r.channel === "email" && r.stepType !== "email_reply" ? T.sinAsunto : (paso ?? T.suelto(MESSAGES.uso.canales[r.channel])));
  const marcas: string[] = [];
  if (r.status === "sent" && r.openedAt) marcas.push(T.abierto);
  if (r.status === "sent" && r.repliedAt) marcas.push(T.respondido);
  const conIntentos = r.attemptCount > 0 && (r.status === "failed" || r.retrying);
  const momento = cuando(r, f);
  return {
    id: r.touchId,
    estado: MESSAGES.estados[r.status],
    estadoKind: ESTADO_PILL[r.status],
    titulo,
    // Qué mensaje es, para distinguir las casillas de una misma persona: el paso, o el asunto si no hay paso.
    queEs: paso ?? titulo,
    contacto: r.contactName ?? r.contactEmail ?? T.sinContacto,
    contexto: [r.companyName, r.sequenceName ?? T.sinCadencia].filter(Boolean).join(" · "),
    paso: paso !== titulo ? paso : null,
    cuando: momento.corto,
    cuandoCompleto: momento.largo,
    cuenta: r.accountName ? T.desde(r.accountName) : null,
    motivo: motivoDe(r.status, r.reason, f.locale),
    motivoCodigo: codigoDeMotivo(r.reason),
    motivoTono: r.status === "failed" ? "bad" : r.status === "held" ? "warn" : "muted",
    marcas,
    intentos: conIntentos ? T.intentos(f.int(r.attemptCount), r.attemptCount) : null,
    reintentable: r.retryable,
    // Un fallido que no se puede reintentar dice por qué, con la misma frase que el resumen de un reintento.
    bloqueo: r.status === "failed" && r.retryBlock && r.retryBlock !== "account_down"
      ? MESSAGES.reintentar.bloqueo(MESSAGES.resultado.reintento[r.retryBlock])
      : null,
    reconectar: r.status === "failed" && r.retryBlock === "account_down" ? canalHref(r.channel) : null,
    cancelable: r.cancelable,
    enviando: r.status === "processing",
    fichaHref: `/ventas/empresas/${r.companyId}`,
  };
}
