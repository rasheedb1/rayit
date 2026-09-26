/**
 * Textos de la página pública de baja (VEN-15). La abre quien recibió un
 * correo de un creador: no es nadie dentro del producto, así que nada de
 * jerga («workspace», «secuencia», «outreach»). Referencia: la página de
 * baja de Substack, que dice qué dirección se da de baja y de quién, una
 * frase y un botón.
 *
 * Por idioma (r5): el pie del correo sale en el idioma del espacio que
 * escribe (footerTextsFor, @mc/core/outreach/deliverability-messages), y la página
 * a la que lleva tiene que hablar el mismo. La página elige con
 * `bajaIdioma`: el locale del espacio que envió (lo devuelve
 * public_optout_preview) y, si no se sabe (un enlace que no existe, o
 * quien lo abre es el remitente), el Accept-Language del navegador. La
 * misma forma que alertTextsFor en apps/worker/src/jobs/ventas/messages.ts.
 */

import { OUTREACH_LANGUAGES, outreachLanguage, type OutreachLanguage } from "@mc/core/outreach/deliverability-messages";

/** Los idiomas de la página: los del outreach, ni uno más ni uno menos. */
export type BajaIdioma = OutreachLanguage;

export interface BajaTexts {
  metaTitle: string;
  pregunta: {
    title: string;
    /**
     * Una sola frase con quién escribe y a qué dirección (enmascarada),
     * como la baja de Substack, dicha como CONSECUENCIA de confirmar
     * (todavía no ha pasado nada): «Si confirmas, Laura no volverá a
     * escribirte: ni a v•••@marca.com ni por ningún otro canal». Quién va PRIMERO, porque es
     * lo que limita la promesa: la baja es de quien envió este correo, en
     * todos sus canales, y no de toda la plataforma (entregabilidad §8): cada creador
     * responde de su propio envío. Antes eran dos frases y la
     * primera («Dejarás de recibir mensajes en v•••@…») sonaba a baja
     * total. Sin nombre (el espacio ya no existe), «quien te escribió».
     * No dice «a este correo, ni por correo»: la dirección y los demás
     * canales van como dos cosas distintas.
     */
    frase: (quien: string | null, direccion: string) => string;
    boton: string;
    enviando: string;
  };
  listo: {
    /** Con el nombre de quien escribía, si la página lo sabe (r4). */
    title: (quien: string | null) => string;
    /**
     * Qué pasó y, si hay un correo de soporte (SUPPORT_EMAIL), cómo se
     * deshace. La baja no la deshace quien escribía: solo un operador,
     * a pedido de la persona desde esa dirección (outbound_optout_event).
     * Así que no se promete «responde y quien te escribió lo verá». Sin
     * correo de soporte no se inventa una salida: solo lo que pasó.
     */
    body: (soporte: string | null) => string;
  };
  /** Con el nombre de quien escribía, si la página lo sabe. */
  yaEstaba: { title: string; body: (quien: string | null) => string };
  /**
   * Un enlace que no es de ningún correo enviado: /baja/<token>/not-found
   * con un 404 de verdad (los monitores y los proveedores que prueban el
   * enlace distinguen uno roto de uno bueno), o el botón si el enlace deja
   * de valer entre abrir la página y pulsar.
   */
  noExiste: { title: string; body: string };
  remitente: { title: string; body: string; accion: string };
  error: string;
  /**
   * La frontera de error de /baja/<token> (r4): si la base falla al abrir
   * la página. Sin hablar de «documentos» (la de (public) es de Cotizar), y
   * con la salida que siempre funciona: responder al correo.
   */
  errorPagina: { title: string; body: string; retry: string; reference: string };
}

export const MESSAGES_ES: BajaTexts = {
  metaTitle: "Dejar de recibir mensajes",
  pregunta: {
    title: "¿Dejar de recibir estos mensajes?",
    frase: (quien, direccion) =>
      `Si confirmas, ${quien ?? "quien te escribió"} no volverá a escribirte: ni a ${direccion} ni por ningún otro canal.`,
    boton: "Dejar de recibir mensajes",
    enviando: "Un momento…",
  },
  listo: {
    title: (quien) => (quien ? `Listo. ${quien} no te escribirá más.` : "Listo. No te escribirá más."),
    body: (soporte) =>
      soporte
        ? `Tu dirección quedó fuera de sus envíos. Si fue un error, escríbenos a ${soporte} desde esta dirección y lo revisamos.`
        : "Tu dirección quedó fuera de sus envíos.",
  },
  yaEstaba: {
    title: "Ya estabas fuera de sus envíos",
    body: (quien) => `No hace falta hacer nada: ${quien ?? "quien te escribió"} ya no te escribe a esta dirección.`,
  },
  noExiste: {
    title: "Este enlace no es válido",
    body: "Puede que esté incompleto. Copia el enlace entero desde el correo, o responde al mensaje y pide que no te escriban más.",
  },
  remitente: {
    title: "Este enlace es de un correo que enviaste tú",
    body: "Lo abriste con tu sesión de On Cue. Este botón es de quien recibió el correo, no tuyo, así que aquí no hace nada. Si quieres dejar de escribirle, pausa su secuencia desde Ventas.",
    accion: "Ir a Ventas",
  },
  error: "No se pudo completar la baja. Inténtalo de nuevo.",
  errorPagina: {
    title: "No pudimos completar la baja ahora",
    body: "Vuelve a intentarlo en un momento, o responde al correo y pide que no te escriban más.",
    retry: "Reintentar",
    reference: "Referencia",
  },
};

export const MESSAGES_EN: BajaTexts = {
  metaTitle: "Unsubscribe",
  pregunta: {
    title: "Stop getting these messages?",
    frase: (quien, direccion) =>
      `If you confirm, ${quien ?? "the sender"} won't write to you again: not at ${direccion}, and not on any other channel.`,
    boton: "Unsubscribe",
    enviando: "One moment…",
  },
  listo: {
    title: (quien) => (quien ? `Done. ${quien} won't write to you again.` : "Done. You won't hear from them again."),
    body: (soporte) =>
      soporte
        ? `Your address is off their list. If this was a mistake, email us at ${soporte} from this address and we'll look into it.`
        : "Your address is off their list.",
  },
  yaEstaba: {
    title: "You were already off their list",
    body: (quien) => `Nothing else to do: ${quien ?? "the sender"} no longer writes to this address.`,
  },
  noExiste: {
    title: "This link isn't valid",
    body: "It may be incomplete. Copy the whole link from the email, or reply to the message and ask them to stop writing.",
  },
  remitente: {
    title: "This link is from an email you sent",
    body: "You opened it signed in to On Cue. This button belongs to the person who got the email, not to you, so it does nothing here. To stop writing to them, pause their sequence in Sales.",
    accion: "Go to Sales",
  },
  error: "We couldn't unsubscribe you. Please try again.",
  errorPagina: {
    title: "We couldn't unsubscribe you right now",
    body: "Try again in a moment, or reply to the email and ask them to stop writing.",
    retry: "Try again",
    reference: "Reference",
  },
};

const TEXTOS: Readonly<Record<BajaIdioma, BajaTexts>> = { es: MESSAGES_ES, en: MESSAGES_EN };

/** Los textos de un idioma. */
export function bajaTexts(idioma: BajaIdioma): BajaTexts {
  return TEXTOS[idioma];
}

/**
 * El idioma de la página. Con el locale del espacio que envió, la regla
 * del pie del correo (outreachLanguage, @mc/core/outreach/deliverability-messages): el
 * idioma base por Intl.Locale, con español de respaldo. Sin él, el primer
 * idioma que la página habla en el Accept-Language, por orden de
 * preferencia (q); si no habla ninguno, el mismo respaldo.
 */
export function bajaIdioma(locale: string | null | undefined, acceptLanguage?: string | null): BajaIdioma {
  if (locale) return outreachLanguage(locale);
  return idiomaDelNavegador(acceptLanguage ?? "") ?? outreachLanguage(null);
}

/** El primer idioma que la página habla en el Accept-Language, por q descendente (RFC 9110 §12.5.4). */
export function idiomaDelNavegador(acceptLanguage: string): BajaIdioma | null {
  const pedidos = acceptLanguage
    .split(",")
    .map((parte, orden) => {
      const [tag = "", ...params] = parte.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const peso = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), peso: Number.isFinite(peso) ? peso : 0, orden };
    })
    .filter((p) => p.tag && p.tag !== "*" && p.peso > 0)
    .sort((a, b) => b.peso - a.peso || a.orden - b.orden);
  for (const p of pedidos) {
    // outreachLanguage cae al respaldo con lo que no habla: aquí se quiere
    // saber si lo habla, así que se compara con su idioma base.
    const base = p.tag.split("-")[0] ?? "";
    const idioma = OUTREACH_LANGUAGES.find((l) => l === base);
    if (idioma) return idioma;
  }
  return null;
}
