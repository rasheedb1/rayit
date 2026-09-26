/**
 * Textos de /ventas/perfil (VEN-11): el perfil comercial del creador.
 *
 * Jerarquía de los media kits de Beacons y Passionfroot (quién soy, a
 * quién llego, qué funciona, con quién trabajé, cuánto cobro) y la regla
 * del perfil de Stripe Atlas: cada dato dice de dónde sale. Voz: la del
 * creador que se presenta ante una marca; las explicaciones, cortas.
 *
 * Aquí vive también lo que dice cada cifra en su tooltip (`cifra.que`):
 * @mc/core solo guarda la clave y los parámetros del claim. Nada atado a
 * un país: las cifras, las fechas y los países llegan formateados con el
 * locale, la moneda y la zona del workspace (lib/format.ts). Este
 * archivo llega al cliente (narrativa.tsx, cifra.tsx): solo tipos de
 * @mc/core.
 */
import type {
  ClaimKey, ContentKind, CutSpan, DurationBucket, DurationVsTypical, HookKind, OutlierTier, PieceKind, ToneTrait, WhyAxis,
} from "@mc/core/outreach/perfil";
import type { NarrativeFallback } from "@mc/core/outreach/narrativa";
import type { NarrativeSource } from "@mc/core/outreach/perfil-guardado";

const reglas = new Intl.PluralRules("es");
/** La forma de una frase según la cifra, con las reglas del idioma de estos textos. */
function plural(n: number, one: string, other: string): string {
  return reglas.select(n) === "one" ? one : other;
}

/**
 * Los OTROS videos de un grupo del porqué, en plural: «Tus otros videos
 * que abren con una promesa», «Tus otros reels». «Otros» porque el grupo
 * deja fuera al video que se explica (whyContrast de @mc/core).
 */
const GRUPOS: Record<WhyAxis, Record<string, string>> = {
  hook: {
    reto: "Tus otros videos que abren con un reto",
    pregunta: "Tus otros videos que abren con una pregunta",
    error: "Tus otros videos que abren con un error común",
    lista: "Tus otros videos que abren con una lista",
    promesa: "Tus otros videos que abren con una promesa concreta",
    historia: "Tus otros videos que abren con una historia propia",
    directo: "Tus otros videos que entran directo al tema",
  } satisfies Record<HookKind, string>,
  piece: {
    reel: "Tus otros reels", tiktok: "Tus otros videos de TikTok", short: "Tus otros shorts", historia: "Tus otras historias",
    video: "Tus otros videos largos o de feed",
  } satisfies Record<PieceKind, string>,
  content: {
    tutorial: "Tus otros tutoriales y recetas", reto: "Tus otros retos", lista: "Tus otras listas",
    colaboracion: "Tus otras colaboraciones con marcas", otro: "Tus demás videos",
  } satisfies Record<ContentKind, string>,
  duration: {
    muy_corto: "Tus otros videos muy cortos", corto: "Tus otros videos cortos", medio: "Tus otros videos de duración media",
    largo: "Tus otros videos largos",
  } satisfies Record<DurationBucket, string>,
};

/** El rasgo dicho después de «sin»: «Tus videos sin abrir con una promesa concreta», «sin ser reel». */
const SIN_RASGO: Record<WhyAxis, Record<string, string>> = {
  hook: {
    reto: "abrir con un reto", pregunta: "abrir con una pregunta", error: "abrir con un error común", lista: "abrir con una lista",
    promesa: "abrir con una promesa concreta", historia: "abrir con una historia propia", directo: "entrar directo al tema",
  } satisfies Record<HookKind, string>,
  piece: {
    reel: "ser reel", tiktok: "ser video de TikTok", short: "ser short", historia: "ser historia", video: "ser video largo o de feed",
  } satisfies Record<PieceKind, string>,
  content: {
    tutorial: "ser tutorial o receta", reto: "ser reto", lista: "ser lista", colaboracion: "ser colaboración con marca", otro: "ese rasgo",
  } satisfies Record<ContentKind, string>,
  duration: { muy_corto: "durar muy poco", corto: "ser corto", medio: "tener duración media", largo: "ser largo" } satisfies Record<DurationBucket, string>,
};

/** Las claves de las cifras de una campaña: cada una lleva su etiqueta en «Con quién has trabajado». */
export type CampaignClaimKey = Extract<ClaimKey, `campaign.${string}`>;

export const MESSAGES = {
  metaTitle: "Perfil comercial",
  header: {
    eyebrow: "Ventas · perfil comercial",
    title: "Cómo te presentas ante una marca",
    description:
      "Tu audiencia, tus mejores videos y lo que los distingue, tus campañas y tus tarifas, leídos de tus datos. Toca o pasa el cursor por una cifra para ver de dónde sale.",
  },
  calculado: (fecha: string) => `Calculado el ${fecha}`,
  datosNuevos: "Hay datos más nuevos que este cálculo. Recalcula para ponerlo al día.",
  sinPermiso: "Solo quien es dueño, administra o es miembro de este espacio puede recalcular el perfil o editar su narrativa.",

  recalcular: {
    boton: "Recalcular",
    calculando: "Calculando…",
    primero: "Calcular mi perfil",
    /** Recalcular reescribe la narrativa: si el creador la editó, se pregunta antes. */
    confirmar: "¿Recalcular tu perfil?",
    consecuencia: "Las cifras se ponen al día y la narrativa que editaste se reemplaza por una nueva.",
    confirmarSi: "Sí, recalcular",
    confirmarNo: "Cancelar",
    listo: "Perfil recalculado.",
    error: "No se pudo recalcular. Inténtalo de nuevo en un momento.",
    /** Otra pestaña o persona ya está recalculando: solo uno llama al modelo. */
    enCurso: "Ya se está recalculando tu perfil. Espera unos segundos y recarga la página.",
    /** Alguien guardó una edición de la narrativa mientras se recalculaba: no se pisa. */
    edicionNueva:
      "Alguien editó la narrativa mientras se recalculaba, así que no la reemplazamos. Recarga la página para verla y recalcula de nuevo si quieres.",
  },

  vacio: {
    title: "Tu perfil todavía no está calculado",
    description:
      "Lo armamos con tus redes conectadas, tus videos, tus campañas y tu tarifario. Tarda unos segundos y lo puedes recalcular cuando quieras.",
    /** Para quien solo puede mirar: no se le ofrece calcularlo. */
    soloLectura: "Todavía nadie lo ha calculado. Lo puede calcular quien es dueño, administra o es miembro de este espacio.",
  },
  sinCreador: {
    title: "Este espacio no tiene un creador activo",
    description: "El perfil comercial se arma con los datos de un creador. Crea o reactiva uno para verlo aquí.",
  },

  narrativa: {
    title: "Narrativa",
    meta: "Tres párrafos para presentarte. Cada cifra lleva a su origen.",
    /** Lo que de verdad se garantiza: las cifras marcadas salen del perfil (el verificador rechaza cualquier otra). */
    fuente: {
      llm: (modelo: string) => `Redactada por ${modelo}. Las cifras marcadas salen de este perfil; el verificador rechaza cualquier otra.`,
      template: "Redactada con la plantilla. Las cifras marcadas salen de este perfil.",
      edited: "Editada por ti. Las cifras marcadas salen de este perfil; el verificador rechaza cualquier otra.",
    } satisfies Record<NarrativeSource, string | ((m: string) => string)>,
    /** Por qué la narrativa es de plantilla. */
    fallback: {
      no_model: "La redacción automática todavía no está activada en On Cue; usamos una plantilla con tus mismas cifras.",
      budget: "Hoy ya se alcanzó el tope de gasto en redacción automática; mañana se puede volver a intentar.",
      rejected: "La redacción automática citó cifras que no están en tu perfil, así que usamos la plantilla.",
      error: "La redacción automática no respondió a tiempo; usamos la plantilla.",
    } satisfies Record<NarrativeFallback, string>,
    editar: "Editar",
    guardar: "Guardar narrativa",
    guardando: "Guardando…",
    cancelar: "Cancelar",
    guardada: "Narrativa guardada.",
    campo: "Texto de la narrativa",
    ayuda:
      "Cada cifra va entre ⟦ ⟧ y sigue enlazada a su origen: no la escribas a mano, ponla con «Insertar una cifra». Separa los párrafos con una línea en blanco.",
    insertar: "Insertar una cifra",
    insertarAyuda: "Elige una cifra para ponerla donde está el cursor.",
    insertarBoton: "Insertar",
    vistaPrevia: "Así se verá",
    vistaPreviaVacia: "Escribe algo para ver cómo quedará.",
    /** La vista previa corre el mismo verificador que el servidor y subraya lo que no pasaría. */
    vistaPreviaProblemas: "Lo subrayado no pasará el verificador al guardar:",
    vistaPreviaBien: "Todas las cifras están marcadas y salen de tu perfil.",
    /** Hoy la narrativa solo se redacta y se verifica en un idioma; se dice con su nombre en el idioma del workspace. */
    idioma: (lengua: string) => `La narrativa se redacta en ${lengua}.`,
    vacia: "Todavía no hay narrativa.",
    errores: {
      titulo: "No se guardó:",
      empty: "La narrativa está vacía.",
      too_long: (max: string) => `Es demasiado larga: el máximo son ${max} caracteres.`,
      paragraphs: "Usa de uno a cinco párrafos, separados por una línea en blanco.",
      /** `ficha` llega como el creador la ve en el editor: ⟦…⟧. */
      unknown_claim: (ficha: string) => `${ficha} no es una cifra de este perfil: ponla con «Insertar una cifra».`,
      malformed_marker: (ficha: string) => `${ficha} no es una cifra de este perfil: ponla con «Insertar una cifra».`,
      bare_number: (texto: string) => `«${texto}» es una cifra escrita a mano: cámbiala por una de «Insertar una cifra» o quítala.`,
      number_word: (texto: string) =>
        `«${texto}» dice una cantidad, un puesto o una proporción sin cifra: cámbiala por una de «Insertar una cifra» o quítala.`,
      placeholder: (texto: string) => `Quedó un hueco sin llenar: «${texto}».`,
      /**
       * `cifra` es la ficha de la cifra (⟦115,4 mil⟧) cuando quien la dice la conoce (la vista previa), o
       * `cifraAnterior`; `mide` sale de `mide` (abajo), por la unidad del claim.
       */
      unit_mismatch: (palabra: string, cifra: string, mide: string) =>
        `«${palabra}» no es lo que mide ${cifra}: esa cifra es ${mide}. Cambia la palabra por lo que la cifra mide o quítala.`,
      /** `texto` va pegado a la cifra sin espacio («k», «M», «x2»); `cifra`, como en unit_mismatch. */
      glued_suffix: (texto: string, cifra: string) =>
        `«${texto}» va pegado a ${cifra} y cambia lo que dice: esa cifra ya está entera. Quítalo o sepáralo con un espacio.`,
      cifraAnterior: "la cifra que va antes",
      /** Qué mide una cifra, por su unidad (Claim.unit); una moneda ISO-4217 es `dinero`. */
      mide: {
        views: "un número de views",
        seguidores: "un número de seguidores",
        videos: "un número de videos",
        canjes: "un número de canjes",
        pct: "un porcentaje",
        x: "un múltiplo de tu mediana",
        s: "una duración",
        dinero: "un monto de dinero",
      } as Record<string, string>,
      no_claims: "Cita al menos una cifra.",
      stale_edit: "La narrativa cambió mientras la editabas (otra pestaña o un recálculo). Recarga la página y vuelve a intentarlo.",
      recalc_in_progress: "Hay un recálculo en curso. Espera a que termine y vuelve a intentarlo.",
      not_calculated: "El perfil todavía no está calculado.",
      creator_not_found: "Ese creador no existe en este espacio.",
      generico: "No se pudo guardar. Inténtalo de nuevo.",
    },
  },

  cifra: {
    /** Nombre accesible del botón de una cifra: el valor, qué es y qué hace. */
    ver: (valor: string, que: string) => `${valor}, ${que}. Ver de dónde sale`,
    abrir: "Abrir el origen",
    /** El enlace del origen, con su destino en el nombre accesible. */
    abrirA: (destino: string) => `Abrir el origen: ${destino}`,
    filas: (n: number, texto: string) => `${texto} ${plural(n, "publicación", "publicaciones")}`,
    /** La fecha de la lectura de la fila: «al 24 de septiembre de 2026». */
    fecha: (fecha: string) => `al ${fecha}`,
    tablas: {
      creator_baseline: "Línea base del creador",
      post: "Tus publicaciones",
      post_score: "Puntaje del video frente a tu mediana",
      post_metrics_latest: "Última lectura de tus videos",
      audience_breakdown: "Demografía de la cuenta",
      account_metric_snapshot: "Lectura diaria de la cuenta",
      campaign_result: "Resultado de la campaña",
      rate_card_item: "Tu tarifario vigente",
    },
    /** El corte de edad de una cifra, sin convertir a mano: core entrega la unidad (cutOf). */
    corte: (c: CutSpan, n: string) => (c.unit === "hours" ? `a las ${n} horas de publicado` : `a los ${n} días de publicado`),
    /** Qué es cada cifra, por la clave de su claim: lo que dice el tooltip. */
    que: {
      followers: (red: string) => `Tus seguidores en ${red}`,
      audienceAge: (red: string, franja: string) => `Parte de tus seguidores de ${red} con ${franja} años`,
      audienceGender: (red: string, genero: "f" | "m" | "u") =>
        genero === "u"
          ? `Parte de tus seguidores de ${red} de género sin especificar`
          : `Parte de tus seguidores de ${red} que son ${genero === "f" ? "mujeres" : "hombres"}`,
      audienceCountry: (red: string, pais: string) => `Parte de tus seguidores de ${red} que vive en ${pais}`,
      nonFollowers: (red: string) => `Alcance en personas que no siguen tu cuenta: mediana por video en ${red}`,
      median: (red: string, corte: string) => `Views medianas por video en ${red}, ${corte}`,
      scoredVideos: "Videos con puntaje frente a tu mediana",
      videoMultiple: (titulo: string, red: string, corte: string) => `Veces tu mediana de ${red} que hizo «${titulo}», ${corte}`,
      videoViews: (titulo: string, red: string, corte: string) => `Views de «${titulo}» en ${red}, ${corte}`,
      videoDuration: (titulo: string) => `Duración de «${titulo}»`,
      whyGroup: (axis: WhyAxis, group: string, titulo: string) =>
        `${GRUPOS[axis][group] ?? group}, sin contar «${titulo}»: su mediana, en veces tu mediana`,
      whyRest: (axis: WhyAxis, group: string) => `Tus videos sin ${SIN_RASGO[axis][group] ?? group}: su mediana, en veces tu mediana`,
      formatPiece: (pieza: PieceKind) => `Publicaciones que son ${PIEZAS_PLURAL[pieza]}`,
      formatContent: (contenido: ContentKind) => `Publicaciones que son ${CONTENIDOS_PLURAL[contenido]}`,
      tone: (rasgo: ToneTrait) => `Parte de tus captions ${TONO_CAPTIONS[rasgo]}`,
      captionsRead: "Captions leídos para inferir formatos y tono",
      campaignViews: (marca: string) => `Views de la campaña con ${marca}`,
      campaignMultiple: (marca: string) => `Veces tu mediana que hizo la campaña con ${marca}`,
      campaignBrandFollowers: (marca: string) => `Seguidores que ganó ${marca} con la campaña`,
      campaignRedemptions: (marca: string) => `Canjes del código de ${marca}`,
      campaignRevenue: (marca: string) => `Ventas atribuidas a la campaña con ${marca}`,
      rateLow: (item: string) => `Tu tarifa de «${item}», desde`,
      rateHigh: (item: string) => `Tu tarifa de «${item}», hasta`,
    },
  },

  identidad: {
    title: "Quién eres",
    redes: "Redes conectadas",
    seguidores: "seguidores",
    sinSeguidores: "Sin lectura de seguidores",
    idiomas: "Idiomas",
    pais: "País",
    nichos: "Nichos",
  },

  audiencia: {
    title: "A quién llegas",
    meta: (red: string, fecha: string) => `${red} · demografía del ${fecha}`,
    sinDatos: "Tus redes todavía no traen demografía. Llega cuando una cuenta business sincroniza sus seguidores.",
    edad: "Edad",
    genero: "Género",
    pais: "País",
    generos: { f: "Mujeres", m: "Hombres", u: "Sin especificar" } satisfies Record<"f" | "m" | "u", string>,
    noSeguidores: "Alcance en personas que no te siguen",
    noSeguidoresNota: "Mediana por video, últimos videos de cada red",
  },

  desempeno: {
    title: "Qué te funciona",
    medianas: "Views medianas por video",
    medianaNota: (n: string, confiable: boolean, corte: string) => `${n} videos · ${corte}${confiable ? "" : " · muestra corta"}`,
    mejores: "Tus cinco mejores videos",
    mejoresMeta: (n: string) => `Frente a tu mediana, entre ${n} videos con puntaje`,
    sinVideos: "Todavía no hay videos con puntaje. Aparecen cuando la línea base de una red tiene suficientes videos.",
    veces: "tu mediana",
    views: (corte: string) => `views ${corte}`,
    viewsPalabra: "views",
    duracion: "duración",
    frenteA: (red: string) => `Tu mediana de ${red} a esa edad:`,
    tier: {
      under: "Bajo tu mediana", normal: "En tu mediana", good: "Bueno", outlier: "Muy por encima", breakout: "Fuera de serie",
    } satisfies Record<OutlierTier, string>,
    /** La portada del video: su título, para quien no la ve. */
    portada: (titulo: string) => `Portada de «${titulo}»`,
    /** Sin portada (o una que ya no carga): la red y la duración en su lugar, para quien no la ve. */
    sinPortada: (red: string, duracion: string | null) => (duracion ? `Video de ${red} de ${duracion}, sin portada` : `Video de ${red}, sin portada`),
    /** Cómo es el video (gancho, pieza, tipo, duración frente a la típica): la explicación principal. */
    comoEs: "Cómo es",
    /**
     * Una razón, solo cuando los datos la sostienen: «Tus otros reels
     * hacen 2,1× tu mediana, frente a 0,8× de tus videos sin ser reel».
     */
    distingue: "Lo que lo distingue",
    razonHacen: "hacen",
    razonFrente: "tu mediana, frente a",
    razonResto: (axis: WhyAxis, group: string) => `de tus videos sin ${SIN_RASGO[axis][group] ?? group}`,
    grupos: GRUPOS,
    gancho: {
      reto: "abre con un reto",
      pregunta: "abre con una pregunta",
      error: "abre con un error común",
      lista: "abre con una lista",
      promesa: "abre con una promesa concreta",
      historia: "abre con una historia propia",
      directo: "entra directo al tema",
    } satisfies Record<HookKind, string>,
    ganchoLab: "según el análisis del video",
    pieza: {
      reel: "reel", tiktok: "TikTok", short: "short", historia: "historia", video: "video largo o de feed",
    } satisfies Record<PieceKind, string>,
    contenido: {
      tutorial: "tutorial", reto: "reto", lista: "lista", colaboracion: "colaboración con marca", otro: "",
    } satisfies Record<ContentKind, string>,
    duracionBucket: { muy_corto: "muy corto", corto: "corto", medio: "de duración media", largo: "largo" } satisfies Record<DurationBucket, string>,
    /** 'similar' no se dice: no distingue nada. */
    vsTipico: {
      mas_corto: "más corto que tus videos típicos",
      similar: "",
      mas_largo: "más largo que tus videos típicos",
    } satisfies Record<DurationVsTypical, string>,
  },

  formatos: {
    title: "Qué haces y cómo hablas",
    meta: (n: string) => `Leído de ${n} captions`,
    piezas: "Formatos",
    contenidos: "Tipos de contenido",
    tono: "Tono",
    /** «video» es lo que no es reel, TikTok, short ni historia: los videos de Facebook, los largos de YouTube y lo de feed. */
    pieza: {
      reel: "Reels", tiktok: "Videos de TikTok", short: "Shorts", historia: "Historias", video: "Videos largos o de feed",
    } satisfies Record<PieceKind, string>,
    contenido: {
      tutorial: "Tutoriales y recetas", reto: "Retos", lista: "Listas", colaboracion: "Colaboraciones con marcas", otro: "Otros",
    } satisfies Record<ContentKind, string>,
    rasgo: {
      emojis: "Usa emojis",
      tutea: "Le habla de tú a quien mira",
      primera_persona: "Escribe en primera persona",
      preguntas: "Hace preguntas",
      breve: "Captions breves",
      hashtags: "Usa hashtags",
    } satisfies Record<ToneTrait, string>,
    sinDatos: "Todavía no hay publicaciones para leer.",
  },

  pruebaSocial: {
    title: "Con quién has trabajado",
    meta: "Campañas reportadas o cerradas, con resultado medido",
    sinDatos: "Todavía no tienes campañas con resultado medido. Aparecen aquí cuando reportas una en Campañas.",
    /** Lo que acompaña a cada cifra de campaña, por la clave de su claim. */
    etiquetas: {
      "campaign.views": "views",
      "campaign.multiple": "veces tu mediana",
      "campaign.brand_followers": "seguidores nuevos para la marca",
      "campaign.redemptions": "canjes del código",
      "campaign.revenue": "en ventas atribuidas",
    } satisfies Record<CampaignClaimKey, string>,
  },

  tarifas: {
    title: "Cuánto cobras",
    verTarifario: "Ver el tarifario",
    sinDatos: "Todavía no tienes tarifario. Créalo en Cotizar y aparecerá aquí.",
  },

  fuentes: {
    title: "De dónde sale cada cifra",
    meta: "Las cifras que no llevan a un video, a una campaña o al tarifario",
    /** El resumen del bloque plegado. */
    ver: (n: string) => `Ver las ${n} fuentes`,
    /** Los grupos, por el origen de la cifra. */
    grupos: {
      audiencia: "Demografía y alcance",
      base: "Líneas base",
      porque: "Puntajes y porqué",
      captions: "Lo que se lee en tus captions",
    },
    videos: "Videos que la forman:",
    /** Las cifras de demografía: de qué informe salen y el resto del reparto de esa lectura. */
    informe: (red: string) => `Del informe de audiencia que da ${red}, solo sobre tus seguidores.`,
    reparto: (lista: string) => `En la misma lectura: ${lista}.`,
    segmento: (nombre: string, valor: string) => `${nombre} ${valor}`,
    yMas: (n: string) => `y ${n} más`,
    /** Para soporte, solo en el title de la fila: la tabla, la columna y la fila tal cual. */
    soporte: (tabla: string, campo: string, fila: string) => `${tabla}.${campo} · ${fila}`,
  },

  unidades: {
    segundos: (n: string) => `${n} s`,
  },

  error: {
    eyebrow: "Ventas · perfil comercial",
    title: "No pudimos leer tu perfil comercial",
  },
  loading: {
    label: "Cargando el perfil comercial",
  },
} as const;

const PIEZAS_PLURAL: Record<PieceKind, string> = {
  reel: "reels", tiktok: "videos de TikTok", short: "shorts", historia: "historias", video: "videos largos o de feed",
};
const CONTENIDOS_PLURAL: Record<ContentKind, string> = {
  tutorial: "tutoriales o recetas", reto: "retos", lista: "listas", colaboracion: "colaboraciones con marcas", otro: "otros",
};
const TONO_CAPTIONS: Record<ToneTrait, string> = {
  emojis: "con emojis",
  tutea: "que le hablan de tú a quien mira",
  primera_persona: "en primera persona",
  preguntas: "con una pregunta",
  breve: "breves",
  hashtags: "con hashtags",
};
