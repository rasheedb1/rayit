/**
 * La bandeja unificada tal como la pinta el cliente (VEN-14): solo texto
 * ya formateado con el locale y la zona del workspace, y banderas. La arma
 * la página con los datos de @mc/db/queries/bandejas; aquí no se consulta
 * nada. Puro: lo prueba bandeja.test.tsx.
 */
import {
  INBOX_REPLY_MAX_CHARS, type BandejaChannel, type ClassifierStatus, type InboxConversation, type InboxFilter, type InboxThread,
  type PendingReply, type ReplyBlock,
} from "@mc/db/queries/bandejas";
import type { MessageIntent } from "@mc/core/outreach/intent";
import { channelLabel, holdReasonText, noticeLang, type NoticeLang } from "@mc/core/outreach/messages";
import type { Formatter } from "@/lib/format";
import { INTENCIONES, MESSAGES, VISTAS, type Intencion, type IntencionClave, type VistaBandeja } from "./messages";

/**
 * INTENCIONES (messages.ts, que llega al cliente y no puede importar
 * @mc/core/outreach/intent) es la lista de MESSAGE_INTENTS en el orden en
 * que se ofrece «Corregir». Si una de las dos cambia, esto no compila; la
 * prueba compara además los valores.
 */
type Iguales<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const INTENCIONES_AL_DIA: Iguales<Intencion, MessageIntent> = true;

const CONOCIDAS: ReadonlySet<string> = new Set(INTENCIONES);

/** La clave de la etiqueta de una intención; sin clasificar, «pendiente». */
export function intencionClave(intent: string | null): IntencionClave {
  return intent && CONOCIDAS.has(intent) ? (intent as Intencion) : "pendiente";
}

/** La vista de la lista que pide la URL; por defecto, los pendientes. */
export function vistaDe(v: string | undefined): VistaBandeja {
  return (VISTAS as readonly string[]).includes(v ?? "") ? (v as VistaBandeja) : "pendientes";
}

/** El filtro de @mc/db de cada vista. */
export const FILTRO: Record<VistaBandeja, InboxFilter> = { pendientes: "pending", hechas: "done", todas: "all" };

/** La URL de la lista en una vista (la de siempre, sin parámetro). */
export function listaHref(vista: VistaBandeja): string {
  return vista === "pendientes" ? "/ventas/bandeja" : `/ventas/bandeja?vista=${vista}`;
}

/** La URL de un hilo: la ficha y el canal van en la consulta, la lista (y su vista) queda a la izquierda. */
export function hiloHref(contactId: string, channel: string, vista: VistaBandeja = "pendientes"): string {
  const base = `/ventas/bandeja?contacto=${encodeURIComponent(contactId)}&canal=${encodeURIComponent(channel)}`;
  return vista === "pendientes" ? base : `${base}&vista=${vista}`;
}

export interface HiloVista {
  key: string;
  href: string;
  persona: string;
  empresa: string;
  canal: string;
  cuando: string;
  extracto: string;
  deNosotros: boolean;
  sinLeer: number;
  sinLeerTexto: string | null;
  intencion: IntencionClave;
  hecha: boolean;
  /** Es el hilo de la conversación abierta (j y k cuentan desde aquí). */
  activo: boolean;
  /**
   * La página lo abrió sola (la primera sin leer): la conversación solo se
   * ve en escritorio, así que solo ahí se marca como elegida. En un
   * teléfono se ve la lista y ninguna fila parece abierta.
   */
  soloEscritorio: boolean;
}

/**
 * Las clases de la columna de la lista. Una rejilla con UNA columna que
 * puede encogerse (minmax(0,1fr)): con la pista implícita «auto», los
 * extractos con `truncate` la estiraban hasta su ancho sin cortar (894 px
 * en vez de 20rem), la lista quedaba debajo de la conversación, que se
 * comía los clics, y a 400 px la página se desplazaba de lado. jsdom no
 * mide cajas: lo mide scripts/ancho-movil.mjs (TOPE) y esta función lo
 * fija en bandeja.test.tsx.
 */
export function columnaListaClase(conversacionVisible: boolean): string {
  return conversacionVisible
    ? "hidden min-w-0 lg:grid lg:grid-cols-[minmax(0,1fr)] lg:content-start lg:gap-3"
    : "grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-3";
}

export function hiloVista(
  h: InboxThread, f: Formatter, activo: boolean, vista: VistaBandeja = "pendientes", implicita = false,
): HiloVista {
  return {
    key: `${h.contactId}:${h.channel}`,
    href: hiloHref(h.contactId, h.channel, vista),
    persona: h.contactName ?? h.companyName,
    empresa: h.companyName,
    canal: channelLabel(noticeLang(f.locale), h.channel),
    // «27 sep», la misma forma corta de fecha que el resto de Ventas (pulido r2 y r5), no «27/9».
    cuando: f.date(h.lastAt.toISOString()),
    extracto: h.lastSnippet,
    deNosotros: h.lastDirection === "outbound",
    sinLeer: h.unread,
    sinLeerTexto: h.unread > 0 ? MESSAGES.lista.sinLeer(f.int(h.unread)) : null,
    intencion: intencionClave(h.lastIntent),
    hecha: h.done,
    activo,
    soloEscritorio: activo && implicita,
  };
}

/**
 * Adónde pasa «Marcar como hecha» (y la tecla e) en la vista de
 * pendientes: la conversación de detrás de la abierta, o la de delante si
 * era la última, o la lista si era la única. En «Hechas» y «Todas» la
 * conversación sigue en la lista: se queda (null). Una abierta que no está
 * en la lista (por URL) también se queda.
 */
export function siguienteTrasHecha(hilos: readonly HiloVista[], vista: VistaBandeja, lista: string): string | null {
  if (vista !== "pendientes") return null;
  const i = hilos.findIndex((h) => h.activo);
  if (i < 0) return null;
  return hilos[i + 1]?.href ?? hilos[i - 1]?.href ?? lista;
}

export interface ReferidoVista {
  propuesta: string;
  nombre: string | null;
  correo: string | null;
  cargo: string | null;
  creado: boolean;
  /**
   * Creada la ficha (§5.7: «se crea el contacto y se propone enrolarlo»):
   * adónde lleva «Enrolar en una cadencia», con el negocio y la persona
   * nueva elegidos, y el enlace a su ficha. null mientras no se creó.
   */
  enrolarHref: string | null;
  contactoHref: string | null;
}

export interface MensajeVista {
  id: string;
  deNosotros: boolean;
  /**
   * Quién lo escribió: «Tú», el nombre de la ficha, o la dirección de quien
   * respondió si no es ella (un colega, un tercero en copia). Front y
   * Superhuman siempre dicen quién habló.
   */
  de: string;
  /** Lo escribió alguien que no es la ficha: «no es Paula Restrepo». */
  noEsLaFicha: string | null;
  asunto: string | null;
  cuerpo: string;
  cuando: string;
  intencion: IntencionClave | null;
  /** Quién la clasificó y con cuánta confianza, o que falta clasificarla. */
  clasificacion: string | null;
  /** La frase del clasificador: por qué. */
  porque: string | null;
  vuelve: string | null;
  enfria: string | null;
  referido: ReferidoVista | null;
  /**
   * La baja la pidió alguien que no es la ficha: la cadencia se detuvo y
   * la ficha NO quedó de baja; lo decide una persona con «Corregir».
   */
  bajaDeTercero: string | null;
  /** Se puede corregir la intención: todo, salvo una baja con la ficha ya de baja. */
  corregible: boolean;
}

export interface PendienteVista {
  touchId: string;
  estado: string;
  cuerpo: string;
  /** Todavía espera su turno: se puede cancelar o editar. */
  cancelable: boolean;
  /** Por qué no salió, o por qué la retuvo el envío. */
  motivo: string | null;
  /** La retuvo el despachador: también espera en la bandeja de aprobación. */
  retenida: boolean;
}

export interface ConversacionVista {
  contactId: string;
  channel: BandejaChannel;
  persona: string;
  empresa: string;
  canal: string;
  /** La URL de este hilo en la vista actual: donde queda fijada la abierta sola al marcarse leída. */
  href: string;
  fichaHref: string;
  negocio: string | null;
  siguiente: string | null;
  mensajes: MensajeVista[];
  porSalir: PendienteVista[];
  noSalieron: PendienteVista[];
  bloqueo: ReplyBlock | null;
  /** Un correo sin la dirección postal del pie: no se puede responder hasta guardarla en la política. */
  faltaDireccion: boolean;
  cuenta: string | null;
  envioApagado: boolean;
  /** La clasificación con IA no está encendida: se dice arriba y no se promete. */
  clasificadorApagado: boolean;
  hecha: boolean;
  sinLeer: number;
  /** Abierta sin pedirla (la primera sin leer, en escritorio): en un teléfono no se ve ni se marca leída. */
  implicita: boolean;
  /** Las opciones de «Corregir», en palabras. */
  opcionesIntencion: Array<{ value: Intencion; label: string }>;
  /** Su rol deja responder, corregir y marcar (PUEDEN_OPERAR_VENTAS); sin él, la conversación se lee. */
  puedeOperar: boolean;
  /** El tope de «Tu respuesta»: el de @mc/db, el mismo que mira el servidor. */
  maxCaracteres: number;
}

/**
 * Adónde lleva «Enrolar en una cadencia»: la cadencia del hilo con el
 * negocio (y, si ya existe, la persona referida) elegidos; sin cadencia,
 * los negocios de la ficha de la empresa.
 */
export function enrolarHrefDe(c: Pick<InboxConversation, "sequenceId" | "companyId" | "deal">, contactoId: string | null = null): string {
  if (!c.sequenceId) return `/ventas/empresas/${c.companyId}#negocios`;
  const q = new URLSearchParams();
  if (c.deal) q.set("negocio", c.deal.id);
  if (contactoId) q.set("contacto", contactoId);
  const qs = q.toString();
  return `/ventas/cadencias/${c.sequenceId}${qs ? `?${qs}` : ""}#enrolar`;
}

/**
 * Por qué no salió (o por qué espera): lo que no salió, con el
 * blocked_reason; lo retenido por el despachador, con el held_reason en
 * palabras del motor (la misma frase de la bandeja de aprobación, donde
 * también espera). Lo que solo está en cola no lleva motivo.
 */
function motivoPendiente(p: PendingReply, lang: NoticeLang): string | null {
  const t = MESSAGES.responder;
  if (p.status === "failed" || p.status === "canceled") {
    return p.blockedReason ? t.motivos[p.blockedReason] ?? t.motivoGenerico : t.motivoGenerico;
  }
  if (p.status === "held") {
    const frase = p.heldReason ? holdReasonText(lang, p.heldReason, "queue_edit_only") : null;
    return frase ? t.retenida(`${frase.charAt(0).toUpperCase()}${frase.slice(1)}`) : t.retenidaSinMotivo;
  }
  return null;
}

function pendienteVista(p: PendingReply, lang: NoticeLang): PendienteVista {
  const t = MESSAGES.responder;
  return {
    touchId: p.touchId,
    estado: t.estados[p.status] ?? p.status,
    cuerpo: p.body,
    cancelable: p.cancelable,
    motivo: motivoPendiente(p, lang),
    retenida: p.status === "held",
  };
}

export function conversacionVista(
  c: InboxConversation,
  f: Formatter,
  opts: { clasificador: ClassifierStatus; implicita?: boolean; puedeOperar?: boolean; vista?: VistaBandeja },
): ConversacionVista {
  const t = MESSAGES;
  const apagado = opts.clasificador === "off";
  const lang = noticeLang(f.locale);
  const persona = c.contactName ?? c.companyName;
  return {
    contactId: c.contactId,
    channel: c.channel,
    persona,
    empresa: c.companyName,
    canal: channelLabel(lang, c.channel),
    href: hiloHref(c.contactId, c.channel, opts.vista),
    fichaHref: `/ventas/empresas/${c.companyId}`,
    negocio: c.deal ? t.conversacion.negocio(c.deal.stageLabel) : null,
    siguiente: c.deal?.nextAction ? t.conversacion.siguiente(c.deal.nextAction) : null,
    mensajes: c.messages.map((m): MensajeVista => {
      const entrante = m.direction === "inbound";
      const r = m.referral;
      // Un tercero: la dirección que dio el proveedor («Otra Persona <otra@marca.test>» se lee tal cual).
      const tercero = entrante && !m.fromContact ? (m.fromAddress?.trim() || t.conversacion.otraPersona) : null;
      const bajaDeTercero = entrante && m.intent === "unsubscribe" && !c.contactOptedOut;
      const quien = r ? [r.name, r.email].filter(Boolean).join(" · ") : "";
      const clasificacion = !entrante
        ? null
        : !m.intent
        ? apagado
          ? t.conversacion.sinClasificarApagado
          : t.conversacion.sinClasificar
        : m.intentSource === "person"
        ? t.conversacion.corregida
        : m.intentSource
        ? t.conversacion.clasificada(
            t.conversacion.fuentes[m.intentSource],
            m.intentConfidence === null ? null : f.pct(m.intentConfidence),
          )
        : null;
      return {
        id: m.id,
        deNosotros: !entrante,
        de: !entrante ? t.conversacion.tu : tercero ?? persona,
        noEsLaFicha: tercero ? t.conversacion.noEsLaFicha(persona) : null,
        asunto: m.subject,
        cuerpo: m.body,
        cuando: f.dateTimeShort(m.occurredAt.toISOString()),
        intencion: entrante ? intencionClave(m.intent) : null,
        clasificacion,
        porque: entrante && m.intentReason ? t.conversacion.porque(m.intentReason) : null,
        vuelve: entrante && m.intent === "ooo" && m.resumeAt ? t.conversacion.vuelve(f.date(m.resumeAt.toISOString(), "long")) : null,
        enfria:
          entrante && m.intent === "not_now" && m.cooldownUntil ? t.conversacion.enfria(f.date(m.cooldownUntil.toISOString(), "long")) : null,
        referido:
          entrante && m.intent === "referral"
            ? {
                propuesta: quien ? t.referido.propone(quien) : t.referido.proponeSinDatos,
                nombre: r?.name ?? null,
                correo: r?.email ?? null,
                cargo: r?.role ?? null,
                creado: m.referralContactId !== null,
                enrolarHref: m.referralContactId ? enrolarHrefDe(c, m.referralContactId) : null,
                contactoHref: m.referralContactId ? `/ventas/empresas/${c.companyId}#contactos` : null,
              }
            : null,
        bajaDeTercero: bajaDeTercero
          ? tercero
            ? t.conversacion.bajaDeTercero(tercero)
            : t.conversacion.bajaSinFicha
          : null,
        // Una baja se corrige solo mientras la ficha no esté de baja (la pidió un tercero): la de la ficha es de una sola dirección.
        corregible: entrante && !(m.intent === "unsubscribe" && c.contactOptedOut),
      };
    }),
    porSalir: c.pending.map((p) => pendienteVista(p, lang)),
    noSalieron: c.notSent.map((p) => pendienteVista(p, lang)),
    bloqueo: c.replyBlock,
    faltaDireccion: c.postalAddressMissing,
    cuenta: c.accountName,
    envioApagado: c.sendingOff,
    clasificadorApagado: apagado,
    hecha: c.done,
    // Los de la propia conversación, no los de la fila de la lista: un hilo
    // abierto por URL que no está en la vista actual también se marca leído.
    sinLeer: c.unread,
    implicita: opts.implicita === true,
    // En «Corregir», la baja se dice por lo que hace: da de baja a la ficha (la pidiera ella o un tercero).
    opcionesIntencion: INTENCIONES.map((i) => ({ value: i, label: i === "unsubscribe" ? t.corregir.opcionBaja : t.intenciones[i].label })),
    puedeOperar: opts.puedeOperar !== false,
    maxCaracteres: INBOX_REPLY_MAX_CHARS,
  };
}
