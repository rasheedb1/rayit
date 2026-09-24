/**
 * Textos de la página pública de baja (VEN-15). La abre quien recibió un
 * correo de un creador: no es nadie dentro del producto, así que nada de
 * jerga («workspace», «secuencia», «outreach»). Referencia: la página de
 * baja de Substack, que dice qué dirección se da de baja y de quién, una
 * frase y un botón.
 */
export const MESSAGES = {
  metaTitle: "Dejar de recibir mensajes",
  loading: "Comprobando el enlace",
  pregunta: {
    title: "¿Dejas de recibir estos mensajes?",
    /** «Dejarás de recibir mensajes en v•••@marca.com.» La dirección llega enmascarada. */
    destino: (direccion: string) => `Dejarás de recibir mensajes en ${direccion}.`,
    /**
     * Quién escribe, si se sabe; si el espacio ya no existe, sin nombre.
     * La promesa es la de quien envió este correo: la baja pasa a toda la
     * plataforma cuando la pide también a otro creador (0038 §8), y eso
     * no se promete aquí.
     */
    alcance: (quien: string | null) =>
      quien
        ? `Un clic y ${quien} no te vuelve a escribir a este correo, por ningún canal.`
        : "Un clic y quien te escribió no te vuelve a escribir a este correo, por ningún canal.",
    boton: "Dejar de recibir mensajes",
    enviando: "Un momento…",
  },
  listo: {
    title: "Listo. No te escribirá más.",
    body: "Tu dirección quedó fuera de sus envíos. Si otro creador de On Cue te escribe, su correo trae su propio enlace. Si fue un error, responde al último correo y quien te escribió lo verá.",
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
} as const;
