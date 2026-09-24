/**
 * Textos de /ventas/politica (VEN-15): la política de envío del
 * outreach y la salud del día. Cada regla lleva una línea que dice qué
 * hace y por qué; referencia: la configuración de límites y
 * calentamiento de Lemlist e Instantly. Voz: una creadora que escribe a
 * marcas, no un equipo de ventas. Nada atado a un país: las cifras y las
 * fechas llegan formateadas con el locale del workspace.
 *
 * Los plurales (r4): la cifra llega formateada para pintarla y cruda para
 * elegir la forma con Intl.PluralRules del idioma de estos textos, nunca
 * con un «n === 1» a mano.
 */
const reglas = new Intl.PluralRules("es");
/** La forma de una frase según la cifra: «1 atascado», «3 atascados». */
function plural(n: number, one: string, other: string): string {
  return reglas.select(n) === "one" ? one : other;
}

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
    /** Nunca se encendió y falta algo: el paso concreto lo dice la línea de abajo, sin repetirlo aquí (r4). */
    offHelpNuncaCorto: "Todavía no sale nada.",
    /** Se apagó, sin motivo guardado: lo que estaba en cola se canceló. */
    offHelp: "No sale nada. Lo que estaba en cola se canceló y vuelve a planificarse al encender.",
    offReason: (motivo: string, fecha: string) => `Apagado el ${fecha}: ${motivo}.`,
    /**
     * Los motivos que guarda outbound_policy.disabled_reason como código
     * (r4): la base no guarda frases. Uno que no está aquí (lo pone otro
     * proceso) se enseña con offReasonDetalle, como detalle.
     */
    motivos: { manual: "lo apagaste desde la política" } as Readonly<Record<string, string>>,
    offReasonDetalle: (detalle: string, fecha: string) => `Apagado el ${fecha}. Motivo registrado: ${detalle}.`,
    encender: "Encender el envío",
    apagar: "Apagar el envío",
    confirmarApagar: "¿Apagar el envío?",
    consecuenciaApagar: "Lo que está en cola se cancela; tus secuencias quedan como están y vuelven a planificarse al encender.",
    siApagar: "Sí, apagar",
    cancelar: "Cancelar",
    sinDireccion: "Para encender el envío guarda primero tu dirección postal.",
    /** Sin ninguna cuenta de envío conectada, encender no enviaría nada. */
    sinCanal: "Para encender el envío conecta primero una cuenta de envío (Gmail, LinkedIn o Instagram).",
    /** Quien no es dueño ni administra el espacio (0038 §7). */
    sinPermiso: "Solo quien es dueño o administra este espacio puede encender o apagar el envío.",
    confirmarEncender: "¿Encender el envío?",
    /** `n` es el número de mensajes aprobados para hoy, ya formateado; `cuantos`, el mismo sin formatear. */
    consecuenciaEncender: (n: string, cuantos: number) =>
      cuantos > 0
        ? `${plural(cuantos, `Hoy sale ${n} mensaje aprobado`, `Hoy salen ${n} mensajes aprobados`)}, dentro de tus límites, y desde ahí lo que apruebes sale solo, en tu nombre.`
        : "Hoy no hay mensajes aprobados en cola. Desde ahora, lo que apruebes sale solo, en tu nombre y dentro de tus límites.",
    siEncender: "Sí, encender",
    /** El código que se guarda al apagar a mano (disable_outreach lo toma también por defecto, 0037). */
    motivoManual: "manual",
    errorEncender: "No se pudo encender. Revisa que la dirección postal esté guardada.",
    errorApagar: "No se pudo apagar. Inténtalo de nuevo.",
  },

  /** El formulario, para quien no es dueño ni administra el espacio (0038 §7). */
  sinPermiso: "Solo quien es dueño o administra este espacio puede cambiar estas reglas. Puedes verlas; para cambiarlas, pídeselo.",

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
    /** El nombre de la línea del gráfico (tooltip). */
    serie: "Correos al día",
    /** Debajo del gráfico: qué es el eje horizontal. */
    ejeX: "Día desde que conectaste tu Gmail",
  },

  salud: {
    title: "Salud de hoy",
    description: "Las últimas 24 horas del envío. Si algo se sale de lo normal, también te avisamos por correo.",
    enviados: { label: "Correos enviados", note: "En las últimas 24 horas" },
    rebotes: {
      label: "Rebotes",
      /** «1 de 40 no existe», «2 de 40 no existen»; `n` es `duros` sin formatear. */
      note: (duros: string, enviados: string, n: number) =>
        plural(n, `${duros} de ${enviados} no existe`, `${duros} de ${enviados} no existen`),
      sinEnvios: "Sin envíos todavía",
    },
    cola: {
      label: "Por salir",
      /** `n` es `atascados` sin formatear. */
      note: (atascados: string, n: number) => plural(n, `${atascados} atascado`, `${atascados} atascados`),
      noteSinAtascos: "Nada atascado",
    },
    cuentas: {
      label: "Cuentas caídas",
      /** Cuáles, ya en una lista con Intl («LinkedIn: Laura · Cocina fácil»). */
      note: (cuales: string) => cuales,
      noteBien: "Todas conectadas",
    },
    /** La lista de cuentas caídas, adonde lleva la alerta outreach_account_down. */
    caidas: {
      title: "Cuentas que necesitan atención",
      description:
        "Mientras una cuenta no se reconecte, no sale nada por ella: lo de ese canal espera en la cola y no se pierde.",
      estado: { needs_reconnect: "Pide reconectar", error: "Falla" } as Record<"needs_reconnect" | "error", string>,
      /** «Desde el 23 de septiembre». */
      desde: (fecha: string) => `Desde el ${fecha}`,
      sinDetalle: "El proveedor no dio más detalle.",
      /**
       * El paso concreto, en una frase, en vez de un enlace a una página
       * que no resuelve nada: la pantalla de canales (VEN-9), donde se
       * reconecta, todavía no está integrada. Cuando llegue, la alerta y
       * esta lista enlazan allí (CANALES_URL del worker).
       */
      paso: {
        email: "Para volver a enviar, vuelve a conectar este Gmail y acepta los permisos de envío.",
        otro: "Para volver a enviar, vuelve a conectar esta cuenta con tu sesión del proveedor.",
      },
    },
    canal: { email: "Gmail", linkedin: "LinkedIn", instagram_dm: "Instagram", whatsapp: "WhatsApp" } as Record<
      "email" | "linkedin" | "instagram_dm" | "whatsapp",
      string
    >,
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
    /**
     * Mientras el job de rebotes no lea los buzones (BOUNCE_READING_CONNECTED
     * de @mc/core, hasta integrar VEN-9): que «Ningún rebote» no se lea como
     * «todo bien» (r4).
     */
    lecturaPendiente: {
      title: "Todavía no leemos los rebotes de tu Gmail",
      description:
        "La lectura automática de los avisos de rebote se conecta junto con los canales de envío. Hasta entonces, esta tabla y la cifra de rebotes no cuentan los que lleguen a tu buzón: revísalos allí.",
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
