/**
 * Textos de /ventas/politica (VEN-15): la política de envío del
 * outreach. Cada regla lleva una línea que dice qué hace y por qué;
 * referencia: la configuración de límites y calentamiento de Lemlist e
 * Instantly. Voz: una creadora que escribe a marcas, no un equipo de
 * ventas.
 */
export const MESSAGES = {
  metaTitle: "Política de envío",
  header: {
    eyebrow: "Ventas · política de envío",
    title: "Las reglas que respeta cada mensaje",
    description:
      "Cuánto se escribe, cada cuánto y con qué cuidado. Valen para el correo, LinkedIn e Instagram, y se revisan antes de cada envío.",
    back: "Volver a Ventas",
  },

  interruptor: {
    title: "Envío automático",
    on: "Encendido",
    off: "Apagado",
    onHelp: "Los mensajes aprobados salen solos, dentro de estos límites.",
    offHelp: "No sale nada. Lo que estaba en cola se canceló y vuelve a planificarse al encender.",
    offReason: (motivo: string, fecha: string) => `Apagado el ${fecha}: ${motivo}.`,
    encender: "Encender el envío",
    apagar: "Apagar el envío",
    confirmarApagar: "¿Apagar el envío? Lo que está en cola se cancela; tus secuencias quedan como están.",
    sinDireccion: "Para encender el envío guarda primero tu dirección postal.",
    motivoManual: "lo apagaste desde la política",
    errorEncender: "No se pudo encender. Revisa que la dirección postal esté guardada.",
    errorApagar: "No se pudo apagar. Inténtalo de nuevo.",
  },

  secciones: {
    ritmo: "Ritmo",
    cuidado: "Cuidado",
    cumplimiento: "Cumplimiento",
    calentamiento: "Calentamiento",
  },

  campos: {
    maxTouchesPerCompany: {
      label: "Mensajes por marca",
      help: "Cuántas veces, como mucho, se le escribe a una marca en una secuencia. Más de cuatro suele sentirse insistente.",
    },
    minDaysBetweenTouches: {
      label: "Días entre mensajes",
      help: "El mínimo de días entre un mensaje y el siguiente a la misma marca.",
    },
    maxEmailsPerDay: {
      label: "Correos al día",
      help: "El tope diario de tu Gmail. Una cuenta personal aguanta 50 a 100 sin llamar la atención; Workspace, 100 a 150.",
    },
    cooldownDaysAfterNo: {
      label: "Días de espera tras un «no»",
      help: "Si una marca dice que no, no se le vuelve a escribir hasta que pasen estos días.",
    },
    requireHumanReview: {
      label: "Revisión humana",
      help: "Cada mensaje espera tu aprobación antes de salir. Recomendado hasta que confíes en lo que se redacta.",
    },
    claimsMustBeSourced: {
      label: "Cifras con origen",
      help: "Toda cifra de un mensaje (vistas, resultados de campañas) tiene que salir de tus datos. Un mensaje con una cifra inventada no sale.",
    },
    warmupDays: {
      label: "Días de calentamiento",
      help: "Una cuenta nueva empieza con 20 correos al día la primera semana y sube poco a poco hasta tu tope en este día.",
    },
    postalAddress: {
      label: "Dirección postal",
      help: "Va al pie de cada correo junto al enlace de baja. La exigen las leyes de correo comercial (CAN-SPAM, habeas data); sin ella no sale nada.",
      placeholder: "Calle 93 # 11-26, Bogotá, Colombia",
    },
  },

  si: "Sí",
  no: "No",
  /** Los rangos que acepta cada campo, ya con cifras formateadas. */
  rango: (min: string, max: string) => `Entre ${min} y ${max}.`,
  entero: "Escribe un número entero.",
  direccionLarga: (max: string) => `La dirección no puede pasar de ${max} caracteres.`,

  calentamiento: {
    title: "Cómo sube tu tope de correos",
    dia: (d: string) => `Día ${d}`,
    correos: (n: string) => `${n} al día`,
    sinCalentamiento: "Sin calentamiento: el tope vale desde el primer día.",
    caption: "Correos al día según el día desde que conectaste tu Gmail",
  },

  fijo: {
    optout: {
      label: "Enlace de baja",
      body: "Siempre. Cada correo lleva un enlace para dejar de recibir mensajes y la cabecera de baja de un clic que piden Gmail y Yahoo. No se puede apagar.",
    },
    llm: {
      label: "Presupuesto diario de redacción",
      body: (monto: string) => `${monto} al día para redactar y revisar mensajes. Lo fija On Cue; si se agota, lo nuevo espera a mañana.`,
    },
  },

  guardar: "Guardar la política",
  guardado: "Política guardada.",
  errorGuardar: "No se pudo guardar. Inténtalo de nuevo.",
  necesitaDireccion: "Con el envío encendido la dirección postal es obligatoria. Apágalo primero si quieres quitarla.",
  actualizada: (fecha: string) => `Actualizada el ${fecha}`,
  nuncaGuardada: "Todavía con los valores por defecto",

  error: {
    eyebrow: "Ventas · política de envío",
    title: "No pudimos leer tu política de envío",
  },
  loading: {
    label: "Cargando la política de envío",
  },
} as const;
