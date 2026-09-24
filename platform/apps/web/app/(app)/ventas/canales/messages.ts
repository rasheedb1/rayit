/**
 * Textos de /ventas/canales (VEN-9): la pantalla, sus avisos, los
 * errores que vuelven de un proveedor, las respuestas de las rutas y las
 * frases que quedan en la base (el aviso de la campana cuando una cuenta
 * cae, el motivo de una baja). Un solo sitio para traducirlos.
 *
 * Al creador nunca se le enseñan nombres de variables de entorno, rutas
 * del repositorio ni códigos crudos de un proveedor: eso va a los
 * registros del servidor, a api_call_log y, solo en desarrollo, a un
 * bloque plegado para quien administra la plataforma.
 */
export const MESSAGES = {
  meta: { title: "Canales de outreach" },
  header: {
    eyebrow: "Ventas",
    title: "Canales",
    description:
      "Las cuentas desde las que On Cue escribe a las marcas por ti. Cada cuenta tiene su límite diario y semanal, dentro de la política de tu espacio y de lo que aguanta el proveedor.",
  },
  tabs: { canales: "Canales" },
  section: "Tus canales",
  policyOff: "El outreach automático de este espacio está apagado. Conectar un canal no envía nada todavía.",

  channels: {
    email: { name: "Correo", provider: "Gmail", blurb: "El canal principal: las marcas leen su buzón de alianzas." },
    linkedin: { name: "LinkedIn", provider: "LinkedIn", blurb: "Para llegar a la persona de marketing de la marca." },
    instagram_dm: { name: "Instagram", provider: "Instagram", blurb: "Opcional: mensajes directos cuando la marca no tiene otro contacto." },
  },

  status: {
    connected: "Conectado",
    pending: "Conectando",
    expired: "Sin terminar",
    needsReconnect: "Necesita reconectar",
    error: "Con error",
    disconnected: "Sin conectar",
    notConfigured: "No disponible",
    /** Una cuenta conectada que hoy no puede enviar porque el canal no está disponible en la plataforma. */
    paused: "En pausa",
  },

  detail: {
    account: "Cuenta",
    /** «Hoy 3 de 20 · Semana 12 de 100»: los dos límites vienen de la vista de límites (0040), siempre con número. */
    usage: (today: string, dayCap: string, week: string, weekCap: string) => `Hoy ${today} de ${dayCap} · Semana ${week} de ${weekCap}`,
    lastOk: (when: string) => `Comprobado ${when}`,
    pendingHint: {
      email: "Estás autorizando en Google. Si cerraste esa página sin terminar, vuelve a intentarlo.",
      unipile: (provider: string) => `Termina la conexión en la página de ${provider} que se abrió. Si la cerraste, vuelve a intentarlo.`,
    },
    expiredHint: {
      email: "No terminaste de autorizar en Google. Vuelve a intentarlo.",
      unipile: (provider: string) => `La conexión con ${provider} no se terminó a tiempo. Vuelve a intentarlo.`,
    },
    /** Sin las llaves del proveedor en la plataforma: para el creador, en voz de producto. */
    unavailable: "Este canal todavía no está disponible en tu cuenta de On Cue. Te avisamos cuando lo esté.",
    /** Una cuenta conectada que no puede enviar mientras el canal no esté disponible. */
    unavailableConnected: "Tu cuenta sigue conectada, pero On Cue no puede enviar por este canal ahora mismo. Te avisamos cuando vuelva.",
    /** Solo en desarrollo: qué falta en el servidor, plegado. */
    adminDetails: "Detalles para quien administra la plataforma",
    adminMissing: (vars: string) => `Faltan en el servidor: ${vars}. Cómo se consiguen: platform/.env.example.`,
  },

  actions: {
    connect: "Conectar",
    reconnect: "Reconectar",
    retry: "Volver a intentar",
    disconnect: "Desconectar",
    disconnectConfirm: "¿Desconectar esta cuenta? Los envíos pendientes por este canal se detienen y la cuenta se suelta en el proveedor.",
    cancel: "Cancelar",
    saveCaps: "Guardar límites",
    saving: "Guardando…",
    manage: "Límites y cuenta",
    /** El nombre accesible de un botón deshabilitado: la acción y por qué no se puede. */
    unavailableLabel: (action: string, why: string) => `${action}: ${why}`,
  },

  caps: {
    legend: "Límites",
    daily: "Por día",
    weekly: "Por semana",
    /** El máximo de la cuenta y quién lo fija. */
    max: {
      policy: (n: string) => `Máximo ${n} (política del espacio)`,
      personal: (n: string) => `Máximo ${n} (Gmail personal)`,
      provider: (n: string, provider: string) => `Máximo ${n} (${provider})`,
      plain: (n: string) => `Máximo ${n}`,
    },
    /** Vacío = sin tope propio: rige el máximo, que va de marcador en el campo. */
    emptyMeansMax: "Vacío: el máximo.",
    saved: "Límites guardados.",
    invalid: (n: string) => `Tiene que ser un número entero entre 0 y ${n}.`,
    dailyAboveWeekly: (n: string) => `El tope diario no puede pasar del semanal (${n}).`,
    notFound: "Esa cuenta ya no está en este espacio.",
  },

  /** Lo que vuelve en /ventas/canales?conectado=… o ?error=… */
  banners: {
    connected: (channel: string) => `${channel} quedó conectado.`,
    /** El aviso de éxito llegó antes que el de Unipile: la fila sigue «Conectando». */
    finishing: (channel: string) => `Estamos terminando de conectar tu ${channel}…`,
    errors: {
      cancelada: "Cancelaste la autorización. La cuenta no se conectó.",
      permisos: "Google no concedió los permisos de enviar y leer correo. Vuelve a conectar y acepta los dos.",
      ocupada: "Esa cuenta ya está conectada en otro espacio de On Cue.",
      vencida: "La conexión tardó demasiado o ya se había usado. Vuelve a intentarlo.",
      proveedor: "El proveedor no respondió. Inténtalo de nuevo en unos minutos.",
      intercambio: "Google no aceptó la autorización. Vuelve a intentar conectar el correo.",
      sin_creador: "Este espacio no tiene un perfil de creador; no se puede conectar una cuenta.",
      no_configurado: "Este canal todavía no está disponible en tu cuenta de On Cue.",
      canal_equivocado: "La cuenta que conectaste no es de ese canal.",
    },
  },

  /** Respuestas de las rutas (texto plano o JSON para el proveedor, no la pantalla). */
  routes: {
    notConfigured: "Este canal no está disponible.",
    postOnly: "Usa el botón «Conectar» de /ventas/canales: el inicio va por POST.",
    webhookPostOnly: "Solo POST.",
    badState: "La respuesta del proveedor no corresponde a una conexión empezada en este navegador. Vuelve a /ventas/canales y pulsa «Conectar».",
    otherWorkspace: "Esta conexión se empezó en otro espacio. Cambia a ese espacio y vuelve a intentarlo.",
    unauthorized: "Firma inválida.",
    badJson: "JSON inválido.",
    tooLarge: "Aviso demasiado grande.",
    providerDown: "Unipile no respondió.",
    /** Por qué un aviso autenticado no cambió nada (va en el JSON de la respuesta a Unipile). */
    ignored: {
      unknownAccount: "cuenta desconocida o desconectada",
      echo: "eco de un envío propio",
      duplicate: "mensaje repetido",
      healthy: "la cuenta sigue bien",
      unknownInUnipile: "cuenta desconocida en Unipile",
      notAccountEvent: "aviso de cuenta con cabeceras de ruta",
    },
    /** Lo que se registra en el servidor (console.warn) cuando falta configuración. */
    serverMissing: (channel: string, vars: string) => `[canales] ${channel} no está disponible: faltan ${vars} (ver platform/.env.example).`,
  },

  /**
   * Lo que dice Unipile de una sesión, en frase. El código crudo
   * (CREDENTIALS, STOPPED…) no llega al creador: queda en el registro del
   * servidor.
   */
  unipileStatus: (status: string, channel: string): string => {
    switch (status) {
      case "CREDENTIALS": return `${channel} cerró la sesión.`;
      case "STOPPED": return "La cuenta se detuvo.";
      case "DELETED": return "La cuenta se borró en el proveedor.";
      case "DISCONNECTED": return "La cuenta se desconectó.";
      default: return `${channel} dio un error con la sesión.`;
    }
  },

  /** Lo que queda escrito en la base cuando Unipile avisa que la cuenta cayó. */
  downNotice: {
    title: (channel: string, name: string | null) => `Vuelve a conectar tu ${channel}${name ? ` (${name})` : ""}`,
    body: (what: string) => `${what} Vuelve a conectar la cuenta desde Canales.`,
  },
  /** contact.opted_out_reason cuando una respuesta pide la baja. */
  optOutReason: (channel: string) => `Pidió no ser contactado, respondiendo por ${channel}.`,
  /** Queda en last_error si no se pudieron dar de alta los avisos de la cuenta. */
  webhookSetupFailed: "Conectada, pero sin avisos de respuestas: no pudimos darlos de alta. Reconecta la cuenta para reintentarlo.",

  loading: { label: "Cargando canales" },
  error: { eyebrow: "Ventas", title: "No pudimos leer tus canales" },
} as const;
