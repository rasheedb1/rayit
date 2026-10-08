import { INVITACION_VIGENCIA_DIAS, INVITACIONES_POR_DIA, type Casilla } from "@mc/core";
import type { TeamErrorCode } from "@mc/db/queries/equipo";

/**
 * Todos los textos de Equipo (ACC-4) y del enlace de invitación, en un
 * solo sitio: la pantalla, las Server Actions, el correo y la página de
 * aceptar. Las etiquetas y descripciones de los roles NO están aquí:
 * vienen de la base (role.label_es, role.description_es), que es donde
 * vivirán también los roles a medida (ACC-9).
 */
/** «7 días», «1 día»: el plazo del enlace, siempre desde INVITACION_VIGENCIA_DIAS de @mc/core. */
const plazo = (dias: number) => (dias === 1 ? "1 día" : `${dias} días`);

/** El texto de un enlace vencido, con el plazo que de verdad tiene. */
export const textoVencida = (dias: number) => `Los enlaces valen ${plazo(dias)}. Pídele a quien te invitó que te mande uno nuevo.`;

/**
 * Lo que da cada casilla, contado a quien recibe la invitación (la página
 * del enlace y el correo), con el nombre del espacio: las etiquetas del
 * formulario (MESSAGES.casillas.*.label) hablan desde quien invita
 * («mis finanzas») y aquí no se entenderían.
 */
const CASILLAS_PARA_INVITADO = {
  finanzas: (espacio: string) => `Ver las finanzas de ${espacio}: facturas, gastos y flujo de caja.`,
  conexiones: (espacio: string) => `Conectar y quitar las cuentas de redes de ${espacio}.`,
} as const satisfies Record<Casilla, (espacio: string) => string>;

export const MESSAGES = {
  meta: "Equipo",
  eyebrow: "Tu espacio",
  titulo: "Equipo",
  descripcion:
    "Quién entra a este espacio y qué puede hacer. Cada persona ve solo lo que su rol le deja; el dinero y las cuentas conectadas se dan a propósito.",
  cargando: "Cargando el equipo",
  error: { eyebrow: "Equipo", title: "No pudimos leer tu equipo" },

  casillas: {
    finanzas: {
      label: "También puede ver mis finanzas",
      ayuda: "Facturas, gastos y flujo de caja. Solo ver: no crea facturas ni registra pagos.",
      corta: "Ve finanzas",
    },
    conexiones: {
      label: "También puede conectar mis cuentas",
      ayuda: "Conectar y quitar tus cuentas de redes. Lo que conecte queda a tu nombre y te avisamos.",
      corta: "Conecta cuentas",
    },
  } satisfies Record<Casilla, { label: string; ayuda: string; corta: string }>,
  /** Cuando quien invita no tiene lo que la casilla da: no la puede ofrecer. */
  casillaNoDisponible: "No la puedes dar: tú no tienes ese permiso.",

  invitar: {
    titulo: "Invitar a alguien",
    descripcion: (dias: number) =>
      `Te damos un enlace que vale ${plazo(dias)} y solo sirve para ese correo; si hay correo configurado, también se lo enviamos.`,
    correo: "Correo",
    correoAyuda: "Con el que esa persona entra a On Cue.",
    rol: "Rol",
    rolPlaceholder: "Elige un rol",
    casillasTitulo: "Lo que el rol de Mánager no trae",
    enviar: "Invitar",
  },

  resultado: {
    titulo: (correo: string) => `Invitación para ${correo}`,
    enviada: "Le enviamos el enlace por correo.",
    /** Falta el SMTP de la PLATAFORMA (SMTP_URL, MAIL_FROM): no es un ajuste del espacio y quien invita no lo arregla. */
    sinCorreo: "On Cue todavía no envía correos desde este servidor: copia el enlace y mándaselo tú.",
    /**
     * Modo demo (sin inicio de sesión): no se envía nada aunque haya SMTP,
     * porque nadie firma la invitación. Y el enlace no se puede aceptar
     * (no hay cuentas): abrirlo enseña lo que verá la persona invitada.
     */
    demo: "En la demo no se envían correos: copia el enlace para ver lo que recibirá esa persona.",
    falloCorreo: "No se pudo enviar el correo: copia el enlace y mándaselo tú.",
    enlace: "Enlace de la invitación",
    soloAhora: "El enlace solo se muestra ahora. Si se pierde, genera uno nuevo desde las invitaciones pendientes.",
    vence: (fecha: string) => `Vence el ${fecha}.`,
    reemplazada: "La invitación anterior a este correo quedó revocada.",
    copiar: "Copiar enlace",
    copiado: "Copiado",
    copiadoAviso: "Enlace copiado.",
    copiarFallo: "No se pudo copiar: selecciona el enlace y cópialo a mano.",
  },

  miembros: {
    titulo: "Personas",
    meta: (n: number) => (n === 1 ? "1 persona" : `${n} personas`),
    columnas: { persona: "Persona", rol: "Rol" },
    /** Bajo el correo de cada persona: desde cuándo es miembro. */
    desde: (fecha: string) => `Desde el ${fecha}`,
    tu: "Tú",
    cambiarRol: "Cambiar rol",
    guardar: "Guardar",
    cancelar: "Cancelar",
    guardado: "Rol guardado.",
    quitar: "Quitar",
    quitarPregunta: (quien: string) => `¿Quitar a ${quien} del espacio?`,
    quitarConsecuencia: "Deja de entrar en cuanto confirmes. Para volver necesita una invitación nueva.",
    quitarConfirmar: "Sí, quitar",
    /** Se anuncia (aria-live) cuando la fila desaparece: el foco vuelve al título de la lista. */
    quitado: (quien: string) => `Se quitó a ${quien} del espacio.`,
    /**
     * Bajo el botón deshabilitado de quien es el único Dueño. Corta y
     * neutra: nadie provocó un error. El error de verdad
     * (errores.last_owner) es para cuando la acción falla.
     */
    unicoDueno: "Único Dueño: nombra antes a otra persona como Dueño.",
  },

  pendientes: {
    titulo: "Invitaciones pendientes",
    vacio: "No hay invitaciones esperando respuesta.",
    vence: (fecha: string) => `Vence el ${fecha}`,
    vencida: "Vencida",
    invitadaPor: (quien: string) => `Invitó ${quien}`,
    renovar: "Nuevo enlace",
    revocar: "Revocar",
    revocarPregunta: (correo: string) => `¿Revocar la invitación de ${correo}?`,
    revocarConsecuencia: "El enlace deja de servir en cuanto confirmes.",
    revocarConfirmar: "Sí, revocar",
    /** Se anuncia (aria-live) cuando la fila desaparece: el foco vuelve al título de la lista. */
    revocada: (correo: string) => `Se revocó la invitación de ${correo}.`,
    cancelar: "Cancelar",
  },

  soloVer: "Puedes ver quién está en el espacio. Invitar y cambiar roles es de quien administra el equipo.",

  errores: {
    forbidden: "No tienes permiso para hacer esto en el equipo.",
    cannot_grant: "No puedes dar un rol o una casilla que tú no tienes, ni cambiar a alguien que tiene más permisos que tú.",
    role_not_found: "Ese rol no existe en este espacio.",
    extras_not_allowed: "Esas casillas solo van con el rol de Mánager.",
    already_member: "Esa persona ya está en el espacio.",
    not_found: "Esa persona o esa invitación ya no está.",
    last_owner: "No se puede quitar ni degradar al último dueño del espacio. Nombra antes a otra persona como Dueño.",
    pending_exists: "Alguien acaba de invitar a ese correo; recarga la lista.",
    rate_limited: `Este espacio ya creó ${INVITACIONES_POR_DIA} invitaciones en las últimas 24 horas. Vuelve a intentarlo mañana.`,
    scoped:
      "Tu acceso está limitado a algunos creadores o campañas: invitar, cambiar roles o quitar a alguien lo hace quien ve todo el espacio.",
    scoped_member:
      "Esta persona tiene el acceso limitado a algunos creadores, marcas o campañas, y Dueño y Administrador ven todo el espacio: quítale antes ese límite para darle uno de esos roles.",
    correo: "Escribe un correo válido.",
    rol: "Elige un rol.",
    sinOrigen: "No pudimos armar el enlace. Inténtalo de nuevo o escríbenos.",
  } satisfies Record<TeamErrorCode | "correo" | "rol" | "sinOrigen", string>,

  aceptar: {
    meta: "Invitación",
    eyebrow: "Invitación",
    titulo: (espacio: string) => `Te invitan a ${espacio}`,
    rol: (rol: string) => `Entrarías como ${rol}.`,
    invitadoPor: (quien: string) => `Te invita ${quien}.`,
    vence: (fecha: string) => `El enlace vence el ${fecha}.`,
    casillasTitulo: "Además de tu rol:",
    /** Las casillas, contadas al invitado (CASILLAS_PARA_INVITADO). */
    casillas: CASILLAS_PARA_INVITADO,
    boton: "Aceptar y entrar",
    otroCorreo: (correo: string) =>
      `Esta invitación es para ${correo}. Entra con ese correo para aceptarla: el enlace no sirve para otra cuenta.`,
    sinSesion: {
      titulo: "Entra para aceptar la invitación",
      texto: "La invitación es para un correo: entra con él y vuelve a abrir el enlace.",
      entrar: "Entrar",
    },
    estados: {
      not_found: {
        titulo: "Este enlace no es válido",
        texto: "Puede que esté incompleto. Pídele a quien te invitó que te mande uno nuevo.",
      },
      /**
       * Revocada a mano, reemplazada por «Nuevo enlace» (la anterior se
       * revoca) o muerta porque quien invitó ya no puede dar ese rol
       * (0080 §3). El texto sirve para los tres: no culpa a nadie ni
       * hace pedir algo que puede estar ya en la bandeja.
       */
      revoked: {
        titulo: "Este enlace ya no sirve",
        texto: "Puede que te hayan mandado uno más nuevo (busca el último correo) o que la invitación se haya cancelado.",
      },
      used: { titulo: "Este enlace ya se usó", texto: "Cada invitación sirve una sola vez. Si ya eres parte del espacio, entra desde el selector de espacios." },
      expired: { titulo: "Esta invitación venció", texto: textoVencida(INVITACION_VIGENCIA_DIAS) },
      wrong_email: {
        titulo: "Esta invitación es para otro correo",
        texto: "Entra con el correo al que te invitaron y vuelve a abrir el enlace.",
      },
      already_member: {
        titulo: "Ya eres parte de este espacio",
        texto: "No hace falta aceptar nada: cámbiate a él desde el selector de espacios.",
      },
    },
    /**
     * Modo demo (sin llaves de Auth, como corre hoy la demo pública): no
     * hay cuentas, así que el enlace se ve pero no se acepta. Va en lugar
     * del botón de aceptar y de «Entrar con otra cuenta», que en la demo
     * no llevan a ningún sitio.
     */
    demo: {
      titulo: "En la demo no se puede aceptar",
      texto: "En la demo no hay cuentas: el enlace muestra lo que verá la persona invitada; aceptarlo pide iniciar sesión con su correo.",
    },
    irAlInicio: "Ir al inicio",
    salir: "Entrar con otra cuenta",
    /**
     * /invitacion, sin token: quien entró sin espacio porque lo esperan
     * en uno (lib/auth/sincronizar.ts) y abrió otra página antes de
     * aceptar. La aplicación no tiene nada que enseñarle todavía.
     */
    esperando: {
      meta: "Te esperan en un espacio",
      titulo: "Te esperan en un espacio",
      texto:
        "Tienes una invitación pendiente. Abre el enlace que te mandaron para entrar. Si prefieres empezar con tu propio espacio, puedes crearlo ahora y aceptar la invitación después.",
      crearPropio: "Crear mi propio espacio",
    },
  },

  correo: {
    asunto: (espacio: string) => `Te invitan a ${espacio} en On Cue`,
    cuerpo: (d: { espacio: string; rol: string; quien: string | null; enlace: string; vence: string; casillas: readonly Casilla[] }) =>
      [
        d.quien ? `${d.quien} te invita a ${d.espacio} en On Cue como ${d.rol}.` : `Te invitan a ${d.espacio} en On Cue como ${d.rol}.`,
        ...(d.casillas.length > 0
          ? ["", "Además de tu rol podrás:", ...d.casillas.map((c) => `· ${CASILLAS_PARA_INVITADO[c](d.espacio)}`)]
          : []),
        "",
        `Acepta la invitación aquí (entra con este mismo correo): ${d.enlace}`,
        "",
        `El enlace vence el ${d.vence} y sirve una sola vez.`,
        "Si no esperabas esta invitación, ignora este correo.",
      ].join("\n"),
  },
} as const;
