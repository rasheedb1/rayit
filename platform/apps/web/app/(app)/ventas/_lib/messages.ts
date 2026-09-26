import type { VentasErrorCode } from "@mc/db/queries/ventas";

/**
 * Los topes del brief (BRIEF_LIMITS de @mc/db) ya formateados con el
 * locale del workspace («2.000» o «2,000»). Las frases que dicen un tope
 * lo reciben así, en vez de llevarlo escrito: si cambia el tope o el
 * idioma, el texto no miente. Los arma brief/limites.ts.
 */
export interface BriefLimitTexts {
  categories: string;
  countries: string;
  companies: string;
  titleMax: string;
  categoryMax: string;
  notesMax: string;
  deliverables: string;
}

/** Una frase de error del brief: recibe los topes formateados y el dato del error, si lo trae. */
export type BriefErrorPhrase = (limits: BriefLimitTexts, detail: string | null) => string;

/** Tipa las frases de briefErrores con la misma firma, sin perder sus nombres. */
function briefPhrases<K extends string>(phrases: Record<K, BriefErrorPhrase>): Record<K, BriefErrorPhrase> {
  return phrases;
}

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
    /** El título de la pestaña del navegador. */
    metaTitle: "Ventas",
    /** El enlace a /ventas/politica (VEN-15). */
    politica: "Política de envío",
    /**
     * Junto al enlace, si hoy hay avisos urgentes del outreach (una cuenta
     * caída, los rebotes disparados): «1 urgente», «2 urgentes». `n` ya
     * formateado; `cuantos` es la cifra cruda para el plural.
     */
    politicaUrgentes: (n: string, cuantos: number) =>
      new Intl.PluralRules("es").select(cuantos) === "one" ? `${n} urgente` : `${n} urgentes`,
  },

  tabs: {
    label: "Vistas de Ventas",
    radar: "Radar",
    pipeline: "Pipeline",
    empresas: "Empresas",
    canales: "Canales",
    cadencias: "Cadencias",
    perfil: "Perfil comercial",
    brief: "Brief",
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
    /**
     * «6 cerrados» y, si alguno no tiene monto, «6 cerrados, 1 sin monto»:
     * sin eso el conteo sube y la suma no, y las dos cifras no cuadran.
     */
    wonCount: (n: string, sinMonto?: string) => (sinMonto ? `${n} cerrados, ${sinMonto} sin monto` : `${n} cerrados`),
    noNextAction: (n: number) => `${n} sin siguiente acción`,
    overdue: (n: number) => `${n} con seguimiento vencido`,
    /** El nombre accesible del botón (i) de cada cifra. */
    infoLabel: (kpi: string) => `De dónde sale «${kpi}»`,
    weightedInfo: [
      "Suma de cada negocio abierto por su probabilidad de cierre.",
      "La probabilidad es la de la etapa en la que está: un negocio en «Propuesta enviada» pesa más que uno «Nuevo».",
    ],
    /** El trimestre se corta en la zona del espacio (getSalesKpis), no en la de quien mira: se nombra. */
    wonInfo: (zona: string) => [
      `Los negocios que pasaron a «Ganado» desde el inicio del trimestre, en ${zona}.`,
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
    /**
     * Las pendientes que el brief activo deja fuera (VEN-7). La bandeja
     * lo dice siempre que haya alguna: ocultar sin avisar es perder
     * señales sin saberlo.
     */
    hidden: {
      line: (n: string, count: number) =>
        count === 1 ? `${n} señal oculta por tu brief` : `${n} señales ocultas por tu brief`,
      show: "Verlas",
      hide: "Ocultarlas",
      showing: (n: string, count: number) =>
        count === 1
          ? "Estás viendo también la señal que tu brief no acepta."
          : `Estás viendo también las ${n} señales que tu brief no acepta.`,
      editBrief: "Editar el brief",
      /** El separador que abre el grupo de las ocultas, al final de la bandeja. */
      group: "Ocultas por tu brief",
      /**
       * En la tarjeta, cuando se están viendo las ocultas: la regla que la
       * deja fuera, como la escribió el creador, para saber cuál quitar.
       */
      reason: {
        company: (name: string) => `Tu brief no acepta a ${name}`,
        category: (category: string) => `Tu brief no acepta «${category}»`,
      },
    },
    /**
     * Cómo encaja la señal con «Qué buscas» del brief activo (VEN-7). No
     * oculta nada: la tarjeta lo marca para decidir con el dato a la vista.
     */
    briefFit: {
      belowMin: "Bajo tu mínimo",
      countryOutside: "Fuera de tus países",
      /** El brief busca categorías y la marca no tiene ninguna (VEN-7 r4). */
      categoryOutside: "Fuera de lo que buscas",
      /**
       * La categoría buscada que tiene la marca, fundida en la Pill del
       * encaje («82 % · alimentos»): sola, en cada tarjeta, no distinguía
       * nada (VEN-7 r4).
       */
      fitWithCategory: (fit: string, category: string) => `${fit} · ${category}`,
      /** Lo mismo, entero, para el title y el lector de pantalla. */
      fitWithCategoryLabel: (fit: string, category: string) => `Encaje ${fit}; es de «${category}», que buscas`,
    },
    /**
     * «No aceptar esta marca», desde su tarjeta (VEN-7 r4): la da de alta
     * en el CRM como bloqueada y la agrega a «Marcas que no aceptas» del
     * brief, en un paso. Solo lo ve quien puede cambiar el brief.
     */
    reject: {
      action: "No aceptar esta marca",
      actionFor: (name: string) => `No aceptar la marca ${name}`,
      title: (name: string) => `¿No aceptar ${name}?`,
      description:
        "Entra a tu CRM como bloqueada y a «Marcas que no aceptas» del brief. El radar deja de enseñar sus señales cuando la excluyen todos los briefs activos, y ninguna cadencia le escribe.",
      creators: "En el brief de",
      creatorsHelp: "Con varios creadores, elige en qué briefs activos. Lo que uno no acepta, otro puede aceptarlo.",
      confirm: "No aceptarla",
      noCreator: "Elige al menos un brief.",
      /** El resultado, arriba de la bandeja: la tarjeta se va con la revalidación. */
      doneHidden: (name: string) => `${name} ya no se ve en tu bandeja: está en «Marcas que no aceptas» de tu brief.`,
      doneVisible: (name: string) =>
        `${name} está en «Marcas que no aceptas» del brief elegido. Se sigue viendo porque otro brief activo la acepta.`,
      error: "No se pudo excluir la marca.",
    },
    importCsv: "Cargar una lista",
    toolbar: "Añadir al radar",
    unknownBrand: "Marca sin identificar",
    fromCsv: "De una lista",
    acceptError: "No se pudo aceptar la señal.",
    discardError: "No se pudo descartar la señal.",
    discardPlaceholder: "Ya trabaja con otra creadora, no encaja con mi nicho…",
    discardConfirm: "Descartar señal",
    goToDeal: "Ver en el pipeline",
    /**
     * La marca de la señal ya está en el CRM (pulido r8): la tarjeta lo
     * dice antes de aceptar, con enlace a su ficha.
     */
    inCrm: "Ya en tu CRM",
    inCrmLink: (name: string) => `Ya en tu CRM: ver la ficha de ${name}`,
    /** Aceptarla no abre otro negocio: la señal se suma al abierto (acceptSignal). */
    joinsDeal: (deal: string) => `Al aceptarla se sumará a «${deal}», el negocio abierto: no abre otro.`,
    /** Lo mismo cuando el negocio se llama como la marca (los viejos del radar). */
    joinsOpenDeal: "Al aceptarla se sumará al negocio abierto con esta marca: no abre otro.",

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
      /** La opción vacía del <Select> de país (la lista sale de _lib/paises.ts). */
      countryPlaceholder: "Sin país",
      industry: "Sector",
      note: "Nota",
      submit: "Anotar",
      created: "Anotada. Ya está en la bandeja.",
      /** Entró, pero el brief activo la deja fuera de la bandeja (VEN-7). */
      createdHidden: "Anotada, pero tu brief no la acepta: no la verás en la bandeja mientras siga así.",
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
        // Cargar la misma lista dos veces no es «entraron 0»: es que ya
        // estaban todas, y se dice así.
        if (created === 0) {
          if (duplicated === 0) return "No entró ninguna marca nueva.";
          return duplicated === 1
            ? "No entró ninguna marca nueva: esa ya estaba en el radar."
            : `No entró ninguna marca nueva: las ${duplicated} ya estaban en el radar.`;
        }
        const a = created === 1 ? "Entró 1 marca nueva" : `Entraron ${created} marcas nuevas`;
        const b =
          duplicated === 0
            ? ""
            : duplicated === 1
              ? "; 1 ya estaba en el radar y no se repitió"
              : `; ${duplicated} ya estaban en el radar y no se repitieron`;
        return `${a}${b}.`;
      },
      /**
       * De las que entraron, las que el brief activo deja fuera de la
       * bandeja (VEN-7). `n` llega formateado con el locale del workspace;
       * `count`, el número crudo, elige singular o plural.
       */
      hiddenByBrief: (n: string, count: number) =>
        count === 1 ? "Una no se ve en la bandeja: tu brief no la acepta." : `${n} no se ven en la bandeja: tu brief no las acepta.`,
      lineErrors: "Filas que no entraron",
      /** Filas que sí entraron, pero con algo que se descartó (un país que no se reconoce). */
      lineWarnings: "Entraron con un aviso",
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
        unknownCountry: (value: string) =>
          `País no reconocido: «${value}». La marca entró sin país; usa el nombre o el código de dos letras (CO).`,
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
    /** Lo que pinta una celda de cifra vacía; el texto de arriba va para el lector de pantalla. */
    emptyCell: "—",
    optedOut: (n: number) => `${n} con baja`,
    shortSearch: (min: number) => `Escribe al menos ${min} letras para buscar.`,
    relationshipFilter: "Relación",
    allRelationships: "Todas",
    back: "Empresas",
    pendingSignals: (n: number) => `${n} ${n === 1 ? "señal" : "señales"} en el radar`,
    /**
     * Las de la empresa que el brief activo deja fuera de la bandeja
     * (VEN-7); enlaza a «Verlas». `n` formateado, `count` para el plural.
     */
    hiddenSignals: (n: string, count: number) => `${n} ${count === 1 ? "señal oculta" : "señales ocultas"} por tu brief`,

    form: {
      metaTitle: "Nueva empresa · Ventas",
      domainPlaceholder: "cafealma.co",
      title: "Nueva empresa",
      help: "Una marca con la que hablas o quieres hablar. Si su dominio ya está en el catálogo, se vincula esa en vez de crear otra.",
      name: "Nombre",
      domain: "Web o dominio",
      country: "País",
      /** La opción vacía del <Select> de país (la lista sale de _lib/paises.ts). */
      countryPlaceholder: "Sin país",
      city: "Ciudad",
      industry: "Sector",
      relationship: "Relación",
      notes: "Notas",
      submit: "Crear empresa",
      error: "No se pudo crear la empresa.",
      /** Ya hay una empresa con ese nombre en el CRM: se pregunta antes de crear otra. */
      sameName: {
        title: (name: string) => `Ya tienes una empresa llamada «${name}».`,
        help: "Si es la misma marca, ábrela en vez de crear otra. Si es otra (otro país, otra razón social), créala igual.",
        see: (name: string) => `Ver «${name}»`,
        createAnyway: "Crear igual",
      },
      /** Editar desde la ficha, con el mismo formulario. */
      editTitle: "Editar los datos",
      save: "Guardar cambios",
      saved: "Datos actualizados.",
      editError: "No se pudo guardar la empresa.",
      /** Una empresa del catálogo compartido: sus datos no son de este espacio. */
      notOwn:
        "Esta empresa es del catálogo compartido: su nombre, su web y su sector los ven todos los espacios y no se editan desde aquí. Las notas sí son tuyas.",
    },

    detail: {
      /** Solo si la empresa no se pudo leer; la pestaña lleva su nombre (metaTitleOf). */
      metaTitle: "Empresa · Ventas",
      /** Con varias fichas abiertas, cada pestaña dice de quién es (pulido r8). */
      metaTitleOf: (name: string) => `${name} · Ventas`,
      breadcrumb: "Ruta",
      empty: "—",
      data: "Datos",
      domain: "Dominio",
      location: "Ubicación",
      industry: "Sector",
      owner: "Responsable",
      noOwner: "Sin responsable",
      edit: "Editar",
      editLabel: (name: string) => `Editar los datos de ${name}`,
      save: "Guardar",
      saved: "Guardado.",
      openDeals: "Negocios abiertos",
      lastActivity: "Última actividad",
      notes: "Notas",
      noNotes: "Sin notas.",
      relationship: "Relación",
      error: "No se pudo actualizar la empresa.",
      /** «Nuevo negocio» en la ficha: abrir uno a mano, sin pasar por el radar. */
      newDeal: {
        open: "Nuevo negocio",
        title: "Nuevo negocio",
        help: "Nace en «Nuevo» con «Enviar pitch» a tres días hábiles. El monto es sin impuestos; si todavía no lo sabes, déjalo vacío: lo pondrá la cotización.",
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
    /**
     * Los motivos que guarda la base como código (contact.opted_out_reason,
     * VEN-15 r4): se traducen aquí. Lo que no es un código es el texto que
     * escribió quien registró la baja a mano, y se enseña tal cual.
     */
    optedOutReasons: {
      unsubscribe_link: "Pidió la baja desde el enlace de un correo.",
    } as Readonly<Record<string, string>>,
    optedOutHelp: "No se le escribe por ningún canal. No se puede deshacer.",
    /** El motivo de una baja que llegó respondiendo a un toque (contact.opted_out_code). */
    optedOutByReply: {
      email: "Pidió no ser contactado, respondiendo a un correo.",
      linkedin: "Pidió no ser contactado, respondiendo por LinkedIn.",
      instagram_dm: "Pidió no ser contactado, respondiendo por Instagram.",
    },
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
    edit: "Editar",
    editLabel: (name: string) => `Editar: ${name}`,
    editTitle: "Editar el contacto",
    saveEdit: "Guardar cambios",
    edited: "Contacto actualizado.",
    editError: "No se pudo actualizar el contacto.",
    bounced: "Correo rebotado",
    /** Junto a la píldora: cuándo y por qué, con el diagnóstico del servidor que lo rechazó (0038). */
    bouncedNote: (fecha: string, motivo: string) => `Rebotó el ${fecha}: ${motivo}`,
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
    /**
     * Perder un negocio cierra sus cotizaciones enviadas o vistas (0031):
     * el aviso lo dice, para que nadie espere que la marca todavía firme.
     */
    quotesClosed: (numbers: string[]) =>
      numbers.length === 1
        ? `También se cerró ${numbers[0]}: la marca ya no puede aceptarla.`
        : `También se cerraron ${new Intl.ListFormat("es", { type: "conjunction" }).format(numbers)}: la marca ya no puede aceptarlas.`,
    /** La línea que deja en la historia del negocio cada cotización cerrada al perderlo. */
    quoteClosedActivity: (quoteNumber: string) => `${quoteNumber} se cerró al perder el negocio`,
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
    /** Pasar un negocio a una etapa perdida: el motivo es obligatorio, en un diálogo. */
    lost: {
      dialogTitle: (name: string) => `Perder el negocio con ${name}`,
      title: "¿Por qué lo pierdes?",
      help: "Queda anotado en el negocio. Con el tiempo es lo que te dice dónde se caen tus ventas. Si le enviaste una cotización, se cierra y la marca ya no podrá aceptarla.",
      placeholder: "Elige el motivo",
      confirm: (stage: string) => `Pasar a «${stage}»`,
      formLabel: (name: string) => `Por qué pierdes el negocio con ${name}`,
    },
    /**
     * Ganar un negocio que no tiene monto: se pide en la tarjeta, como el
     * motivo de pérdida. Sin él la base no lo mueve (AmountRequired).
     */
    won: {
      title: "¿Por cuánto lo ganaste?",
      help: "Sin impuestos. Es lo que suma en «Ganado este trimestre».",
      confirm: (stage: string) => `Pasar a «${stage}»`,
      formLabel: (name: string) => `Por cuánto ganas el negocio con ${name}`,
      required: "Escribe el monto: sin él no suma en lo ganado.",
    },
    /**
     * La conversión de cada etapa (VEN-8), en la fila de abajo de cada
     * columna del tablero: qué parte de los negocios que entraron llegó
     * más lejos, y sobre cuántos.
     */
    conversion: {
      rate: (pct: string) => `${pct} avanza`,
      /**
       * Sobre cuántos negocios y de cuándo (VEN-8 r4): la tasa es la de los
       * que entraron en los últimos `days` días, no la de toda la historia.
       */
      basis: (n: string, count: number, days: string) => `de ${n} ${count === 1 ? "negocio" : "negocios"} en ${days} días`,
      none: (days: string) => `Nadie entró en ${days} días`,
      /**
       * Lo que lee un lector de pantalla y el title de la fila. `entered` y
       * `advanced` llegan formateados con el locale del workspace; las
       * cifras crudas (`enteredCount`, `advancedCount`) eligen la forma de
       * la frase: nunca se compara un texto formateado.
       */
      label: (
        stage: string, entered: string, enteredCount: number, advanced: string, advancedCount: number, pct: string, days: string,
      ) => {
        if (enteredCount === 1) {
          return `En los últimos ${days} días, del negocio que entró en «${stage}», ${advancedCount === 1 ? "llegó más lejos" : "no llegó más lejos"} (${pct}).`;
        }
        const cuantos =
          advancedCount === 0 ? "ninguno llegó más lejos" : advancedCount === 1 ? "uno llegó más lejos" : `${advanced} llegaron más lejos`;
        return `En los últimos ${days} días, de los ${entered} negocios que entraron en «${stage}», ${cuantos} (${pct}).`;
      },
      labelNone: (stage: string, days: string) => `Ningún negocio entró en «${stage}» en los últimos ${days} días.`,
      /** La vista Lista: la misma fila por etapa, en un resumen encima de la tabla. */
      listTitle: (days: string) => `Conversión por etapa · últimos ${days} días`,
    },
  },

  /**
   * El brief de outbound (VEN-7, /ventas/brief). La referencia es el
   * formulario de preferencias de Passionfroot: qué buscas arriba, qué no
   * aceptas abajo y separado, porque lo segundo es una regla y lo primero
   * una preferencia.
   */
  brief: {
    metaTitle: "Brief · Ventas",
    eyebrow: "Ventas",
    title: "Qué buscas y qué no aceptas",
    description:
      "Tu brief dice a qué marcas quieres venderles y a cuáles no. Lo que no aceptas es una regla: el radar deja fuera esas señales y ninguna cadencia les escribe.",
    /** Cada creador tiene su brief (uno activo por creador): la pantalla dice de quién es. */
    of: (name: string) => `Brief de ${name}`,
    /** El selector de creador, cuando el espacio tiene más de uno (una agencia). */
    creator: {
      label: "Creador",
      submit: "Ver su brief",
      /** En la opción del selector: el estado del brief de cada creador. */
      option: (name: string, status: string | null) => (status ? `${name} · ${status}` : `${name} · sin brief`),
    },
    /**
     * Con varios creadores, cómo se combinan los briefs. El radar es del
     * espacio (una señal no tiene creador todavía): oculta solo lo que
     * excluyen TODOS los activos. Las cadencias escriben en nombre del
     * creador del negocio y usan su brief.
     */
    others: (names: string, count: number) =>
      count === 1
        ? `${names} también tiene brief activo. El radar oculta solo lo que excluyen todos los briefs activos: lo que este no acepta pero ${names} sí, se sigue viendo.`
        : `${names} también tienen brief activo. El radar oculta solo lo que excluyen todos los briefs activos: lo que este no acepta pero otro sí, se sigue viendo.`,
    cadencesRule:
      "Las cadencias de cada negocio usan el brief de su creador; si ese creador no tiene brief activo, lo que excluyen todos los del espacio.",
    /** Une los nombres de «others»: «Ana y Beto», «Ana, Beto y Carla». */
    joinNames: (names: string[]) =>
      names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`,
    savedAt: (date: string) => `Guardado el ${date}`,
    none: "Todavía no tienes brief. Guárdalo y el radar empieza a aplicarlo.",
    /** El nombre con el que nace el primero, para no abrir el formulario con un campo obligatorio vacío. */
    defaultTitle: "Mi brief",
    status: { active: "Activo", paused: "En pausa", draft: "Borrador", closed: "Cerrado" },
    /** Cuántas señales de la bandeja oculta hoy, con el enlace a verlas. */
    hidingNow: (n: string, count: number) =>
      count === 1 ? `Hoy deja fuera ${n} señal de tu bandeja.` : `Hoy deja fuera ${n} señales de tu bandeja.`,
    /** Lo mismo con varios briefs activos: lo que queda fuera es lo que excluyen todos, no solo este. */
    hidingNowAll: (n: string, count: number) =>
      count === 1
        ? `Entre todos los briefs activos, hoy queda fuera ${n} señal de la bandeja.`
        : `Entre todos los briefs activos, hoy quedan fuera ${n} señales de la bandeja.`,
    seeHidden: "Verlas en el radar",
    wants: {
      title: "Qué buscas",
      help: "Una preferencia, no un filtro: no oculta ninguna señal. El radar marca en cada una lo que no encaja («Bajo tu mínimo», «Fuera de tus países», «Fuera de lo que buscas»); las cadencias proponen solo los formatos que ofreces y fechas dentro de tu disponibilidad.",
    },
    rejects: {
      title: "Qué no aceptas",
      help: "Una regla, no una preferencia: el radar deja fuera de la bandeja las señales de estas categorías y marcas, las cadencias no les escriben (no se inscriben, y lo que estaba programado se cancela) y ningún mensaje sale sin la divulgación, si la exiges.",
    },
    state: {
      title: "Estado",
      help: "En pausa, el brief se guarda pero no oculta ni frena nada.",
    },
    fields: {
      title: "Nombre del brief",
      titleHelp: "Para ti: «Marcas de cocina · Q4».",
      wantedCategories: "Categorías que buscas",
      wantedCategoriesHelp: "Sectores o nichos de marca: alimentos, cocina, hogar.",
      wantedCountries: "Países",
      wantedCountriesHelp: "Donde está la marca o su campaña. El radar marca las de otros países.",
      minBudget: "Presupuesto mínimo",
      minBudgetHelp: "Por campaña, sin impuestos. Vacío si no tienes mínimo. El radar marca las señales que estiman menos, en la misma moneda.",
      currency: "Moneda del mínimo",
      deliverables: "Qué entregas",
      deliverablesHelp: "Los formatos que ofreces. Las cadencias los usan al proponer: el pitch no ofrece ningún otro.",
      availabilityFrom: "Disponible desde",
      availabilityTo: "Hasta",
      availabilityHelp: "Las cadencias proponen fechas dentro de esta ventana. Vacía, no proponen fechas por su cuenta.",
      excludedCategories: "Categorías que no aceptas",
      excludedCategoriesHelp: "Alcohol, apuestas, suplementos… Sin importar tildes ni mayúsculas.",
      excludedCompanies: "Marcas que no aceptas",
      excludedCompaniesHelp:
        "Busca entre las marcas de tu CRM: competencia de un cliente, una mala experiencia. Las que aún no están en tu CRM se excluyen desde su señal en el radar, con «No aceptar esta marca».",
      requiresDisclosure: "Divulgación obligatoria",
      requiresDisclosureHelp:
        "No acepto contenido pagado sin la marca de publicidad de la red. Los mensajes de tus cadencias lo dicen siempre.",
      notes: "Notas",
      notesHelp: "Lo que deben saber los mensajes que escriben las cadencias: «siempre con código propio y enlace rastreado».",
      active: "Aplicar el brief",
      activeHelp: "Si lo apagas, el brief queda en pausa: la bandeja muestra todo y las cadencias no lo miran.",
    },
    chips: {
      add: "Agregar",
      addTo: (field: string) => `Agregar a «${field}»`,
      remove: (value: string) => `Quitar ${value}`,
      empty: "Ninguna todavía.",
      categoryPlaceholder: "Escribe una categoría",
      countryPlaceholder: "Elige un país",
      companyPlaceholder: "Escribe el nombre de una marca",
      /** La búsqueda de marcas del CRM (VEN-7 r4): en el servidor, en todo el CRM. */
      searchMin: (min: string) => `Escribe al menos ${min} letras para buscar.`,
      searching: "Buscando…",
      searchNone: "Ninguna marca de tu CRM se llama así.",
      searchResults: (n: string, count: number) => (count === 1 ? "1 marca encontrada" : `${n} marcas encontradas`),
      searchError: "No se pudo buscar. Vuelve a intentarlo.",
      listLabel: (field: string) => `Elegidas en «${field}»`,
    },
    /** Los formatos de entregable (rate_card_item.deliverable y DELIVERABLES de @mc/core). */
    deliverables: {
      reel: "Reel de Instagram",
      tiktok: "Video de TikTok",
      historia: "Historias de Instagram",
      short: "YouTube Short",
      dedicado: "Video dedicado de YouTube",
      integracion: "Integración en un video",
    },
    /** Lo que valida el formulario antes de llegar a la base (zod, en brief/actions.ts). */
    validacion: {
      categoryTooLong: (l: BriefLimitTexts) => `Cada categoría va en ${l.categoryMax} caracteres o menos.`,
      countryUnknown: "Elige los países de la lista.",
      creatorUnknown: "Elige de quién es el brief.",
    },
    submit: "Guardar el brief",
    saved: "Guardado. El radar y las cadencias ya aplican tu brief.",
    savedPaused: "Guardado en pausa: no oculta ni frena nada.",
    /** Un 'member', 'viewer' o 'client' lo ve pero no lo cambia (PUEDEN_EDITAR_BRIEF). */
    sinPermiso:
      "Solo quien es dueño o administra este espacio puede cambiar el brief: lo que excluye se le oculta a todo el equipo. Puedes verlo; para cambiarlo, pídeselo.",
    error: "No se pudo guardar el brief.",
    errorTitle: { eyebrow: "Ventas", title: "No pudimos leer tu brief" },
    cargando: "Cargando el brief",
    noCreator: {
      title: "Falta el perfil de creador del espacio",
      description: "El brief cuelga de un perfil de creador, y este espacio todavía no tiene ninguno. Conecta las cuentas primero.",
      action: "Ir a Conexiones",
    },
  },

  /**
   * Los errores de dominio del brief (BriefError.code de @mc/db), en
   * español. Todas reciben los topes ya formateados (BriefLimitTexts) y el
   * dato del error, si lo trae: ningún número va escrito a mano.
   */
  briefErrores: briefPhrases({
    InvalidTitle: (l) => `Ponle un nombre al brief, de hasta ${l.titleMax} caracteres.`,
    InvalidCategory: (l, detail) => `La categoría «${detail ?? ""}» pasa de ${l.categoryMax} caracteres.`,
    TooManyCategories: (l) => `Son demasiadas categorías: hasta ${l.categories} por lista.`,
    CategoryConflict: (_l, detail) =>
      `«${detail ?? ""}» está en lo que buscas y en lo que no aceptas. Déjala en una sola.`,
    InvalidCountry: (_l, detail) => `«${detail ?? ""}» no es un país que reconozcamos.`,
    TooManyCountries: (l) => `Son demasiados países: hasta ${l.countries}.`,
    InvalidBudget: () => "Escribe el presupuesto mínimo como un monto, solo con cifras, o déjalo vacío.",
    InvalidCurrency: () => "Elige la moneda del mínimo de la lista.",
    InvalidWindow: () => "La fecha final va después de la inicial.",
    InvalidDeliverable: (l) => `Ese formato de entregable no existe, o son más de ${l.deliverables}.`,
    InvalidNotes: (l) => `Las notas pasan de ${l.notesMax} caracteres.`,
    CompanyNotInCrm: () => "Una de las marcas ya no está en tu CRM. Vuelve a elegirlas.",
    TooManyCompanies: (l) => `Son demasiadas marcas: hasta ${l.companies}.`,
    NoCreator: () => "Este espacio todavía no tiene un perfil de creador al que colgarle el brief.",
    UnknownCreator: () => "Ese creador no es de este espacio, o ya no existe. Vuelve a elegirlo.",
    NoActiveBrief: () => "No hay ningún brief activo donde agregarla. Activa el brief primero.",
    SignalNotFound: () => "Esa señal ya no está en la bandeja.",
    SignalWithoutBrand: () => "Esta señal no dice de qué marca es: no hay nada que excluir.",
    Forbidden: () =>
      "Solo quien es dueño o administra este espacio puede cambiar el brief: lo que excluye se le oculta a todo el equipo.",
  }),

  /** Por qué se perdió un negocio (deal.lost_reason), en la tarjeta y en la ficha: «Perdido · Por el precio». */
  motivosPerdida: {
    sin_presupuesto: "No tenía presupuesto",
    eligio_otro_creador: "Eligió a otro creador",
    sin_respuesta: "Dejó de responder",
    fuera_de_tiempo: "Se pasó el momento",
    precio: "Por el precio",
    no_encaja: "No encaja con lo que hago",
    otro: "Otro motivo",
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
    country: "Elige el país de la lista.",
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
    owner: "Elige a alguien de tu espacio.",
    lostReason: "Di por qué lo pierdes: es lo que te enseña el pipeline.",
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
    /** El tope de numeric(14,2), ya formateado en la moneda del espacio. */
    amountMax: (max: string) => `El monto no puede pasar de ${max}.`,
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
    InvalidOwner: "El responsable tiene que ser alguien de tu espacio.",
    InvalidReason: "Di por qué la descartas: es lo que afina el radar.",
    InvalidRelationship: "Esa relación no existe.",
    InvalidSource: "Un contacto no se guarda sin decir de dónde salió.",
    InvalidStage: "Esa etapa no existe.",
    LostReasonRequired: "Di por qué lo pierdes antes de pasarlo a «Perdido».",
    AmountRequired: "Di por cuánto lo ganaste: un negocio ganado sin monto no suma en «Ganado este trimestre».",
    DuplicateCompanyName: (p: Readonly<Record<string, string>>) => `Ya tienes una empresa llamada «${p.name ?? ""}».`,
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
    ficha: "Cargando la ficha de la empresa",
    nueva: "Cargando el formulario de empresa",
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
