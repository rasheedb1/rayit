/**
 * La bandeja unificada tal como la pinta el cliente (VEN-14): solo texto
 * ya formateado con el locale y la zona del workspace, y banderas. La arma
 * la página con los datos de @mc/db/queries/bandejas; aquí no se consulta
 * nada. Puro: lo prueba bandeja.test.tsx.
 */
import {
  INBOX_REPLY_MAX_CHARS, type ClassifierStatus, type InboxConversation, type InboxFilter, type InboxThread, type PendingReply,
  type ReplyBlock,
} from "@mc/db/queries/bandejas";
import type { MessageIntent } from "@mc/core/outreach/intent";
import { channelLabel, noticeLang } from "@mc/core/outreach/messages";
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
    cuando: f.dayMonth(h.lastAt.toISOString()),
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
  /** Se puede corregir la intención (una respuesta que no es una baja). */
  corregible: boolean;
}

export interface PendienteVista {
  touchId: string;
  estado: string;
  cuerpo: string;
  /** Todavía espera su turno: se puede cancelar o editar. */
  cancelable: boolean;
  /** Por qué no salió (solo en las que no salieron). */
  motivo: string | null;
}

export interface ConversacionVista {
  contactId: string;
  channel: string;
  persona: string;
  empresa: string;
  canal: string;
  fichaHref: string;
  negocio: string | null;
  siguiente: string | null;
  mensajes: MensajeVista[];
  porSalir: PendienteVista[];
  noSalieron: PendienteVista[];
  bloqueo: ReplyBlock | null;
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

function pendienteVista(p: PendingReply): PendienteVista {
  const t = MESSAGES.responder;
  const noSalio = p.status === "failed" || p.status === "canceled";
  return {
    touchId: p.touchId,
    estado: t.estados[p.status] ?? p.status,
    cuerpo: p.body,
    cancelable: p.cancelable,
    motivo: noSalio ? (p.blockedReason ? t.motivos[p.blockedReason] ?? t.motivoGenerico : t.motivoGenerico) : null,
  };
}

export function conversacionVista(
  c: InboxConversation,
  f: Formatter,
  opts: { clasificador: ClassifierStatus; implicita?: boolean; puedeOperar?: boolean },
): ConversacionVista {
  const t = MESSAGES;
  const apagado = opts.clasificador === "off";
  return {
    contactId: c.contactId,
    channel: c.channel,
    persona: c.contactName ?? c.companyName,
    empresa: c.companyName,
    canal: channelLabel(noticeLang(f.locale), c.channel),
    fichaHref: `/ventas/empresas/${c.companyId}`,
    negocio: c.deal ? t.conversacion.negocio(c.deal.stageLabel) : null,
    siguiente: c.deal?.nextAction ? t.conversacion.siguiente(c.deal.nextAction) : null,
    mensajes: c.messages.map((m): MensajeVista => {
      const entrante = m.direction === "inbound";
      const r = m.referral;
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
        asunto: m.subject,
        cuerpo: m.body,
        cuando: f.dateTime(m.occurredAt.toISOString()),
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
        corregible: entrante && m.intent !== "unsubscribe",
      };
    }),
    porSalir: c.pending.map(pendienteVista),
    noSalieron: c.notSent.map(pendienteVista),
    bloqueo: c.replyBlock,
    cuenta: c.accountName,
    envioApagado: c.sendingOff,
    clasificadorApagado: apagado,
    hecha: c.done,
    // Los de la propia conversación, no los de la fila de la lista: un hilo
    // abierto por URL que no está en la vista actual también se marca leído.
    sinLeer: c.unread,
    implicita: opts.implicita === true,
    opcionesIntencion: INTENCIONES.map((i) => ({ value: i, label: t.intenciones[i].label })),
    puedeOperar: opts.puedeOperar !== false,
    maxCaracteres: INBOX_REPLY_MAX_CHARS,
  };
}
