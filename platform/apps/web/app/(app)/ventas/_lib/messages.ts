import type { VentasErrorCode } from "@mc/db/queries/ventas";

/**
 * Todos los textos de interfaz del módulo Ventas, en un solo archivo.
 *
 * No es purismo: el producto se vende fuera de Colombia y traducirlo no
 * puede ser buscar comillas por el árbol. La regla del repositorio es
 * un `messages.ts` por módulo, y aquí vive el de Ventas entero —el de
 * la ficha de empresa incluido, para que la voz sea la misma—: las
 * validaciones de los formularios, los errores del CSV, las etiquetas
 * de relación y procedencia, y los errores de dominio que @mc/db
 * devuelve como código (VentasError.code → MESSAGES.errores). Traducir
 * Ventas es traducir este archivo; @mc/db no tiene frases.
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
      "El radar te trae marcas que encajan con lo que haces; el tablero dice en qué etapa está cada negocio y qué toca hacer hoy.",
    plan: "Plan de construcción",
    /** El título de la pestaña del navegador. */
    metaTitle: "Ventas",
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
    /** Los contadores llegan ya formateados con el locale del workspace. */
    openCount: (n: string) => `${n} abiertos`,
    wonCount: (n: string) => `${n} cerrados`,
    noNextAction: (n: number) => `${n} sin siguiente acción`,
    overdue: (n: number) => `${n} con seguimiento vencido`,
    /** El nombre accesible del botón (i) de cada cifra. */
    infoLabel: (kpi: string) => `De dónde sale «${kpi}»`,
    weightedInfo: [
      "Suma de cada negocio abierto por su probabilidad de cierre.",
      "La probabilidad es la de la etapa en la que está: un negocio en «Propuesta enviada» pesa más que uno «Nuevo».",
    ],
    wonInfo: [
      "Los negocios que pasaron a «Ganado» desde el inicio del trimestre, en tu zona horaria.",
      "Montos sin impuestos: cuando una cotización se envía o se acepta, el negocio toma su valor antes de IVA. La campaña y la factura llevan el total con impuestos.",
    ],
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
    /** Aceptar la señal de una marca que ya tiene un negocio abierto: se suma a ese. */
    alreadyOpen: (name: string) => `Ya tienes un negocio con ${name}: la señal quedó anotada en él.`,
    seeDeal: "Ver el negocio",
    /** La siguiente acción con la que nace un negocio (del radar o a mano). */
    pitchAction: "Enviar pitch",
    /**
     * El título de un negocio aceptado cuya señal solo dice la marca (una
     * fila de CSV sin nota). Si la señal trae titular, el negocio se llama
     * así: «Abre 3 tiendas en Bogotá».
     */
    pendingDealName: "Por definir",
    /**
     * La que la reemplaza cuando se envía una cotización del negocio: el
     * pitch ya se superó con una propuesta. La escribe Cotizar al enviar
     * (cotizar/_lib/textos.ts), con este texto.
     */
    quoteFollowUpAction: "Seguimiento a la cotización",
    /** El cuerpo de la actividad que deja una señal aceptada. */
    acceptedActivity: "Señal aceptada desde el radar.",
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
      duplicate: "Esa misma señal ya estaba en el radar, así que no se repite.",
      duplicatePending: "Esa marca ya está en tu bandeja: revísala ahí.",
      duplicateDiscarded: "Esa marca la descartaste antes, así que no vuelve a entrar.",
      /** La misma señal ya se aceptó: la marca es un negocio. Una señal con otro titular sí entra. */
      duplicateAccepted: "Esa señal ya la aceptaste y la marca es un negocio tuyo. Si viste algo nuevo, anótalo con otro titular.",
      seeCompany: "Ver la ficha",
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
      /** El titular de una marca que entra por lista sin nota. */
      headline: (name: string) => `${name} entró por una lista de marcas`,
      /** Los errores por línea que devuelve el lector (_lib/csv.ts). */
      parse: {
        empty: "El archivo está vacío.",
        tooManyRows: (max: number) =>
          `La lista pasa de ${max} marcas. Se cargaron las primeras ${max}; parte el archivo para el resto.`,
        missingName: "Falta el nombre de la marca.",
        nameTooLong: (max: number) => `El nombre de la marca pasa de ${max} caracteres.`,
        onlyHeader: "El archivo solo tiene la cabecera.",
      },
    },
  },

  empresas: {
    title: "Empresas",
    metaTitle: "Empresas · Ventas",
    searchPlaceholder: "Café Alma, cafealma.co",
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
      metaTitle: "Nueva empresa · Ventas",
      domainPlaceholder: "cafealma.co",
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
      metaTitle: "Empresa · Ventas",
      breadcrumb: "Ruta",
      empty: "—",
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
      /** «Nuevo negocio» en la ficha: abrir uno a mano, sin pasar por el radar. */
      newDeal: {
        open: "Nuevo negocio",
        title: "Nuevo negocio",
        help: "Nace en «Nuevo» con «Enviar pitch» a tres días. El monto es sin impuestos; si todavía no lo sabes, déjalo vacío: lo pondrá la cotización.",
        name: "Nombre del negocio",
        namePlaceholder: "Serie de 3 videos · Q4",
        amount: "Monto estimado",
        submit: "Abrir negocio",
        created: (name: string) => `Abriste «${name}». Está en «Nuevo», en el pipeline.`,
        error: "No se pudo abrir el negocio.",
      },
      quote: "Cotizar",
      quoteLabel: (name: string) => `Cotizar «${name}»`,
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
    instagramPlaceholder: "@usuario",
    linkedinPlaceholder: "https://linkedin.com/in/…",
    urlPlaceholder: "https://",
    /** Un contacto sin nombre, correo ni usuario (no debería pasar: la base lo exige). */
    noName: "—",
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
    meta: (n: number) => `${n} ${n === 1 ? "negocio" : "negocios"}`,
    /** El atajo a Cotizar desde la tarjeta y la fila de un negocio abierto. */
    quote: "Cotizar",
    quoteLabel: (name: string) => `Cotizar el negocio con ${name}`,
  },

  /** Relación del workspace con una empresa (company_link.relationship). */
  relaciones: {
    prospect: "Prospecto",
    contacted: "Contactada",
    client: "Cliente",
    past_client: "Cliente anterior",
    blocked: "Bloqueada",
  },

  /**
   * De dónde salió el dato de un contacto, con la ayuda que dice cuándo
   * usar cada una. La ayuda no es decorativa: elegir bien la procedencia
   * es lo que separa un contacto que se puede usar de uno que no.
   */
  procedencias: {
    public_website: { label: "Web de la empresa", help: "Estaba publicado en su sitio (equipo, contacto, prensa)." },
    public_profile: { label: "Perfil público", help: "Su LinkedIn, su Instagram o su perfil profesional abierto." },
    user_provided: { label: "Me lo dieron", help: "Te lo pasó alguien, o lo diste tú en una reunión." },
    inbound: { label: "Te escribió", help: "Llegó por un mensaje, un formulario o un comentario." },
    enrichment_vendor: { label: "Proveedor de datos", help: "Vino de una herramienta de enriquecimiento con licencia." },
    press: { label: "Prensa", help: "Salió en una nota, un comunicado o una entrevista." },
  },

  /** El estado de una señal del radar. */
  estadosSenal: {
    pending: "Por revisar",
    accepted: "Aceptada",
    discarded: "Descartada",
    expired: "Vencida",
    duplicate: "Repetida",
  },

  /** Lo que dicen los formularios cuando un campo no vale (zod, en actions.ts). */
  validacion: {
    tooLong: (label: string, max: number) => `${label} no puede pasar de ${max} caracteres.`,
    country: "El país va en dos letras: CO, MX, PE.",
    campos: {
      brand: "La marca",
      domain: "El dominio",
      sector: "El sector",
      note: "La nota",
      city: "La ciudad",
      notes: "Las notas",
      name: "El nombre",
      role: "El cargo",
      phone: "El teléfono",
    },
    headlineRequired: "Di en una línea qué viste.",
    headlineTooLong: "Una línea: hasta 280 caracteres.",
    evidenceUrl: "El enlace tiene que empezar por http:// o https://.",
    fit: "El encaje es un número de 0 a 100.",
    budget: "El presupuesto no es un monto válido.",
    brandRequired: "Di de qué marca es: su nombre o su web.",
    reasonRequired: "Di por qué la descartas: es lo que afina el radar.",
    reasonTooLong: "El motivo cabe en 280 caracteres.",
    relationship: "Elige una relación de la lista.",
    companyName: "La empresa necesita un nombre.",
    companyNameTooLong: "El nombre cabe en 200 caracteres.",
    company: "La empresa no es válida.",
    source: "Di de dónde sacaste el dato: sin eso no se guarda.",
    email: "El correo no es válido.",
    linkedin: "El LinkedIn tiene que ser un enlace que empiece por https://.",
    instagram: "El usuario de Instagram no es válido.",
    sourceUrl: "El enlace a la fuente tiene que empezar por http:// o https://.",
    contactAtLeastOne: "Escribe al menos el nombre, el correo o el Instagram.",
    dealName: "El negocio necesita un nombre de hasta 120 caracteres.",
    amount: "El monto no es válido: solo números, con hasta dos decimales.",
  },

  /**
   * Los errores de dominio de @mc/db/queries/ventas, por su código
   * (VentasError.code). Los que necesitan un dato lo reciben en
   * `params` (el nombre de la empresa que ya tiene el dominio, el motivo
   * de un bloqueo).
   */
  errores: {
    CompanyNotFound: "Esa empresa no existe en tu espacio.",
    CompanyNotEditable:
      "Esta empresa es del catálogo compartido: sus datos no se editan desde tu espacio. Puedes cambiar la relación y las notas.",
    CompanyCreateFailed: "No se pudo crear la empresa.",
    ContactNotFound: "Ese contacto no existe o no lo guardaste tú.",
    ContactNotOwned: "Solo puedes editar los contactos que guardaste tú.",
    ContactCreateFailed: "No se pudo guardar el contacto.",
    DealNotFound: "Ese negocio no existe en tu espacio.",
    DealCreateFailed: "No se pudo abrir el negocio.",
    DealLocked: (p: Readonly<Record<string, string>>) =>
      p.reason === "quote"
        ? "Este negocio tiene una cotización aceptada: no sale de «Ganado». Termina su campaña desde la cotización y, si el acuerdo se cayó, cancélala en Campañas antes de reabrirlo."
        : "Este negocio tiene una campaña en curso: no sale de «Ganado» mientras la campaña siga viva. Cancélala en Campañas si el acuerdo se cayó.",
    DuplicateDomain: (p: Readonly<Record<string, string>>) =>
      `Ese dominio ya es de «${p.name ?? ""}». Búscala en vez de crearla otra vez.`,
    DuplicateEmail: "Ya hay un contacto con ese correo.",
    EmptyContact: "Un contacto necesita al menos nombre, correo o usuario de Instagram.",
    InvalidAmount: "El monto no es válido: solo números, con hasta dos decimales.",
    InvalidCompany: "Di de qué marca es la señal: su nombre o su dominio.",
    InvalidDealName: "El negocio necesita un nombre de hasta 120 caracteres.",
    InvalidHeadline: "La señal necesita una línea que diga qué viste.",
    InvalidName: "La empresa necesita un nombre.",
    InvalidOwner: "El responsable no es válido.",
    InvalidReason: "Di por qué la descartas: es lo que afina el radar.",
    InvalidRelationship: "Esa relación no existe.",
    InvalidSource: "Un contacto no se guarda sin decir de dónde salió.",
    InvalidStage: "Esa etapa no existe.",
    SignalAlreadyReviewed: "Esa señal ya la revisaste. Recarga la bandeja para ver cómo quedó.",
    SignalNotFound: "Esa señal ya no está en tu bandeja.",
    SignalWithoutCompany: "La señal no dice de qué marca es. Edítala antes de aceptarla.",
  } satisfies Record<VentasErrorCode, string | ((p: Readonly<Record<string, string>>) => string)>,

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
    empresas: "Cargando Empresas",
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
