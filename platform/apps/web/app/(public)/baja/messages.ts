/**
 * Textos de la página pública de baja (VEN-15). La abre quien recibió un
 * correo de un creador: no es nadie dentro del producto, así que nada de
 * jerga («workspace», «secuencia», «outreach»). Referencia: la página de
 * baja de Substack, que dice qué dirección se da de baja y de quién, una
 * frase y un botón.
 *
 * Por idioma (r5): el pie del correo sale en el idioma del espacio que
 * escribe (footerTextsFor, @mc/core/outreach/deliverability), y la página
 * a la que lleva tiene que hablar el mismo. La página elige con
 * `bajaIdioma`: el locale del espacio que envió (lo devuelve
 * public_optout_preview) y, si no se sabe (un enlace que no existe, o
 * quien lo abre es el remitente), el Accept-Language del navegador. La
 * misma forma que alertTextsFor en apps/worker/src/jobs/ventas/messages.ts.
 */

export type BajaIdioma = "es" | "en";

export interface BajaTexts {
  metaTitle: string;
  loading: string;
  pregunta: {
    title: string;
    /** «Dejarás de recibir mensajes en v•••@marca.com.» La dirección llega enmascarada. */
    destino: (direccion: string) => string;
    /**
     * Quién escribe, si se sabe; si el espacio ya no existe, sin nombre.
     * La promesa es la de quien envió este correo: la baja pasa a toda la
     * plataforma cuando la pide también a otro creador (0038 §8), y eso
     * no se promete aquí.
     */
    alcance: (quien: string | null) => string;
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
  yaEstaba: { title: string; body: string };
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
  loading: "Comprobando el enlace",
  pregunta: {
    title: "¿Dejar de recibir estos mensajes?",
    destino: (direccion) => `Dejarás de recibir mensajes en ${direccion}.`,
    alcance: (quien) =>
      quien
        ? `Un clic y ${quien} no te vuelve a escribir, ni por correo ni por otro canal.`
        : "Un clic y quien te escribió no te vuelve a escribir, ni por correo ni por otro canal.",
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
    body: "No hace falta hacer nada: quien te escribió ya no envía mensajes a esta dirección.",
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
  loading: "Checking the link",
  pregunta: {
    title: "Stop getting these messages?",
    destino: (direccion) => `You'll stop getting messages at ${direccion}.`,
    alcance: (quien) =>
      quien
        ? `One click and ${quien} won't write to you again, by email or any other channel.`
        : "One click and the sender won't write to you again, by email or any other channel.",
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
    body: "Nothing else to do: the sender no longer writes to this address.",
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

/** Los textos de un idioma. */
export function bajaTexts(idioma: BajaIdioma): BajaTexts {
  return idioma === "en" ? MESSAGES_EN : MESSAGES_ES;
}

/**
 * El idioma de la página. Con el locale del espacio que envió, la regla
 * del pie (footerTextsFor): inglés si empieza por «en», español si no.
 * Sin él, el primer idioma que la página habla en el Accept-Language, por
 * orden de preferencia (q); si no habla ninguno, español, el idioma por
 * defecto de un espacio.
 */
export function bajaIdioma(locale: string | null | undefined, acceptLanguage?: string | null): BajaIdioma {
  if (locale) return /^en\b/i.test(locale) ? "en" : "es";
  return idiomaDelNavegador(acceptLanguage ?? "") ?? "es";
}

/** El primer «es» o «en» del Accept-Language, por q descendente (RFC 9110 §12.5.4). */
export function idiomaDelNavegador(acceptLanguage: string): BajaIdioma | null {
  const pedidos = acceptLanguage
    .split(",")
    .map((parte, orden) => {
      const [tag = "", ...params] = parte.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const peso = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), peso: Number.isFinite(peso) ? peso : 0, orden };
    })
    .filter((p) => p.tag && p.peso > 0)
    .sort((a, b) => b.peso - a.peso || a.orden - b.orden);
  for (const p of pedidos) {
    if (/^en\b/.test(p.tag)) return "en";
    if (/^es\b/.test(p.tag)) return "es";
  }
  return null;
}
