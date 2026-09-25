import { ACTIVITY_BODY_MAX, NEXT_ACTION_MAX } from "@mc/core";
import type { ActivityKind, FichaErrorCode, LoggableActivityKind } from "@mc/db/queries/ventas-ficha";

/** Las dos formas de un conteo; cuál toca la elige Intl.PluralRules del idioma del espacio. */
type Formas = { one: string; other: string };

/**
 * Elige la forma de un conteo con las reglas del idioma (no con `n === 1`,
 * que solo sirve en español e inglés) y pone el número ya formateado con
 * el locale del espacio («1.000», no «1000»).
 */
function contar(n: number, texto: string, plural: Intl.PluralRules, formas: Formas): string {
  return (plural.select(n) === "one" ? formas.one : formas.other).replace("{n}", texto);
}

/** Lo que un conteo necesita del espacio: el número formateado y las reglas de plural. */
export interface Conteo {
  int: (n: number) => string;
  plural: Intl.PluralRules;
}

/**
 * Los textos de la ficha de empresa (VEN-5) y de la siguiente acción
 * (VEN-4): la línea de tiempo, el registro rápido, «lo que sabemos», la
 * cadena negocio → cotización → campaña → factura, el editor de la
 * siguiente acción y el bloque «Para hoy» de /ventas.
 *
 * Lo que ya existía de la ficha (datos, contactos, relación, «Nuevo
 * negocio») sigue en ../_lib/messages.ts, con la misma voz: le hablamos a
 * una creadora que vende su trabajo. Traducir Ventas es traducir los dos.
 */
export const FICHA = {
  cabecera: {
    niche: "Nicho",
    industry: "Sector",
    owner: "Responsable",
    noOwner: "Sin responsable",
    /** El resumen de la cabecera, para quien no ve la tira de datos. */
    label: "Resumen de la empresa",
  },
  /** El editor del pitch (VEN-6 dentro de VEN-12), que se abre desde la ficha. */
  pitch: {
    abrir: "Redactar pitch",
    abrirLabel: (company: string) => `Redactar un pitch para ${company}`,
  },

  bloques: {
    deals: "Negocios",
    /** Lo que suma la cifra de al lado de «Negocios»: «COP 12,0 M abiertos». */
    dealsOpenAmount: (amount: string) => `${amount} abiertos`,
    activity: "Actividad",
    known: "Lo que sabemos",
    relation: "Relación y responsable",
  },

  /** La siguiente acción de un negocio, en una línea y editable (VEN-4). */
  siguiente: {
    none: "Sin siguiente acción",
    set: "Poner siguiente acción",
    setLabel: (deal: string) => `Poner la siguiente acción de «${deal}»`,
    edit: "Cambiar",
    editLabel: (deal: string) => `Cambiar la siguiente acción de «${deal}»`,
    done: "Hecha",
    doneLabel: (action: string) => `Marcar «${action}» como hecha`,
    /** La nota que queda en la historia al marcarla hecha. */
    doneActivity: (action: string) => `Hecho: ${action}`,
    doneNotice: "Hecha. ¿Qué sigue?",
    formLabel: (deal: string) => `Siguiente acción de «${deal}»`,
    action: "Qué toca hacer",
    actionPlaceholder: "Llamar a Sofía para cerrar fechas",
    dueDate: "Cuándo",
    dueTime: "Hora",
    /**
     * La hora se guarda en la zona del ESPACIO, no en la de quien escribe:
     * se nombra («En hora estándar de Colombia.»), porque una colaboradora
     * en Madrid dentro de un espacio de Bogotá agendaría con 7 horas de
     * diferencia si leyera «tu zona».
     */
    dueTimeHelp: (zona: string) => `En ${zona}.`,
    responsible: "Quién",
    noResponsible: "Sin responsable",
    save: "Guardar",
    saved: "Siguiente acción guardada.",
    /** Al guardar, con el día y la hora en la zona del espacio: «Guardada para el 24 sep · 3:00 p. m.» (sin punto final: la hora ya acaba en «m.»). */
    savedFor: (when: string) => `Guardada para el ${when}`,
    error: "No se pudo guardar la siguiente acción.",
    doneError: "No se pudo marcar como hecha.",
    shortcut: "Enter guarda · Esc cancela",
    /**
     * El responsable de hoy ya no está en el espacio y la base no deja
     * leer su nombre: se ofrece igual en «Quién», para que guardar la
     * fecha no lo borre sin avisar.
     */
    formerMember: "Alguien que ya no está en el espacio",
  },

  /**
   * «Hace cuántos días no le hablo» (VEN-5): la última llamada, correo o
   * reunión de un negocio abierto, en la ficha, el tablero y la lista.
   */
  ultimoContacto: {
    /** «Último contacto: hace 3 días». El relativo lo pone Intl, en el idioma del espacio. */
    text: (relativo: string) => `Último contacto: ${relativo}`,
    none: "Sin contacto todavía",
    /** La columna de la lista del pipeline. */
    column: "Último contacto",
  },

  /** El bloque de arriba de /ventas: lo vencido y lo de hoy (VEN-4). */
  paraHoy: {
    title: "Para hoy",
    meta: (vencidos: number, hoy: number, c: Conteo) => {
      const partes = [];
      if (vencidos > 0) partes.push(contar(vencidos, c.int(vencidos), c.plural, { one: "{n} vencido", other: "{n} vencidos" }));
      if (hoy > 0) partes.push(contar(hoy, c.int(hoy), c.plural, { one: "{n} vence hoy", other: "{n} vencen hoy" }));
      return partes.join(" · ");
    },
    more: (n: number, c: Conteo) => `y ${c.int(n)} más en el pipeline`,
    withoutAction: (n: number, c: Conteo) =>
      contar(n, c.int(n), c.plural, {
        one: "{n} negocio abierto no tiene siguiente acción con fecha.",
        other: "{n} negocios abiertos no tienen siguiente acción con fecha.",
      }),
    fixWithoutAction: "Ponérsela",
    listLabel: "Seguimientos vencidos y de hoy",
    /** Tras «Hecha» y Esc: la fila se va sin siguiente acción; se dice, no se calla. */
    leftWithout: "Sin siguiente acción por ahora: queda en la cuenta de abajo.",
  },

  /** El pipeline filtrado desde «Para hoy» (?seguimiento=…). */
  filtro: {
    /** Cuenta como «Para hoy»: sin acción, o con acción pero sin fecha (listPipeline, listDueToday). */
    sin_accion: "Solo los negocios abiertos sin siguiente acción o sin fecha",
    para_hoy: "Solo los seguimientos vencidos y de hoy",
    clear: "Ver todos",
    empty: {
      sin_accion: { title: "Todos tienen siguiente acción con fecha", description: "Cada negocio abierto sabe qué sigue y cuándo." },
      para_hoy: { title: "Nada vencido ni para hoy", description: "Los seguimientos están al día." },
    },
  },

  /** La línea de tiempo y el registro rápido (VEN-5). */
  actividad: {
    empty: {
      title: "Todavía no hay actividad",
      description: "Registra la primera llamada, el correo que enviaste o una nota de lo que sabes de la marca.",
    },
    composerLabel: "Registrar actividad",
    kindLabel: "Tipo de actividad",
    body: "Qué pasó",
    bodyPlaceholder: {
      note: "Lo que sabes de la marca y no quieres olvidar.",
      call: "Con quién hablaste y en qué quedaron.",
      email_sent: "Qué le escribiste.",
      meeting: "Quiénes estuvieron y qué se acordó.",
    } satisfies Record<LoggableActivityKind, string>,
    deal: "Negocio",
    dealAll: "Todos los abiertos",
    dealNone: "Ninguno",
    dealHelp: "Una llamada, un correo o una reunión cuentan como último contacto del negocio.",
    /** La etapa del negocio elegido, debajo del campo: «En conversación.» */
    dealStage: (stage: string) => `Etapa: ${stage}.`,
    contact: "Con quién",
    contactNone: "Nadie",
    occurredOn: "Cuándo",
    submit: "Registrar",
    shortcut: "⌘ o Ctrl + Enter registra",
    /**
     * Las teclas que eligen el tipo, como en Superhuman: la inicial de cada
     * palabra EN ESTE IDIOMA (Nota, Llamada, Correo, Reunión). Viven aquí,
     * junto a los nombres, para que al traducir cambien juntos: en inglés
     * serían N, C, E y M (Note, Call, Email, Meeting). Una letra por tipo y
     * sin repetir (lo comprueba registro.test.tsx).
     */
    teclas: { note: "n", call: "l", email_sent: "c", meeting: "r" } satisfies Record<LoggableActivityKind, string>,
    /** Los atajos de una letra solo valen con el foco en el bloque «Actividad» (WCAG 2.1.4). */
    keys: (atajos: string) => `Con el foco en Actividad: ${atajos}`,
    /**
     * Tras registrar una llamada, un correo o una reunión en un negocio
     * cuya siguiente acción está vencida o es de hoy: probablemente se
     * acaba de hacer justo eso. Se pregunta, no se marca solo.
     */
    pendiente: {
      question: (action: string) => `¿Era «${action}»?`,
      markDone: "Marcarla hecha",
      markDoneLabel: (action: string) => `Marcar «${action}» como hecha y poner la siguiente`,
      dismiss: "No",
      dismissLabel: (action: string) => `No era «${action}»: dejarla como está`,
      /** De qué negocio es, cuando la empresa tiene varios abiertos. */
      deal: (deal: string) => `En «${deal}».`,
      /** Tras «Marcarla hecha» y Esc en el editor: se dice dónde quedó, no se calla. */
      leftWithout: "Hecha. El negocio queda sin siguiente acción: ponla desde su línea en «Negocios».",
      /** Lo que agrupa la pregunta, para el lector de pantalla. */
      label: (action: string) => `Siguiente acción pendiente: «${action}»`,
    },
    logged: {
      note: "Nota guardada.",
      call: "Llamada registrada. Cuenta como último contacto.",
      email_sent: "Correo registrado. Cuenta como último contacto.",
      meeting: "Reunión registrada. Cuenta como último contacto.",
    } satisfies Record<LoggableActivityKind, string>,
    error: "No se pudo registrar la actividad.",
    more: "Ver más",
    moreError: "No se pudo traer la actividad anterior. Vuelve a intentarlo.",
    /** Quien firma lo que deja el producto (una señal, un cambio de etapa, un pago, un reporte). */
    system: "On Cue",
    /** Quien firma una nota, llamada, correo o reunión sin autor guardado: la escribió una persona. */
    unknownAuthor: "Alguien del equipo",
    with: (name: string) => `con ${name}`,
    minutes: (n: number) => `${n} min`,
    listLabel: "Historia de la empresa, la más reciente primero",
  },

  /** Cómo se llama cada tipo de actividad en la línea de tiempo. */
  tipos: {
    note: "Nota",
    email_sent: "Correo enviado",
    email_received: "Correo recibido",
    dm_sent: "Mensaje enviado",
    dm_received: "Mensaje recibido",
    call: "Llamada",
    meeting: "Reunión",
    proposal_sent: "Propuesta enviada",
    contract_sent: "Contrato enviado",
    signal_detected: "Señal detectada",
    stage_change: "Cambio de etapa",
    report_sent: "Reporte enviado",
    payment_received: "Pago recibido",
  } satisfies Record<ActivityKind, string>,

  /** Las cuatro que se registran a mano, en el orden del selector. */
  tiposManuales: {
    note: "Nota",
    call: "Llamada",
    email_sent: "Correo",
    meeting: "Reunión",
  } satisfies Record<LoggableActivityKind, string>,

  /** «Lo que sabemos»: los datos de la marca y sus señales. */
  sabemos: {
    facts: "Datos de la marca",
    size: "Tamaño",
    sizes: {
      micro: "Micro",
      pyme: "Pyme",
      mediana: "Mediana",
      grande: "Grande",
      enterprise: "Corporativa",
    } as Record<string, string>,
    ads: "Pauta",
    /** Dónde pauta, por el id que guarda el enriquecimiento (company.ads_platforms). */
    plataformas: {
      meta: "Meta",
      tiktok: "TikTok",
      youtube: "YouTube",
      google: "Google",
      instagram: "Instagram",
      facebook: "Facebook",
    } as Record<string, string>,
    adsYes: (platforms: string) => (platforms ? `Anuncia en ${platforms}` : "Anuncia"),
    adsNo: "No se le ve pauta",
    fit: "Encaje",
    signals: "Señales",
    noSignals: "El radar todavía no ha visto nada de esta marca.",
    noFacts: "Sin datos de enriquecimiento todavía.",
    evidence: "Ver la evidencia",
    budget: (amount: string) => `Presupuesto estimado ${amount}`,
    discarded: (reason: string) => `Descartada: ${reason}`,
    reviewInRadar: "Revisarla en el radar",
  },

  /** La cadena negocio → cotización → campaña → factura. */
  cadena: {
    label: (deal: string) => `Lo que salió de «${deal}»`,
    quote: "Cotización",
    campaign: "Campaña",
    invoice: "Factura",
    noQuote: "Sin cotización todavía",
    /** Un negocio ganado o perdido sin cotización: ya no va a llegar. */
    noQuoteClosed: "Sin cotización",
    loose: "Sin negocio",
    /** Facturas de la cadena que no se alcanzaron a leer (más de 2.000 de una marca). */
    moreInvoices: (n: number, c: Conteo) =>
      contar(n, c.int(n), c.plural, { one: "y {n} factura más en Finanzas", other: "y {n} facturas más en Finanzas" }),
    looseHelp: "Cotizaciones, campañas o facturas de esta marca que no cuelgan de ningún negocio.",
  },

  /** Los errores de @mc/db/queries/ventas-ficha, por su código (FichaError.code). */
  /**
   * Los mensajes de la cadencia: adonde llevan los avisos del
   * motor. Un mensaje retenido dice por qué y se aprueba aquí, con su
   * texto a la vista y editable. El motivo lo traduce holdReasonText de
   * @mc/core/outreach/messages (los textos del motor viven ahí).
   */
  cadencia: {
    title: "Mensajes de la cadencia",
    caption: "Los mensajes de tus secuencias para esta empresa: primero los que esperan tu aprobación",
    meta: (pendientes: string) => `${pendientes} por aprobar`,
    columnas: { persona: "Persona", estado: "Estado" },
    paso: (secuencia: string, n: string) => `${secuencia} · paso ${n}`,
    pasoSuelto: "Mensaje suelto",
    sinNombre: "Sin nombre",
    estados: {
      held: "Espera tu aprobación",
      draft: "Borrador",
      scheduled: "Programado",
      processing: "Enviándose",
      sent: "Enviado",
      failed: "No salió",
      skipped: "Saltado",
      canceled: "Cancelado",
    } as Record<string, string>,
    canales: { email: "Correo", linkedin: "LinkedIn", instagram_dm: "Instagram", whatsapp: "WhatsApp" } as Record<string, string>,
    /** El canal dentro de una frase («el mensaje por correo»). */
    canalesEnFrase: { email: "correo", linkedin: "LinkedIn", instagram_dm: "Instagram", whatsapp: "WhatsApp" } as Record<string, string>,
    /** La línea de debajo del nombre: por dónde y cuándo («Correo · sale el 25 sep, 10:12»). */
    linea: (canal: string, cuando: string) => (cuando ? `${canal} · ${cuando}` : canal),
    sale: (fecha: string) => `sale el ${fecha}`,
    salio: (fecha: string) => `salió el ${fecha}`,
    porQue: (motivo: string) => `Retenido: ${motivo}.`,
    respondio: (fecha: string) => `Respondió ${fecha}:`,
    vacio: {
      title: "Sin mensajes de cadencia",
      description: "Cuando enroles a alguien de esta empresa en una secuencia, sus mensajes aparecen aquí.",
    },
    revisar: "Revisar y aprobar",
    revisarLabel: (persona: string) => `Revisar y aprobar el mensaje a ${persona}`,
    asunto: "Asunto",
    /** Una respuesta en el hilo no lleva asunto propio: sale como «Re: …» del correo anterior. */
    enHilo: (asunto: string) => `Responde en el hilo de: «${asunto}»`,
    enHiloSinAsunto: "Responde en el hilo del correo anterior.",
    texto: "Mensaje",
    textoHelp: "Lo que sale, tal cual. Sale a su hora, o en la próxima pasada si ya pasó.",
    aprobar: "Aprobar y enviar",
    cerrar: "Cerrar",
    aprobado: "Aprobado. Sale en la próxima pasada del envío, dentro de tu horario.",
    error: "No se pudo aprobar. Inténtalo de nuevo.",
    errores: {
      not_found: "Ese mensaje ya no existe.",
      not_held: "Ese mensaje ya no espera aprobación: alguien lo movió.",
      empty: "Escribe el mensaje.",
      empty_subject: "Escribe el asunto del correo.",
      placeholders: (huecos: string) => `Quedan huecos sin rellenar: ${huecos}.`,
      note_too_long: (n: string) => `La nota de la invitación tiene ${n} caracteres; LinkedIn permite 300.`,
      unsourced_figure: (cifras: string) =>
        cifras.includes(",")
          ? `Las cifras ${cifras} no salen de tu perfil: cámbialas por cifras tuyas o quítalas.`
          : `La cifra ${cifras} no sale de tu perfil: cámbiala por una de tus cifras o quítala.`,
      opted_out: "Esa persona pidió no ser contactada: el mensaje no puede salir.",
      no_postal_address: "Falta tu dirección postal: guárdala en la política de envío y vuelve a aprobarlo.",
    },
    /** El enlace del aviso de no_postal_address. */
    irAPolitica: "Ir a la política de envío",
    /**
     * Un mensaje retenido porque el proveedor no confirmó si salió
     * (unconfirmed_attempt): la persona lo busca con lo que se le enseña y
     * dice qué pasó. «Sí, salió» lo registra como enviado y la cadencia
     * sigue; «No salió» lo vuelve a poner en la cola, con confirmación.
     */
    intento: {
      /** «No sabemos si el correo «Una idea» que enviamos el 24 de septiembre desde laura@… llegó…». */
      pregunta: ({ canal, asunto, dia, cuenta }: { canal: string; asunto: string | null; dia: string | null; cuenta: string | null }) =>
        `No sabemos si ${asunto ? `el correo «${asunto}»` : `el mensaje por ${canal}`} que enviamos` +
        `${dia ? ` el ${dia}` : ""}${cuenta ? ` desde ${cuenta}` : ""} llegó: el proveedor no lo confirmó. ` +
        "Búscalo en tu carpeta de enviados (o en el chat) y dinos qué pasó.",
      salio: "Sí, salió",
      salioLabel: (persona: string) => `Sí, el mensaje a ${persona} salió`,
      noSalio: "No salió: enviarlo",
      confirmarReenvio: "¿Enviarlo otra vez?",
      consecuenciaReenvio: (persona: string) => `Si en realidad sí salió, a ${persona} le llegará dos veces.`,
      siReenviar: "Sí, enviarlo",
      cancelar: "Cancelar",
      registrado: "Anotado como enviado. La cadencia sigue con el paso siguiente.",
      reenviado: "Vuelve a la cola: sale en la próxima pasada, dentro de tu horario.",
      error: "No se pudo guardar. Inténtalo de nuevo.",
      errores: {
        not_found: "Ese mensaje ya no existe.",
        not_unconfirmed: "Ese mensaje ya no espera esta respuesta: se resolvió por otro lado.",
        opted_out: "Esa persona pidió no ser contactada: el mensaje no puede salir ni anotarse como enviado.",
      },
    },
  },

  errores: {
    DealClosed: "Ese negocio ya se cerró: no tiene siguiente acción.",
    InvalidNextAction: `Escribe qué toca hacer, en hasta ${NEXT_ACTION_MAX} caracteres.`,
    InvalidDueDate: "Elige un día y una hora válidos.",
    PastDueDate: "Ese día ya pasó. Elige hoy o uno que venga.",
    PastDueTime: "Esa hora ya pasó. Elige una más tarde o mañana.",
    InvalidResponsible: "Elige a alguien de tu espacio.",
    NoNextAction: "Ese negocio no tiene una siguiente acción que marcar.",
    /** La acción que se quiso marcar hecha ya no es la del negocio: se cerró o cambió por otro camino. */
    ActionChanged: (current: string | null) =>
      current
        ? `Esa acción ya cambió: ahora es «${current}». No se marcó nada; revísala en su línea.`
        : "Esa acción ya se cerró o se quitó por otro lado. No se marcó nada.",
    InvalidActivityKind: "Elige nota, llamada, correo o reunión.",
    InvalidActivityBody: `Escribe qué pasó (hasta ${ACTIVITY_BODY_MAX} caracteres).`,
    InvalidActivityDate: "Elige hoy o un día anterior.",
    DealNotInCompany: "Ese negocio no es de esta empresa.",
    ContactNotInCompany: "Ese contacto no es de esta empresa.",
    ContactOptedOut: "Esa persona pidió no ser contactada: no se le registran llamadas, correos ni reuniones. Una nota sí.",
  } satisfies Record<FichaErrorCode, string | ((current: string | null) => string)>,
} as const;
