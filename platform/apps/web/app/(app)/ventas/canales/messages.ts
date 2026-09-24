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
 *
 * Las frases de SALUD de una cuenta (qué dijo Unipile de la sesión, el
 * aviso de la campana) no están aquí: las escribe también el keepalive
 * del worker, y viven en @mc/core (canales-textos.ts) para que el mismo
 * evento diga lo mismo lo detecte quien lo detecte. Se re-exportan abajo.
 */
import { CANALES_TEXTOS } from "@mc/core";

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
    /** «Hoy 3 de 20» y «Semana 12 de 100», por separado para que en móvil no se partan a medias. Los límites vienen de la vista (0040). */
    usageToday: (today: string, dayCap: string) => `Hoy ${today} de ${dayCap}`,
    usageWeek: (week: string, weekCap: string) => `Semana ${week} de ${weekCap}`,
    /** Cuándo se comprobó por última vez que la cuenta responde (last_ok_at), como las integraciones de Vercel. */
    lastOk: (when: string) => `Comprobada ${when}`,
    /** El nombre accesible de la lista de las demás cuentas vivas de un canal. */
    otherAccounts: (channel: string) => `Otras cuentas de ${channel}`,
    /** Una cuenta conectada sin avisos de Unipile: no nos enteramos de sus respuestas. */
    webhooksMissing: "Conectada, pero todavía no nos enteramos de las respuestas: no pudimos activar sus avisos.",
    /** Se reconectó mientras la soltábamos en el proveedor. */
    releasing: "Estábamos soltando esta cuenta cuando la volviste a conectar. Espera un minuto y vuelve a intentarlo.",
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
    connecting: "Abriendo…",
    disconnect: "Desconectar",
    /** El nombre accesible de «Desconectar» de una cuenta concreta. */
    disconnectAccount: (account: string) => `Desconectar ${account}`,
    disconnectConfirm: "¿Desconectar esta cuenta? Los envíos pendientes por este canal se detienen y la cuenta se suelta en el proveedor.",
    cancel: "Cancelar",
    saveCaps: "Guardar límites",
    saving: "Guardando…",
    manage: "Límites y cuenta",
    /** El nombre accesible de un botón deshabilitado: la acción y por qué no se puede. */
    unavailableLabel: (action: string, why: string) => `${action}: ${why}`,
  },

  caps: {
    /** El nombre accesible del formulario de límites de una cuenta. */
    legend: (account: string) => `Límites de ${account}`,
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
      otro_espacio: "Esta conexión se empezó en otro espacio de On Cue. Cambia a ese espacio y vuelve a intentarlo.",
      soltando: "Estábamos soltando esa cuenta en el proveedor. Espera un minuto y vuelve a intentarlo.",
    },
    /** «Volver a intentar» de los avisos de una cuenta conectada. */
    webhooksRestored: "Listo: ya nos enteramos de las respuestas de esa cuenta.",
    webhooksStillMissing: "El proveedor no respondió. Inténtalo de nuevo en unos minutos; también lo reintentamos cada día.",
  },

  /** Respuestas de las rutas (texto plano o JSON para el proveedor, no la pantalla). */
  routes: {
    notConfigured: "Este canal no está disponible.",
    postOnly: "Usa el botón «Conectar» de /ventas/canales: el inicio va por POST.",
    webhookPostOnly: "Solo POST.",
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
      /** Un DM del creador que no es respuesta a un toque nuestro: ni se guarda ni se clasifica. */
      foreignChat: "chat ajeno al outreach",
      notAccountEvent: "aviso de cuenta con cabeceras de ruta",
    },
    /** Lo que se registra en el servidor (console.warn) cuando falta configuración. */
    serverMissing: (channel: string, vars: string) => `[canales] ${channel} no está disponible: faltan ${vars} (ver platform/.env.example).`,
  },

  /**
   * La salud de una cuenta (@mc/core): lo que dice Unipile de la sesión y
   * el aviso de la campana cuando cae. El código crudo (CREDENTIALS,
   * STOPPED…) no llega al creador: queda en el registro del servidor.
   */
  health: CANALES_TEXTOS,
  /** contact.opted_out_reason cuando una respuesta pide la baja. */
  optOutReason: (channel: string) => `Pidió no ser contactado, respondiendo por ${channel}.`,

  loading: { label: "Cargando canales" },
  error: { eyebrow: "Ventas", title: "No pudimos leer tus canales" },
} as const;
