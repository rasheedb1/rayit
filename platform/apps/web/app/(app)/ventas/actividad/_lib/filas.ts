/**
 * De una fila de outbound_queue a lo que pinta la lista: todo formateado
 * con el formateador del espacio (fechas en su zona, cifras en su
 * idioma) y los códigos convertidos en frases. Puro, con pruebas.
 */
import { OUTREACH_URLS } from "@mc/core/outreach/messages";
import { isTextlessStep } from "@mc/core/outreach/sequence-policy";
import { DONE_BY_HAND, type QueueBlockers, type QueueRow } from "@mc/db/queries/actividad";
import type { Formatter } from "@/lib/format";
import { etiquetaTipo } from "../../cadencias/_lib/vista";
import { canalHref } from "../../canales/_lib/foco";
import type { FilaVista } from "../lista";
import { MESSAGES } from "../messages";
import { codigoDeMotivo, ESTADO_PILL, motivoDe } from "./vista";

const T = MESSAGES.fila;
const W = MESSAGES.espera;
const M = MESSAGES.fila.aMano;

/**
 * Un gesto a mano por hacer: el borrador de un paso que hace la persona
 * (TEXTLESS_STEP_TYPES: comentario o reacción en una red, tarea a mano).
 * El despachador no lo reclama nunca, así que no «sale», no «se redacta» y
 * el envío apagado no lo para: dice «A mano · el 28 sep» y lleva «Hecho».
 */
export function esGestoPorHacer(r: Pick<QueueRow, "status" | "stepType">): boolean {
  return r.status === "draft" && r.stepType !== null && isTextlessStep(r.stepType);
}

/** Un gesto a mano que la persona ya marcó «Hecho» (markManualTouchDone). */
export function esGestoHecho(r: Pick<QueueRow, "status" | "reason">): boolean {
  return r.status === "skipped" && r.reason === DONE_BY_HAND;
}

/** Lo que la fila necesita saber además de su toque: qué para la cola (getQueueBlockers) y el reloj (para el año de la fecha). */
export interface ContextoFila {
  bloqueos?: QueueBlockers | null;
  now?: Date;
}

/** Los estados que esperan a salir: a ellos les importa si la cola está parada. */
const POR_SALIR = new Set<QueueRow["status"]>(["scheduled", "draft", "held"]);

/** Por qué espera una fila: la frase corta (al lado de la pastilla) y, si el motivo es de ESA fila, la frase entera con adónde ir. */
export interface Espera {
  corto: string;
  detalle: { texto: string; enlace: string; href: string } | null;
}

/** La frase entera y el enlace de un motivo, sin su corto. */
const sinCorto = ({ texto, enlace }: { texto: string; enlace: string }) => ({ texto, enlace });

/** La página de una cadencia, donde está «Reanudar». */
const cadenciaHref = (sequenceId: string) => `/ventas/cadencias/${sequenceId}`;

/**
 * La cadencia de la fila no deja salir el mensaje: las condiciones con
 * las que el despachador lo aplaza cada día en vez de mandarlo
 * (decideBeforeSend de @mc/db, en su orden). Solo cuenta con una
 * inscripción (enrollmentStatus): un toque suelto no tiene cadencia que
 * pausar. La inscripción de esta persona en pausa o en espera tras un
 * «ahora no» va primero; después, la cadencia entera en pausa o todavía
 * en borrador. Archivada no: el despachador lo cancela, no lo aplaza.
 */
function cadenciaParada(
  r: Pick<QueueRow, "sequenceId" | "sequenceStatus" | "enrollmentStatus" | "companyId">,
): Espera | null {
  if (r.enrollmentStatus === null) return null;
  const ficha = OUTREACH_URLS.companyCadence(r.companyId);
  if (r.enrollmentStatus === "paused") return { corto: W.enrollmentPaused.corto, detalle: { ...sinCorto(W.enrollmentPaused), href: ficha } };
  if (r.enrollmentStatus === "cooldown") {
    return { corto: W.enrollmentCooldown.corto, detalle: { ...sinCorto(W.enrollmentCooldown), href: ficha } };
  }
  if ((r.sequenceStatus === "paused" || r.sequenceStatus === "draft") && r.sequenceId) {
    return { corto: W.sequencePaused.corto, detalle: { ...sinCorto(W.sequencePaused), href: cadenciaHref(r.sequenceId) } };
  }
  return null;
}

/**
 * Por qué no va a salir aunque llegue su hora, o null. En este orden:
 *   · el envío del espacio apagado: para todo. La fila dice solo el
 *     corto («envío apagado»); la frase y el enlace están UNA vez en el
 *     aviso de arriba (AvisoApagado), no repetidos en cada fila. Si
 *     además su cadencia está parada, la fila lo suma («envío apagado ·
 *     cadencia en pausa») con el enlace a la cadencia: encender el envío
 *     no bastaría;
 *   · su cadencia en pausa, o esta persona en pausa o tras un «ahora
 *     no» (cadenciaParada): el despachador lo aplaza cada día;
 *   · el canal fuera de la política o sin ninguna cuenta conectada: el
 *     reclamo no lo toma.
 * Con cualquiera, «Sale el lunes» sería una promesa que el lunes no se
 * cumple.
 */
export function esperaDe(
  r: Pick<QueueRow, "status" | "stepType" | "channel" | "sequenceId" | "sequenceStatus" | "enrollmentStatus" | "companyId">,
  bloqueos: QueueBlockers | null | undefined,
): Espera | null {
  if (!POR_SALIR.has(r.status)) return null;
  // Un gesto a mano no sale por la cola: ni el envío apagado ni el canal sin cuenta lo paran.
  if (esGestoPorHacer(r)) return null;
  const cadencia = cadenciaParada(r);
  if (bloqueos && !bloqueos.outreachEnabled) {
    // El envío apagado ya lo dice el aviso de arriba: si además la cadencia está parada, eso es lo que la fila
    // tiene que contar («envío apagado · cadencia en pausa», con «Ir a la cadencia»). Encender el envío no la hace salir.
    return cadencia ? { corto: `${W.disabled.corto} · ${cadencia.corto}`, detalle: cadencia.detalle } : { corto: W.disabled.corto, detalle: null };
  }
  if (cadencia) return cadencia;
  if (!bloqueos) return null;
  const canal = MESSAGES.uso.canales[r.channel];
  if (bloqueos.channelsNotAllowed.includes(r.channel)) {
    return {
      corto: W.notAllowed.corto(canal),
      detalle: { texto: W.notAllowed.texto(canal), enlace: W.notAllowed.enlace, href: MESSAGES.uso.politicaHref },
    };
  }
  if (bloqueos.channelsWithoutAccount.includes(r.channel)) {
    return {
      corto: W.noAccount.corto(canal),
      detalle: { texto: W.noAccount.texto(canal), enlace: W.noAccount.enlace, href: canalHref(r.channel) },
    };
  }
  return null;
}

/**
 * Cuándo, en una frase corta (la fila cabe a 400 px), y la fecha larga
 * para el detalle y el title: lo que va a salir, cuándo sale; lo demás,
 * cuándo salió o cuándo cambió.
 *
 * La frase corta va al lado de la pastilla del estado. Cuando la pastilla
 * ya dice el verbo («Falló», «Enviado», «Cancelado», «Saltado»), la corta
 * es solo la fecha: «Falló · Falló 24 de sept» repetía lo mismo dos veces.
 * El verbo sigue en la larga, que se lee en el title y en el detalle.
 *
 * Solo lo programado dice «Sale …» (o «Reintento …»): es lo único que el
 * despachador reclama solo. Lo retenido y el borrador esperan a una
 * persona, así que su hora es la prevista («Previsto para … si lo
 * apruebas», «Sale cuando lo programes»). Y si la cola está parada para
 * esa fila (esperaDe), ninguna de las tres promete hora: «En espera ·
 * envío apagado».
 *
 * La hora de lo programado es la que el despachador va a usar: un
 * reintento hecho fuera de la ventana ya viene corrido a su apertura
 * (retryScheduledFor), así que «Sale» no promete un envío inmediato que
 * no ocurre.
 */
function cuando(
  r: QueueRow,
  f: Formatter,
  espera: { corto: string } | null,
  now: Date | undefined,
): { corto: string; largo: string | null } {
  const corta = (d: Date) => f.dateTimeShort(d.toISOString(), now);
  const larga = (d: Date) => f.dateTime(d.toISOString());
  const con = (d: Date, frase: (cuando: string) => string, fraseLarga: (cuando: string) => string = frase) => ({
    corto: frase(corta(d)),
    largo: fraseLarga(larga(d)),
  });
  const soloFecha = (c: string) => c;
  if (esGestoPorHacer(r)) return r.dueAt ? { corto: M.cuando(f.date(r.dueAt.toISOString())), largo: M.largo(larga(r.dueAt)) } : { corto: "", largo: null };
  if (espera) return { corto: T.enEspera(espera.corto), largo: r.dueAt ? T.esperaPrevisto(larga(r.dueAt)) : null };
  if (r.status === "sent" && r.sentAt) return con(r.sentAt, soloFecha, T.salio);
  if (r.status === "scheduled") return r.dueAt ? con(r.dueAt, r.retrying ? T.reintento : T.toca) : { corto: T.sinHora, largo: null };
  if (r.status === "held") return r.dueAt ? con(r.dueAt, T.previsto) : { corto: T.sinHora, largo: null };
  if (r.status === "draft") return { corto: T.borrador, largo: r.dueAt ? T.borradorPrevisto(larga(r.dueAt)) : null };
  if (r.status === "processing") return con(r.statusChangedAt, T.desdeCorto, T.cambio.processing);
  const verbo: (cuando: string) => string = r.status in T.cambio ? T.cambio[r.status as keyof typeof T.cambio] : T.cambioGenerico;
  return con(r.statusChangedAt, soloFecha, verbo);
}

export function filaVista(r: QueueRow, f: Formatter, ctx: ContextoFila = {}): FilaVista {
  const tipo = r.stepType ? etiquetaTipo(r.stepType) : null;
  // Sin paso, el contexto ya dice «Sin cadencia»: la fila no repite «Fuera de una cadencia».
  const paso = r.stepPosition !== null && tipo ? T.paso(f.int(r.stepPosition), tipo) : tipo;
  const asunto = r.subject?.trim() || null;
  const porHacer = esGestoPorHacer(r);
  const hechoAMano = esGestoHecho(r);
  // Un borrador de una cadencia que todavía no se redacta no es un correo vacío a punto de salir: dice su paso
  // («Paso 2 · Correo») y «por redactar», como las filas de LinkedIn; el asunto, cuando exista. Un gesto a mano
  // no se redacta nunca: su título es su paso y su nota, «lo haces tú».
  const porRedactar = !asunto && r.status === "draft" && paso !== null && !porHacer;
  const titulo = asunto
    ?? ((porRedactar || (porHacer && paso !== null)) ? paso
      : r.channel === "email" && r.stepType !== "email_reply" ? T.sinAsunto : (paso ?? T.suelto(MESSAGES.uso.canales[r.channel])));
  const marcas: string[] = [];
  if (r.status === "sent" && r.openedAt) marcas.push(T.abierto);
  if (r.status === "sent" && r.repliedAt) marcas.push(T.respondido);
  const conIntentos = r.attemptCount > 0 && (r.status === "failed" || r.retrying);
  const espera = esperaDe(r, ctx.bloqueos);
  const momento = cuando(r, f, espera, ctx.now);
  return {
    id: r.touchId,
    estado: porHacer ? M.estado : hechoAMano ? M.hecho : MESSAGES.estados[r.status],
    estadoKind: hechoAMano ? "good" : ESTADO_PILL[r.status],
    titulo,
    // Qué mensaje es, para distinguir las casillas de una misma persona: el paso, o el asunto si no hay paso.
    queEs: paso ?? titulo,
    contacto: r.contactName ?? r.contactEmail ?? T.sinContacto,
    contexto: [r.companyName, r.sequenceName ?? T.sinCadencia].filter(Boolean).join(" · "),
    paso: paso !== titulo ? paso : null,
    nota: porHacer ? M.nota : porRedactar ? T.porRedactar : null,
    cuando: momento.corto,
    cuandoCompleto: momento.largo,
    cuenta: r.accountName ? T.desde(r.accountName) : null,
    // Hecho a mano ya lo dice la pastilla: sin motivo debajo.
    motivo: hechoAMano ? null : motivoDe(r.status, r.reason),
    motivoCodigo: hechoAMano ? null : codigoDeMotivo(r.status, r.reason),
    motivoTono: r.status === "failed" ? "bad" : r.status === "held" ? "warn" : "muted",
    marcas,
    intentos: conIntentos ? T.intentos(f.int(r.attemptCount), r.attemptCount) : null,
    reintentable: r.retryable,
    // Un fallido que no se puede reintentar dice por qué, con la misma frase que el resumen de un reintento.
    bloqueo: r.status === "failed" && r.retryBlock && r.retryBlock !== "account_down"
      ? MESSAGES.reintentar.bloqueo(MESSAGES.resultado.reintento[r.retryBlock])
      : null,
    reconectar: r.status === "failed" && r.retryBlock === "account_down" ? canalHref(r.channel) : null,
    espera: espera?.detalle ?? null,
    // Lo retenido espera a una persona: su botón lleva a la cadencia de la ficha, donde está «Aprobar y enviar».
    revisar: r.status === "held" ? OUTREACH_URLS.companyCadence(r.companyId) : null,
    cancelable: r.cancelable,
    hecho: porHacer,
    enviando: r.status === "processing",
    fichaHref: OUTREACH_URLS.company(r.companyId),
  };
}
