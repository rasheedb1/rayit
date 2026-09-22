/**
 * Consultas del módulo Resumen. Dueño: Rasheed (RES-1, RES-2).
 *
 * Toda función recibe un WorkspaceTx: una transacción con el workspace
 * ya fijado. RLS filtra las lecturas; los INSERT usan
 * current_workspace_id(). Ninguna recibe workspace_id suelto.
 *
 * La regla que manda en este archivo: **ninguna pantalla hace
 * aritmética de métricas**. Las sumas por red, la comparación contra el
 * periodo anterior, la razón de alcance en no seguidores y los
 * guardados por mil se calculan en SQL, sobre account_metric_snapshot y
 * la vista post_metrics_latest. React solo formatea lo que llega.
 *
 * El reloj: el "hoy" del módulo es el ÚLTIMO DÍA CERRADO con lecturas,
 * no now(). El recolector cierra el día anterior de madrugada, así que
 * anclar en now() dejaría siempre un día a medias al final de cada
 * serie y el aviso «datos hasta el {fecha}» diría "hoy" con datos
 * incompletos.
 *
 * Ese último día mira las DOS fuentes: la serie de cuenta
 * (account_metric_snapshot, que llena el recolector) y las lecturas de
 * contenido (post_metric_snapshot, que llena también la importación por
 * CSV). Un workspace que solo subió un archivo —el creador para el que
 * existe RES-2— no tiene ni una fila de serie de cuenta, y anclar el
 * reloj solo ahí dejaba el Resumen entero en blanco.
 *
 * Las fechas `date` salen como 'YYYY-MM-DD' (to_char) para no depender
 * de la zona horaria del driver; los timestamptz, como ISO 8601 en UTC.
 */
import { desc } from 'drizzle-orm';
import type { WorkspaceTx } from '../client.ts';
import { creatorPostBoard } from '../schema/index.ts';

export type PostBoardRow = typeof creatorPostBoard.$inferSelect;

const DEFAULT_LIMIT = 50;
/** Techo de una página: más que esto es un error de quien llama, no una consulta. */
const MAX_LIMIT = 500;

/** La tabla "Mis videos": última métrica y puntaje de cada post, más reciente primero. */
export async function listPostBoard(tx: WorkspaceTx, opts: { limit?: number } = {}): Promise<PostBoardRow[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit inválido: ${String(opts.limit)}. Un entero entre 1 y ${MAX_LIMIT}.`);
  }
  return tx.db
    .select()
    .from(creatorPostBoard)
    .orderBy(desc(creatorPostBoard.publishedAt))
    .limit(limit);
}

// =====================================================================
// Tipos del módulo
// =====================================================================

/** platform.id (catálogo de 0002). Las cuatro redes del MVP. */
export type RedId = 'tiktok' | 'instagram' | 'facebook' | 'youtube';

export const REDES: readonly RedId[] = ['tiktok', 'instagram', 'facebook', 'youtube'];

/** Los tres periodos que ofrece la pantalla. Van en la URL, así que se validan. */
export const PERIODOS = [7, 30, 90] as const;
export type Periodo = (typeof PERIODOS)[number];

export interface ResumenFiltro {
  /** 7, 30 o 90 días. */
  dias: Periodo;
  /** null = todas las redes. */
  red?: RedId | null;
}

/**
 * Un KPI con su comparación. `spark` son hasta doce puntos del mismo
 * cálculo sobre ventanas deslizantes: la última ES el periodo actual y,
 * cuando la historia da para las doce, la primera ES el periodo
 * anterior, así que la línea y el delta nunca se contradicen.
 *
 * Cuando la base no llega tan atrás, las ventanas que no cubre salen
 * NULL y la sparkline se queda con el tramo final. Es la diferencia
 * entre «no lo sabemos» y «fue cero», y en un panel de métricas esa
 * diferencia es todo.
 */
export interface KpiSerie {
  /** null cuando no hay ninguna lectura con la que calcularlo. */
  value: number | null;
  previous: number | null;
  /** Relativo: 0.31 = +31 %. null si el periodo anterior es cero o no existe. */
  delta: number | null;
  /** El tramo final sin huecos. Con menos de dos puntos, no se dibuja. */
  spark: number[];
}

export interface ResumenKpis {
  /** Último día cerrado con lecturas, 'YYYY-MM-DD'. null si el workspace no tiene ninguna. */
  hasta: string | null;
  /** Primer día del periodo, 'YYYY-MM-DD'. */
  desde: string | null;
  /** Seguidores sumados de las redes del filtro, al final del periodo. */
  followers: KpiSerie;
  /** Views de la cuenta sumadas dentro del periodo. */
  views: KpiSerie;
  /** Razón 0..1: alcance en no seguidores sobre alcance total del contenido publicado en el periodo. */
  nonFollowerReach: KpiSerie;
  /** Guardados por cada mil views del contenido publicado en el periodo. */
  savesPer1k: KpiSerie;
  /** Cuántos posts entraron en los dos KPIs de contenido. */
  posts: number;
}

export interface SeriePorRed {
  platformId: RedId;
  data: number[];
}

export interface SerieDiaria {
  /** Un día por punto, 'YYYY-MM-DD', de más viejo a más nuevo. */
  labels: string[];
  series: SeriePorRed[];
}

export interface BloqueSemana {
  /** 'YYYY-MM-DD', inclusive. */
  inicio: string;
  /** 'YYYY-MM-DD', inclusive. */
  fin: string;
}

export interface SeriePorBloque {
  bloques: BloqueSemana[];
  /** Cuántos días cubre cada bloque: 1 (diario) o 7 (semanal). */
  paso: number;
  series: SeriePorRed[];
}

export interface FrescuraConexion {
  connectionId: string;
  platformId: RedId;
  handle: string | null;
  displayName: string | null;
  status: string;
  /** ISO, o null si nunca se sincronizó. */
  lastSyncedAt: string | null;
  /** Último día cerrado de la serie de cuenta, 'YYYY-MM-DD'. */
  ultimoDiaCuenta: string | null;
  /** Última lectura de contenido, ISO. */
  ultimaLecturaContenido: string | null;
  /** De dónde vino esa última lectura: 'api' | 'csv_import' | 'manual' | 'aggregator'. */
  ultimaFuente: string | null;
  tokenExpiringSoon: boolean;
}

export interface CoberturaResumen {
  /** Conexiones vivas del workspace. */
  conexiones: number;
  /** De esas, cuántas tienen al menos una lectura de cuenta o de contenido. */
  conDatos: number;
}

// =====================================================================
// 1 · La fila de KPIs
// =====================================================================

/**
 * Doce ventanas deslizantes que terminan repartidas entre «hace un
 * periodo» y «ahora». El bucket 0 cubre exactamente el periodo anterior
 * y el 11 exactamente el actual: de ahí salen el valor, la comparación
 * y la sparkline, sin que nadie reste nada fuera de Postgres.
 *
 * `paso` es fraccionario a propósito (dias / 11): con 7 días, once
 * pasos de 0,64 días dan una línea con la misma forma que con 90.
 */
const SQL_KPIS = `
WITH ventana AS (
  SELECT $1::int AS dias,
         $2::text AS red,
         -- greatest() ignora los NULL: basta con que UNA de las dos
         -- fuentes tenga algo para que el módulo tenga "hoy".
         greatest(
           (SELECT max(a.day) FROM account_metric_snapshot a),
           (SELECT (max(s.captured_at) AT TIME ZONE 'UTC')::date FROM post_metric_snapshot s)
         ) AS fin
),
corte AS (
  SELECT v.dias, v.red,
         ((v.fin + 1)::timestamp AT TIME ZONE 'UTC') AS hasta,
         v.dias / 11.0 AS paso
  FROM ventana v
  WHERE v.fin IS NOT NULL
),
-- Desde cuándo hay serie de cuenta. Sirve para descartar las ventanas
-- que la historia no cubre: una SUMA de treinta días sobre una base con
-- tres días de historia no vale cero, no vale nada.
--
-- Solo la usan las views, que son una suma. Los dos KPIs de contenido
-- son RAZONES sobre los posts publicados dentro de la ventana: una
-- ventana que empieza antes del primer post no los falsea, solo los
-- calcula sobre menos videos. Atarlos a este origen era lo que dejaba
-- en null el alcance y los guardados de un workspace recién importado.
origen AS (
  SELECT (SELECT min(a.day) FROM account_metric_snapshot a
            JOIN social_connection sc ON sc.id = a.connection_id AND sc.deleted_at IS NULL
           WHERE ($2::text IS NULL OR sc.platform_id = $2::text)) AS dia_cuenta
),
bucket AS (
  SELECT g.i, c.dias, c.red,
         c.hasta - make_interval(secs => (11 - g.i) * c.paso * 86400) AS fin_b
  FROM corte c CROSS JOIN generate_series(0, 11) AS g(i)
),
-- Seguidores: el último valor conocido de cada conexión en ese instante.
seguidores AS (
  SELECT b.i, sum(u.followers)::bigint AS followers
  FROM bucket b
  CROSS JOIN LATERAL (
    SELECT DISTINCT ON (a.connection_id) a.followers
    FROM account_metric_snapshot a
    JOIN social_connection sc ON sc.id = a.connection_id AND sc.deleted_at IS NULL
    WHERE (b.red IS NULL OR sc.platform_id = b.red)
      AND a.day < (b.fin_b AT TIME ZONE 'UTC')::date
    ORDER BY a.connection_id, a.day DESC
  ) u
  GROUP BY b.i
),
-- Views de la cuenta: suma de los días dentro de la ventana.
vistas AS (
  SELECT b.i, sum(a.views)::bigint AS views
  FROM bucket b
  JOIN social_connection sc ON sc.deleted_at IS NULL AND (b.red IS NULL OR sc.platform_id = b.red)
  JOIN account_metric_snapshot a ON a.connection_id = sc.id
   AND a.day <  (b.fin_b AT TIME ZONE 'UTC')::date
   AND a.day >= ((b.fin_b - make_interval(days => b.dias)) AT TIME ZONE 'UTC')::date
  GROUP BY b.i
),
-- Contenido publicado dentro de la ventana, con su última lectura.
contenido AS (
  SELECT b.i,
         sum(m.reach)::bigint               AS reach,
         sum(m.reach_non_followers)::bigint AS reach_nf,
         sum(m.saves)::bigint               AS saves,
         sum(m.views)::bigint               AS post_views,
         count(*)::int                      AS posts
  FROM bucket b
  JOIN post p ON p.deleted_on_platform = false
             AND (b.red IS NULL OR p.platform_id = b.red)
             AND p.published_at <  b.fin_b
             AND p.published_at >= b.fin_b - make_interval(days => b.dias)
  JOIN post_metrics_latest m ON m.post_id = p.id
  GROUP BY b.i
),
punto AS (
  SELECT b.i,
         to_char((b.fin_b AT TIME ZONE 'UTC')::date - 1, 'YYYY-MM-DD') AS dia,
         -- Los seguidores son un valor de un instante: basta con que
         -- haya una lectura antes, y de eso ya se ocupa la CTE seguidores.
         s.followers,
         -- Las views y el contenido son SUMAS sobre la ventana: si la
         -- ventana empieza antes de que hubiera datos, el número sería
         -- una suma a medias que se lee como una caída.
         CASE WHEN (b.fin_b - make_interval(days => b.dias)) AT TIME ZONE 'UTC' >= o.dia_cuenta
              THEN v.views END AS views,
         -- Razones: valen con los videos que haya en la ventana, y si no
         -- hay ninguno el divisor es NULL y la razón sale NULL sola.
         CASE WHEN c.reach > 0
              THEN c.reach_nf::numeric / c.reach END AS no_seguidores,
         CASE WHEN c.post_views > 0
              THEN c.saves::numeric * 1000 / c.post_views END AS guardados_1k,
         COALESCE(c.posts, 0) AS posts
  FROM bucket b
  CROSS JOIN origen o
  LEFT JOIN seguidores s ON s.i = b.i
  LEFT JOIN vistas     v ON v.i = b.i
  LEFT JOIN contenido  c ON c.i = b.i
)
SELECT p.i, p.dia, p.followers, p.views, p.no_seguidores, p.guardados_1k, p.posts,
       a.followers     AS followers_prev,
       a.views         AS views_prev,
       a.no_seguidores AS no_seguidores_prev,
       a.guardados_1k  AS guardados_1k_prev,
       to_char((SELECT fin FROM ventana), 'YYYY-MM-DD')                       AS hasta,
       to_char((SELECT fin FROM ventana) - ($1::int - 1), 'YYYY-MM-DD')       AS desde
FROM punto p
CROSS JOIN (SELECT * FROM punto WHERE i = 0) a
ORDER BY p.i`;

interface FilaKpi {
  i: number;
  dia: string;
  followers: string | number | null;
  views: string | number | null;
  no_seguidores: string | null;
  guardados_1k: string | null;
  posts: number;
  followers_prev: string | number | null;
  views_prev: string | number | null;
  no_seguidores_prev: string | null;
  guardados_1k_prev: string | null;
  hasta: string;
  desde: string;
}

/** Postgres devuelve bigint y numeric como texto; aquí se convierten una sola vez. */
function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function serie(
  filas: FilaKpi[],
  campo: 'followers' | 'views' | 'no_seguidores' | 'guardados_1k',
  campoPrev: 'followers_prev' | 'views_prev' | 'no_seguidores_prev' | 'guardados_1k_prev',
): KpiSerie {
  const ultima = filas[filas.length - 1];
  const value = ultima ? num(ultima[campo]) : null;
  const previous = ultima ? num(ultima[campoPrev]) : null;
  // Solo el tramo FINAL sin huecos: una ventana que la historia no
  // cubre vuelve NULL, y unir los puntos por encima del hueco dibujaría
  // una subida que nunca pasó.
  const puntos = filas.map((f) => num(f[campo]));
  let trasElUltimoHueco = 0;
  puntos.forEach((v, i) => {
    if (v === null) trasElUltimoHueco = i + 1;
  });
  const spark = puntos.slice(trasElUltimoHueco).filter((v): v is number => v !== null);
  // Sin periodo anterior, o con un cero detrás, no hay variación que contar.
  const delta = value !== null && previous !== null && previous !== 0 ? (value - previous) / previous : null;
  return { value, previous, delta, spark };
}

export function assertPeriodo(dias: number): asserts dias is Periodo {
  if (!(PERIODOS as readonly number[]).includes(dias)) {
    throw new Error(`periodo inválido: ${String(dias)}. Uno de ${PERIODOS.join(', ')}.`);
  }
}

export function assertRed(red: string | null | undefined): asserts red is RedId | null | undefined {
  if (red !== null && red !== undefined && !REDES.includes(red as RedId)) {
    throw new Error(`red inválida: "${red}". Una de ${REDES.join(', ')}.`);
  }
}

const KPIS_VACIOS: KpiSerie = { value: null, previous: null, delta: null, spark: [] };

/** Los cuatro KPIs del Resumen, con su comparación contra el periodo anterior. */
export async function getResumenKpis(tx: WorkspaceTx, filtro: ResumenFiltro): Promise<ResumenKpis> {
  assertPeriodo(filtro.dias);
  assertRed(filtro.red);
  const { rows } = await tx.query<FilaKpi>(SQL_KPIS, [filtro.dias, filtro.red ?? null]);
  if (rows.length === 0) {
    return {
      hasta: null, desde: null,
      followers: KPIS_VACIOS, views: KPIS_VACIOS,
      nonFollowerReach: KPIS_VACIOS, savesPer1k: KPIS_VACIOS,
      posts: 0,
    };
  }
  const ultima = rows[rows.length - 1]!;
  return {
    hasta: ultima.hasta,
    desde: ultima.desde,
    followers: serie(rows, 'followers', 'followers_prev'),
    views: serie(rows, 'views', 'views_prev'),
    nonFollowerReach: serie(rows, 'no_seguidores', 'no_seguidores_prev'),
    savesPer1k: serie(rows, 'guardados_1k', 'guardados_1k_prev'),
    posts: ultima.posts,
  };
}

// =====================================================================
// 2 · Seguidores por red, un punto por día
// =====================================================================

/**
 * El seguidor de un día es el último valor conocido HASTA ese día
 * (arrastre), no el del día exacto: si un día no se sincronizó, la
 * curva no cae a cero.
 *
 * La ventana la decide EL PERIODO, no la conexión más joven. El único
 * suelo es «antes de esto no hay ni una lectura en todo el workspace»:
 * con `greatest(max(day) - (dias-1), min(primer_dia))`, conectar hoy
 * una cuenta nueva ya no recorta la serie de las que llevan meses
 * midiendo —que era lo que dejaba el gráfico en un solo punto.
 *
 * Una red que empezó a medirse dentro de la ventana arranca en cero
 * hasta su primera lectura: la serie del kit es `number[]`, no admite
 * huecos, y un cero es más honesto que arrastrar hacia atrás un valor
 * que nadie midió. La nota del gráfico lo dice.
 */
const SQL_SEGUIDORES = `
WITH conexion AS (
  SELECT sc.id, sc.platform_id,
         (SELECT min(a.day) FROM account_metric_snapshot a WHERE a.connection_id = sc.id) AS primer_dia
  FROM social_connection sc
  WHERE sc.deleted_at IS NULL AND ($2::text IS NULL OR sc.platform_id = $2::text)
),
rango AS (
  SELECT greatest(
           (SELECT max(a.day) FROM account_metric_snapshot a) - ($1::int - 1),
           (SELECT min(c.primer_dia) FROM conexion c WHERE c.primer_dia IS NOT NULL)
         ) AS desde,
         (SELECT max(a.day) FROM account_metric_snapshot a) AS hasta
),
dia AS (
  SELECT generate_series(r.desde, r.hasta, interval '1 day')::date AS day FROM rango r
)
SELECT to_char(d.day, 'YYYY-MM-DD') AS dia, c.platform_id, sum(u.followers)::bigint AS followers
FROM dia d
JOIN conexion c ON c.primer_dia IS NOT NULL AND c.primer_dia <= d.day
CROSS JOIN LATERAL (
  SELECT a.followers FROM account_metric_snapshot a
  WHERE a.connection_id = c.id AND a.day <= d.day
  ORDER BY a.day DESC LIMIT 1
) u
GROUP BY d.day, c.platform_id
ORDER BY d.day, c.platform_id`;

/** Seguidores por red, un punto por día, dentro del periodo. */
export async function getSeguidoresPorRed(tx: WorkspaceTx, filtro: ResumenFiltro): Promise<SerieDiaria> {
  assertPeriodo(filtro.dias);
  assertRed(filtro.red);
  const { rows } = await tx.query<{ dia: string; platform_id: RedId; followers: string | number }>(
    SQL_SEGUIDORES,
    [filtro.dias, filtro.red ?? null],
  );
  return armarSerie(rows.map((r) => ({ label: r.dia, platformId: r.platform_id, value: num(r.followers) ?? 0 })));
}

// =====================================================================
// 3 · Views por bloque (día o semana) y red
// =====================================================================

/**
 * Los bloques se anclan al último día cerrado y caminan hacia atrás, no
 * a la semana del calendario: así el último bloque siempre está
 * completo. Cuántos días cubre cada uno lo decide `pasoDeBloque`.
 *
 * El generate_series va hasta `dias` porque ese es el techo aunque el
 * paso sea 1; quien corta de verdad es el WHERE, que descarta el
 * bloque en cuanto empieza antes del primer día con datos.
 */
const SQL_VIEWS = `
WITH conexion AS (
  SELECT sc.id, sc.platform_id,
         (SELECT min(a.day) FROM account_metric_snapshot a WHERE a.connection_id = sc.id) AS primer_dia
  FROM social_connection sc
  WHERE sc.deleted_at IS NULL AND ($2::text IS NULL OR sc.platform_id = $2::text)
),
rango AS (
  SELECT (SELECT max(a.day) FROM account_metric_snapshot a) AS hasta,
         greatest(
           (SELECT max(a.day) FROM account_metric_snapshot a) - ($1::int - 1),
           (SELECT min(c.primer_dia) FROM conexion c WHERE c.primer_dia IS NOT NULL)
         ) AS desde
),
bloque AS (
  SELECT k,
         (SELECT hasta FROM rango) - ($3::int * (k + 1) - 1) AS inicio,
         (SELECT hasta FROM rango) - ($3::int * k)           AS fin
  FROM generate_series(0, $1::int) AS g(k)
  WHERE (SELECT hasta FROM rango) - ($3::int * (k + 1) - 1) >= (SELECT desde FROM rango)
)
SELECT to_char(b.inicio, 'YYYY-MM-DD') AS inicio,
       to_char(b.fin, 'YYYY-MM-DD')    AS fin,
       c.platform_id,
       COALESCE(sum(a.views), 0)::bigint AS views
FROM bloque b
JOIN conexion c ON c.primer_dia IS NOT NULL AND c.primer_dia <= b.fin
LEFT JOIN account_metric_snapshot a ON a.connection_id = c.id AND a.day BETWEEN b.inicio AND b.fin
GROUP BY b.inicio, b.fin, c.platform_id
ORDER BY b.inicio, c.platform_id`;

/** Views de la cuenta por bloque y red. El paso lo decide pasoDeBloque. */
export async function getViewsPorBloque(tx: WorkspaceTx, filtro: ResumenFiltro): Promise<SeriePorBloque> {
  assertPeriodo(filtro.dias);
  assertRed(filtro.red);
  const paso = pasoDeBloque(filtro.dias);
  const { rows } = await tx.query<{ inicio: string; fin: string; platform_id: RedId; views: string | number }>(
    SQL_VIEWS,
    [filtro.dias, filtro.red ?? null, paso],
  );
  const plano = armarSerie(rows.map((r) => ({ label: r.inicio, platformId: r.platform_id, value: num(r.views) ?? 0 })));
  const finDe = new Map(rows.map((r) => [r.inicio, r.fin] as const));
  return {
    paso,
    bloques: plano.labels.map((inicio) => ({ inicio, fin: finDe.get(inicio) ?? inicio })),
    series: plano.series,
  };
}

/**
 * Cuántos días cubre cada barra. No es una regla estética: BarChart
 * etiqueta el eje x cada `ceil(n/8)` categorías Y ADEMÁS fuerza la
 * última, así que si la última no cae en esa rejilla sus dos etiquetas
 * se pisan y se lee «8 sep15 sep». La condición es
 * `(n - 1) % (n > 8 ? ceil(n / 8) : 1) === 0`, y la comprueba
 * `ultimaEtiquetaEnLaRejilla` en las pruebas.
 *
 * Con doce barras de siete días —las doce semanas del mock— eso NO se
 * cumple: ceil(12/8) = 2 marca 0,2,4,6,8,10 y luego fuerza la 11. Subir
 * el número de etiquetas es cambiar la API del kit, así que lo que se
 * mueve es el número de barras:
 *
 *    7 días →  7 barras de un día      (n ≤ 8: se etiquetan todas)
 *   30 días →  7 barras de cuatro días (n ≤ 8: se etiquetan todas)
 *   90 días →  9 barras de diez días   (cada 2: 0,2,4,6,8 y 8 es la última)
 *
 * De paso caben a 400 px: con quince barras las ocho etiquetas se
 * tocaban en móvil aunque la rejilla cuadrara.
 */
export function pasoDeBloque(dias: Periodo): number {
  return dias >= 90 ? 10 : dias >= 30 ? 4 : 1;
}

/**
 * La regla de etiquetado de BarChart, escrita una sola vez para que la
 * prueba compruebe lo mismo que el kit dibuja.
 */
export function ultimaEtiquetaEnLaRejilla(barras: number): boolean {
  if (barras <= 1) return true;
  const cada = barras > 8 ? Math.ceil(barras / 8) : 1;
  return (barras - 1) % cada === 0;
}

/**
 * Filas (etiqueta, red, valor) → etiquetas ordenadas y una serie por
 * red con un valor por etiqueta. Lo que no vino es cero: la consulta ya
 * dejó fuera las redes que aún no tienen historia en la ventana.
 */
function armarSerie(filas: { label: string; platformId: RedId; value: number }[]): SerieDiaria {
  const labels = [...new Set(filas.map((f) => f.label))].sort();
  const indice = new Map(labels.map((l, i) => [l, i] as const));
  const porRed = new Map<RedId, number[]>();
  for (const f of filas) {
    let data = porRed.get(f.platformId);
    if (!data) {
      data = new Array<number>(labels.length).fill(0);
      porRed.set(f.platformId, data);
    }
    data[indice.get(f.label)!] = f.value;
  }
  const series = REDES.filter((r) => porRed.has(r)).map((platformId) => ({ platformId, data: porRed.get(platformId)! }));
  return { labels, series };
}

// =====================================================================
// 4 · Frescura y cobertura
// =====================================================================

const SQL_FRESCURA = `
SELECT h.id,
       h.platform_id,
       h.handle,
       (SELECT sc.display_name FROM social_connection sc WHERE sc.id = h.id) AS display_name,
       h.status,
       to_char(h.last_synced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_synced_at,
       to_char((SELECT max(a.day) FROM account_metric_snapshot a WHERE a.connection_id = h.id), 'YYYY-MM-DD') AS ultimo_dia_cuenta,
       to_char(u.captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ultima_lectura_contenido,
       u.source AS ultima_fuente,
       h.token_expiring_soon
FROM connection_health h
LEFT JOIN LATERAL (
  SELECT s.captured_at, s.source
  FROM post_metric_snapshot s
  JOIN post p ON p.id = s.post_id
  WHERE p.connection_id = h.id
  ORDER BY s.captured_at DESC
  LIMIT 1
) u ON true
ORDER BY h.platform_id`;

/** Una fila por conexión viva: hasta cuándo llegan sus datos y de dónde vinieron. */
export async function getFrescuraPorConexion(tx: WorkspaceTx): Promise<FrescuraConexion[]> {
  const { rows } = await tx.query<{
    id: string; platform_id: RedId; handle: string | null; display_name: string | null; status: string;
    last_synced_at: string | null; ultimo_dia_cuenta: string | null; ultima_lectura_contenido: string | null;
    ultima_fuente: string | null; token_expiring_soon: boolean | null;
  }>(SQL_FRESCURA);
  return rows.map((r) => ({
    connectionId: r.id,
    platformId: r.platform_id,
    handle: r.handle,
    displayName: r.display_name,
    status: r.status,
    lastSyncedAt: r.last_synced_at,
    ultimoDiaCuenta: r.ultimo_dia_cuenta,
    ultimaLecturaContenido: r.ultima_lectura_contenido,
    ultimaFuente: r.ultima_fuente,
    tokenExpiringSoon: r.token_expiring_soon === true,
  }));
}

/**
 * Lo que la pantalla necesita para elegir entre "estado vacío" y
 * "cifras": cuántas conexiones hay y cuántas traen datos. Un workspace
 * sin conexiones ve el estado vacío, no cuatro ceros.
 */
export async function getCoberturaResumen(tx: WorkspaceTx): Promise<CoberturaResumen> {
  const { rows } = await tx.query<{ conexiones: number; con_datos: number }>(`
    SELECT count(*)::int AS conexiones,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM account_metric_snapshot a WHERE a.connection_id = sc.id)
                OR EXISTS (SELECT 1 FROM post p WHERE p.connection_id = sc.id)
           )::int AS con_datos
    FROM social_connection sc
    WHERE sc.deleted_at IS NULL`);
  const fila = rows[0];
  return { conexiones: fila?.conexiones ?? 0, conDatos: fila?.con_datos ?? 0 };
}

/**
 * Cuántos posts vivos tiene el workspace. Va aparte de `getCoberturaResumen`
 * a propósito: es un conteo completo de la tabla más grande y la
 * cobertura se lee en el camino crítico de /resumen, antes de soltar el
 * shell. Hoy solo lo usan las pruebas y la importación.
 */
export async function contarPosts(tx: WorkspaceTx): Promise<number> {
  const { rows } = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM post');
  return rows[0]?.n ?? 0;
}

// =====================================================================
// 5 · Importación por CSV (RES-2)
// ---------------------------------------------------------------------
// El CSV no trae credenciales, así que la cuenta a la que pertenece se
// guarda con access_mode = 'manual_csv' (valor previsto en 0002) y un
// secret_ref opaco que no resuelve a ningún token: no hay nada que
// descifrar porque no hay nada guardado.
//
// Las lecturas son APPEND-ONLY: importar el mismo archivo dos veces
// añade dos lecturas del mismo post con distinto captured_at, que es
// exactamente lo que el esquema espera. Lo que NO se duplica es el
// post: (platform_id, external_post_id, connection_id) es único, y el
// INSERT usa ese índice.
// =====================================================================

export interface CuentaImportable {
  connectionId: string;
  platformId: RedId;
  handle: string | null;
  displayName: string | null;
  /** 'manual_csv' cuando la creó una importación. */
  accessMode: string;
  posts: number;
}

/** Las cuentas del workspace a las que se puede pegar un CSV. Sin `red`, todas. */
export async function listCuentasImportables(tx: WorkspaceTx, red?: RedId | null): Promise<CuentaImportable[]> {
  assertRed(red);
  const { rows } = await tx.query<{
    id: string; platform_id: RedId; handle: string | null; display_name: string | null; access_mode: string; posts: number;
  }>(
    `SELECT sc.id, sc.platform_id, sc.handle, sc.display_name, sc.access_mode,
            (SELECT count(*)::int FROM post p WHERE p.connection_id = sc.id) AS posts
       FROM social_connection sc
      WHERE sc.deleted_at IS NULL AND ($1::text IS NULL OR sc.platform_id = $1::text)
      ORDER BY sc.platform_id, sc.handle NULLS LAST`,
    [red ?? null],
  );
  return rows.map((r) => ({
    connectionId: r.id,
    platformId: r.platform_id,
    handle: r.handle,
    displayName: r.display_name,
    accessMode: r.access_mode,
    posts: r.posts,
  }));
}

/**
 * De estos identificadores, cuáles YA existen en la cuenta de destino.
 *
 * Es lo que deja que el paso 3 de la importación avise «este video ya
 * está: se añade una lectura nueva» ANTES de escribir, en vez de
 * enterarse en el resumen final. Recibe los ids del archivo y no
 * devuelve la tabla entera: una cuenta con miles de videos no tiene por
 * qué viajar al navegador para comparar veinte filas.
 */
export async function listExternalPostIds(
  tx: WorkspaceTx,
  connectionId: string,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const { rows } = await tx.query<{ external_post_id: string }>(
    'SELECT external_post_id FROM post WHERE connection_id = $1 AND external_post_id = ANY($2::text[])',
    [connectionId, [...new Set(ids)]],
  );
  return rows.map((r) => r.external_post_id);
}

/**
 * La cuenta "importada por CSV": se crea al vuelo la primera vez y se
 * reutiliza después. external_account_id lleva el prefijo csv: para que
 * no choque con el id real si algún día se conecta la cuenta por OAuth.
 */
export async function asegurarCuentaCsv(
  tx: WorkspaceTx,
  input: { red: RedId; handle: string },
): Promise<CuentaImportable> {
  assertRed(input.red);
  const handle = input.handle.trim().replace(/^@/, '');
  if (!handle) throw new Error('El nombre de la cuenta no puede estar vacío.');
  const externo = `csv:${handle.toLowerCase()}`;
  const creador = await getCreadorPorDefecto(tx);
  const { rows } = await tx.query<{ id: string; access_mode: string }>(
    `INSERT INTO social_connection
       (workspace_id, creator_id, platform_id, external_account_id, handle, display_name,
        account_type, secret_ref, scopes, access_mode, status)
     VALUES (current_workspace_id(), $1, $2, $3, $4, $4, 'unknown', $5, '{}', 'manual_csv', 'active')
     ON CONFLICT (platform_id, external_account_id, workspace_id)
       DO UPDATE SET deleted_at = NULL, handle = EXCLUDED.handle
     RETURNING id, access_mode`,
    [creador, input.red, externo, handle, `csv://${input.red}/${handle.toLowerCase()}`],
  );
  const fila = rows[0]!;
  return { connectionId: fila.id, platformId: input.red, handle, displayName: handle, accessMode: fila.access_mode, posts: 0 };
}

/**
 * TODO(CIM-3): el creador saldrá de la sesión. Hasta entonces, el
 * workspace del MVP tiene uno solo y la importación lo cuelga de él.
 */
async function getCreadorPorDefecto(tx: WorkspaceTx): Promise<string> {
  const { rows } = await tx.query<{ id: string }>('SELECT id FROM creator_profile ORDER BY created_at LIMIT 1');
  const id = rows[0]?.id;
  if (!id) throw new Error('El workspace no tiene ningún creador; no hay a qué colgar la cuenta importada.');
  return id;
}

/** post.media_type (CHECK en 0003). Lo que un CSV puede traer. */
export type MediaTypeCsv = 'video' | 'image' | 'carousel' | 'story';

/** Una fila ya validada, lista para escribirse. Los números son enteros o null. */
export interface LecturaCsv {
  externalPostId: string;
  /** ISO 8601. */
  publishedAt: string;
  mediaType: MediaTypeCsv;
  title: string | null;
  url: string | null;
  durationS: number | null;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  followsFromPost: number | null;
  reachNonFollowers: number | null;
}

export interface ResultadoImportacion {
  /** Posts creados por esta importación. */
  postsNuevos: number;
  /** Posts que ya existían y solo recibieron una lectura más. */
  postsConocidos: number;
  /** Filas escritas en post_metric_snapshot. */
  lecturas: number;
  /** ISO del captured_at con el que entraron todas. */
  capturadoEn: string;
}

/**
 * Escribe el lote: un post por fila nueva y SIEMPRE una lectura.
 * `age_hours` sale de la propia base —captured_at menos published_at—,
 * no del navegador: es la columna que hace comparables dos videos
 * publicados en momentos distintos y no puede depender del reloj de
 * quien sube el archivo.
 */
export async function importarLecturasCsv(
  tx: WorkspaceTx,
  input: { connectionId: string; red: RedId; filas: readonly LecturaCsv[] },
): Promise<ResultadoImportacion> {
  assertRed(input.red);
  if (input.filas.length === 0) {
    throw new Error('No hay filas que importar.');
  }
  // La cuenta de destino se comprueba ANTES que nada: es la frontera
  // entre workspaces. Si se mirase después del creador, un connectionId
  // ajeno en un workspace sin creador moriría con el mensaje equivocado
  // y la comprobación que de verdad importa no llegaría a correr.
  const { rows: cuenta } = await tx.query<{ id: string }>(
    'SELECT id FROM social_connection WHERE id = $1 AND deleted_at IS NULL AND platform_id = $2',
    [input.connectionId, input.red],
  );
  if (!cuenta[0]) throw new Error('La cuenta de destino no existe en este workspace.');
  const creador = await getCreadorPorDefecto(tx);

  // Un solo captured_at para todo el lote: las lecturas de un mismo
  // archivo son la misma foto, y así age_hours queda coherente entre ellas.
  const { rows: reloj } = await tx.query<{ ahora: string }>(
    `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ahora`,
  );
  const capturadoEn = reloj[0]!.ahora;

  const ids = input.filas.map((f) => f.externalPostId);
  // La misma consulta que usa la previsualización del paso 3, para que
  // lo que el creador vio antes de confirmar y lo que se le cuenta
  // después salgan del mismo sitio.
  const conocidos = new Set(await listExternalPostIds(tx, input.connectionId, ids));

  // jsonb_to_recordset casa por NOMBRE de campo, así que el lote viaja
  // con las claves de la tabla (snake_case), no con las del tipo.
  const datos = JSON.stringify(
    input.filas.map((f) => ({
      external_post_id: f.externalPostId,
      published_at: f.publishedAt,
      media_type: f.mediaType,
      title: f.title,
      url: f.url,
      duration_s: f.durationS,
      views: f.views,
      reach: f.reach,
      likes: f.likes,
      comments: f.comments,
      shares: f.shares,
      saves: f.saves,
      follows_from_post: f.followsFromPost,
      reach_non_followers: f.reachNonFollowers,
    })),
  );

  await tx.query(
    `INSERT INTO post (workspace_id, creator_id, connection_id, platform_id, external_post_id,
                       url, media_type, title, duration_s, published_at)
     SELECT current_workspace_id(), $1, $2, $3, f.external_post_id, f.url, f.media_type, f.title,
            f.duration_s, f.published_at
     FROM jsonb_to_recordset($4::jsonb) AS f(
       external_post_id text, url text, media_type text, title text, duration_s numeric, published_at timestamptz)
     ON CONFLICT (platform_id, external_post_id, connection_id) DO NOTHING`,
    [creador, input.connectionId, input.red, datos],
  );

  const { rows: escritas } = await tx.query<{ n: number }>(
    `WITH entrada AS (
       SELECT * FROM jsonb_to_recordset($3::jsonb) AS f(
         external_post_id text, published_at timestamptz, views bigint, reach bigint, likes bigint,
         comments bigint, shares bigint, saves bigint, follows_from_post bigint, reach_non_followers bigint)
     ),
     escritas AS (
       INSERT INTO post_metric_snapshot
         (post_id, workspace_id, captured_at, age_hours, views, reach, likes, comments, shares, saves,
          total_interactions, follows_from_post, reach_followers, reach_non_followers, source)
       SELECT p.id, current_workspace_id(), $2::timestamptz,
              round(EXTRACT(EPOCH FROM ($2::timestamptz - p.published_at)) / 3600.0, 2),
              e.views, e.reach, e.likes, e.comments, e.shares, e.saves,
              COALESCE(e.likes, 0) + COALESCE(e.comments, 0) + COALESCE(e.shares, 0) + COALESCE(e.saves, 0),
              e.follows_from_post,
              CASE WHEN e.reach IS NOT NULL AND e.reach_non_followers IS NOT NULL
                   THEN e.reach - e.reach_non_followers END,
              e.reach_non_followers,
              'csv_import'
       FROM entrada e
       JOIN post p ON p.connection_id = $1 AND p.external_post_id = e.external_post_id
       RETURNING 1
     )
     SELECT count(*)::int AS n FROM escritas`,
    [input.connectionId, capturadoEn, datos],
  );

  // La cuenta importada queda "sincronizada" al momento del archivo:
  // es lo que connection_health y el aviso de frescura van a contar.
  await tx.query('UPDATE social_connection SET last_synced_at = $2::timestamptz WHERE id = $1', [
    input.connectionId,
    capturadoEn,
  ]);

  return {
    postsNuevos: ids.filter((id) => !conocidos.has(id)).length,
    postsConocidos: conocidos.size,
    lecturas: escritas[0]?.n ?? 0,
    capturadoEn,
  };
}
