/**
 * Todos los textos de interfaz del módulo Ventas, en un solo archivo.
 *
 * No es purismo: el producto se vende fuera de Colombia y traducirlo no
 * puede ser buscar comillas por el árbol. La regla del repositorio es
 * un `messages.ts` por módulo, y aquí vive el de Ventas entero —el de
 * la ficha de empresa incluido, para que la voz sea la misma.
 *
 * Voz: le hablamos a una creadora que vende su trabajo, no a un equipo
 * de ventas. «Marca» y no «cuenta», «negocio» y no «oportunidad»,
 * «siguiente acción» y no «tarea».
 */
export const MESSAGES = {
  header: {
    eyebrow: "Ventas",
    title: "A quién le vendes, en qué va cada conversación y qué sigue",
    description:
      "El radar te trae marcas que encajan con lo que haces; el tablero dice en qué etapa está cada negocio y qué toca hacer hoy. Los montos y el cierre ponderado salen de la vista deal_pipeline: ninguna pantalla los suma.",
    plan: "Plan de construcción",
  },

  tabs: {
    label: "Vistas de Ventas",
    radar: "Radar",
    pipeline: "Pipeline",
    empresas: "Empresas",
  },

  kpis: {
    pending: "Señales por revisar",
    pendingNoteZero: "Bandeja al día",
    open: "Negocios abiertos",
    weighted: "Cierre ponderado",
    weightedNote: "Monto × probabilidad de la etapa",
    won: "Ganado este trimestre",
    wonNoteZero: "Todavía nada cerrado",
    noNextAction: (n: number) => `${n} sin siguiente acción`,
    overdue: (n: number) => `${n} con seguimiento vencido`,
  },

  radar: {
    title: "Señales por revisar",
    meta: (n: number) => `${n} ${n === 1 ? "señal" : "señales"}`,
    empty: {
      title: "No hay señales por revisar",
      description:
        "El radar todavía no tiene nada nuevo que proponerte. Puedes anotar una marca que viste tú o cargar una lista para revisarlas de una vez.",
      action: "Anotar una marca",
    },
    manualOnly:
      "Por ahora el radar es manual: lo que anotas tú y lo que cargas por CSV. Las fuentes automáticas (pauta en Meta, Top Ads de TikTok, marketplaces) llegan en la siguiente fase.",
    accept: "Aceptar",
    accepted: (name: string) => `Abriste un negocio con ${name}. La siguiente acción es «Enviar pitch».`,
    discard: "Descartar",
    discardTitle: "¿Por qué la descartas?",
    discardHelp:
      "Queda anotado y esa señal no vuelve a entrar. El motivo es lo que afina el radar para la próxima.",
    discardReason: "Motivo",
    discarded: "Señal descartada. No volverá a la bandeja.",
    fit: "Encaje",
    budget: "Presupuesto estimado",
    evidence: "Ver la evidencia",
    source: "Fuente",
    detected: "Detectada",
    newSignal: "Anotar una marca",
    importCsv: "Cargar una lista",
  },

  empresas: {
    title: "Empresas",
    meta: (n: number) => `${n} ${n === 1 ? "empresa" : "empresas"}`,
    search: "Buscar por nombre o dominio",
    searchHelp: "Desde el tercer carácter",
    new: "Nueva empresa",
    empty: {
      title: "Todavía no tienes empresas",
      description:
        "Aquí van las marcas con las que hablas: las que acepta el radar y las que anotas tú. La primera se crea en veinte segundos.",
      action: "Crear la primera empresa",
    },
    emptySearch: {
      title: "Ninguna empresa coincide",
      description: "Prueba con menos letras, o con el dominio.",
      action: "Ver todas",
    },
    columns: {
      name: "Empresa",
      relationship: "Relación",
      contacts: "Contactos",
      deals: "Negocios",
      lastActivity: "Última actividad",
    },
    noContacts: "Sin contactos",
    noDeals: "Sin negocios abiertos",
    neverContacted: "Sin actividad",
    optedOut: (n: number) => `${n} con baja`,
  },

  contacto: {
    title: "Contactos",
    new: "Añadir contacto",
    source: "¿De dónde lo sacaste?",
    sourceHelp:
      "Es obligatorio. Sin procedencia no se guarda: es lo que nos deja escribirle sin romper la ley ni tu reputación.",
    optedOut: "Pidió la baja",
    optedOutHelp: "No se le escribe por ningún canal. No se puede deshacer.",
    optOut: "Registrar baja",
    optOutTitle: "Registrar la baja de este contacto",
    optOutHelp:
      "Deja de recibir cualquier mensaje tuyo, por cualquier canal, para siempre. Esto no se puede deshacer.",
    notOwn: "Lo guardó otro espacio de trabajo. Puedes verlo porque su fuente es pública, pero no editarlo.",
    empty: {
      title: "Sin contactos todavía",
      description: "Añade a quien decide, con la fuente de donde salió su dato.",
      action: "Añadir el primero",
    },
  },

  pipeline: {
    title: "Pipeline",
    board: "Tablero",
    list: "Lista",
    viewLabel: "Forma de ver el pipeline",
    empty: {
      title: "Todavía no hay negocios",
      description:
        "Un negocio nace cuando aceptas una señal del radar o cuando lo abres tú desde una empresa.",
      action: "Ir al radar",
    },
    stageEmpty: "Nada aquí",
    columns: {
      deal: "Negocio",
      stage: "Etapa",
      amount: "Monto",
      nextAction: "Siguiente acción",
      daysInStage: "En la etapa",
    },
    noNextAction: "Sin siguiente acción",
    noNextActionHelp: "Un negocio sin siguiente acción se enfría. Ponle una.",
    noAmount: "Sin monto",
    moved: (name: string, stage: string) => `${name} pasó a «${stage}».`,
    days: (n: number) => `${n} ${n === 1 ? "día" : "días"}`,
    dragHint: "Arrastra una tarjeta a otra columna, o usa el menú de la tarjeta.",
    moveTo: "Mover a",
  },

  due: {
    vencido: "Vencido",
    hoy: "Hoy",
    futuro: "Al día",
    sin_fecha: "Sin fecha",
  },

  error: {
    eyebrow: "Ventas",
    title: "No pudimos leer tu pipeline",
    description:
      "La base de datos no respondió a tiempo o rechazó la conexión. Tus datos no cambiaron; vuelve a intentarlo y, si sigue igual, avísanos.",
    retry: "Reintentar",
    /** Solo se muestra cuando Next entrega un identificador del error (producción). */
    reference: "Referencia",
  },

  loading: {
    label: "Cargando Ventas",
    kpis: ["Señales por revisar", "Negocios abiertos", "Cierre ponderado", "Ganado este trimestre"],
    section: "Pipeline",
  },

  acciones: {
    cancel: "Cancelar",
    save: "Guardar",
    saving: "Guardando…",
    close: "Cerrar",
  },
} as const;
