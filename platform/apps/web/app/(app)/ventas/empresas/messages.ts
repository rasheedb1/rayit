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
    dueTimeHelp: "En tu zona horaria.",
    responsible: "Quién",
    noResponsible: "Sin responsable",
    save: "Guardar",
    saved: "Siguiente acción guardada.",
    /** Al guardar, con el día y la hora en la zona del espacio: «Guardada para el 24 sep · 3:00 p. m.» (sin punto final: la hora ya acaba en «m.»). */
    savedFor: (when: string) => `Guardada para el ${when}`,
    error: "No se pudo guardar la siguiente acción.",
    doneError: "No se pudo marcar como hecha.",
    shortcut: "Enter guarda · Esc cancela",
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
    sin_accion: "Solo los negocios abiertos sin siguiente acción",
    para_hoy: "Solo los seguimientos vencidos y de hoy",
    clear: "Ver todos",
    empty: {
      sin_accion: { title: "Todos tienen siguiente acción", description: "Cada negocio abierto sabe qué sigue y cuándo." },
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
    contact: "Con quién",
    contactNone: "Nadie",
    occurredOn: "Cuándo",
    submit: "Registrar",
    shortcut: "⌘ o Ctrl + Enter registra",
    /** Los atajos de una letra solo valen con el foco en el bloque «Actividad» (WCAG 2.1.4). */
    keys: "Con el foco en Actividad: N nota · L llamada · C correo · R reunión",
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
    looseHelp: "Cotizaciones, campañas o facturas de esta marca que no cuelgan de ningún negocio.",
  },

  /** Los errores de @mc/db/queries/ventas-ficha, por su código (FichaError.code). */
  errores: {
    DealClosed: "Ese negocio ya se cerró: no tiene siguiente acción.",
    InvalidNextAction: "Escribe qué toca hacer, en hasta 200 caracteres.",
    InvalidDueDate: "Elige un día y una hora válidos.",
    PastDueDate: "Ese día ya pasó. Elige hoy o uno que venga.",
    PastDueTime: "Esa hora ya pasó. Elige una más tarde o mañana.",
    InvalidResponsible: "Elige a alguien de tu espacio.",
    NoNextAction: "Ese negocio no tiene una siguiente acción que marcar.",
    InvalidActivityKind: "Elige nota, llamada, correo o reunión.",
    InvalidActivityBody: "Escribe qué pasó (hasta 4000 caracteres).",
    InvalidActivityDate: "Elige hoy o un día anterior.",
    DealNotInCompany: "Ese negocio no es de esta empresa.",
    ContactNotInCompany: "Ese contacto no es de esta empresa.",
    ContactOptedOut: "Esa persona pidió no ser contactada: no se le registran llamadas, correos ni reuniones. Una nota sí.",
  } satisfies Record<FichaErrorCode, string>,
} as const;
