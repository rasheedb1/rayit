/**
 * Textos de /ventas/perfil (VEN-11): el perfil comercial del creador.
 *
 * Jerarquía de los media kits de Beacons y Passionfroot (quién soy, a
 * quién llego, qué funciona, con quién trabajé, cuánto cobro) y la regla
 * del perfil de Stripe Atlas: cada dato dice de dónde sale. Voz: la del
 * creador que se presenta ante una marca; las explicaciones, cortas.
 *
 * Nada atado a un país: las cifras y las fechas llegan formateadas con
 * el locale, la moneda y la zona del workspace (lib/format.ts). Este
 * archivo llega al cliente (narrativa.tsx): solo tipos de @mc/core.
 */
import type {
  ContentKind, DurationBucket, DurationVsTypical, HookKind, OutlierTier, PieceKind, ToneTrait,
} from "@mc/core/outreach/perfil";
import type { NarrativeFallback } from "@mc/core/outreach/narrativa";
import type { NarrativeSource } from "@mc/core/outreach/perfil-guardado";

const reglas = new Intl.PluralRules("es");
/** La forma de una frase según la cifra, con las reglas del idioma de estos textos. */
function plural(n: number, one: string, other: string): string {
  return reglas.select(n) === "one" ? one : other;
}

export const MESSAGES = {
  metaTitle: "Perfil comercial",
  header: {
    eyebrow: "Ventas · perfil comercial",
    title: "Cómo te presentas ante una marca",
    description:
      "Tu audiencia, tus mejores videos y por qué funcionaron, tus campañas y tus tarifas, leídos de tus datos. Pasa el cursor por una cifra para ver de dónde sale.",
  },
  calculado: (fecha: string) => `Calculado el ${fecha}`,
  datosNuevos: "Hay datos más nuevos que este cálculo. Recalcula para ponerlo al día.",

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
  },

  vacio: {
    title: "Tu perfil todavía no está calculado",
    description:
      "Lo armamos con tus redes conectadas, tus videos, tus campañas y tu tarifario. Tarda unos segundos y lo puedes recalcular cuando quieras.",
  },
  sinCreador: {
    title: "Este espacio no tiene un creador activo",
    description: "El perfil comercial se arma con los datos de un creador. Crea o reactiva uno para verlo aquí.",
  },

  narrativa: {
    title: "Narrativa",
    meta: "Tres párrafos para presentarte. Cada cifra enlaza a su origen.",
    fuente: {
      llm: (modelo: string) => `Redactada por ${modelo} y verificada: solo usa cifras de este perfil.`,
      template: "Redactada con la plantilla: solo usa cifras de este perfil.",
      edited: "Editada por ti y verificada: solo usa cifras de este perfil.",
    } satisfies Record<NarrativeSource, string | ((m: string) => string)>,
    /** Por qué la narrativa es de plantilla. */
    fallback: {
      no_model: "La redacción automática no está configurada en este espacio (falta la llave de Anthropic).",
      budget: "Hoy ya se alcanzó el tope de gasto en redacción automática; mañana se puede volver a intentar.",
      rejected: "La redacción automática citó cifras que no están en tu perfil, así que usamos la plantilla.",
      error: "La redacción automática no respondió; usamos la plantilla.",
    } satisfies Record<NarrativeFallback, string>,
    editar: "Editar",
    guardar: "Guardar narrativa",
    guardando: "Guardando…",
    cancelar: "Cancelar",
    guardada: "Narrativa guardada.",
    campo: "Texto de la narrativa",
    ayuda:
      "Escribe las cifras solo con su marca, por ejemplo [claim:mediana-tiktok]: así cada una sigue enlazada a su origen. Separa los párrafos con una línea en blanco.",
    insertar: "Insertar una cifra",
    insertarAyuda: "Elige una cifra para ponerla donde está el cursor.",
    insertarBoton: "Insertar",
    vacia: "Todavía no hay narrativa.",
    errores: {
      titulo: "No se guardó:",
      empty: "La narrativa está vacía.",
      too_long: (max: string) => `Es demasiado larga: el máximo son ${max} caracteres.`,
      paragraphs: "Usa de uno a cinco párrafos, separados por una línea en blanco.",
      unknown_claim: (id: string) => `[claim:${id}] no es una cifra de este perfil.`,
      malformed_marker: (texto: string) => `«${texto}» no es una marca válida: se escribe [claim:id], con el id de la lista.`,
      bare_number: (texto: string) => `«${texto}» es una cifra escrita a mano: cámbiala por su marca de la lista o quítala.`,
      placeholder: (texto: string) => `Quedó un hueco sin llenar: «${texto}».`,
      no_claims: "Cita al menos una cifra.",
      stale_edit: "La narrativa cambió mientras la editabas (otra pestaña o un recálculo). Recarga la página y vuelve a intentarlo.",
      not_calculated: "El perfil todavía no está calculado.",
      creator_not_found: "Ese creador no existe en este espacio.",
      generico: "No se pudo guardar. Inténtalo de nuevo.",
    },
  },

  cifra: {
    /** El tooltip: qué es y de dónde sale. */
    origen: "Origen",
    abrir: "Abrir el origen",
    filas: (n: number, texto: string) => `${texto} ${plural(n, "publicación", "publicaciones")}`,
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
    generos: { F: "Mujeres", M: "Hombres", U: "Sin especificar" } as Record<string, string>,
    noSeguidores: "Alcance en personas que no te siguen",
    noSeguidoresNota: "Mediana por video, últimos videos de cada red",
  },

  desempeno: {
    title: "Qué te funciona",
    medianas: "Views medianas por video",
    medianaNota: (n: string, confiable: boolean) => `${n} videos${confiable ? "" : " · muestra corta"}`,
    corte: (dias: string) => `A los ${dias} días de publicado`,
    mejores: "Tus cinco mejores videos",
    mejoresMeta: (n: string) => `Frente a tu mediana, entre ${n} videos con puntaje`,
    sinVideos: "Todavía no hay videos con puntaje. Aparecen cuando la línea base de una red tiene suficientes videos.",
    veces: "tu mediana",
    views: "views",
    duracion: "duración",
    verVideo: "Ver el video",
    tier: { under: "Bajo su mediana", normal: "Normal", good: "Bueno", outlier: "Outlier", breakout: "Breakout" } satisfies Record<OutlierTier, string>,
    porque: "Por qué funcionó",
    gancho: {
      reto: "Abre con un reto",
      pregunta: "Abre con una pregunta",
      error: "Abre con un error común",
      lista: "Abre con una lista",
      promesa: "Abre con una promesa concreta",
      historia: "Abre con una historia propia",
      directo: "Entra directo al tema",
    } satisfies Record<HookKind, string>,
    ganchoLab: "según el análisis del video",
    pieza: { reel: "reel", tiktok: "TikTok", short: "short", historia: "historia", video: "video" } satisfies Record<PieceKind, string>,
    contenido: {
      tutorial: "tutorial", reto: "reto", lista: "lista", colaboracion: "colaboración con marca", otro: "",
    } satisfies Record<ContentKind, string>,
    duracionBucket: { muy_corto: "muy corto", corto: "corto", medio: "de duración media", largo: "largo" } satisfies Record<DurationBucket, string>,
    vsTipico: {
      mas_corto: "más corto que tus videos típicos",
      similar: "de tu duración habitual",
      mas_largo: "más largo que tus videos típicos",
    } satisfies Record<DurationVsTypical, string>,
  },

  formatos: {
    title: "Qué haces y cómo hablas",
    meta: (n: string) => `Leído de ${n} captions`,
    piezas: "Formatos",
    contenidos: "Tipos de contenido",
    tono: "Tono",
    pieza: { reel: "Reels", tiktok: "Videos de TikTok", short: "Shorts", historia: "Historias", video: "Videos" } satisfies Record<PieceKind, string>,
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
    deLosCaptions: "de los captions",
    sinDatos: "Todavía no hay publicaciones para leer.",
  },

  pruebaSocial: {
    title: "Con quién has trabajado",
    meta: "Campañas reportadas o cerradas, con resultado medido",
    sinDatos: "Todavía no tienes campañas con resultado medido. Aparecen aquí cuando reportas una en Campañas.",
    verCampana: "Ver la campaña",
    etiquetas: {
      views: "views",
      x: "veces tu mediana",
      "seguidores-marca": "seguidores nuevos para la marca",
      canjes: "canjes del código",
      ingresos: "en ventas atribuidas",
    } as Record<string, string>,
  },

  tarifas: {
    title: "Cuánto cobras",
    meta: "Tu tarifario vigente en Cotizar",
    sinDatos: "Todavía no tienes tarifario. Créalo en Cotizar y aparecerá aquí.",
    verTarifario: "Ver el tarifario",
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
