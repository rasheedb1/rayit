/**
 * Textos de la página pública de baja (VEN-15). La abre quien recibió un
 * correo de un creador: no es nadie dentro del producto, así que nada de
 * jerga («workspace», «secuencia», «outreach»). Referencia: la página de
 * baja de Substack, una frase y un botón.
 */
export const MESSAGES = {
  metaTitle: "Dejar de recibir mensajes",
  pregunta: {
    title: "¿Dejas de recibir estos mensajes?",
    body: "Un clic y nadie en On Cue te vuelve a escribir a este correo: ni este creador ni ningún otro.",
    boton: "Dejar de recibir mensajes",
    enviando: "Un momento…",
  },
  listo: {
    title: "Listo. No te escribiremos más.",
    body: "Tu dirección quedó fuera de todos los envíos. Si fue un error, responde al último correo y quien te escribió lo verá.",
  },
  yaEstaba: {
    title: "Ya estabas fuera de los envíos",
    body: "No hacía falta: esta dirección ya no recibe mensajes enviados desde On Cue.",
  },
  noExiste: {
    title: "Este enlace no es válido",
    body: "Puede que esté incompleto. Copia el enlace entero desde el correo, o responde al mensaje y pide que no te escriban más.",
  },
  remitente: {
    title: "Este enlace es de un correo que enviaste tú",
    body: "Lo abriste con tu sesión de On Cue. Si lo pulsaras, la marca dejaría de recibir mensajes de todos los creadores de la plataforma, así que aquí no hace nada. Si quieres dejar de escribirle, pausa su secuencia desde Ventas.",
    accion: "Ir a Ventas",
  },
  noDisponible: {
    title: "No podemos comprobar el enlace ahora",
    body: "Inténtalo de nuevo en unos minutos, o responde al correo y pide que no te escriban más.",
  },
  error: "No se pudo completar la baja. Inténtalo de nuevo.",
} as const;
