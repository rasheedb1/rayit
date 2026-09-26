/**
 * Textos de /ventas/bandeja (VEN-14): la bandeja unificada, donde se
 * leen y se contestan las respuestas de las marcas por correo, LinkedIn e
 * Instagram. Referencias: Front y Superhuman (la lista a la izquierda, la
 * conversación a la derecha, las acciones arriba, todo con el teclado) y
 * Stripe Radar para el «por qué» de cada clasificación.
 *
 * Las cifras y las fechas llegan formateadas con el locale del workspace.
 * Este archivo llega al cliente: no importa nada de @mc/db.
 */
import type { PillKind } from "@/components/ui/pill";

const reglas = new Intl.PluralRules("es");
function plural(n: number, one: string, other: string): string {
  return reglas.select(n) === "one" ? one : other;
}

/** Las seis intenciones de §5.7, en el orden en que se ofrecen para corregir. */
export const INTENCIONES = ["interested", "not_now", "ooo", "referral", "ambiguous", "unsubscribe"] as const;
export type Intencion = (typeof INTENCIONES)[number];
/** La intención de una respuesta, con su color; «pendiente», todavía sin clasificar. */
export type IntencionClave = Intencion | "pendiente";

/** Qué hilos enseña la lista (?vista=…): los que esperan, los atendidos o todos. */
export const VISTAS = ["pendientes", "hechas", "todas"] as const;
export type VistaBandeja = (typeof VISTAS)[number];

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

  vistas: {
    label: "Qué conversaciones ver",
    pendientes: "Pendientes",
    hechas: "Hechas",
    todas: "Todas",
  } satisfies Record<VistaBandeja | "label", string>,

  /** La ayuda del teclado, sobre la lista (solo con teclado: desde sm). */
  atajos: {
    label: "Atajos de teclado",
    items: [
      { key: "j", text: "siguiente" },
      { key: "k", text: "anterior" },
      { key: "r", text: "responder" },
      { key: "e", text: "marcar como hecha" },
      { key: "Esc", text: "volver a la lista" },
    ],
  },

  lista: {
    label: "Conversaciones",
    /** El número de mensajes sin leer de un hilo, para un lector de pantalla. */
    sinLeer: (n: string) => `${n} sin leer`,
    tu: "Tú: ",
    hecha: "Hecha",
    vacio: {
      title: "Todavía nadie respondió",
      description: "Cuando una marca conteste a tus cadencias por correo, LinkedIn o Instagram, la conversación aparece aquí.",
      action: "Ver tus cadencias",
    },
    alDia: {
      title: "Estás al día",
      description: "No queda ninguna conversación por atender. Las que marcaste como hechas siguen en «Hechas».",
      action: "Ver todas",
    },
    sinHechas: {
      title: "Ninguna conversación hecha todavía",
      description: "Cuando termines con una, márcala como hecha (tecla e) y sale de tus pendientes.",
      action: "Ver pendientes",
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
    marcarHecha: "Marcar como hecha",
    reabrir: "Reabrir",
    hechaAviso: "Conversación hecha: sale de tus pendientes y vuelve sola si responden.",
    reabiertaAviso: "Conversación reabierta: vuelve a tus pendientes.",
    negocio: (etapa: string) => `Negocio: ${etapa}`,
    siguiente: (accion: string) => `Siguiente acción: ${accion}`,
    tu: "Tú",
    /** Quien respondió sin que el proveedor dijera su dirección y no es la ficha. */
    otraPersona: "Otra persona",
    /** La marca junto al remitente cuando no es la ficha (un colega, un tercero en copia). */
    noEsLaFicha: (persona: string) => `no es ${persona}`,
    /** Una baja que pidió un tercero: la ficha no quedó de baja y lo decide una persona. */
    bajaDeTercero: (quien: string) =>
      `Lo pidió ${quien}, no la ficha: la cadencia se detuvo y la ficha sigue sin baja. Decide tú con «Corregir».`,
    bajaSinFicha: "La ficha no quedó de baja: la cadencia se detuvo. Decide tú con «Corregir».",
    asunto: "Asunto",
    /** «Clasificada por la IA · 94 %». */
    clasificada: (fuente: string, confianza: string | null) => (confianza ? `Clasificada por ${fuente} · ${confianza}` : `Clasificada por ${fuente}`),
    /** Una corrección de una persona no lleva porcentaje: la decidió alguien. */
    corregida: "Corregida por una persona",
    fuentes: { model: "la IA", fake: "el clasificador de prueba", detector: "la regla de bajas" },
    /** El «por qué» de la clasificación: la frase del clasificador. */
    porque: (frase: string) => `Por qué: ${frase}`,
    vuelve: (fecha: string) => `Vuelve el ${fecha}: la cadencia espera hasta entonces.`,
    enfria: (fecha: string) => `La cadencia vuelve el ${fecha}, a tu bandeja de aprobación: nada sale sola.`,
    sinClasificar: "Todavía sin clasificar: la IA la lee en unos minutos.",
    sinClasificarApagado: "Sin clasificar: léela y di tú qué pide con «Corregir».",
    clasificadorApagado:
      "La clasificación con IA no está encendida en este espacio: las respuestas nuevas no se clasifican solas. Léelas y corrige tú la intención.",
  },

  corregir: {
    abrir: "Corregir",
    label: "Qué pide esta respuesta",
    guardar: "Guardar",
    cancelar: "Cancelar",
    /** Con la confirmación de la baja abierta, el botón que cierra «Corregir» no se llama igual que el suyo. */
    cerrar: "Cerrar",
    /** La opción de baja en «Corregir»: lo que hace. */
    opcionBaja: "Pidió la baja: dar de baja a la ficha",
    ayuda: "Se aplica como si hubiera llegado así: interesada mueve el negocio, ahora no enfría la cadencia. El negocio no retrocede solo.",
    bajaPregunta: "¿Dar de baja a esta persona?",
    bajaConsecuencia: "No le vuelves a escribir desde On Cue por ningún canal y se cancela lo que tenía pendiente. No se puede deshacer.",
    bajaConfirmar: "Sí, dar de baja",
    listo: (intencion: string) => `Intención corregida: ${intencion}.`,
    listoMovido: (intencion: string) => `Intención corregida: ${intencion}. El negocio pasó a «En conversación».`,
    bajaNoSeCorrige: "La ficha está de baja: ya no recibe mensajes y eso no se corrige.",
    vuelta: "Vuelve el",
    vueltaAyuda: "Opcional. Vacía, se lee del mensaje; sin fecha en el mensaje, la cadencia sigue en 7 días.",
  },

  referido: {
    propone: (quien: string) => `Propone escribirle a ${quien}.`,
    proponeSinDatos: "Te remite a otra persona de la marca.",
    crear: "Crear contacto",
    creado: "Ya está en los contactos de la marca.",
    nombre: "Nombre",
    correo: "Correo",
    cargo: "Cargo",
    guardar: "Guardar contacto",
    cancelar: "Cancelar",
    listo: (quien: string) => `${quien} ya es contacto de la marca.`,
    enrolar: "Enrolar en una cadencia",
    verContacto: "Ver en la ficha",
  },

  responder: {
    label: "Tu respuesta",
    placeholder: "Escribe tu respuesta…",
    enviar: "Enviar respuesta",
    ayuda: (cuenta: string) => `Sale desde ${cuenta}, en el mismo hilo.`,
    ayudaSinCuenta: "Sale por la cuenta que recibió el mensaje, en el mismo hilo.",
    enviada: "Tu respuesta está en camino: sale en la próxima pasada del envío. Puedes cancelarla mientras espera.",
    enviadaApagado: "Quedó en cola: sale cuando enciendas el envío. Puedes cancelarla mientras espera.",
    envioApagado: "El envío está apagado: tu respuesta sale cuando lo enciendas.",
    irAPolitica: "Ir a la política de envío",
    irACanales: "Ir a canales",
    bloqueos: {
      opted_out: "Esta persona pidió no recibir más mensajes: no se le puede responder desde On Cue.",
      no_inbound: "Todavía no hay un mensaje suyo al que responder.",
      no_account: "La cuenta que recibió este mensaje no está conectada: reconéctala para responder.",
    },
    /** Un correo sale con el pie de baja y su dirección postal (VEN-15): sin ella no se responde. */
    faltaDireccion: "Falta tu dirección postal para el pie de los correos: guárdala en la política de envío para responder.",
    irADireccion: "Guardar la dirección postal",
    /** Una respuesta que el envío retuvo: por qué, y que también espera en la bandeja de aprobación. */
    retenida: (motivo: string) => `${motivo}. También espera en tu bandeja de aprobación.`,
    retenidaSinMotivo: "El envío la retuvo. Espera en tu bandeja de aprobación.",
    irAAprobaciones: "Ir a aprobaciones",
    /** j, k, e o Esc con una respuesta escrita: la primera vez avisa; la segunda, sigue. */
    borradorPendiente: (tecla: string) =>
      `Tienes una respuesta sin enviar. Queda guardada en esta conversación: pulsa ${tecla} otra vez para seguir.`,
    estados: {
      scheduled: "En cola",
      processing: "Enviándose",
      held: "Retenida",
      failed: "No salió",
      canceled: "Cancelada",
    } as Record<string, string>,
    porSalir: (n: number) => plural(n, "Respuesta por salir", "Respuestas por salir"),
    noSalieron: (n: number) => plural(n, "Respuesta que no salió", "Respuestas que no salieron"),
    cancelar: "Cancelar",
    editar: "Editar",
    descartar: "Descartar",
    cancelada: "Respuesta cancelada: no sale.",
    descartada: "Descartada: ya no se ve en la conversación.",
    aEditar: "Respuesta cancelada: su texto está en «Tu respuesta» para que la corrijas.",
    /** Por qué no salió, del blocked_reason del toque. */
    motivos: {
      canceled_by_person: "La cancelaste.",
      opted_out: "La persona pidió la baja antes de que saliera.",
      email_invalid: "El correo de esta persona rebotó: la dirección no existe.",
      outreach_disabled: "El envío del espacio se desactivó antes de que saliera.",
    } as Record<string, string>,
    motivoGenerico: "No pudo salir. Escríbela otra vez si todavía hace falta.",
  },

  /** Un 'viewer' o un 'client' del espacio: lee los hilos, no los opera (PUEDEN_OPERAR_VENTAS). */
  sinPermiso:
    "Solo quien es dueño, administra o es miembro de este espacio puede responder, corregir o marcar estas conversaciones. Puedes leerlas; para cambiarlas, pídeselo.",

  errores: {
    generico: "No pudimos guardar tu respuesta. Inténtalo de nuevo.",
    accion: "No pudimos hacer el cambio. Inténtalo de nuevo.",
    empty: "Escribe tu respuesta.",
    too_long: (n: string) => `La respuesta es muy larga: el máximo es ${n} caracteres.`,
    placeholders: (huecos: string) => `Quedan huecos sin rellenar: ${huecos}.`,
    not_found: "Esa conversación ya no existe.",
    not_cancelable: "Ya no se puede cancelar: está saliendo o ya salió.",
    opted_out: "La ficha está de baja: ya no recibe mensajes y eso no se corrige.",
    no_postal_address: "Falta tu dirección postal para el pie de los correos: guárdala en la política de envío para responder.",
    referidoGenerico: "No pudimos crear el contacto. Inténtalo de nuevo.",
    already_created: "Ese contacto ya se creó.",
    DuplicateEmail: "Ya tienes un contacto con ese correo.",
    EmptyContact: "Escribe al menos el nombre o el correo.",
    correoInvalido: "Ese correo no parece válido.",
  },
} as const;
