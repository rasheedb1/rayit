/**
 * Textos de /ventas/politica (VEN-15): la política de envío del
 * outreach y la salud del día. Cada regla lleva una línea que dice qué
 * hace y por qué; referencia: la configuración de límites y
 * calentamiento de Lemlist e Instantly. Voz: una creadora que escribe a
 * marcas, no un equipo de ventas. Nada atado a un país: las cifras y las
 * fechas llegan formateadas con el locale del workspace.
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
    /** Nunca se encendió: no había nada en cola que cancelar. */
    offHelpNunca: "Todavía no sale nada. Enciéndelo cuando tengas tu dirección postal guardada y un canal conectado.",
    /** Se apagó, sin motivo guardado: lo que estaba en cola se canceló. */
    offHelp: "No sale nada. Lo que estaba en cola se canceló y vuelve a planificarse al encender.",
    offReason: (motivo: string, fecha: string) => `Apagado el ${fecha}: ${motivo}.`,
    encender: "Encender el envío",
    apagar: "Apagar el envío",
    confirmarApagar: "¿Apagar el envío?",
    consecuenciaApagar: "Lo que está en cola se cancela; tus secuencias quedan como están y vuelven a planificarse al encender.",
    siApagar: "Sí, apagar",
    cancelar: "Cancelar",
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
      /** `dias` es la ventana en la que se cuentan (COMPANY_CAP_WINDOW_DAYS de @mc/db), ya formateada. */
      help: (dias: string) =>
        `Cuántas veces, como mucho, se le escribe a una marca en ${dias} días, sumando todas tus secuencias. Los de más no salen. Más de cuatro suele sentirse insistente.`,
    },
    minDaysBetweenTouches: {
      label: "Días entre mensajes",
      help: "El mínimo de días entre un mensaje y el siguiente a la misma marca, por cualquier canal. Si una secuencia los tiene más juntos, el siguiente espera.",
    },
    sendWindow: {
      label: "Horario de envío",
      /** `zona` es el nombre de la zona del workspace, en su idioma («hora estándar de Colombia»). */
      help: (zona: string) => `Los mensajes salen entre estas horas, en ${zona}, de lunes a viernes.`,
      desde: "Desde",
      hasta: "Hasta",
      error: "La hora de fin tiene que ser después de la de inicio.",
      invalida: "Elige una hora de la lista.",
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
      help: "Cada mensaje de tus secuencias espera tu aprobación en la ficha de la empresa antes de salir. Recomendado hasta que confíes en lo que se redacta.",
    },
    claimsMustBeSourced: {
      label: "Cifras con origen",
      help: "Toda cifra de un mensaje (vistas, resultados de campañas) tiene que salir de tus datos. Un mensaje con una cifra inventada no sale.",
    },
    warmupDays: {
      label: "Días de calentamiento",
      /** `inicio` es WARMUP_START_LIMIT ya formateado: la regla vive en @mc/core/outreach/warmup. */
      help: (inicio: string) =>
        `Una cuenta nueva empieza con ${inicio} correos al día y sube poco a poco hasta tu tope en este día. 0 es sin calentamiento.`,
    },
    postalAddress: {
      label: "Dirección postal",
      help: "Va al pie de cada correo junto al enlace de baja. La exigen las leyes de correo comercial (CAN-SPAM, RGPD y las leyes locales); sin ella no sale nada.",
      placeholder: "Calle, número, ciudad y país",
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
    /** El tope no pasa del inicio del calentamiento: no hay nada que subir. */
    topeBajo: (tope: string) => `Con un tope de ${tope} correos al día no hace falta calentar: vale desde el primer día.`,
    fueraDeRango: "Corrige el tope o los días de calentamiento para ver la curva.",
    caption: "Correos al día según el día desde que conectaste tu Gmail",
  },

  salud: {
    title: "Salud de hoy",
    description: "Las últimas 24 horas del envío. Si algo se sale de lo normal, también te avisamos por correo.",
    enviados: { label: "Correos enviados", note: "En las últimas 24 horas" },
    rebotes: {
      label: "Rebotes",
      /** «2 de 40 no existen». */
      note: (duros: string, enviados: string) => `${duros} de ${enviados} no existen`,
      sinEnvios: "Sin envíos todavía",
    },
    cola: {
      label: "Por salir",
      note: (atascados: string) => `${atascados} atascados`,
      noteSinAtascos: "Nada atascado",
    },
    cuentas: { label: "Cuentas caídas", note: "Piden reconectar o fallan", noteBien: "Todas conectadas" },
    sinDato: "—",
    rebotesTitle: "Últimos rebotes",
    rebotesCaption: "Los últimos avisos de rebote leídos de tu Gmail",
    columnas: { direccion: "Dirección", tipo: "Tipo", motivo: "Lo que dijo el servidor", fecha: "Cuándo" },
    tipos: { hard: "No existe", soft: "Pasajero", blocked: "Bloqueado" },
    sinDireccion: "Sin dirección en el aviso",
    sinRebotes: {
      title: "Ningún rebote",
      description: "Cuando un correo no llegue, aquí verás a qué dirección y por qué.",
    },
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
