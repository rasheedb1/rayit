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

/**
 * El idioma de estos textos. Sus reglas de plural son las del idioma en
 * que están escritos (no las del número): al traducir el archivo, cambia
 * esto y cada frase trae las formas que su idioma pida (one, few, many…).
 */
export const IDIOMA_MENSAJES = "es";
const reglasPlural = new Intl.PluralRules(IDIOMA_MENSAJES);

type Formas = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
type Plural = (n: string, count: number) => string;
/**
 * Una frase con cifra. `n` llega ya formateado (Formatter del espacio) y
 * reemplaza «{n}»; la forma la elige Intl.PluralRules con `count`.
 */
export const plural =
  (formas: Formas): Plural =>
  (n, count) =>
    (formas[reglasPlural.select(count)] ?? formas.other).replaceAll("{n}", n);

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
    /** Hay más señales que las que caben arriba: el enlace a la lista entera. */
    verTodas: plural({ one: "Ver la señal ({n})", other: "Ver todas las señales ({n})" }),
    verMenos: "Ver solo las más recientes",
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
    resumen: (pasos: string, count: number, dias: string, senal: string | null) =>
      plural({
        one: `{n} paso en ${dias} días${senal ? ` · ${senal}` : ""}`,
        other: `{n} pasos en ${dias} días${senal ? ` · ${senal}` : ""}`,
      })(pasos, count),
  },

  lista: {
    titulo: "Tus cadencias",
    caption: "Cadencias del espacio",
    columnas: { cadencia: "Cadencia", estado: "Estado", pasos: "Pasos", enrolados: "Dentro", respuesta: "Respuesta" },
    /** Bajo la tasa de respuesta, en su propia línea: cuántas respondieron de cuántas a las que ya les salió algo. */
    contactadas: (respondidas: string, contactadas: string) => `${respondidas} de ${contactadas} contactadas`,
    sinContactar: "Sin envíos",
    desde: (senal: string) => `Desde: ${senal}`,
    /**
     * En un teléfono, las cifras de las columnas que no caben (pasos,
     * dentro, respuesta) van bajo el nombre: la creadora ve cómo va cada
     * cadencia sin desplazar la tabla.
     */
    pasosCorto: plural({ one: "{n} paso", other: "{n} pasos" }),
    dentroCorto: (n: string) => `${n} dentro`,
    respuestaCorto: (pct: string) => `${pct} respuesta`,
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
    dentro: plural({ one: "{n} persona dentro", other: "{n} personas dentro" }),
    renombrar: "Cambiar el nombre",
    nombreLabel: "Nombre de la cadencia",
    guardar: "Guardar",
    cancelar: "Cancelar",
    flujo: "Resumen",
    flujoPaso: (dia: string, tipo: string) => `Día ${dia}: ${tipo}`,
    pasos: "Pasos",
    bloqueada:
      "Ya hay personas en esta cadencia: sus mensajes ya tienen día y canal. Puedes cambiar la guía, el ángulo, el texto y la hora (vale para quien entre después); para cambiar días, canales u orden, duplícala.",
    archivada: "Esta cadencia está archivada. Duplícala para volver a usarla.",
  },

  estado: {
    activar: "Activar",
    activarPara: (persona: string) => `Activar y escribir a ${persona}`,
    /** Lo que dice la región viva mientras corre cada acción de la fila (el botón pulsado gira). */
    trabajando: { activar: "Activando…", pausar: "Pausando…", duplicar: "Duplicando…", archivar: "Archivando…" },
    pausar: "Pausar",
    reanudar: "Reanudar",
    reanudarPara: (persona: string) => `Reanudar y escribir a ${persona}`,
    duplicar: "Duplicar",
    archivar: "Archivar",
    archivarPregunta: "¿Archivar esta cadencia?",
    archivarConsecuencia: "Lo que no ha salido se cancela y ya no se puede activar. La puedes duplicar.",
    archivarConfirmar: "Sí, archivar",
    copia: (nombre: string) => `${nombre} (copia)`,
    activada: "Cadencia activa. Enrola a las personas desde un negocio, abajo.",
    activadaCon: (persona: string, partes: string) =>
      `Cadencia activa y ${persona} dentro: ${partes}. Los ves y apruebas en la ficha de la empresa.`,
    /**
     * Lo que le queda a una persona al entrar, por tipo: los mensajes (programados, por revisar, por
     * redactar, saltados) y los gestos públicos que hace ella a mano (una reacción o un comentario),
     * que no se redactan: la tarjeta los marca «Lo hace una persona».
     */
    partes: {
      scheduled: plural({ one: "{n} mensaje programado", other: "{n} mensajes programados" }),
      held: plural({ other: "{n} esperando tu revisión" }),
      drafts: plural({ other: "{n} por redactar" }),
      manual: plural({ one: "{n} gesto a mano", other: "{n} gestos a mano" }),
      skipped: plural({ one: "{n} paso saltado, sin dirección", other: "{n} pasos saltados, sin dirección" }),
    },
    activadaSinPersona: (persona: string, motivo: string) => `Cadencia activa, pero ${persona} no entró: ${motivo}.`,
    activadaYaEnOtra: (persona: string, cadencia: string) =>
      `Cadencia activa. ${persona} no entró: ya está en «${cadencia}», y dos cadencias a la vez a la misma persona duplican los mensajes.`,
    sinPasos: "Añade al menos un paso para activarla.",
    revisarEnFicha: "Revisar en la ficha",
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
    /** Una reacción o una tarea a mano: la persona la hace y no hay mensaje. */
    sinTexto: "Lo haces tú a mano: no lleva mensaje.",
    /** Un comentario público sí lleva texto, pero lo escribe la persona: On Cue no lo redacta ni lo envía. */
    comentarioAMano: "Lo escribes tú en su publicación: On Cue no lo redacta ni lo envía.",
    activo: { media_kit: "Adjunta el media kit", quote: "Enlaza la cotización" } as Record<string, string>,
    /** La guía la escribió la persona para otro tipo de paso y no se recompuso: que la revise. */
    guiaPorRevisar: (tipo: string) => `Esta guía se escribió para «${tipo}». Revísala y guarda el paso.`,
    editar: "Editar",
    quitar: "Quitar",
    quitarPregunta: "¿Quitar este paso?",
    quitarConsecuencia: "Se borra de la cadencia con su guía.",
    quitarConfirmar: "Sí, quitar",
    subir: (n: string) => `Subir el paso ${n}`,
    bajar: (n: string) => `Bajar el paso ${n}`,
    arrastrar: (n: string) => `Arrastra para mover el paso ${n}`,
    fueraDePolitica: "Con tu política no sale: pasa del máximo de mensajes a una marca.",
    espera: plural({ one: "Espera {n} día hábil", other: "Espera {n} días hábiles" }),
    mismoDia: "El mismo día",
    seCorre: plural({
      one: "Sale más tarde: tu política pide {n} día entre mensajes.",
      other: "Sale más tarde: tu política pide {n} días entre mensajes.",
    }),
    campos: {
      dia: "Día",
      diaAyuda: "Días hábiles desde que la persona entra.",
      hora: "Hora",
      tipo: "Canal y tipo",
      red: "Red",
      redAyuda: "Dónde la haces tú.",
      angulo: "Ángulo",
      guia: "Guía",
      guiaAyuda: "Qué abrir, qué no mencionar y cómo cerrar. La sigue el generador y la vigila quien revisa.",
      /** En un paso que hace una persona la guía no va al generador: es lo que hay que hacer. */
      guiaAyudaAMano: "Qué hacer en este paso.",
      modo: "Texto",
      asunto: "Asunto",
      cuerpo: "Texto del mensaje",
      cuerpoAyuda: "Puedes usar {{first_name}}, {{company}} y {{sender_name}}.",
      activo: "Adjunto",
      ninguno: "Ninguno",
    },
    modos: { ai: "Lo redacta On Cue con la guía", fijo: "Texto fijo" },
    anadir: "Añadir paso",
    anadidoComoGesto:
      "Tu política ya tiene su máximo de mensajes a una marca: el paso nuevo es una reacción en su publicación, que no cuenta. Para que sea un mensaje, quita otro antes.",
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
    sinDireccion: "Sin dirección en tus canales",
    deBaja: "Pidió no recibir mensajes",
    /** Detrás de su nombre en «Para»: ya está viva en otra cadencia, y Activar no la enrolará. */
    ocupada: (cadencia: string) => `ya está en «${cadencia}»`,
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
    contactBusy: (persona: string, cadencia: string) => `${persona} ya está en «${cadencia}»: Activar no la enrolará aquí.`,
    noCreator:
      "El negocio no tiene creador y tu espacio tiene varios: la propuesta no usa el nicho ni el brief de nadie. Asigna el creador en el negocio y propón otra vez.",
    irAlNegocio: "Ir a la ficha",
    politicaAjuste: {
      titulo: (max: string, dias: string) =>
        `Ajustada a tu política de envío (hasta ${max} mensajes por marca, ${dias} días entre ellos):`,
      suavizados: (angulos: string, count: number) =>
        plural({
          one: `${angulos} pasa a una reacción en su publicación, que no cuenta como mensaje`,
          other: `${angulos} pasan a reacciones en su publicación, que no cuentan como mensajes`,
        })("", count).trim(),
      quitados: (angulos: string, count: number) =>
        plural({ one: `${angulos} se quita`, other: `${angulos} se quitan` })("", count).trim(),
      corridos: plural({ one: "el cierre sale {n} día más tarde", other: "el cierre sale {n} días más tarde" }),
      soloSeparacion: "los días se separan para respetarla",
    },
    guiaModelo: "La guía de cada paso la redactó On Cue con IA a partir de las reglas.",
    guiaReglas: {
      no_key: "La guía sale de las reglas: la redacción con IA está apagada en On Cue.",
      budget: "La guía sale de las reglas: se agotó el presupuesto de redacción de hoy.",
      failed: "La guía sale de las reglas: la redacción con IA no respondió.",
      rejected: "La guía sale de las reglas: lo que propuso la IA no pasó la revisión.",
    } as Record<string, string>,
    politica: {
      titulo: "Con tu política de envío",
      overCap: (n: string, count: number, max: string) =>
        plural({
          one: `{n} de estos mensajes no saldrá: tu política permite ${max} mensajes por marca.`,
          other: `{n} de estos mensajes no saldrán: tu política permite ${max} mensajes por marca.`,
        })(n, count),
      gap: plural({
        one: "Algunos pasos saldrán más tarde de lo que dicen: tu política pide {n} día entre mensajes.",
        other: "Algunos pasos saldrán más tarde de lo que dicen: tu política pide {n} días entre mensajes.",
      }),
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
    /** La línea bajo la casilla de quien no tiene dirección en ningún canal con el que esta cadencia escribe. */
    noLlegaDetalle: "No llega por los canales de esta cadencia",
    /** Motivo de una saltada: el mismo, en minúscula tras su nombre. */
    noLlega: "no llega por los canales de esta cadencia",
    boton: "Enrolar",
    enrolando: "Enrolando…",
    soloActiva: "Activa la cadencia para enrolar.",
    sinNegocios: "No hay negocios abiertos.",
    resultado: plural({ one: "{n} persona enrolada.", other: "{n} personas enroladas." }),
    /** Lo que le queda a cada persona que entró, con las mismas partes que «Activar». */
    dentroCon: (persona: string, partes: string) => `${persona}: ${partes}.`,
    saltadas: {
      not_found: "no está en este espacio",
      opted_out: "pidió no recibir mensajes",
      already_enrolled: "ya estaba dentro",
      email_invalid: "su correo rebotó",
      no_address: "no tiene dirección en ningún canal de la cadencia",
      invalid_address: "su dirección está mal escrita",
      /** VEN-7: la marca es de una categoría o está en la lista que el brief no acepta. */
      brief_excluded: "tu brief no acepta su marca",
    } as Record<string, string>,
    saltadaGenerica: "no se pudo enrolar",
    /** Motivo de una saltada: ya está viva en otra cadencia del espacio. */
    enOtra: (cadencia: string) => `ya está en «${cadencia}»`,
    /** La línea bajo su casilla, que no se puede marcar. */
    enOtraDetalle: (cadencia: string) => `Ya está en «${cadencia}»`,
    nadieDisponible: "Nadie de este negocio puede entrar ahora.",
    negocioCerrado: "su negocio ya se cerró",
    sinNegocio: "esta señal no tiene un negocio abierto",
    saltada: (persona: string, motivo: string) => `${persona}: ${motivo}.`,
    elige: "Elige al menos una persona.",
    ajenas: "Alguna de esas personas no es de la marca de este negocio, o el negocio ya se cerró. Vuelve a elegir.",
    yaDentro: "Ya está dentro",
  },

  errores: {
    not_found: "Esa cadencia ya no existe o no es de este espacio.",
    has_enrollments: "Ya hay personas en esta cadencia: duplícala para cambiar días, canales u orden.",
    archived: "La cadencia está archivada: duplícala para cambiarla.",
    no_steps: "Añade al menos un paso para activarla.",
    invalid: "Revisa los datos del paso.",
    no_template: "No hay ninguna plantilla para esta señal todavía.",
    no_signal: "Esa señal ya no existe o no es de este espacio.",
    sequence_not_active: "Activa la cadencia para enrolar.",
    generico: "No pudimos guardar el cambio. Inténtalo otra vez.",
  } as Record<string, string>,

  /** Los errores que dicen un límite: reciben la cifra ya formateada (MAX_STEPS, MAX_STEPS_PER_DAY de @mc/db). */
  erroresConLimite: {
    too_many_steps: (max: string) => `Una cadencia lleva hasta ${max} pasos.`,
    day_full: (max: string) => `Ese día ya tiene ${max} pasos: elige otro.`,
  } as Record<string, (max: string) => string>,
} as const;
