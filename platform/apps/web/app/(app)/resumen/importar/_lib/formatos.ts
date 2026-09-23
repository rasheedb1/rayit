import type { PlatformId } from "@mc/db/queries/resumen";
import type { OrdenFecha } from "./csv";

/**
 * Qué columnas buscamos en un CSV exportado de una plataforma, y cómo
 * se llaman en cada exportación.
 *
 * LO QUE HAY QUE SABER ANTES DE TOCAR ESTE ARCHIVO
 * -----------------------------------------------
 * Ninguna de las tres plataformas documenta el encabezado exacto de su
 * exportación, y los tres lo cambian: el nombre depende del informe
 * elegido, del idioma de la cuenta y de qué columnas estaban visibles
 * al exportar (YouTube exporta «la vista actual»; Meta cambia
 * «Impresiones» por «Reproducciones» entre informes; TikTok Studio y
 * TikTok Business Center no exportan lo mismo). Comprobado el 22 de
 * septiembre de 2026: no existe una lista oficial contra la que
 * programar.
 *
 * Por eso el detector NO exige una firma exacta:
 *
 *   1. `FIRMAS` solo sirve para adivinar DE QUÉ RED es el archivo, con
 *      dos o tres encabezados característicos. Acertar aquí ahorra un
 *      clic; fallar no rompe nada.
 *   2. `ALIAS` mapea encabezado → campo nuestro, en español y en
 *      inglés, y se aplica venga de donde venga el archivo. Es lo que
 *      hace que una exportación que no reconocemos quede casi mapeada.
 *   3. Lo que quede sin mapear lo asigna la persona en el paso 2. El
 *      mapeo manual no es el camino de excepción: es el camino, y el
 *      automático solo lo rellena por adelantado.
 *
 * Añadir un alias nuevo es una línea. Si alguien trae una exportación
 * real que no encaja, el alias entra aquí y su cabecera entra como
 * fixture en `apps/web/test/fixtures/csv/`.
 */

/** Los campos que sabemos escribir. El orden es el de la tabla de mapeo. */
export const CAMPOS = [
  "externalPostId",
  "publishedAt",
  "title",
  "url",
  "mediaType",
  "durationS",
  "views",
  "reach",
  "likes",
  "comments",
  "shares",
  "saves",
  "followsFromPost",
  "reachNonFollowers",
] as const;

export type Campo = (typeof CAMPOS)[number];

export type TipoCampo = "texto" | "fecha" | "entero" | "decimal" | "tipoMedio";

/**
 * Qué es cada campo. Su NOMBRE y su ayuda no viven aquí: son texto de
 * interfaz y están en `MESSAGES.importar.campos`, junto al resto de los
 * textos del módulo, para que traducir no sea buscar comillas por el
 * árbol.
 */
export interface DefCampo {
  campo: Campo;
  tipo: TipoCampo;
  /** Sin este campo no se puede escribir la fila. */
  obligatorio: boolean;
}

export const DEF_CAMPOS: readonly DefCampo[] = [
  { campo: "externalPostId", tipo: "texto", obligatorio: true },
  { campo: "publishedAt", tipo: "fecha", obligatorio: true },
  { campo: "title", tipo: "texto", obligatorio: false },
  { campo: "url", tipo: "texto", obligatorio: false },
  { campo: "mediaType", tipo: "tipoMedio", obligatorio: false },
  { campo: "durationS", tipo: "decimal", obligatorio: false },
  { campo: "views", tipo: "entero", obligatorio: false },
  { campo: "reach", tipo: "entero", obligatorio: false },
  { campo: "likes", tipo: "entero", obligatorio: false },
  { campo: "comments", tipo: "entero", obligatorio: false },
  { campo: "shares", tipo: "entero", obligatorio: false },
  { campo: "saves", tipo: "entero", obligatorio: false },
  { campo: "followsFromPost", tipo: "entero", obligatorio: false },
  { campo: "reachNonFollowers", tipo: "entero", obligatorio: false },
];

export const DEF_POR_CAMPO = new Map(DEF_CAMPOS.map((d) => [d.campo, d]));

/** Al menos uno de estos: una lectura sin ninguna cifra no es una lectura. */
export const CAMPOS_METRICA: readonly Campo[] = [
  "views",
  "reach",
  "likes",
  "comments",
  "shares",
  "saves",
  "followsFromPost",
  "reachNonFollowers",
];

/**
 * Encabezado → clave comparable: sin mayúsculas, sin tildes, sin
 * paréntesis ni puntuación, con los espacios colapsados. Así
 * «Duration (sec)», «duration sec» y «DURATION (SEC)» son lo mismo.
 */
export function normalizar(encabezado: string): string {
  return encabezado
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, " ")
    .trim();
}

/**
 * Alias conocidos, ya normalizados por `normalizar`. Español e inglés,
 * porque la exportación sale en el idioma de la cuenta.
 *
 * Regla que no se rompe: **impresiones no es alcance**. Una impresión
 * es una vez que se mostró; el alcance son cuentas distintas. Meta da
 * las dos y llamarlas igual falsearía el KPI de no seguidores, así que
 * «impressions» no es alias de `reach` y se queda sin mapear a
 * propósito.
 */
const ALIAS: Record<Campo, readonly string[]> = {
  externalPostId: ["post id", "publication id", "id de la publicacion", "id publicacion", "video id", "id del video", "media id", "content", "contenido", "id"],
  publishedAt: [
    "publish time", "publish date", "published", "date", "fecha", "hora de publicacion", "fecha de publicacion",
    "post time", "posted", "video publish time", "fecha y hora de publicacion", "tiempo de publicacion",
  ],
  title: ["description", "descripcion", "video title", "titulo del video", "title", "titulo", "caption", "texto de la publicacion", "post text", "nombre del video"],
  url: ["permalink", "enlace permanente", "video link", "enlace del video", "url", "enlace", "link", "video url"],
  mediaType: ["post type", "tipo de publicacion", "media type", "tipo de contenido", "content type", "tipo"],
  durationS: ["duration sec", "duracion s", "duracion segundos", "duration", "duracion", "video length", "duracion del video"],
  views: ["views", "visualizaciones", "reproducciones", "video views", "total views", "plays", "reel plays", "reproducciones del video", "visualizaciones totales", "vistas"],
  reach: ["accounts reached", "cuentas alcanzadas", "reach", "alcance", "accounts center accounts reached", "unique viewers", "espectadores unicos"],
  likes: ["likes", "me gusta", "total likes", "reactions", "reacciones", "likes and reactions", "me gusta y reacciones"],
  comments: ["comments", "comentarios", "total comments", "comentarios totales"],
  shares: ["shares", "veces compartido", "compartidos", "total shares", "reposts", "republicaciones", "veces que se compartio"],
  saves: ["saves", "guardados", "saved", "favorites", "total favorites", "favoritos", "veces guardado"],
  followsFromPost: ["follows", "new followers", "seguidores ganados", "nuevos seguidores", "subscribers", "suscriptores", "subscribers gained", "seguidores conseguidos"],
  reachNonFollowers: ["non follower reach", "alcance en no seguidores", "reach from non followers", "non followers", "no seguidores"],
};

/**
 * Encabezados que traen el DÍA DEL INFORME, no el de publicación: la
 * exportación de Meta lleva «Date» junto a «Publish time». No son un
 * campo de la fila; sirven para proponer la fecha de la exportación en
 * el paso 2 (`proponerFechaExportacion`). Normalizados.
 */
export const ALIAS_DIA_INFORME: readonly string[] = [
  "date", "fecha", "report date", "fecha del informe", "day", "dia", "data date",
];

export type FormatoId = "instagram_meta" | "tiktok_studio" | "youtube_studio";

/**
 * Una exportación que sabemos reconocer. Su nombre visible y de dónde
 * se descarga son texto de interfaz: `MESSAGES.importar.formatos[id]`.
 */
export interface FormatoConocido {
  id: FormatoId;
  red: PlatformId;
  /** Encabezados característicos, normalizados. Dos aciertos bastan. */
  firma: readonly string[];
  /**
   * El orden de las fechas numéricas que escribe esta exportación, si
   * es fijo. Meta Business Suite escribe «Publish time» en mes/día
   * («09/10/2026 15:04») sea cual sea el idioma de la cuenta: en un
   * archivo de los primeros doce días del mes, que no demuestra su
   * orden, proponer el del workspace (día/mes en es-CO) guardaba el 3
   * de septiembre como 9 de marzo, fuera de la ventana y sin error.
   */
  ordenFechas?: OrdenFecha;
}

export const FORMATOS: readonly FormatoConocido[] = [
  {
    id: "instagram_meta",
    red: "instagram",
    firma: ["account username", "nombre de usuario de la cuenta", "permalink", "accounts reached", "cuentas alcanzadas", "post id"],
    ordenFechas: "md",
  },
  {
    id: "tiktok_studio",
    red: "tiktok",
    firma: ["video title", "titulo del video", "video link", "enlace del video", "post time", "total views"],
  },
  {
    id: "youtube_studio",
    red: "youtube",
    firma: ["video publish time", "watch time hours", "impressions", "content", "impressions click through rate %"],
  },
];

export interface Deteccion {
  formato: FormatoConocido | null;
  /** Cuántos encabezados de la firma aparecieron. */
  aciertos: number;
}

/**
 * De qué red es el archivo. Solo cuenta coincidencias de firma: con dos
 * basta, con una no. Devolver `null` no es un fallo — significa «elige
 * tú la red y revisa el mapeo», que es el camino previsto.
 */
export function detectarFormato(encabezados: readonly string[]): Deteccion {
  const claves = new Set(encabezados.map(normalizar));
  let mejor: Deteccion = { formato: null, aciertos: 0 };
  for (const formato of FORMATOS) {
    const aciertos = formato.firma.filter((f) => claves.has(f)).length;
    if (aciertos > mejor.aciertos) mejor = { formato, aciertos };
  }
  return mejor.aciertos >= 2 ? mejor : { formato: null, aciertos: mejor.aciertos };
}

export type Mapeo = Partial<Record<Campo, string>>;

/**
 * Mapeo automático por alias: campo → encabezado del archivo. Lo que no
 * reconoce se queda fuera y lo completa la persona.
 *
 * Manda el ORDEN DE LOS ALIAS, no el de las columnas: la exportación de
 * Meta trae «Publish time» y también «Date» —que es el día del informe,
 * no el de publicación—, y la fecha correcta tiene que ganar esté donde
 * esté en el archivo. Una columna solo se usa una vez.
 */
export function mapearPorAlias(encabezados: readonly string[]): Mapeo {
  const porClave = new Map<string, string>();
  for (const e of encabezados) {
    const k = normalizar(e);
    if (k && !porClave.has(k)) porClave.set(k, e);
  }
  const mapeo: Mapeo = {};
  const usados = new Set<string>();
  for (const campo of CAMPOS) {
    for (const alias of ALIAS[campo]) {
      const encabezado = porClave.get(alias);
      if (encabezado && !usados.has(encabezado)) {
        mapeo[campo] = encabezado;
        usados.add(encabezado);
        break;
      }
    }
  }
  return mapeo;
}
