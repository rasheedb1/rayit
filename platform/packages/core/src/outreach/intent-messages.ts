/**
 * Los textos de lo que hace la intención de una respuesta (VEN-14): los
 * avisos que deja el job outbound.intent y la siguiente acción que pone
 * en el negocio, en el idioma del workspace (noticeLang). Los guarda la
 * base ya escritos, como los demás avisos del motor (notification.title_es
 * y body_es, 0055 §4); la bandeja los traduce desde el código de la
 * intención, no desde estas frases.
 *
 * Aparte de messages.ts (VEN-10) para que cada pieza tenga su archivo.
 */
import type { NoticeLang } from './messages.ts';

/** Adónde llevan los avisos de una respuesta: la bandeja, abierta en su hilo. */
export const INBOX_URLS = {
  approvals: '/ventas/aprobaciones',
  inbox: '/ventas/bandeja',
  thread: (contactId: string, channel: string) =>
    `/ventas/bandeja?contacto=${encodeURIComponent(contactId)}&canal=${encodeURIComponent(channel)}`,
} as const;

export const INTENT_NOTICE_TEXTS = {
  es: {
    /** deal.next_action de un «me interesa». */
    replyToday: 'Responder hoy',
    interestedTitle: (who: string) => `${who} quiere seguir la conversación`,
    interestedBody: (company: string | null, moved: boolean) =>
      company && moved
        ? `El negocio con ${company} pasó a «En conversación» y la siguiente acción es responder hoy. Tienes la conversación en la bandeja.`
        : 'La siguiente acción es responder hoy. Tienes la conversación en la bandeja.',
    /** No había negocio abierto con la marca: se abrió uno. */
    interestedBodyCreated: (company: string | null) =>
      `${company ? `Abrimos un negocio con ${company}` : 'Abrimos un negocio'} en «En conversación» y la siguiente acción es responder hoy. Tienes la conversación en la bandeja.`,
    /** El nombre del negocio que abre un «me interesa» sin negocio. */
    dealName: (company: string) => `Conversación con ${company}`,
    notNowTitle: (who: string) => `${who} dijo «ahora no»`,
    notNowBody: (until: string) =>
      `La cadencia se enfría hasta el ${until}. Ese día vuelve a tu bandeja de aprobación, sin enviar nada por su cuenta.`,
    /** Sin cadencia que enfriar (un pitch suelto, o la ficha ya estaba de baja): solo cuándo volver a escribir. */
    notNowBodyNoCadence: (after: string) => `Dice que ahora no. Si quieres, escríbele de nuevo después del ${after}.`,
    referralTitle: (who: string) => `${who} te remite a otra persona`,
    referralBody: (name: string) => `Propone escribirle a ${name}. En la bandeja puedes crearlo como contacto de la marca.`,
    referralBodyUnknown: () => 'Propone escribirle a otra persona de la marca. Léelo en la bandeja.',
    ambiguousTitle: (who: string) => `Revisa la respuesta de ${who}`,
    ambiguousBody: () => 'No pudimos saber con seguridad qué pide. Léela en la bandeja y decide qué hacer.',
    cooldownOverTitle: (who: string) => `Terminó el «ahora no» de ${who}`,
    cooldownOverBody: (n: number) =>
      n > 0
        ? `${n === 1 ? 'Un mensaje de la cadencia vuelve' : `${n} mensajes de la cadencia vuelven`} a tu bandeja de aprobación: nada sale sin que lo apruebes.`
        : 'La cadencia ya no tenía mensajes pendientes. Si quieres retomar, escríbele desde la bandeja.',
  },
  en: {
    replyToday: 'Reply today',
    interestedTitle: (who: string) => `${who} wants to keep talking`,
    interestedBody: (company: string | null, moved: boolean) =>
      company && moved
        ? `The deal with ${company} moved to "In conversation" and the next step is to reply today. The conversation is in your inbox.`
        : 'The next step is to reply today. The conversation is in your inbox.',
    interestedBodyCreated: (company: string | null) =>
      `${company ? `We opened a deal with ${company}` : 'We opened a deal'} in "In conversation" and the next step is to reply today. The conversation is in your inbox.`,
    dealName: (company: string) => `Conversation with ${company}`,
    notNowTitle: (who: string) => `${who} said "not now"`,
    notNowBody: (until: string) =>
      `The cadence cools down until ${until}. That day it comes back to your approval queue, without sending anything on its own.`,
    notNowBodyNoCadence: (after: string) => `They said not now. If you like, write again after ${after}.`,
    referralTitle: (who: string) => `${who} referred you to someone else`,
    referralBody: (name: string) => `They suggest writing to ${name}. You can add them as a contact from the inbox.`,
    referralBodyUnknown: () => 'They suggest writing to someone else at the brand. Read it in the inbox.',
    ambiguousTitle: (who: string) => `Review ${who}'s reply`,
    ambiguousBody: () => "We couldn't tell for sure what they want. Read it in the inbox and decide.",
    cooldownOverTitle: (who: string) => `${who}'s "not now" is over`,
    cooldownOverBody: (n: number) =>
      n > 0
        ? `${n === 1 ? 'One cadence message is' : `${n} cadence messages are`} back in your approval queue: nothing goes out until you approve it.`
        : 'The cadence had nothing pending. To pick it up again, write from the inbox.',
  },
} as const satisfies Record<NoticeLang, Record<string, unknown>>;
