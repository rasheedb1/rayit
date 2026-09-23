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
    toolbar: "Añadir al radar",
    unknownBrand: "Marca sin identificar",
    fromCsv: "De una lista",
    acceptError: "No se pudo aceptar la señal.",
    discardError: "No se pudo descartar la señal.",
    discardPlaceholder: "Ya trabaja con otra creadora, no encaja con mi nicho…",
    discardConfirm: "Descartar señal",
    goToDeal: "Ver en el pipeline",

    form: {
      title: "Anotar una marca",
      help: "Lo que viste tú: una pauta, un lanzamiento, una marca que te escribió. Entra a la bandeja como cualquier señal.",
      company: "Marca",
      companyHelp: "Su nombre, como la conoces.",
      domain: "Web o dominio",
      domainHelp: "Si ya existe en el catálogo, se reutiliza en vez de duplicarse.",
      headline: "Qué viste",
      headlineHelp: "Una línea: «Lanzó cold brew y está pautando en Meta».",
      evidence: "Enlace a la evidencia",
      fit: "Encaje %",
      fitHelp: "De 0 a 100. Vacío si todavía no lo sabes.",
      budget: "Presupuesto estimado",
      country: "País",
      countryHelp: "Dos letras: CO, MX, PE.",
      industry: "Sector",
      note: "Nota",
      submit: "Anotar",
      created: "Anotada. Ya está en la bandeja.",
      duplicate: "Esa marca ya había entrado al radar antes (aunque se haya descartado), así que no se repite.",
      error: "No se pudo anotar la señal.",
    },

    csv: {
      title: "Cargar una lista",
      help: "Un CSV con una marca por fila. Columnas: marca, dominio, país, sector y nota; solo la marca es obligatoria. Sirve el archivo tal como lo exporta Excel.",
      file: "Archivo CSV",
      paste: "O pega las filas aquí",
      pastePlaceholder: "marca;dominio;país\nCafé Alma;cafealma.co;CO",
      submit: "Cargar",
      empty: "Elige un archivo o pega las filas.",
      tooBig: "El archivo pasa de 1 MB. Pártelo en varios.",
      notCsv: "Ese archivo no parece un CSV de texto.",
      result: (created: number, duplicated: number) => {
        const a = created === 1 ? "Entró 1 marca nueva" : `Entraron ${created} marcas nuevas`;
        const b =
          duplicated === 0
            ? ""
            : duplicated === 1
              ? "; 1 ya estaba en el radar y no se repitió"
              : `; ${duplicated} ya estaban en el radar y no se repitieron`;
        return `${a}${b}.`;
      },
      lineErrors: "Filas que no entraron",
      line: (n: number) => `Línea ${n}`,
      error: "No se pudo cargar la lista.",
    },
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
    shortSearch: (min: number) => `Escribe al menos ${min} letras para buscar.`,
    relationshipFilter: "Relación",
    allRelationships: "Todas",
    back: "Empresas",
    pendingSignals: (n: number) => `${n} ${n === 1 ? "señal" : "señales"} en el radar`,

    form: {
      title: "Nueva empresa",
      help: "Una marca con la que hablas o quieres hablar. Si su dominio ya está en el catálogo, se vincula esa en vez de crear otra.",
      name: "Nombre",
      domain: "Web o dominio",
      country: "País",
      countryHelp: "Dos letras: CO, MX, PE.",
      city: "Ciudad",
      industry: "Sector",
      relationship: "Relación",
      notes: "Notas",
      submit: "Crear empresa",
      error: "No se pudo crear la empresa.",
    },

    detail: {
      data: "Datos",
      domain: "Dominio",
      location: "Ubicación",
      industry: "Sector",
      owner: "Responsable",
      noOwner: "Sin responsable",
      openDeals: "Negocios abiertos",
      lastActivity: "Última actividad",
      notes: "Notas",
      noNotes: "Sin notas.",
      relationship: "Relación",
      saveRelationship: "Cambiar",
      relationshipSaved: "Relación actualizada.",
      error: "No se pudo actualizar la empresa.",
      notFound: {
        title: "Esa empresa no está en tu espacio",
        description: "Puede que el enlace sea de otro espacio de trabajo o que la empresa ya no esté vinculada.",
        action: "Volver a Empresas",
      },
    },
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
    notOwn: "Es del catálogo compartido: sale de una fuente pública y lo ven todos los espacios. Puedes consultarlo, pero no editarlo.",
    empty: {
      title: "Sin contactos todavía",
      description: "Añade a quien decide, con la fuente de donde salió su dato.",
      action: "Añadir el primero",
    },
    fullName: "Nombre",
    roleTitle: "Cargo",
    email: "Correo",
    phone: "Teléfono",
    linkedin: "LinkedIn",
    instagram: "Instagram",
    sourceUrl: "Enlace a la fuente",
    sourceUrlHelp: "Dónde viste el dato, si fue en la web o en un perfil.",
    atLeastOne: "Con nombre, correo o Instagram basta; lo demás es opcional.",
    submit: "Guardar contacto",
    saved: "Contacto guardado.",
    error: "No se pudo guardar el contacto.",
    optOutReason: "Motivo (opcional)",
    optOutConfirm: "Sí, registrar la baja",
    optOutDone: "Baja registrada. No se le volverá a escribir.",
    optOutError: "No se pudo registrar la baja.",
    bounced: "Correo rebotado",
    sourceLabel: "Fuente",
    seeSource: "ver",
    sourcePlaceholder: "Elige la procedencia",
    publicSource: "Fuente pública",
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
    moveToLabel: (name: string) => `Mover «${name}» a otra etapa`,
    moving: "Moviendo…",
    moveError: "No se pudo mover el negocio. Volvió a su etapa.",
    dropHere: (stage: string) => `Soltar en «${stage}»`,
    listCaption: "Negocios del pipeline, por etapa",
    weighted: "Ponderado",
  },

  due: {
    vencido: "Vencido",
    hoy: "Hoy",
    futuro: "Al día",
    sin_fecha: "Sin fecha",
  },

  /** El nombre y el título de la frontera de error; el resto es el de la aplicación (ver finanzas/_lib/messages.ts). */
  error: {
    eyebrow: "Ventas",
    title: "No pudimos leer tu pipeline",
  },

  /**
   * Las fronteras de las pantallas de Empresas. Sin ellas, /ventas/empresas
   * y la ficha caían en la de Ventas y decían «No pudimos leer tu
   * pipeline» cuando lo que no se leyó son las empresas o la ficha.
   */
  errorEmpresas: {
    eyebrow: "Ventas · Empresas",
    title: "No pudimos leer tus empresas",
  },
  errorFicha: {
    eyebrow: "Ventas · Empresas",
    title: "No pudimos leer la ficha de esta empresa",
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
