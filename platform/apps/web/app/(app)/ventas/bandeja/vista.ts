/**
 * La bandeja unificada tal como la pinta el cliente (VEN-14): solo texto
 * ya formateado con el locale y la zona del workspace, y banderas. La arma
 * la página con los datos de @mc/db/queries/bandejas; aquí no se consulta
 * nada.
 */
import type { InboxConversation, InboxThread, ReplyBlock } from "@mc/db/queries/bandejas";
import { channelLabel, noticeLang } from "@mc/core/outreach/messages";
import type { Formatter } from "@/lib/format";
import { MESSAGES, type IntencionClave } from "./messages";

const INTENCIONES: ReadonlySet<string> = new Set(["interested", "not_now", "ooo", "unsubscribe", "referral", "ambiguous"]);

/** La clave de la etiqueta de una intención; sin clasificar, «pendiente». */
export function intencionClave(intent: string | null): IntencionClave {
  return intent && INTENCIONES.has(intent) ? (intent as IntencionClave) : "pendiente";
}

/** La URL de un hilo: la ficha y el canal van en la consulta, la lista queda a la izquierda. */
export function hiloHref(contactId: string, channel: string): string {
  return `/ventas/bandeja?contacto=${encodeURIComponent(contactId)}&canal=${encodeURIComponent(channel)}`;
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
  activo: boolean;
}

export function hiloVista(h: InboxThread, f: Formatter, activo: boolean): HiloVista {
  return {
    key: `${h.contactId}:${h.channel}`,
    href: hiloHref(h.contactId, h.channel),
    persona: h.contactName ?? h.companyName,
    empresa: h.companyName,
    canal: channelLabel(noticeLang(f.locale), h.channel),
    cuando: f.dateTime(h.lastAt.toISOString()),
    extracto: h.lastSnippet,
    deNosotros: h.lastDirection === "outbound",
    sinLeer: h.unread,
    sinLeerTexto: h.unread > 0 ? MESSAGES.lista.sinLeer(f.int(h.unread)) : null,
    intencion: intencionClave(h.lastIntent),
    activo,
  };
}

export interface MensajeVista {
  id: string;
  deNosotros: boolean;
  asunto: string | null;
  cuerpo: string;
  cuando: string;
  intencion: IntencionClave | null;
  clasificacion: string | null;
  vuelve: string | null;
  referido: { propuesta: string; nombre: string | null; correo: string | null; cargo: string | null; creado: boolean } | null;
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
  pendientes: Array<{ touchId: string; estado: string; cuerpo: string }>;
  bloqueo: ReplyBlock | null;
  cuenta: string | null;
  envioApagado: boolean;
  sinLeer: number;
}

export function conversacionVista(c: InboxConversation, f: Formatter, sinLeer: number): ConversacionVista {
  const t = MESSAGES;
  return {
    contactId: c.contactId,
    channel: c.channel,
    persona: c.contactName ?? c.companyName,
    empresa: c.companyName,
    canal: channelLabel(noticeLang(f.locale), c.channel),
    fichaHref: `/ventas/empresas/${c.companyId}`,
    negocio: c.deal ? t.conversacion.negocio(c.deal.stageLabel) : null,
    siguiente: c.deal?.nextAction ? t.conversacion.siguiente(c.deal.nextAction) : null,
    mensajes: c.messages.map((m) => {
      const entrante = m.direction === "inbound";
      const fuente = m.intentSource ? t.conversacion.fuentes[m.intentSource] ?? m.intentSource : null;
      const r = m.referral;
      const quien = r ? [r.name, r.email].filter(Boolean).join(" · ") : "";
      return {
        id: m.id,
        deNosotros: !entrante,
        asunto: m.subject,
        cuerpo: m.body,
        cuando: f.dateTime(m.occurredAt.toISOString()),
        intencion: entrante ? intencionClave(m.intent) : null,
        clasificacion: entrante && m.intent && fuente
          ? t.conversacion.clasificada(fuente, m.intentConfidence === null ? null : f.pct(m.intentConfidence))
          : entrante && !m.intent
          ? t.conversacion.sinClasificar
          : null,
        vuelve: entrante && m.intent === "ooo" && m.resumeAt ? t.conversacion.vuelve(f.date(m.resumeAt.toISOString(), "long")) : null,
        referido:
          entrante && m.intent === "referral" && r && quien
            ? { propuesta: t.referido.propone(quien), nombre: r.name, correo: r.email, cargo: r.role, creado: m.referralContactId !== null }
            : null,
      };
    }),
    pendientes: c.pending.map((p) => ({ touchId: p.touchId, estado: t.responder.pendientes[p.status] ?? p.status, cuerpo: p.body })),
    bloqueo: c.replyBlock,
    cuenta: c.accountName,
    envioApagado: c.sendingOff,
    sinLeer,
  };
}
