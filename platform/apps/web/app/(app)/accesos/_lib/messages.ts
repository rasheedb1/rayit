import type { Casilla } from "@mc/core";
import type { TeamErrorCode } from "@mc/db/queries/equipo";

/**
 * Todos los textos de Equipo (ACC-4) y del enlace de invitación, en un
 * solo sitio: la pantalla, las Server Actions, el correo y la página de
 * aceptar. Las etiquetas y descripciones de los roles NO están aquí:
 * vienen de la base (role.label_es, role.description_es), que es donde
 * vivirán también los roles a medida (ACC-9).
 */
export const MESSAGES = {
  meta: "Equipo",
  eyebrow: "Accesos",
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
    descripcion: "Le llega un enlace que vale una semana y solo sirve para ese correo.",
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
    sinCorreo: "Este servidor no tiene correo configurado: copia el enlace y mándaselo tú.",
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
    tu: "Tú",
    desde: (fecha: string) => `Desde el ${fecha}`,
    cambiarRol: "Cambiar rol",
    guardar: "Guardar",
    cancelar: "Cancelar",
    guardado: "Rol guardado.",
    quitar: "Quitar",
    quitarPregunta: (quien: string) => `¿Quitar a ${quien} del espacio?`,
    quitarConsecuencia: "Deja de entrar en cuanto confirmes. Para volver necesita una invitación nueva.",
    quitarConfirmar: "Sí, quitar",
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
    correo: "Escribe un correo válido.",
    rol: "Elige un rol.",
    sinOrigen: "No se puede armar el enlace: falta APP_URL en este servidor.",
  } satisfies Record<TeamErrorCode | "correo" | "rol" | "sinOrigen", string>,

  aceptar: {
    meta: "Invitación",
    eyebrow: "Invitación",
    titulo: (espacio: string) => `Te invitan a ${espacio}`,
    rol: (rol: string) => `Entrarías como ${rol}.`,
    invitadoPor: (quien: string) => `Te invita ${quien}.`,
    vence: (fecha: string) => `El enlace vence el ${fecha}.`,
    casillasTitulo: "Además de tu rol:",
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
      revoked: { titulo: "Esta invitación se revocó", texto: "Quien te invitó la canceló. Si fue un error, pídele una nueva." },
      used: { titulo: "Este enlace ya se usó", texto: "Cada invitación sirve una sola vez. Si ya eres parte del espacio, entra desde el selector de espacios." },
      expired: { titulo: "Esta invitación venció", texto: "Los enlaces valen una semana. Pídele a quien te invitó que te mande uno nuevo." },
      wrong_email: {
        titulo: "Esta invitación es para otro correo",
        texto: "Entra con el correo al que te invitaron y vuelve a abrir el enlace.",
      },
      already_member: {
        titulo: "Ya eres parte de este espacio",
        texto: "No hace falta aceptar nada: cámbiate a él desde el selector de espacios.",
      },
    },
    irAlInicio: "Ir al inicio",
    verCuenta: "Ver con qué cuenta entré",
  },

  correo: {
    asunto: (espacio: string) => `Te invitan a ${espacio} en On Cue`,
    cuerpo: (d: { espacio: string; rol: string; quien: string | null; enlace: string; vence: string }) =>
      [
        d.quien ? `${d.quien} te invita a ${d.espacio} en On Cue como ${d.rol}.` : `Te invitan a ${d.espacio} en On Cue como ${d.rol}.`,
        "",
        `Acepta la invitación aquí (entra con este mismo correo): ${d.enlace}`,
        "",
        `El enlace vence el ${d.vence} y sirve una sola vez.`,
        "Si no esperabas esta invitación, ignora este correo.",
      ].join("\n"),
  },
} as const;
