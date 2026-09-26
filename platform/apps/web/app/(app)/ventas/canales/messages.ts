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
 * aviso de la campana) no están aquí: el keepalive del worker escribe el
 * mismo aviso, y viven en @mc/core (canales-textos.ts) para que el mismo
 * evento diga lo mismo lo detecte quien lo detecte. Se re-exportan abajo
 * (`health`). En last_error de la base solo hay CÓDIGOS: la pantalla los
 * traduce aquí al pintar (_lib/filas.ts, REASON_BY_CODE).
 */
import { CANALES_TEXTOS } from "@mc/core";

export const MESSAGES = {
  meta: { title: "Canales para escribir a marcas" },
  header: {
    eyebrow: "Ventas",
    title: "Canales",
    description:
      "Las cuentas desde las que On Cue escribe a las marcas por ti. Cada cuenta tiene su límite diario y semanal, dentro de la política de tu espacio y de lo que permite cada servicio.",
  },
  tabs: { canales: "Canales" },
  section: "Tus canales",
  policyOff: "Los envíos automáticos a marcas están apagados en este espacio. Conectar un canal no envía nada todavía.",

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
    /** Una cuenta conectada que hoy no puede enviar porque el canal no está disponible en la plataforma o está apagado en el espacio. */
    paused: "En pausa",
    /** El canal no está en outbound_policy.allowed_channels: Instagram nace así (0045, §5.1). */
    off: "Apagado en este espacio",
  },

  detail: {
    /**
     * Cuándo se comprobó por última vez que la cuenta responde (last_ok_at),
     * en relativo como las integraciones de Vercel y Linear («Comprobada
     * hace 2 horas»); la fecha completa va en el title.
     */
    lastOk: (when: string) => `Comprobada ${when}`,
    /** En una cuenta caída, last_ok_at es la última vez que funcionó, no la última vez que se miró. */
    lastWorked: (when: string) => `Funcionó por última vez ${when}`,
    /** El nombre accesible de la lista de las demás cuentas vivas de un canal. */
    otherAccounts: (channel: string) => `Otras cuentas de ${channel}`,
    /** Una cuenta conectada sin avisos de Unipile: no nos enteramos de sus respuestas. */
    webhooksMissing: "Conectada, pero todavía no nos enteramos de las respuestas: no pudimos activar sus avisos.",
    /** Se reconectó mientras la soltábamos en el servicio. */
    releasing: "Estábamos desconectando esta cuenta cuando la volviste a conectar. Espera un minuto y vuelve a intentarlo.",
    pendingHint: {
      email: "Estás autorizando en Google. Si cerraste esa página sin terminar, vuelve a intentarlo.",
      unipile: (provider: string) => `Termina la conexión en la página de ${provider} que se abrió. Si la cerraste, vuelve a intentarlo.`,
      /** La persona YA volvió de la página de conexión (?conectado=): falta la confirmación, no su parte. */
      returned: (provider: string) => `Terminaste en ${provider}; estamos esperando su confirmación. Si en unos minutos no aparece como conectado, vuelve a intentarlo.`,
    },
    expiredHint: {
      email: "No terminaste de autorizar en Google. Vuelve a intentarlo.",
      unipile: (provider: string) => `La conexión con ${provider} no se terminó a tiempo. Vuelve a intentarlo.`,
    },
    /**
     * Sin las llaves del proveedor en la plataforma: para el creador, en
     * voz de producto y con el nombre del servicio. Sin promesas: nada
     * avisa cuando las llaves llegan. Es la misma frase que el aviso de
     * arriba (banners.errors.no_configurado): la fila y el aviso dicen lo mismo.
     */
    unavailable: (service: string) => `${service} todavía no está disponible en On Cue.`,
    /** Lo mismo cuando no se sabe de qué servicio (el «Volver a intentar» de los avisos, sin la cuenta a mano). */
    unavailableGeneric: "Este canal todavía no está disponible en On Cue.",
    /** Los tres canales sin llaves: UN aviso arriba de la lista, y en cada fila solo la pastilla. */
    allUnavailable: "Los canales para escribir a marcas todavía no están disponibles en On Cue. Puedes seguir usando el resto de Ventas.",
    /** Una cuenta conectada que no puede enviar mientras el canal no esté disponible. */
    unavailableConnected: "Tu cuenta sigue conectada, pero On Cue no puede enviar por este canal ahora mismo.",
    /**
     * Una cuenta caída en un canal no disponible: el botón «Reconectar» va
     * deshabilitado, así que la frase no pide reconectar (la de la caída,
     * «… Vuelve a conectar la cuenta», contradecía al botón).
     */
    unavailableDown: "Esta cuenta necesita volver a conectarse, pero el canal no está disponible ahora mismo en On Cue.",
    /**
     * El canal está fuera de la política del espacio (allowed_channels): el
     * outreach no lo usa, así que no se ofrece conectarlo (Unipile cobraría
     * la cuenta cada mes sin que nada escribiera por ella).
     */
    off: (service: string) => `${service} está apagado en este espacio: los envíos a marcas no lo usan. Se enciende en la política de ventas del espacio.`,
    /** Una cuenta viva en un canal que el espacio apagó después de conectarla. */
    offLive: (service: string) => `${service} está apagado en este espacio: esta cuenta sigue conectada, pero no se usa para escribir a marcas.`,
    /** Solo en desarrollo: qué falta en el servidor, plegado. */
    adminDetails: "Detalles para quien administra la plataforma",
    adminMissing: (vars: string) => `Faltan en el servidor: ${vars}. Cómo se consiguen: platform/.env.example.`,
    /** Un motivo guardado que la pantalla no conoce (un código nuevo del worker): nunca se enseña crudo. */
    unknownReason: "Algo falló con esta cuenta. Si no se arregla sola, vuelve a conectarla.",
    /** Lo mismo, con la cuenta ya marcada para reconectar (o un intento que no terminó): no se va a arreglar sola. */
    unknownReasonReconnect: "No pudimos usar esta cuenta. Vuelve a conectarla.",
    /** Las frases de los códigos que escribe el keepalive (last_error). */
    reasons: {
      transient: "No pudimos comprobar la cuenta. Lo volvemos a intentar en unas horas.",
      duplicado: "Ese perfil ya estaba conectado en este espacio: seguimos usando esa conexión.",
    },
    /** Quien no puede gestionar los canales (un miembro, un invitado): ve la pantalla, no la toca. */
    readOnly: "Solo quien administra este espacio puede conectar, desconectar o cambiar los límites de los canales.",
  },

  actions: {
    connect: "Conectar",
    /** Un canal que ya tiene una cuenta viva: conectar una más (dos buzones, dos LinkedIn), como «Add another» de Vercel. */
    connectAnother: "Conectar otra cuenta",
    reconnect: "Reconectar",
    retry: "Volver a intentar",
    connecting: "Abriendo…",
    disconnect: "Desconectar",
    /** El nombre accesible de «Desconectar» de una cuenta concreta. */
    disconnectAccount: (account: string) => `Desconectar ${account}`,
    disconnectConfirm: "¿Desconectar esta cuenta? Los envíos pendientes desde esta cuenta se detienen y On Cue deja de tener acceso a ella.",
    /** La confirmación, anunciada en la fila del canal, después de desconectar. */
    disconnected: (account: string) => `Desconectaste ${account}. On Cue deja de usarla ahora y retira su acceso en unos minutos.`,
    /** Desconectar una cuenta que ya no estaba (otra pestaña, otro miembro del espacio). */
    alreadyDisconnected: "Esa cuenta ya estaba desconectada.",
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
    /** El máximo de la cuenta y quién lo fija, igual para el diario y el semanal (daily_limited_by y weekly_limited_by, 0045). */
    max: {
      policy: (n: string) => `Máximo ${n} (política del espacio)`,
      personal: (n: string) => `Máximo ${n} (Gmail personal)`,
      provider: (n: string, provider: string) => `Máximo ${n} (${provider})`,
    },
    /** Vacío = sin tope propio: rige el máximo, que va de marcador en el campo. */
    emptyMeansMax: "Vacío: el máximo.",
    saved: "Límites guardados.",
    invalid: (n: string) => `Tiene que ser un número entero entre 0 y ${n}.`,
    dailyAboveWeekly: (n: string) => `El tope diario no puede pasar del semanal (${n}).`,
    notFound: "Esa cuenta ya no está en este espacio.",
  },

  /**
   * Lo que vuelve en /ventas/canales?conectado=… o ?error=…&canal=…. Un
   * error que depende del servicio es una función de su nombre (Gmail,
   * LinkedIn, Instagram): la persona conectó «LinkedIn», no «el
   * proveedor». Los mismos textos son el motivo de la fila (filas.ts).
   * No todo lo que vuelve por ?error= es un error: el tono de cada código
   * (rojo, ámbar o neutro) lo fija NOTICE_TONE en _lib/banner.ts.
   */
  banners: {
    connected: (channel: string) => `${channel} quedó conectado.`,
    /** El aviso de éxito llegó antes que el de Unipile: la fila sigue «Conectando». */
    finishing: (channel: string) => `Estamos terminando de conectar tu ${channel}…`,
    /** Pasó el minuto de espera y el aviso de Unipile no llegó: no prometer que «estamos terminando» para siempre. */
    finishingSlow: (channel: string) => `${channel} tarda en confirmar. Si en unos minutos no aparece como conectado, vuelve a intentarlo.`,
    errors: {
      cancelada: "Cancelaste la autorización. La cuenta no se conectó.",
      permisos: "Google no concedió los permisos de enviar y leer correo. Vuelve a conectar y acepta los dos.",
      ocupada: "Esa cuenta ya está conectada en otro espacio de On Cue.",
      vencida: "La conexión tardó demasiado o ya se había usado. Vuelve a intentarlo.",
      /** El servicio no respondió al empezar o al terminar la conexión (transitorio). */
      proveedor: (service: string) => `No pudimos conectar con ${service} ahora mismo. Inténtalo de nuevo en unos minutos.`,
      /** La página de conexión de Unipile terminó sin cuenta: contraseña mala, el código de verificación sin resolver o se cerró. */
      unipile_fallo: (service: string) =>
        `No se pudo conectar tu ${service}. Revisa el usuario y la contraseña, o el código de verificación, y vuelve a intentarlo.`,
      intercambio: "Google no aceptó la autorización. Vuelve a intentar conectar el correo.",
      sin_creador: "Este espacio no tiene un perfil de creador; no se puede conectar una cuenta.",
      /** Sin las llaves del servicio en la plataforma: la misma frase que la fila (detail.unavailable), en ámbar. */
      no_configurado: (service: string) => `${service} todavía no está disponible en On Cue.`,
      canal_equivocado: "La cuenta que conectaste no es de ese canal.",
      otro_espacio: "Esta conexión se empezó en otro espacio de On Cue. Cambia a ese espacio y vuelve a intentarlo.",
      soltando: "Todavía estábamos desconectando esa cuenta. Espera un minuto y vuelve a intentarlo.",
      /** El mismo perfil ya está conectado en este espacio (0042): la cuenta nueva se soltó en Unipile. */
      duplicado: "Ese perfil ya está conectado en este espacio. Seguimos usando esa conexión.",
      /** Un inicio de conexión de un canal fuera de la política del espacio (la fila no ofrece el botón; esto es un POST a mano). */
      apagado: (service: string) => `${service} está apagado en este espacio: los envíos a marcas no lo usan.`,
    },
    /** El nombre del servicio cuando un ?error= llega sin ?canal= (un enlace viejo). */
    genericService: "el servicio",
    /** «Volver a intentar» de los avisos de una cuenta conectada. */
    webhooksRestored: "Listo: ya nos enteramos de las respuestas de esa cuenta.",
    webhooksStillMissing: "Todavía no pudimos activar los avisos de esa cuenta. Inténtalo de nuevo en unos minutos; también lo reintentamos cada día.",
  },

  /** Respuestas de las rutas (texto plano o JSON para el proveedor, no la pantalla). */
  routes: {
    notConfigured: "Este canal no está disponible.",
    postOnly: "Usa el botón «Conectar» de /ventas/canales: el inicio va por POST.",
    webhookPostOnly: "Solo POST.",
    unauthorized: "Firma inválida.",
    /** Conectar o desconectar sin el rol (PUEDEN_GESTIONAR_CANALES). */
    forbidden: "Solo quien administra este espacio puede conectar o desconectar canales.",
    /** Un POST de inicio que no sale de una página de On Cue (Origin o Sec-Fetch-Site de otro sitio). */
    crossOrigin: "Conecta el canal desde la pantalla de canales de On Cue.",
    badJson: "JSON inválido.",
    badForm: "Formulario inválido.",
    tooLarge: "Aviso demasiado grande.",
    providerDown: "Unipile no respondió.",
    /** El envío tenía bloqueada la cadencia más de lo que el aviso espera: Unipile lo reintenta. */
    busy: "Ocupado: reintenta en unos segundos.",
    /** Por qué un aviso autenticado no cambió nada (va en el JSON de la respuesta a Unipile). */
    ignored: {
      unknownAccount: "cuenta desconocida o desconectada",
      echo: "eco de un envío propio",
      /** Un mensaje sin sender.attendee_provider_id: podría ser el eco de un envío propio y no se arriesga a detener una cadencia. */
      noSender: "mensaje sin remitente",
      duplicate: "mensaje repetido",
      healthy: "la cuenta sigue bien",
      unknownInUnipile: "cuenta desconocida en Unipile",
      /** Un DM del creador que no es respuesta a un toque nuestro: ni se guarda ni se clasifica. */
      foreignChat: "chat ajeno al outreach",
      notAccountEvent: "aviso de cuenta con cabeceras de ruta",
      /** El aviso de cuenta creada trae una cuenta que no nació de ese intento (una vieja, u otra que la reconectada). */
      notThisAttempt: "cuenta que no es de este intento",
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

  loading: { label: "Cargando canales" },
  error: { eyebrow: "Ventas", title: "No pudimos leer tus canales" },
} as const;
