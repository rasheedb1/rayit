/**
 * Textos de /ventas/canales (VEN-9): la pantalla, sus avisos, los
 * errores que vuelven de un proveedor y las frases que quedan en la
 * base (el aviso de la campana cuando una cuenta cae). Un solo sitio
 * para traducirlos.
 */
export const MESSAGES = {
  meta: { title: "Canales de outreach" },
  header: {
    eyebrow: "Ventas",
    title: "Canales",
    description:
      "Las cuentas desde las que On Cue escribe a las marcas por ti. Cada canal tiene su límite diario y semanal; nunca pasa del techo que aguanta el proveedor.",
  },
  tabs: { canales: "Canales" },
  section: "Tus canales",
  policyOff: "El outreach automático de este espacio está apagado. Conectar un canal no envía nada todavía.",

  channels: {
    email: { name: "Correo", provider: "Gmail", blurb: "El canal principal: las marcas leen su buzón de alianzas." },
    linkedin: { name: "LinkedIn", provider: "LinkedIn", blurb: "Para llegar a la persona de marketing de la marca. Invitación con nota de hasta 300 caracteres." },
    instagram_dm: { name: "Instagram", provider: "Instagram", blurb: "Opcional: mensajes directos cuando la marca no tiene otro contacto." },
  },

  status: {
    connected: "Conectado",
    pending: "Conectando",
    expired: "Vencido",
    needsReconnect: "Necesita reconectar",
    error: "Con error",
    disconnected: "Sin conectar",
    notConfigured: "No configurado",
  },

  detail: {
    account: "Cuenta",
    usage: "Uso",
    today: (used: string, cap: string | null) => (cap ? `Hoy ${used} de ${cap}` : `Hoy ${used}`),
    week: (used: string, cap: string | null) => (cap ? `Semana ${used} de ${cap}` : `Semana ${used}`),
    lastOk: (when: string) => `Comprobado ${when}`,
    pendingHint: "Termina la conexión en la ventana del proveedor. Si la cerraste, vuelve a intentarlo.",
    expiredHint: "El enlace de conexión caducó sin terminarse. Vuelve a intentarlo.",
    notConfiguredHint: (vars: string) => `Falta configurar ${vars} en el servidor. Mientras tanto este canal no se puede conectar.`,
    howTo: "Cómo se consigue: platform/.env.example.",
  },

  actions: {
    connect: "Conectar",
    reconnect: "Reconectar",
    retry: "Volver a intentar",
    disconnect: "Desconectar",
    disconnectConfirm: "¿Desconectar esta cuenta? Los envíos pendientes por este canal se detienen.",
    saveCaps: "Guardar límites",
    saving: "Guardando…",
  },

  caps: {
    legend: "Límites",
    daily: "Por día",
    weekly: "Por semana",
    max: (n: string) => `Máximo ${n}`,
    placeholderPolicy: (n: string) => `Política: ${n}`,
    placeholderNone: "Sin límite propio",
    saved: "Límites guardados.",
    invalid: (n: string) => `Tiene que ser un número entero entre 0 y ${n}.`,
    notFound: "Esa cuenta ya no está en este espacio.",
  },

  /** Lo que vuelve en /ventas/canales?conectado=… o ?error=… */
  banners: {
    connected: (channel: string) => `${channel} quedó conectado.`,
    errors: {
      cancelada: "Cancelaste la autorización. La cuenta no se conectó.",
      permisos: "Google no concedió los permisos de enviar y leer correo. Vuelve a conectar y acepta los dos.",
      ocupada: "Esa cuenta ya está conectada en otro espacio de On Cue.",
      vencida: "La conexión tardó demasiado o ya se había usado. Vuelve a intentarlo.",
      proveedor: "El proveedor no respondió. Inténtalo de nuevo en unos minutos.",
      intercambio: "Google no aceptó la autorización. Vuelve a intentar conectar el correo.",
      sin_creador: "Este espacio no tiene un perfil de creador; no se puede conectar una cuenta.",
      no_configurado: "Ese canal no está configurado en este entorno.",
      canal_equivocado: "La cuenta que conectaste no es de ese canal.",
    },
  },

  /** Respuestas de las rutas (texto plano, no la pantalla). */
  routes: {
    notConfigured: (vars: string) => `Este canal no está configurado en este entorno: faltan ${vars}.`,
    postOnly: "Usa el botón «Conectar» de /ventas/canales: el inicio va por POST.",
    badState: "La respuesta del proveedor no corresponde a una conexión empezada en este navegador. Vuelve a /ventas/canales y pulsa «Conectar».",
    otherWorkspace: "Esta conexión se empezó en otro espacio. Cambia a ese espacio y vuelve a intentarlo.",
    unauthorized: "Firma inválida.",
  },

  /** Lo que queda escrito en la base cuando Unipile avisa que la cuenta cayó. */
  downNotice: {
    title: (channel: string, name: string | null) => `Vuelve a conectar tu ${channel}${name ? ` (${name})` : ""}`,
    body: (status: string) => `El proveedor dice que la sesión se cayó (${status}). Vuelve a conectar la cuenta desde Canales.`,
  },
  /** Queda en last_error si no se pudieron dar de alta los avisos de la cuenta. */
  webhookSetupFailed: "Conectada, pero sin avisos de respuestas: no pudimos darlos de alta en Unipile. Reconecta la cuenta para reintentarlo.",

  loading: { label: "Cargando canales" },
  error: { eyebrow: "Ventas", title: "No pudimos leer tus canales" },
} as const;
