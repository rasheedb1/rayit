/**
 * Textos de /ventas/bandeja (VEN-14): la bandeja unificada, donde se
 * leen y se contestan las respuestas de las marcas por correo, LinkedIn e
 * Instagram. Referencias: Front y Superhuman (la lista a la izquierda, la
 * conversación a la derecha, las acciones arriba).
 *
 * Las cifras y las fechas llegan formateadas con el locale del workspace.
 * Este archivo llega al cliente: no importa nada de @mc/db.
 */
import type { PillKind } from "@/components/ui/pill";

const reglas = new Intl.PluralRules("es");
function plural(n: number, one: string, other: string): string {
  return reglas.select(n) === "one" ? one : other;
}

/** La intención de la última respuesta, con su color. `null`: todavía sin clasificar. */
export type IntencionClave = "interested" | "not_now" | "ooo" | "unsubscribe" | "referral" | "ambiguous" | "pendiente";

export const MESSAGES = {
  metaTitle: "Bandeja",
  header: {
    eyebrow: "Ventas · bandeja",
    title: "Las conversaciones con las marcas",
    description:
      "Lo que responden por correo, LinkedIn e Instagram, en un solo lugar. Primero lo que no has leído. Respondes desde aquí y sale por la misma cuenta, en el mismo hilo.",
    back: "Volver a Ventas",
  },
  loading: { label: "Cargando la bandeja" },
  error: { eyebrow: "Ventas · bandeja", title: "No pudimos cargar la bandeja." },

  lista: {
    label: "Conversaciones",
    /** El número de mensajes sin leer de un hilo, para un lector de pantalla. */
    sinLeer: (n: string) => `${n} sin leer`,
    tu: "Tú: ",
    vacio: {
      title: "Todavía nadie respondió",
      description: "Cuando una marca conteste a tus cadencias por correo, LinkedIn o Instagram, la conversación aparece aquí.",
      action: "Ver tus cadencias",
    },
  },

  intenciones: {
    interested: { label: "Interesada", kind: "good" },
    not_now: { label: "Ahora no", kind: "neutral" },
    ooo: { label: "Fuera de la oficina", kind: "neutral" },
    unsubscribe: { label: "Pidió la baja", kind: "bad" },
    referral: { label: "Te remite a alguien", kind: "warn" },
    ambiguous: { label: "Por revisar", kind: "warn" },
    pendiente: { label: "Sin clasificar", kind: "neutral" },
  } satisfies Record<IntencionClave, { label: string; kind: PillKind }>,

  conversacion: {
    elige: {
      title: "Elige una conversación",
      description: "Abre una de la lista para leerla completa y responder.",
    },
    volver: "Todas las conversaciones",
    verFicha: "Ver la ficha",
    negocio: (etapa: string) => `Negocio: ${etapa}`,
    siguiente: (accion: string) => `Siguiente acción: ${accion}`,
    tu: "Tú",
    asunto: "Asunto",
    /** «Clasificada por la IA · 94 %». */
    clasificada: (fuente: string, confianza: string | null) => (confianza ? `Clasificada por ${fuente} · ${confianza}` : `Clasificada por ${fuente}`),
    fuentes: { model: "la IA", fake: "el clasificador de prueba", detector: "la regla de bajas", person: "una persona" } as Record<string, string>,
    vuelve: (fecha: string) => `Vuelve el ${fecha}: la cadencia espera hasta entonces.`,
    sinClasificar: "Todavía sin clasificar: la IA la lee en unos minutos.",
  },

  referido: {
    propone: (quien: string) => `Propone escribirle a ${quien}.`,
    crear: "Crear contacto",
    creado: "Ya está en los contactos de la marca.",
    nombre: "Nombre",
    correo: "Correo",
    cargo: "Cargo",
    guardar: "Guardar contacto",
    cancelar: "Cancelar",
    listo: (quien: string) => `${quien} ya es contacto de la marca.`,
  },

  responder: {
    label: "Tu respuesta",
    placeholder: "Escribe tu respuesta…",
    enviar: "Enviar respuesta",
    ayuda: (cuenta: string) => `Sale desde ${cuenta}, en el mismo hilo.`,
    ayudaSinCuenta: "Sale por la cuenta que recibió el mensaje, en el mismo hilo.",
    enviada: "Tu respuesta está en camino: sale en la próxima pasada del envío.",
    envioApagado: "El envío está apagado: tu respuesta sale cuando lo enciendas.",
    irAPolitica: "Ir a la política de envío",
    irACanales: "Ir a canales",
    bloqueos: {
      opted_out: "Esta persona pidió no recibir más mensajes: no se le puede responder desde On Cue.",
      no_inbound: "Todavía no hay un mensaje suyo al que responder.",
      no_account: "La cuenta que recibió este mensaje no está conectada: reconéctala para responder.",
      channel_not_supported: "Por este canal todavía no se puede responder desde On Cue.",
    },
    pendientes: {
      scheduled: "En cola",
      processing: "Enviándose",
      held: "Retenida",
      failed: "No salió",
      canceled: "Cancelada",
    } as Record<string, string>,
    pendientesTitulo: (n: number) => plural(n, "Respuesta por salir", "Respuestas por salir"),
  },

  errores: {
    generico: "No pudimos guardar tu respuesta. Inténtalo de nuevo.",
    empty: "Escribe tu respuesta.",
    too_long: (n: string) => `La respuesta es muy larga: el máximo es ${n} caracteres.`,
    placeholders: (huecos: string) => `Quedan huecos sin rellenar: ${huecos}.`,
    not_found: "Esa conversación ya no existe.",
    referidoGenerico: "No pudimos crear el contacto. Inténtalo de nuevo.",
    already_created: "Ese contacto ya se creó.",
    DuplicateEmail: "Ya tienes un contacto con ese correo.",
    EmptyContact: "Escribe al menos el nombre o el correo.",
    correoInvalido: "Ese correo no parece válido.",
  },
} as const;
