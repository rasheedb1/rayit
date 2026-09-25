/**
 * Textos de /ventas/cadencias (VEN-13): la lista, la propuesta desde una
 * señal, la línea de tiempo, la activación y el enrolamiento. Un solo
 * sitio para traducirlos.
 *
 * Lo que el recomendador decide llega en CÓDIGOS (ProposalNote de
 * @mc/core, CadenciaError de @mc/db): aquí se convierten en frases. La
 * guía de cada paso es contenido (outbound_step.guidance_es) y no pasa
 * por aquí.
 */
import type { RerouteReason, RecommendSignalKind } from "@mc/core";

type Plural = (n: string, count: number) => string;
const plural = (uno: string, varios: string): Plural => (n, count) => (count === 1 ? `${n} ${uno}` : `${n} ${varios}`);

export const MESSAGES = {
  metaTitle: "Cadencias",
  header: {
    eyebrow: "Ventas",
    title: "Cadencias",
    description:
      "Los pasos con los que le escribes a una marca: qué día, por qué canal, con qué ángulo y qué decir en cada uno. Pide una propuesta desde una señal del radar, ajústala y actívala.",
  },
  loading: { label: "Cargando las cadencias" },
  error: { eyebrow: "Ventas · Cadencias", title: "No pudimos cargar las cadencias" },

  senales: {
    titulo: "Proponer desde una señal",
    descripcion: "Las señales que aceptaste y cuyo negocio sigue abierto. La propuesta sale de la señal, tus canales y la persona a la que le vas a escribir.",
    proponer: "Proponer cadencia",
    proponiendo: "Proponiendo…",
    verCadencia: "Ver su cadencia",
    negocio: (nombre: string) => `Negocio: ${nombre}`,
    vacio: {
      titulo: "Ninguna señal con negocio abierto",
      descripcion: "Acepta una señal del radar y crea su negocio: desde ahí se propone la cadencia.",
      accion: "Ir al radar",
    },
  },

  plantillas: {
    titulo: "Empezar desde una plantilla",
    descripcion: "Sin señal: copia una de las plantillas tal cual y ajústala.",
    label: "Plantilla",
    placeholder: "Elige una plantilla",
    crear: "Crear borrador",
  },

  lista: {
    titulo: "Tus cadencias",
    caption: "Cadencias del espacio",
    columnas: { cadencia: "Cadencia", estado: "Estado", pasos: "Pasos", enrolados: "Dentro", respuesta: "Respuesta" },
    respuestaDe: (pct: string, contactados: string) => `${pct} de ${contactados}`,
    sinContactar: "Sin envíos",
    desde: (senal: string) => `Desde: ${senal}`,
    vacio: {
      titulo: "Todavía no tienes cadencias",
      descripcion: "Pide una propuesta desde una señal de arriba o empieza desde una plantilla.",
    },
    verArchivadas: "Ver también las archivadas",
    ocultarArchivadas: "Ocultar las archivadas",
  },

  estados: { draft: "Borrador", active: "Activa", paused: "En pausa", archived: "Archivada" } as Record<string, string>,

  canales: { email: "Correo", linkedin: "LinkedIn", instagram_dm: "Instagram", whatsapp: "WhatsApp" } as Record<string, string>,

  /** El nombre corto de cada tipo de paso, para la tarjeta y el resumen «Día 0: …». */
  tipos: {
    email: "Correo",
    email_reply: "Respuesta en el hilo",
    linkedin_connect: "Invitación en LinkedIn",
    linkedin_message: "Mensaje en LinkedIn",
    linkedin_comment: "Comentario en LinkedIn",
    linkedin_like: "Reacción en LinkedIn",
    instagram_dm: "Mensaje en Instagram",
    instagram_comment: "Comentario en Instagram",
    instagram_like: "Reacción en Instagram",
    whatsapp_message: "Mensaje de WhatsApp",
    manual_task: "Tarea a mano",
  } as Record<string, string>,

  senalTipos: {
    active_campaign: "Campaña activa",
    launch: "Lanzamiento",
    season: "Temporada",
    collab: "Colaboración de un competidor",
    manual: "Añadida a mano",
  } satisfies Record<RecommendSignalKind, string>,

  detalle: {
    volver: "Todas las cadencias",
    metaTitle: (nombre: string) => `${nombre} · Cadencias`,
    desdeSenal: (tipo: string, titular: string, empresa: string | null) =>
      empresa ? `${tipo} · ${empresa}: ${titular}` : `${tipo}: ${titular}`,
    plantilla: (nombre: string) => `Plantilla: ${nombre}`,
    dentro: (n: string, count: number) => (count === 1 ? `${n} persona dentro` : `${n} personas dentro`),
    renombrar: "Cambiar el nombre",
    nombreLabel: "Nombre de la cadencia",
    guardar: "Guardar",
    cancelar: "Cancelar",
    flujo: "Resumen",
    flujoPaso: (dia: string, tipo: string) => `Día ${dia}: ${tipo}`,
    bloqueada:
      "Ya hay personas en esta cadencia: sus mensajes ya tienen día y canal. Puedes cambiar la guía, el ángulo, el texto y la hora (vale para quien entre después); para cambiar días, canales u orden, duplícala.",
    archivada: "Esta cadencia está archivada. Duplícala para volver a usarla.",
  },

  estado: {
    activar: "Activar",
    activarPara: (persona: string) => `Activar y escribir a ${persona}`,
    activando: "Activando…",
    pausar: "Pausar",
    reanudar: "Reanudar",
    duplicar: "Duplicar",
    archivar: "Archivar",
    archivarPregunta: "¿Archivar esta cadencia?",
    archivarConsecuencia: "Lo que no ha salido se cancela y ya no se puede activar. La puedes duplicar.",
    archivarConfirmar: "Sí, archivar",
    copia: (nombre: string) => `${nombre} (copia)`,
    activada: "Cadencia activa. Enrola a las personas desde un negocio, abajo.",
    activadaCon: (persona: string, partes: string) =>
      `Cadencia activa y ${persona} dentro: ${partes}. Los ves y apruebas en la ficha de la empresa.`,
    partes: {
      scheduled: plural("mensaje programado", "mensajes programados"),
      held: plural("esperando tu revisión", "esperando tu revisión"),
      drafts: plural("por redactar", "por redactar"),
      skipped: plural("sin dirección para ese canal", "sin dirección para ese canal"),
    },
    activadaSinPersona: (persona: string, motivo: string) => `Cadencia activa, pero ${persona} no entró: ${motivo}.`,
    sinPasos: "Añade al menos un paso para activarla.",
  },

  paso: {
    titulo: (n: string) => `Paso ${n}`,
    dia: (n: string) => `Día ${n}`,
    hora: (hora: string) => `a las ${hora}`,
    angulo: "Ángulo",
    sinAngulo: "Sin ángulo",
    guia: "Guía",
    sinGuia: "Sin guía: el generador solo sigue el ángulo.",
    generacion: "Generación automática",
    textoFijo: "Texto fijo",
    sinTexto: "Lo hace una persona: no lleva texto.",
    activo: { media_kit: "Adjunta el media kit", quote: "Enlaza la cotización" } as Record<string, string>,
    editar: "Editar",
    quitar: "Quitar",
    quitarPregunta: "¿Quitar este paso?",
    quitarConsecuencia: "Se borra de la cadencia con su guía.",
    quitarConfirmar: "Sí, quitar",
    subir: (n: string) => `Subir el paso ${n}`,
    bajar: (n: string) => `Bajar el paso ${n}`,
    arrastrar: (n: string) => `Arrastra para mover el paso ${n}`,
    fueraDePolitica: "Con tu política no sale: pasa del máximo de mensajes a una marca.",
    seCorre: (dias: string) => `Sale más tarde: tu política pide ${dias} días entre mensajes.`,
    campos: {
      dia: "Día",
      diaAyuda: "Días hábiles desde que la persona entra.",
      hora: "Hora",
      tipo: "Canal y tipo",
      angulo: "Ángulo",
      guia: "Guía",
      guiaAyuda: "Qué abrir, qué no mencionar y cómo cerrar. La sigue el generador y la vigila quien revisa.",
      modo: "Texto",
      asunto: "Asunto",
      cuerpo: "Texto del mensaje",
      cuerpoAyuda: "Puedes usar {{first_name}}, {{company}} y {{sender_name}}.",
      activo: "Adjunto",
      ninguno: "Ninguno",
    },
    modos: { ai: "Lo redacta On Cue con la guía", fijo: "Texto fijo" },
    anadir: "Añadir paso",
    moviendo: "Guardando el orden…",
    movido: (n: string, pos: string) => `Paso ${n} movido a la posición ${pos}.`,
  },

  proponer: {
    titulo: "Proponer desde esta señal",
    descripcion: "Vuelve a pedir la propuesta, por ejemplo para otra persona de la marca. Reemplaza los pasos de este borrador.",
    persona: "Para",
    sinPersona: "Sin persona todavía",
    boton: "Proponer otra vez",
    sinCanales: (canales: string) => `Llega por: ${canales}`,
    sinDireccion: "Sin dirección",
    deBaja: "Pidió no recibir mensajes",
  },

  notas: {
    titulo: "Por qué esta propuesta",
    plantilla: {
      niche_and_signal: (nombre: string) => `Plantilla «${nombre}», la de tu nicho para esta señal.`,
      signal: (nombre: string) => `Plantilla «${nombre}», la de esta señal.`,
      generic: (nombre: string) => `Plantilla «${nombre}».`,
    },
    rerouted: (paso: string, de: string, a: string, motivo: string) => `Paso ${paso}: de ${de} a ${a}, ${motivo}.`,
    reroutedManual: (paso: string, de: string, motivo: string) => `Paso ${paso}: queda como tarea a mano en ${de}, ${motivo}.`,
    motivos: {
      channel_not_allowed: "porque tu política de envío no lo permite",
      channel_not_connected: "porque no tienes esa cuenta conectada",
      contact_has_no_address: "porque la persona no tiene dirección ahí",
    } satisfies Record<RerouteReason, string>,
    unreachable: (paso: string, canal: string) => `Paso ${paso}: la persona no tiene ${canal} ni otro canal conectado; ese mensaje se saltará.`,
    channelDown: (canal: string) => `Tu cuenta de ${canal} pide reconectar: hazlo antes del primer mensaje por ahí.`,
    reconectar: "Ir a Canales",
    noContact: "Sin persona elegida: se planeó como si tuviera todas las direcciones.",
    disclosure: "Tu brief pide divulgación: el cierre lo menciona.",
    guiaModelo: "La guía de cada paso la redactó On Cue con IA a partir de las reglas.",
    guiaReglas: {
      no_key: "La guía sale de las reglas: la redacción con IA no está configurada en este espacio.",
      budget: "La guía sale de las reglas: se agotó el presupuesto de redacción de hoy.",
      failed: "La guía sale de las reglas: la redacción con IA no respondió.",
      rejected: "La guía sale de las reglas: lo que propuso la IA no pasó la revisión.",
    } as Record<string, string>,
    politica: {
      titulo: "Con tu política de envío",
      overCap: (n: string, max: string) =>
        `${n} de estos mensajes no saldrán: tu política permite ${max} mensajes por marca.`,
      gap: (dias: string) => `Algunos pasos saldrán más tarde de lo que dicen: tu política pide ${dias} días entre mensajes.`,
      ir: "Revisar la política",
    },
  },

  enrolar: {
    titulo: "Enrolar desde un negocio",
    descripcion: "Elige el negocio y las personas. Cada una recibe la cadencia desde hoy, en días hábiles y en la zona de tu espacio.",
    negocio: "Negocio",
    negocioPlaceholder: "Elige un negocio",
    personas: "Personas",
    sinPersonas: "Este negocio no tiene personas con dirección.",
    boton: "Enrolar",
    enrolando: "Enrolando…",
    soloActiva: "Activa la cadencia para enrolar.",
    sinNegocios: "No hay negocios abiertos.",
    resultado: (n: string, count: number) => (count === 1 ? `${n} persona enrolada.` : `${n} personas enroladas.`),
    saltadas: {
      not_found: "no está en este espacio",
      opted_out: "pidió no recibir mensajes",
      already_enrolled: "ya estaba dentro",
      email_invalid: "su correo rebotó",
      no_address: "no tiene dirección en ningún canal de la cadencia",
      invalid_address: "su dirección está mal escrita",
    } as Record<string, string>,
    saltada: (persona: string, motivo: string) => `${persona}: ${motivo}.`,
    elige: "Elige al menos una persona.",
  },

  errores: {
    not_found: "Esa cadencia ya no existe o no es de este espacio.",
    has_enrollments: "Ya hay personas en esta cadencia: duplícala para cambiar días, canales u orden.",
    archived: "La cadencia está archivada: duplícala para cambiarla.",
    no_steps: "Añade al menos un paso para activarla.",
    too_many_steps: "Una cadencia lleva hasta 12 pasos.",
    day_full: "Ese día ya tiene 4 pasos: elige otro.",
    invalid: "Revisa los datos del paso.",
    no_template: "No hay ninguna plantilla para esta señal todavía.",
    no_signal: "Esa señal ya no existe o no es de este espacio.",
    sequence_not_active: "Activa la cadencia para enrolar.",
    generico: "No pudimos guardar el cambio. Inténtalo otra vez.",
  } as Record<string, string>,
} as const;
