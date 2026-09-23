/**
 * Consultas del módulo Resumen. Dueño: Rasheed (RES-1, RES-2).
 *
 * Toda función recibe un WorkspaceTx: una transacción con el workspace
 * ya fijado. RLS filtra las lecturas; los INSERT usan
 * current_workspace_id(). Ninguna recibe workspace_id suelto.
 *
 * Y la regla que comparte todo queries/: un id que llega de fuera se
 * valida con `isUuid` antes de consultar (ver el bloque de
 * queries/cotizar.ts). Drizzle y pg parametrizan, así que no hay
 * inyección, pero un id imposible acabaría en un 22P02 crudo de
 * Postgres en vez de en el error del producto. `limit`, el periodo y
 * la red también se validan: lo que llega de la URL no tiene por qué
 * llegar a Postgres.
 *
 * La regla que manda en este archivo: **ninguna pantalla hace
 * aritmética de métricas**. Las sumas por red, la comparación contra el
 * periodo anterior, la razón de alcance en no seguidores y los
 * guardados por mil se calculan en SQL, sobre account_metric_snapshot y
 * la vista post_metrics_latest. React solo formatea lo que llega.
 *
 * El reloj: el "hoy" del módulo es el ÚLTIMO DÍA CERRADO con lecturas,
 * no now(). Mira las DOS fuentes:
 *
 *   - la serie de cuenta (account_metric_snapshot, que llena el
 *     recolector): su último `day` ya es un día cerrado;
 *   - las lecturas de contenido (post_metric_snapshot, que llena también
 *     la importación por CSV): una lectura tomada el día D describe el
 *     contenido hasta el día D-1 cerrado, igual que el recolector.
 *
 * Sin la segunda fuente, un workspace que solo subió un archivo —el
 * creador para el que existe RES-2— no tenía "hoy" y el Resumen entero
 * salía en blanco. Sin el «menos un día», importar un CSV a media tarde
 * movía el reloj a un día que la serie de cuenta aún no tiene y la suma
 * de visualizaciones perdía un día entero contra el periodo anterior.
 *
 * Pero el reloj del módulo NO es el final de las sumas de la cuenta. Las
 * visualizaciones y los seguidores de la serie de cuenta terminan en el
 * último día que ESA serie cerró, en las conexiones del filtro. Entre las
 * 00:00 UTC y el cierre de madrugada del recolector, cualquier lectura de
 * contenido (el propio recolector, un CSV) lleva el reloj a D mientras la
 * cuenta sigue en D-1: con el reloj como final, la ventana actual perdía
 * un día entero y el periodo anterior no, y salía una caída falsa (cerca
 * de -14 % con 7 días) justo en el KPI principal. Con `?red=tiktok` y
 * TikTok atrasado, la ventana arrastraba los días que puso otra red.
 *
 * Y los días son días cerrados en UTC, por convención del repositorio
 * («la app trabaja en UTC»): `account_metric_snapshot.day` es el día de
 * la plataforma y no se puede pasar a otra zona. La pantalla lo dice
 * una sola vez, en el aviso de frescura, con palabras de creador.
 *
 * Las fechas `date` salen como 'YYYY-MM-DD' (to_char) para no depender
 * de la zona horaria del driver; los timestamptz, como ISO 8601 en UTC.
 */
import { desc } from 'drizzle-orm';
import { isUuid, type WorkspaceTx } from '../client.ts';
import { creatorPostBoard } from '../schema/index.ts';
import {
  assertPeriod,
  assertPlatform,
  MIN_SAMPLE,
  PLATFORMS,
  VIEWS_WEEKS,
  type Period,
  type PlatformId,
} from './resumen-constantes.ts';

// Las redes y los periodos viven en un módulo aparte SIN dependencias
// de servidor: los componentes cliente de la web los importan como
// valores, y este archivo arrastra el cliente de Postgres (isUuid).
export {
  assertPeriod,
  assertPlatform,
  MIN_SAMPLE,
  PERIODS,
  PLATFORMS,
  VIEWS_WEEKS,
  type Period,
  type PlatformId,
} from './resumen-constantes.ts';

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

export interface ResumenFilter {
  /** 7, 30 o 90 días. */
  days: Period;
  /** null = todas las redes. */
  platform?: PlatformId | null;
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
export interface KpiSeries {
  /** null cuando no hay ninguna lectura con la que calcularlo. */
  value: number | null;
  /**
   * El valor del periodo anterior, de las MISMAS cuentas con las que se
   * calcula `delta` (ver `newAccounts`). null si no existe.
   */
  previous: number | null;
  /**
   * La variación contra el periodo anterior. null si el periodo anterior
   * es cero o no existe. Lo calcula Postgres (SQL_KPIS), no este archivo.
   * Qué unidad lleva lo dice `deltaKind`.
   */
  delta: number | null;
  /**
   * 'relative': 0.31 = +31 % (las sumas y los guardados por mil).
   * 'points': diferencia de dos razones, 0.021 = +2,1 puntos. Es la del
   * alcance en no seguidores: un KPI que ya es un porcentaje y cuya
   * variación relativa («56 %  ▲ +4 %») se leía como puntos.
   */
  deltaKind: 'relative' | 'points';
  /**
   * El tramo final sin huecos. Con menos de dos puntos, no se dibuja. En
   * los KPIs de la cuenta sale de las mismas cuentas que `delta`, así que
   * una cuenta recién conectada no dibuja una subida que nunca pasó.
   */
  spark: number[];
  /**
   * En los KPIs de la cuenta: cuántas conexiones suman en `value` pero NO
   * en `previous`, `delta` ni `spark`, porque empezaron a medirse dentro
   * del tramo que se compara. Conectar un canal de 300 000 seguidores no
   * es crecer un 79 %.
   */
  newAccounts?: number;
  /**
   * Sobre cuántos videos se calculó `value`, en los KPIs de contenido.
   * Es la base REAL de la razón: los videos que no traen los dos
   * términos (un CSV sin alcance en no seguidores, uno sin guardados)
   * no entran, así que puede ser menor que `posts`.
   */
  sample?: number;
  /**
   * En los KPIs de contenido: true cuando HAY valor y periodo anterior,
   * pero alguno de los dos se calculó sobre menos de MIN_SAMPLE videos.
   * Entonces `delta` es null a propósito —una variación sobre un video
   * es ruido— y la pantalla dice «pocos videos para comparar» en vez de
   * «sin periodo anterior».
   */
  lowSample?: boolean;
}

/** De dónde sale la cifra de visualizaciones. */
export type ViewsSource = 'account' | 'content';

export interface ResumenKpis {
  /** Último día cerrado con lecturas, 'YYYY-MM-DD'. null si el workspace no tiene ninguna. */
  end: string | null;
  /** Primer día del periodo, 'YYYY-MM-DD'. */
  start: string | null;
  /** Seguidores sumados de las redes del filtro, al final del periodo. */
  followers: KpiSeries;
  /**
   * Visualizaciones dentro del periodo. Con serie de cuenta, las de la
   * cuenta (`viewsSource = 'account'`); sin ella —un workspace que solo
   * importó CSV—, la suma de lo publicado en el periodo con su última
   * lectura (`'content'`). La pantalla dice cuál de las dos es.
   */
  views: KpiSeries;
  viewsSource: ViewsSource | null;
  /**
   * Los días que suman las visualizaciones, 'YYYY-MM-DD' inclusive. Con
   * serie de cuenta terminan en el último día que la cuenta cerró, que
   * puede ir por detrás de `end`; sin ella, coinciden con start/end.
   * null si no hay cifra.
   */
  viewsWindow: { start: string; end: string } | null;
  /** Razón 0..1: alcance en no seguidores sobre alcance, de lo publicado en el periodo. */
  nonFollowerReach: KpiSeries;
  /** Guardados por cada mil visualizaciones de lo publicado en el periodo. */
  savesPer1k: KpiSeries;
  /** Videos publicados en el periodo, con al menos una lectura. */
  posts: number;
  /** ¿Alguna conexión del filtro tiene serie de cuenta? Sin ella no hay seguidores. */
  hasAccountSeries: boolean;
}

export interface PlatformSeries {
  platformId: PlatformId;
  data: number[];
}

export interface DailySeries {
  /** Un día por punto, 'YYYY-MM-DD', de más viejo a más nuevo. */
  labels: string[];
  series: PlatformSeries[];
  /** ¿Alguna conexión del filtro tiene serie de cuenta? Distingue «sin cuenta» de «sin datos en el periodo». */
  hasAccountSeries: boolean;
}

export interface Bucket {
  /** 'YYYY-MM-DD', inclusive. */
  start: string;
  /** 'YYYY-MM-DD', inclusive. */
  end: string;
}

/**
 * Visualizaciones por semana y red: hasta VIEWS_WEEKS semanas de siete
 * días, de más vieja a más nueva, SIEMPRE las mismas sea cual sea el
 * periodo del filtro (ver getViewsByWeek).
 */
export interface WeekSeries {
  /** Cada semana, con su primer y su último día. Siete días exactos. */
  weeks: Bucket[];
  series: PlatformSeries[];
  /** 'account': visualizaciones diarias de la cuenta. 'content': de lo publicado en cada semana. */
  source: ViewsSource;
}

export interface ConnectionFreshness {
  connectionId: string;
  platformId: PlatformId;
  handle: string | null;
  displayName: string | null;
  /** social_connection.status: 'active', 'expired', 'revoked', 'error', 'needs_reauth' o 'disabled'. */
  status: string;
  accessMode: string;
  /** ISO, o null si nunca se sincronizó. */
  lastSyncedAt: string | null;
  /** Último día cerrado de la serie de cuenta, 'YYYY-MM-DD'. */
  lastAccountDay: string | null;
  /**
   * Último día cerrado que cubre una lectura de contenido que NO vino de
   * un CSV (API, agregador, a mano), 'YYYY-MM-DD'. Con la regla del
   * reloj: una lectura tomada el día D (en UTC) cubre hasta D-1.
   */
  lastSyncedReadingDay: string | null;
  /** Lo mismo para la última lectura importada por CSV. Una conexión OAuth también puede tenerla. */
  lastCsvDay: string | null;
  /**
   * El INSTANTE de la última lectura importada por CSV (ISO en UTC): el
   * momento de la exportación que el creador escribió en el paso 2. La
   * pantalla lo enseña tal cual, en la zona del workspace («exportado el
   * 12 sep»), para que diga la misma fecha que el asistente. La regla
   * del reloj (D-1) sigue mandando en `lastCsvDay`, `dataUntil` y
   * `daysBehind`.
   */
  lastCsvExportAt: string | null;
  /** El más reciente de los tres, 'YYYY-MM-DD'. null = sin ninguna lectura. */
  dataUntil: string | null;
  /**
   * Cuántos días va esta conexión por detrás del reloj del módulo (el
   * último día cerrado del workspace). 0 = al día. null = sin lecturas.
   */
  daysBehind: number | null;
  tokenExpiringSoon: boolean;
}

export interface ResumenCoverage {
  /** Conexiones vivas del workspace. */
  connections: number;
  /** De esas, cuántas tienen al menos una lectura de cuenta o de contenido. */
  withData: number;
}

// =====================================================================
// 0 · Piezas de SQL que comparten las consultas
// =====================================================================

/**
 * El reloj del módulo (ver la cabecera). Un solo fragmento para que los
 * KPIs, las dos series y el aviso de frescura no puedan discrepar sobre
 * qué día es "hoy".
 */
const SQL_ULTIMO_DIA = `greatest(
  (SELECT max(a.day) FROM account_metric_snapshot a
     JOIN social_connection sc ON sc.id = a.connection_id AND sc.deleted_at IS NULL),
  (SELECT (max(s.captured_at) AT TIME ZONE 'UTC')::date - 1 FROM post_metric_snapshot s
     JOIN post p ON p.id = s.post_id
     JOIN social_connection sc ON sc.id = p.connection_id AND sc.deleted_at IS NULL)
)`;

/** ¿Hay serie de cuenta en alguna conexión viva del filtro? $1 = red o NULL. */
const SQL_HAY_SERIE_CUENTA = `
SELECT EXISTS (
  SELECT 1 FROM account_metric_snapshot a
  JOIN social_connection sc ON sc.id = a.connection_id AND sc.deleted_at IS NULL
  WHERE ($1::text IS NULL OR sc.platform_id = $1::text)
) AS hay`;

async function hasAccountSeries(tx: WorkspaceTx, platform: PlatformId | null): Promise<boolean> {
  const { rows } = await tx.query<{ hay: boolean }>(SQL_HAY_SERIE_CUENTA, [platform]);
  return rows[0]?.hay === true;
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
 *
 * DOS finales de ventana, no uno (ver la cabecera):
 *
 *   - `fin_b`, el reloj del módulo, para el contenido publicado;
 *   - `fin_c`, el último día que cerró la serie de cuenta de las
 *     conexiones DEL FILTRO, para seguidores y visualizaciones de la
 *     cuenta. Es el mismo desplazamiento en los doce buckets, así que el
 *     periodo anterior se corre igual que el actual y siguen siendo
 *     comparables.
 *
 * Comparación ENTRE IGUALES en los KPIs de la cuenta. El valor que se
 * enseña suma todas las cuentas, pero el periodo anterior, la variación
 * y la sparkline salen solo de las cuentas que ya se medían al principio
 * del tramo comparado:
 *
 *   - seguidores: las que tenían una lectura antes del instante del
 *     bucket 0;
 *   - visualizaciones: las que cubren la ventana del bucket 0 ENTERA.
 *
 * Sin esto, conectar un canal de 300 000 seguidores hace diez días
 * pasaba la tarjeta de «+3 %» a «+79 %», con una subida en la sparkline
 * que nunca pasó, y conectar las cuentas una a una es justo el primer
 * uso de un cliente nuevo. Las que quedan fuera se cuentan
 * (`nuevas_*`) para que la tarjeta lo diga.
 *
 * Si NINGUNA cuenta es comparable no hay periodo anterior. La sparkline
 * sale entonces de un conjunto fijo —las que cubren el periodo actual,
 * en visualizaciones; todas, en seguidores— y solo en los buckets que
 * ese conjunto cubre entero: el tramo final, sin escalones.
 *
 * Una suma de visualizaciones cuya ventana actual no cubre NINGUNA
 * cuenta vale NULL, no cero: sería una suma a medias que se lee como
 * una caída.
 *
 * Los dos KPIs de contenido son RAZONES, y cada una se calcula SOLO
 * sobre los videos que traen sus dos términos. Sumar en el denominador
 * el alcance de un video que no trae alcance en no seguidores (el CSV
 * de Instagram no lo trae) bajaba la razón sin que pasara nada real.
 *
 * Y se leen con la ÚLTIMA lectura de cada video (vida completa) en las
 * dos ventanas, no con un corte de edad fijo. Es una decisión: el corte
 * de post_metrics_at_cut no tiene alcance en no seguidores, y un video
 * importado por CSV tiene UNA sola lectura, a la edad que tuviera el
 * día de la exportación, así que con un corte de 72 h o 7 d todo lo
 * importado quedaba fuera. Al ser razones y no sumas, la edad pesa
 * poco: los guardados y las visualizaciones crecen juntos. La nota del
 * KPI lo dice.
 *
 * La variación del alcance en no seguidores va en PUNTOS (diferencia de
 * las dos razones), no relativa: es un porcentaje, y «56 %  ▲ +4 %» se
 * leía como «de 52 % a 56 %» cuando era de 53,8 % a 56 %. Los guardados
 * por mil no son un porcentaje y su variación sigue siendo relativa.
 */
const SQL_KPIS = `
WITH ventana AS (
  SELECT ${SQL_ULTIMO_DIA} AS fin
),
-- La serie de cuenta de cada conexión viva del filtro: desde y hasta cuándo.
cuenta AS (
  SELECT a.connection_id AS id, min(a.day) AS primer_dia, max(a.day) AS ultimo_dia
  FROM account_metric_snapshot a
  JOIN social_connection sc ON sc.id = a.connection_id AND sc.deleted_at IS NULL
  WHERE ($2::text IS NULL OR sc.platform_id = $2::text)
  GROUP BY a.connection_id
),
corte AS (
  SELECT $1::int AS dias, $2::text AS red,
         ((v.fin + 1)::timestamp AT TIME ZONE 'UTC') AS hasta,
         -- El final de las sumas de la cuenta: su último día cerrado en
         -- el filtro. Sin serie de cuenta da igual (nadie lo lee).
         ((COALESCE((SELECT max(c.ultimo_dia) FROM cuenta c), v.fin) + 1)::timestamp AT TIME ZONE 'UTC') AS hasta_cuenta,
         $1::int / 11.0 AS paso
  FROM ventana v
  WHERE v.fin IS NOT NULL
),
bucket AS (
  SELECT g.i, c.dias, c.red,
         c.hasta        - make_interval(secs => (11 - g.i) * c.paso * 86400) AS fin_b,
         c.hasta_cuenta - make_interval(secs => (11 - g.i) * c.paso * 86400) AS fin_c
  FROM corte c CROSS JOIN generate_series(0, 11) AS g(i)
),
-- Los días de la serie de cuenta que mira cada bucket: [desde, antes_de).
dia AS (
  SELECT b.i,
         ((b.fin_c - make_interval(days => b.dias)) AT TIME ZONE 'UTC')::date AS desde,
         (b.fin_c AT TIME ZONE 'UTC')::date                                   AS antes_de
  FROM bucket b
),
-- Qué cuenta entra en qué comparación.
conjunto AS (
  SELECT c.id, c.primer_dia,
         c.primer_dia <= d0.desde    AS compara_vistas,
         c.primer_dia <  d0.antes_de AS compara_seguidores,
         c.primer_dia <= d11.desde   AS cubre_actual
  FROM cuenta c
  CROSS JOIN (SELECT * FROM dia WHERE i = 0)  d0
  CROSS JOIN (SELECT * FROM dia WHERE i = 11) d11
),
ref AS (
  SELECT count(*) > 0                                 AS hay_cuenta,
         COALESCE(bool_or(compara_vistas), false)     AS hay_vistas,
         COALESCE(bool_or(compara_seguidores), false) AS hay_seguidores,
         COALESCE(bool_or(cubre_actual), false)       AS cubre_actual,
         count(*)::int                                AS cuentas
  FROM conjunto
),
-- El conjunto fijo del que salen el periodo anterior, la variación y la sparkline.
ref_vistas AS (
  SELECT k.id, k.primer_dia FROM conjunto k CROSS JOIN ref r
  WHERE CASE WHEN r.hay_vistas THEN k.compara_vistas ELSE k.cubre_actual END
),
ref_seguidores AS (
  SELECT k.id, k.primer_dia FROM conjunto k CROSS JOIN ref r
  WHERE CASE WHEN r.hay_seguidores THEN k.compara_seguidores ELSE true END
),
-- Seguidores: el último valor conocido de cada conexión en ese instante.
-- El total, de todas; el comparable, solo de las del conjunto fijo.
seguidores AS (
  SELECT d.i,
         sum(u.followers)::bigint                         AS followers,
         sum(u.followers) FILTER (WHERE u.en_ref)::bigint AS followers_ref,
         count(*) FILTER (WHERE u.en_ref)::int            AS con_lectura
  FROM dia d
  CROSS JOIN LATERAL (
    SELECT DISTINCT ON (a.connection_id) a.followers,
           EXISTS (SELECT 1 FROM ref_seguidores r WHERE r.id = a.connection_id) AS en_ref
    FROM account_metric_snapshot a
    JOIN cuenta c ON c.id = a.connection_id
    WHERE a.day < d.antes_de
    ORDER BY a.connection_id, a.day DESC
  ) u
  GROUP BY d.i
),
-- Visualizaciones de la cuenta: suma de los días dentro de la ventana.
vistas AS (
  SELECT d.i,
         sum(a.views)::bigint                                 AS views,
         sum(a.views) FILTER (WHERE r.id IS NOT NULL)::bigint AS views_ref
  FROM dia d
  JOIN account_metric_snapshot a ON a.day >= d.desde AND a.day < d.antes_de
  JOIN cuenta c ON c.id = a.connection_id
  LEFT JOIN ref_vistas r ON r.id = a.connection_id
  GROUP BY d.i
),
-- Contenido publicado dentro de la ventana, con su última lectura. Cada
-- razón lleva su propio FILTER: solo los videos con los dos términos.
contenido AS (
  SELECT b.i,
         sum(m.reach)               FILTER (WHERE m.reach > 0 AND m.reach_non_followers IS NOT NULL)::bigint AS reach,
         sum(m.reach_non_followers) FILTER (WHERE m.reach > 0 AND m.reach_non_followers IS NOT NULL)::bigint AS reach_nf,
         count(*)                   FILTER (WHERE m.reach > 0 AND m.reach_non_followers IS NOT NULL)::int    AS posts_nf,
         sum(m.saves)               FILTER (WHERE m.views > 0 AND m.saves IS NOT NULL)::bigint               AS saves,
         sum(m.views)               FILTER (WHERE m.views > 0 AND m.saves IS NOT NULL)::bigint               AS views_sv,
         count(*)                   FILTER (WHERE m.views > 0 AND m.saves IS NOT NULL)::int                  AS posts_sv,
         sum(m.views)::bigint                                                                                AS post_views,
         count(*)::int                                                                                       AS posts
  FROM bucket b
  JOIN post p ON p.deleted_on_platform = false
             AND (b.red IS NULL OR p.platform_id = b.red)
             AND p.published_at <  b.fin_b
             AND p.published_at >= b.fin_b - make_interval(days => b.dias)
  JOIN social_connection sc ON sc.id = p.connection_id AND sc.deleted_at IS NULL
  JOIN post_metrics_latest m ON m.post_id = p.id
  GROUP BY b.i
),
punto AS (
  SELECT b.i,
         s.followers,
         -- Solo si TODAS las del conjunto fijo tenían ya una lectura.
         CASE WHEN s.con_lectura = (SELECT count(*) FROM ref_seguidores) THEN s.followers_ref END AS followers_cmp,
         -- Con serie de cuenta, las visualizaciones son las de la cuenta.
         -- Sin ella, las de lo publicado en la ventana: una suma sobre
         -- los videos que conocemos, que vale NULL si no hay ninguno.
         CASE WHEN r.hay_cuenta
              THEN CASE WHEN r.cubre_actual THEN v.views END
              ELSE c.post_views END AS views,
         CASE WHEN r.hay_cuenta
              THEN CASE WHEN d.desde >= (SELECT max(x.primer_dia) FROM ref_vistas x) THEN v.views_ref END
              ELSE c.post_views END AS views_cmp,
         CASE WHEN c.reach > 0      THEN c.reach_nf::numeric / c.reach END AS no_seguidores,
         CASE WHEN c.views_sv > 0   THEN c.saves::numeric * 1000 / c.views_sv END AS guardados_1k,
         COALESCE(c.posts_nf, 0) AS posts_nf,
         COALESCE(c.posts_sv, 0) AS posts_sv,
         COALESCE(c.posts, 0)    AS posts,
         r.hay_cuenta,
         r.cuentas - (SELECT count(*) FROM ref_seguidores)::int AS nuevas_seguidores,
         r.cuentas - (SELECT count(*) FROM ref_vistas)::int     AS nuevas_vistas,
         d.desde, d.antes_de
  FROM bucket b
  JOIN dia d ON d.i = b.i
  CROSS JOIN ref r
  LEFT JOIN seguidores s ON s.i = b.i
  LEFT JOIN vistas     v ON v.i = b.i
  LEFT JOIN contenido  c ON c.i = b.i
)
SELECT p.i, p.followers, p.followers_cmp, p.views, p.views_cmp, p.no_seguidores, p.guardados_1k,
       p.posts, p.posts_nf, p.posts_sv, p.hay_cuenta, p.nuevas_seguidores, p.nuevas_vistas,
       a.followers_cmp AS followers_prev,
       a.views_cmp     AS views_prev,
       a.no_seguidores AS no_seguidores_prev,
       a.guardados_1k  AS guardados_1k_prev,
       -- La variación contra el periodo anterior, también aquí, y SIEMPRE
       -- entre las mismas cuentas: el actual comparable contra el anterior
       -- comparable. Sin periodo anterior, o con un cero detrás, no hay.
       CASE WHEN a.followers_cmp > 0 THEN p.followers_cmp::numeric / a.followers_cmp - 1 END AS followers_delta,
       CASE WHEN a.views_cmp > 0     THEN p.views_cmp::numeric / a.views_cmp - 1         END AS views_delta,
       -- En puntos: la diferencia de las dos razones. Las dos razones de
       -- contenido solo se comparan con al menos $3 videos (MIN_SAMPLE)
       -- en CADA periodo: «−50 %» sobre un video es ruido, no una caída.
       CASE WHEN p.posts_nf >= $3 AND a.posts_nf >= $3
            THEN p.no_seguidores - a.no_seguidores END                                     AS no_seguidores_delta,
       CASE WHEN a.guardados_1k > 0 AND p.posts_sv >= $3 AND a.posts_sv >= $3
            THEN p.guardados_1k / a.guardados_1k - 1 END                                   AS guardados_1k_delta,
       (p.no_seguidores IS NOT NULL AND a.no_seguidores IS NOT NULL
        AND (p.posts_nf < $3 OR a.posts_nf < $3))                                          AS no_seguidores_poca,
       (p.guardados_1k IS NOT NULL AND a.guardados_1k > 0
        AND (p.posts_sv < $3 OR a.posts_sv < $3))                                          AS guardados_1k_poca,
       to_char((SELECT fin FROM ventana), 'YYYY-MM-DD')                 AS hasta,
       to_char((SELECT fin FROM ventana) - ($1::int - 1), 'YYYY-MM-DD') AS desde,
       -- Los días que suman las visualizaciones de la cuenta: [desde, antes_de).
       to_char(p.desde, 'YYYY-MM-DD')        AS vistas_desde,
       to_char(p.antes_de - 1, 'YYYY-MM-DD') AS vistas_hasta
FROM punto p
CROSS JOIN (SELECT * FROM punto WHERE i = 0) a
ORDER BY p.i`;

interface FilaKpi {
  i: number;
  followers: string | number | null;
  followers_cmp: string | number | null;
  views: string | number | null;
  views_cmp: string | number | null;
  no_seguidores: string | null;
  guardados_1k: string | null;
  posts: number;
  posts_nf: number;
  posts_sv: number;
  hay_cuenta: boolean;
  nuevas_seguidores: number;
  nuevas_vistas: number;
  followers_prev: string | number | null;
  views_prev: string | number | null;
  no_seguidores_prev: string | null;
  guardados_1k_prev: string | null;
  followers_delta: string | null;
  views_delta: string | null;
  no_seguidores_delta: string | null;
  guardados_1k_delta: string | null;
  no_seguidores_poca: boolean;
  guardados_1k_poca: boolean;
  hasta: string;
  desde: string;
  vistas_desde: string;
  vistas_hasta: string;
}

/** Postgres devuelve bigint y numeric como texto; aquí se convierten una sola vez. */
function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

type CampoKpi = 'followers' | 'views' | 'no_seguidores' | 'guardados_1k';

/**
 * De qué columna sale la sparkline de cada KPI. En los de la cuenta, de
 * la comparable (las mismas cuentas que el delta); en los de contenido,
 * del propio valor.
 */
const COLUMNA_SPARK = {
  followers: 'followers_cmp',
  views: 'views_cmp',
  no_seguidores: 'no_seguidores',
  guardados_1k: 'guardados_1k',
} as const satisfies Record<CampoKpi, keyof FilaKpi>;

/**
 * Las doce filas de SQL_KPIS → un KpiSeries. Aquí no se calcula nada:
 * el valor, el del periodo anterior y la variación llegan hechos de
 * Postgres; esto solo los convierte a número y recorta la sparkline.
 */
function serie(filas: FilaKpi[], campo: CampoKpi, deltaKind: KpiSeries['deltaKind'] = 'relative'): KpiSeries {
  const ultima = filas[filas.length - 1];
  const value = ultima ? num(ultima[campo]) : null;
  const previous = ultima ? num(ultima[`${campo}_prev`]) : null;
  const delta = ultima ? num(ultima[`${campo}_delta`]) : null;
  // Solo el tramo FINAL sin huecos: una ventana que la historia no
  // cubre vuelve NULL, y unir los puntos por encima del hueco dibujaría
  // una subida que nunca pasó.
  const puntos = filas.map((f) => num(f[COLUMNA_SPARK[campo]]));
  let trasElUltimoHueco = 0;
  puntos.forEach((v, i) => {
    if (v === null) trasElUltimoHueco = i + 1;
  });
  const spark = puntos.slice(trasElUltimoHueco).filter((v): v is number => v !== null);
  return { value, previous, delta, deltaKind, spark };
}

const KPI_VACIO: KpiSeries = { value: null, previous: null, delta: null, deltaKind: 'relative', spark: [] };

/** Los cuatro KPIs del Resumen, con su comparación contra el periodo anterior. */
export async function getResumenKpis(tx: WorkspaceTx, filter: ResumenFilter): Promise<ResumenKpis> {
  assertPeriod(filter.days);
  assertPlatform(filter.platform);
  const { rows } = await tx.query<FilaKpi>(SQL_KPIS, [filter.days, filter.platform ?? null, MIN_SAMPLE]);
  if (rows.length === 0) {
    return {
      end: null, start: null,
      followers: KPI_VACIO, views: KPI_VACIO, viewsSource: null, viewsWindow: null,
      nonFollowerReach: { ...KPI_VACIO, deltaKind: 'points' }, savesPer1k: KPI_VACIO,
      posts: 0,
      hasAccountSeries: false,
    };
  }
  const ultima = rows[rows.length - 1]!;
  const views = serie(rows, 'views');
  const viewsSource: ViewsSource | null = views.value === null ? null : ultima.hay_cuenta ? 'account' : 'content';
  return {
    end: ultima.hasta,
    start: ultima.desde,
    followers: { ...serie(rows, 'followers'), newAccounts: ultima.nuevas_seguidores },
    views: ultima.hay_cuenta ? { ...views, newAccounts: ultima.nuevas_vistas } : views,
    viewsSource,
    viewsWindow:
      viewsSource === null
        ? null
        : viewsSource === 'account'
          ? { start: ultima.vistas_desde, end: ultima.vistas_hasta }
          : { start: ultima.desde, end: ultima.hasta },
    nonFollowerReach: {
      ...serie(rows, 'no_seguidores', 'points'),
      sample: ultima.posts_nf,
      lowSample: ultima.no_seguidores_poca === true,
    },
    savesPer1k: { ...serie(rows, 'guardados_1k'), sample: ultima.posts_sv, lowSample: ultima.guardados_1k_poca === true },
    posts: ultima.posts,
    hasAccountSeries: ultima.hay_cuenta,
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
 * con `greatest(fin - (dias-1), min(primer_dia))`, conectar hoy una
 * cuenta nueva ya no recorta la serie de las que llevan meses midiendo.
 *
 * Una red que empezó a medirse dentro de la ventana arranca en cero
 * hasta su primera lectura: la serie del kit es `number[]`, no admite
 * huecos, y un cero es más honesto que arrastrar hacia atrás un valor
 * que nadie midió. La nota del gráfico lo dice.
 *
 * Los seguidores solo existen en la serie de cuenta: un CSV trae
 * métricas por video, no de la cuenta. Sin serie, la respuesta sale
 * vacía y `hasAccountSeries` le dice a la pantalla por qué.
 *
 * Y la curva termina donde termina la serie de cuenta DEL FILTRO, igual
 * que la tarjeta de seguidores (ver SQL_KPIS): una lectura de contenido
 * que adelanta el reloj del módulo no añade un día que la cuenta aún no
 * ha cerrado.
 */
const SQL_SEGUIDORES = `
WITH conexion AS (
  SELECT sc.id, sc.platform_id, a.primer_dia, a.ultimo_dia
  FROM social_connection sc
  CROSS JOIN LATERAL (
    SELECT min(x.day) AS primer_dia, max(x.day) AS ultimo_dia
    FROM account_metric_snapshot x WHERE x.connection_id = sc.id
  ) a
  WHERE sc.deleted_at IS NULL AND ($2::text IS NULL OR sc.platform_id = $2::text)
),
reloj AS (SELECT max(c.ultimo_dia) AS fin FROM conexion c),
rango AS (
  SELECT greatest(
           (SELECT fin FROM reloj) - ($1::int - 1),
           (SELECT min(c.primer_dia) FROM conexion c WHERE c.primer_dia IS NOT NULL)
         ) AS desde,
         (SELECT fin FROM reloj) AS hasta
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
export async function getFollowersByPlatform(tx: WorkspaceTx, filter: ResumenFilter): Promise<DailySeries> {
  assertPeriod(filter.days);
  assertPlatform(filter.platform);
  const platform = filter.platform ?? null;
  const { rows } = await tx.query<{ dia: string; platform_id: PlatformId; followers: string | number }>(
    SQL_SEGUIDORES,
    [filter.days, platform],
  );
  const plano = buildSeries(rows.map((r) => ({ label: r.dia, platformId: r.platform_id, value: num(r.followers) ?? 0 })));
  return { ...plano, hasAccountSeries: rows.length > 0 || (await hasAccountSeries(tx, platform)) };
}

// =====================================================================
// 3 · Visualizaciones por semana y red
// =====================================================================

/**
 * Doce semanas de siete días, SIEMPRE, sea cual sea el periodo del
 * filtro: es lo que piden la historia y el mock («views por semana y
 * red en 12 semanas»). El gráfico no es la suma del periodo del KPI, y
 * la tarjeta lo dice.
 *
 * Las semanas son de siete días contados hacia atrás desde el último
 * día cerrado, no semanas ISO de lunes a domingo. Con semanas ISO
 * cerradas, entre el lunes y el domingo el gráfico dejaría fuera hasta
 * seis días de datos que la tarjeta sí cuenta; con la ISO en curso, la
 * última barra saldría a medias y se leería como una caída. Así la
 * última semana siempre está completa y termina el mismo día que las
 * cifras de al lado.
 *
 * $1 = red o NULL, $2 = cuántas semanas (VIEWS_WEEKS). La primera
 * consulta suma la serie de la cuenta; la segunda —el respaldo cuando
 * no hay serie de cuenta, el workspace que solo importó CSV— suma las
 * visualizaciones de lo PUBLICADO en cada semana con su última lectura.
 *
 * La primera semana se trata distinto en cada una. En la serie de la
 * cuenta, una semana que empieza antes del primer día medido es una
 * suma a medias —se leería como una caída— y se descarta. Por fecha de
 * publicación no hay «a medias»: lo publicado en esa semana es un
 * hecho, y descartarlo dejaba fuera justo el video más antiguo del
 * archivo.
 *
 * Y la última semana termina en días distintos. Las barras de la cuenta
 * terminan en el último día que cerró la serie de cuenta DEL FILTRO, como
 * la tarjeta de visualizaciones (SQL_KPIS): con el reloj del módulo, una
 * lectura de contenido de madrugada dejaba la última barra a medias. Las
 * de lo publicado, en el reloj del módulo, como las tarjetas de contenido.
 */
const SQL_SEMANAS = (finDatos: string, desdeDatos: string, semanaParcial: 'descartar' | 'incluir') => `
reloj AS (SELECT (${finDatos}) AS fin),
semana AS (
  SELECT k,
         (SELECT fin FROM reloj) - (7 * k + 6) AS inicio,
         (SELECT fin FROM reloj) - 7 * k       AS fin
  FROM generate_series(0, $2::int - 1) AS g(k)
  WHERE (SELECT fin FROM reloj) IS NOT NULL
    AND ${
      semanaParcial === 'descartar'
        ? `(SELECT fin FROM reloj) - (7 * k + 6) >= (${desdeDatos})`
        : `(SELECT fin FROM reloj) - 7 * k >= (${desdeDatos})`
    }
)`;

const SQL_VIEWS_CUENTA = `
WITH conexion AS (
  SELECT sc.id, sc.platform_id, a.primer_dia, a.ultimo_dia
  FROM social_connection sc
  CROSS JOIN LATERAL (
    SELECT min(x.day) AS primer_dia, max(x.day) AS ultimo_dia
    FROM account_metric_snapshot x WHERE x.connection_id = sc.id
  ) a
  WHERE sc.deleted_at IS NULL AND ($1::text IS NULL OR sc.platform_id = $1::text)
),
${SQL_SEMANAS('SELECT max(c.ultimo_dia) FROM conexion c', 'SELECT min(c.primer_dia) FROM conexion c WHERE c.primer_dia IS NOT NULL', 'descartar')}
SELECT to_char(s.inicio, 'YYYY-MM-DD') AS inicio,
       to_char(s.fin, 'YYYY-MM-DD')    AS fin,
       c.platform_id,
       COALESCE(sum(a.views), 0)::bigint AS views
FROM semana s
JOIN conexion c ON c.primer_dia IS NOT NULL AND c.primer_dia <= s.fin
LEFT JOIN account_metric_snapshot a ON a.connection_id = c.id AND a.day BETWEEN s.inicio AND s.fin
GROUP BY s.inicio, s.fin, c.platform_id
ORDER BY s.inicio, c.platform_id`;

const SQL_VIEWS_CONTENIDO = `
WITH publicado AS (
  SELECT p.id, p.platform_id, (p.published_at AT TIME ZONE 'UTC')::date AS dia
  FROM post p
  JOIN social_connection sc ON sc.id = p.connection_id AND sc.deleted_at IS NULL
  WHERE p.deleted_on_platform = false AND ($1::text IS NULL OR p.platform_id = $1::text)
    AND EXISTS (SELECT 1 FROM post_metric_snapshot s WHERE s.post_id = p.id)
),
${SQL_SEMANAS(SQL_ULTIMO_DIA, 'SELECT min(dia) FROM publicado', 'incluir')},
red AS (SELECT DISTINCT platform_id FROM publicado)
SELECT to_char(s.inicio, 'YYYY-MM-DD') AS inicio,
       to_char(s.fin, 'YYYY-MM-DD')    AS fin,
       r.platform_id,
       COALESCE(sum(m.views), 0)::bigint AS views,
       count(p.id)::int AS posts
FROM semana s
CROSS JOIN red r
LEFT JOIN publicado p ON p.platform_id = r.platform_id AND p.dia BETWEEN s.inicio AND s.fin
LEFT JOIN post_metrics_latest m ON m.post_id = p.id
GROUP BY s.inicio, s.fin, r.platform_id
ORDER BY s.inicio, r.platform_id`;

/**
 * Visualizaciones por semana y red, en las últimas VIEWS_WEEKS semanas.
 * Solo recibe la red: el periodo del filtro no cambia este gráfico.
 * Cómo se etiqueta cada barra lo decide la pantalla, no esta capa.
 */
export async function getViewsByWeek(
  tx: WorkspaceTx,
  filter: { platform?: PlatformId | null } = {},
): Promise<WeekSeries> {
  assertPlatform(filter.platform);
  const platform = filter.platform ?? null;
  const source: ViewsSource = (await hasAccountSeries(tx, platform)) ? 'account' : 'content';
  const res = await tx.query<{
    inicio: string; fin: string; platform_id: PlatformId; views: string | number; posts?: number;
  }>(source === 'account' ? SQL_VIEWS_CUENTA : SQL_VIEWS_CONTENIDO, [platform, VIEWS_WEEKS]);
  // Por fecha de publicación, doce semanas en las que no se publicó nada
  // no son «cero visualizaciones»: son semanas sin datos, y la pantalla
  // tiene que poder decirlo en vez de pintar barras vacías.
  const rows = source === 'content' && res.rows.every((r) => !r.posts) ? [] : res.rows;
  const plano = buildSeries(rows.map((r) => ({ label: r.inicio, platformId: r.platform_id, value: num(r.views) ?? 0 })));
  const finDe = new Map(rows.map((r) => [r.inicio, r.fin] as const));
  return {
    source,
    weeks: plano.labels.map((start) => ({ start, end: finDe.get(start) ?? start })),
    series: plano.series,
  };
}

/**
 * Filas (etiqueta, red, valor) → etiquetas ordenadas y una serie por
 * red con un valor por etiqueta. Lo que no vino es cero: la consulta ya
 * dejó fuera las redes que aún no tienen historia en la ventana.
 */
function buildSeries(filas: { label: string; platformId: PlatformId; value: number }[]): {
  labels: string[];
  series: PlatformSeries[];
} {
  const labels = [...new Set(filas.map((f) => f.label))].sort();
  const indice = new Map(labels.map((l, i) => [l, i] as const));
  const porRed = new Map<PlatformId, number[]>();
  for (const f of filas) {
    let data = porRed.get(f.platformId);
    if (!data) {
      data = new Array<number>(labels.length).fill(0);
      porRed.set(f.platformId, data);
    }
    data[indice.get(f.label)!] = f.value;
  }
  const series = PLATFORMS.filter((r) => porRed.has(r)).map((platformId) => ({ platformId, data: porRed.get(platformId)! }));
  return { labels, series };
}

// =====================================================================
// 4 · Frescura y cobertura
// =====================================================================

/**
 * Las dos fuentes van POR SEPARADO: una conexión OAuth a la que además
 * se le subió un CSV tiene que seguir enseñando cuándo sincronizó por
 * última vez el recolector. Mezclarlas tapaba justo lo que este aviso
 * existe para destapar: una sincronización rota.
 *
 * Las fechas salen como DÍA CERRADO y con la misma regla que el reloj
 * del módulo (SQL_ULTIMO_DIA): una lectura tomada el día D, en UTC,
 * cubre hasta D-1. Devolver el instante y dejar que la pantalla lo
 * formatease daba otra fecha que el resto de la página: una importación
 * a las 21:55 en Bogotá (02:55 UTC del día siguiente) salía como «datos
 * hasta el 23» el 22, un día en el futuro para el creador y uno por
 * delante del reloj.
 *
 * `dias_atras` compara cada conexión con ese mismo reloj: es lo que deja
 * a la pantalla señalar la que se quedó atrás sin hacer cuentas.
 */
const SQL_FRESCURA = `
WITH reloj AS (SELECT ${SQL_ULTIMO_DIA} AS fin)
SELECT h.id,
       h.platform_id,
       h.handle,
       sc.display_name,
       sc.access_mode,
       h.status,
       to_char(h.last_synced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_synced_at,
       to_char(d.dia_cuenta, 'YYYY-MM-DD')   AS last_account_day,
       to_char(l.dia_api, 'YYYY-MM-DD')      AS last_synced_reading_day,
       to_char(l.dia_csv, 'YYYY-MM-DD')      AS last_csv_day,
       to_char(l.instante_csv AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_csv_export_at,
       to_char(u.hasta, 'YYYY-MM-DD')        AS data_until,
       (r.fin - u.hasta)::int                AS dias_atras,
       h.token_expiring_soon
FROM connection_health h
JOIN social_connection sc ON sc.id = h.id AND sc.deleted_at IS NULL
CROSS JOIN reloj r
CROSS JOIN LATERAL (
  SELECT max(a.day) AS dia_cuenta FROM account_metric_snapshot a WHERE a.connection_id = h.id
) d
CROSS JOIN LATERAL (
  SELECT (max(s.captured_at) FILTER (WHERE s.source <> 'csv_import') AT TIME ZONE 'UTC')::date - 1 AS dia_api,
         (max(s.captured_at) FILTER (WHERE s.source =  'csv_import') AT TIME ZONE 'UTC')::date - 1 AS dia_csv,
         max(s.captured_at) FILTER (WHERE s.source = 'csv_import') AS instante_csv
  FROM post_metric_snapshot s
  JOIN post p ON p.id = s.post_id
  WHERE p.connection_id = h.id
) l
CROSS JOIN LATERAL (SELECT greatest(d.dia_cuenta, l.dia_api, l.dia_csv) AS hasta) u
WHERE ($1::text IS NULL OR h.platform_id = $1::text)
ORDER BY h.platform_id, h.handle NULLS LAST`;

/** Una fila por conexión viva del filtro: hasta cuándo llegan sus datos y de dónde vinieron. */
export async function getFreshnessByConnection(
  tx: WorkspaceTx,
  filter: { platform?: PlatformId | null } = {},
): Promise<ConnectionFreshness[]> {
  assertPlatform(filter.platform);
  const { rows } = await tx.query<{
    id: string; platform_id: PlatformId; handle: string | null; display_name: string | null; access_mode: string;
    status: string; last_synced_at: string | null; last_account_day: string | null;
    last_synced_reading_day: string | null; last_csv_day: string | null; last_csv_export_at: string | null;
    data_until: string | null; dias_atras: number | null; token_expiring_soon: boolean | null;
  }>(SQL_FRESCURA, [filter.platform ?? null]);
  return rows.map((r) => ({
    connectionId: r.id,
    platformId: r.platform_id,
    handle: r.handle,
    displayName: r.display_name,
    status: r.status,
    accessMode: r.access_mode,
    lastSyncedAt: r.last_synced_at,
    lastAccountDay: r.last_account_day,
    lastSyncedReadingDay: r.last_synced_reading_day,
    lastCsvDay: r.last_csv_day,
    lastCsvExportAt: r.last_csv_export_at,
    dataUntil: r.data_until,
    daysBehind: r.dias_atras,
    tokenExpiringSoon: r.token_expiring_soon === true,
  }));
}

/**
 * Lo que la pantalla necesita para elegir entre "estado vacío" y
 * "cifras": cuántas conexiones hay y cuántas traen datos. Un workspace
 * sin conexiones ve el estado vacío, no cuatro ceros.
 *
 * «Con datos» es con alguna LECTURA: una fila de la serie de cuenta o un
 * post con al menos un snapshot. Un post sin lecturas no cuenta: es la
 * conexión OAuth que ya descubrió sus videos y aún no midió nada, y con
 * ella la página pintaba cuatro «—» y dos gráficos vacíos en vez del
 * estado «conectadas pero sin lecturas».
 */
export async function getResumenCoverage(tx: WorkspaceTx): Promise<ResumenCoverage> {
  const { rows } = await tx.query<{ conexiones: number; con_datos: number }>(`
    SELECT count(*)::int AS conexiones,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM account_metric_snapshot a WHERE a.connection_id = sc.id)
                OR EXISTS (SELECT 1 FROM post p JOIN post_metric_snapshot s ON s.post_id = p.id
                            WHERE p.connection_id = sc.id)
           )::int AS con_datos
    FROM social_connection sc
    WHERE sc.deleted_at IS NULL`);
  const fila = rows[0];
  return { connections: fila?.conexiones ?? 0, withData: fila?.con_datos ?? 0 };
}

/**
 * Cuántos posts tiene el workspace. Va aparte de `getResumenCoverage`
 * a propósito: es un conteo completo de la tabla más grande y la
 * cobertura se lee en el camino crítico de /resumen, antes de soltar el
 * shell. Hoy solo lo usan las pruebas.
 */
export async function countPosts(tx: WorkspaceTx): Promise<number> {
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

/**
 * Los motivos por los que una importación se rechaza. Viajan como
 * CÓDIGO, no como frase: el texto lo pone la pantalla, en su archivo de
 * mensajes, y así @mc/db no decide el idioma de nadie.
 */
export type CsvImportErrorCode =
  | 'invalid_connection'
  | 'connection_not_found'
  | 'no_creator'
  | 'empty_batch'
  | 'duplicate_ids'
  | 'empty_handle'
  | 'invalid_captured_at';

export class CsvImportError extends Error {
  readonly code: CsvImportErrorCode;
  constructor(code: CsvImportErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'CsvImportError';
    this.code = code;
  }
}

export interface ImportableAccount {
  connectionId: string;
  platformId: PlatformId;
  handle: string | null;
  displayName: string | null;
  /** 'manual_csv' cuando la creó una importación. */
  accessMode: string;
  posts: number;
}

/** Las cuentas del workspace a las que se puede pegar un CSV. Sin red, todas. */
export async function listImportableAccounts(tx: WorkspaceTx, platform?: PlatformId | null): Promise<ImportableAccount[]> {
  assertPlatform(platform);
  const { rows } = await tx.query<{
    id: string; platform_id: PlatformId; handle: string | null; display_name: string | null; access_mode: string; posts: number;
  }>(
    `SELECT sc.id, sc.platform_id, sc.handle, sc.display_name, sc.access_mode,
            (SELECT count(*)::int FROM post p WHERE p.connection_id = sc.id) AS posts
       FROM social_connection sc
      WHERE sc.deleted_at IS NULL AND ($1::text IS NULL OR sc.platform_id = $1::text)
      ORDER BY sc.platform_id, sc.handle NULLS LAST`,
    [platform ?? null],
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
  if (!isUuid(connectionId)) throw new CsvImportError('invalid_connection', connectionId);
  if (ids.length === 0) return [];
  const { rows } = await tx.query<{ external_post_id: string }>(
    'SELECT external_post_id FROM post WHERE connection_id = $1 AND external_post_id = ANY($2::text[])',
    [connectionId, [...new Set(ids)]],
  );
  return rows.map((r) => r.external_post_id);
}

export interface KnownPost {
  externalPostId: string;
  /** ISO en UTC de la lectura más reciente del video, o null si aún no tiene ninguna. */
  lastCapturedAt: string | null;
}

/**
 * Como `listExternalPostIds`, y además el instante de la ÚLTIMA lectura
 * de cada video. Con eso el paso 3 distingue los dos casos de un video
 * que ya estaba:
 *
 *   - su última lectura es anterior a la de este archivo: se le añade
 *     una lectura nueva;
 *   - ya tiene una de esta fecha o posterior: esta NO se guardará
 *     (importCsvReadings nunca escribe hacia atrás).
 *
 * Sin esa distinción, reimportar el mismo archivo decía en el paso 3
 * «se añade una lectura» y en el paso 4 «no se guardó».
 */
export async function listKnownPosts(
  tx: WorkspaceTx,
  connectionId: string,
  ids: readonly string[],
): Promise<KnownPost[]> {
  if (!isUuid(connectionId)) throw new CsvImportError('invalid_connection', connectionId);
  if (ids.length === 0) return [];
  const { rows } = await tx.query<{ external_post_id: string; ultima: string | null }>(
    `SELECT p.external_post_id,
            to_char(max(s.captured_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ultima
       FROM post p
       LEFT JOIN post_metric_snapshot s ON s.post_id = p.id
      WHERE p.connection_id = $1 AND p.external_post_id = ANY($2::text[])
      GROUP BY p.external_post_id`,
    [connectionId, [...new Set(ids)]],
  );
  return rows.map((r) => ({ externalPostId: r.external_post_id, lastCapturedAt: r.ultima }));
}

/**
 * La cuenta "importada por CSV": se crea al vuelo la primera vez y se
 * reutiliza después. external_account_id lleva el prefijo csv: para que
 * no choque con el id real si algún día se conecta la cuenta por OAuth.
 *
 * Una cuenta que el creador BORRÓ no se resucita. Si el nombre coincide
 * con una borrada, se crea otra con el mismo nombre visible y un
 * identificador interno distinto: el historial borrado sigue borrado, y
 * el creador obtiene lo que pidió —una cuenta nueva para este archivo—.
 * Un `ON CONFLICT DO UPDATE SET deleted_at = NULL` devolvía en silencio
 * la cuenta con todo su historial, que es lo contrario de lo que el
 * creador decidió al borrarla.
 *
 * Y el nombre se busca entre TODAS las cuentas vivas de esa red, no
 * solo entre las importadas: si el creador escribe «Laura.CocinaFacil»
 * en Instagram teniendo @laura.cocinafacil conectada por OAuth, se le
 * devuelve esa. Crear otra partía sus videos en dos conexiones —el
 * índice único de post incluye connection_id—, así que Resumen contaba
 * cada video dos veces y la frescura enseñaba dos tarjetas de la misma
 * cuenta. El asistente ya lo propone antes (paso 2); esto es la red por
 * si un POST llega sin pasar por él. Si hubiera una importada y una
 * OAuth con el mismo nombre (datos de antes de esta regla), gana la
 * importada: es la que ya tiene el historial del CSV.
 */
export async function ensureCsvConnection(
  tx: WorkspaceTx,
  input: { platform: PlatformId; handle: string },
): Promise<ImportableAccount> {
  return ensureCsvConnectionOnce(tx, input, true);
}

async function ensureCsvConnectionOnce(
  tx: WorkspaceTx,
  input: { platform: PlatformId; handle: string },
  retry: boolean,
): Promise<ImportableAccount> {
  assertPlatform(input.platform);
  const handle = input.handle.trim().replace(/^@/, '');
  if (!handle) throw new CsvImportError('empty_handle');

  const viva = await tx.query<{
    id: string; handle: string | null; display_name: string | null; access_mode: string; posts: number;
  }>(
    `SELECT sc.id, sc.handle, sc.display_name, sc.access_mode,
            (SELECT count(*)::int FROM post p WHERE p.connection_id = sc.id) AS posts
       FROM social_connection sc
      WHERE sc.platform_id = $1 AND sc.deleted_at IS NULL
        AND lower(ltrim(sc.handle, '@')) = lower($2)
      ORDER BY (sc.access_mode = 'manual_csv') DESC, sc.created_at
      LIMIT 1`,
    [input.platform, handle],
  );
  const existente = viva.rows[0];
  if (existente) {
    return {
      connectionId: existente.id, platformId: input.platform, handle: existente.handle ?? handle,
      displayName: existente.display_name ?? existente.handle ?? handle, accessMode: existente.access_mode,
      posts: existente.posts,
    };
  }

  const creador = await getDefaultCreator(tx);
  const base = `csv:${handle.toLowerCase()}`;
  // Si el identificador base ya lo ocupa una cuenta borrada, la nueva
  // lleva un sufijo aleatorio. El índice único sigue siendo el árbitro:
  // ON CONFLICT DO NOTHING cubre la carrera de dos importaciones a la vez.
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO social_connection
       (workspace_id, creator_id, platform_id, external_account_id, handle, display_name,
        account_type, secret_ref, scopes, access_mode, status)
     SELECT current_workspace_id(), $1, $2,
            CASE WHEN EXISTS (SELECT 1 FROM social_connection x
                               WHERE x.platform_id = $2 AND x.external_account_id = $3)
                 THEN $3 || ':' || gen_random_uuid()::text ELSE $3 END,
            $4, $4, 'unknown', $5, '{}', 'manual_csv', 'active'
     ON CONFLICT (platform_id, external_account_id, workspace_id) DO NOTHING
     RETURNING id`,
    [creador, input.platform, base, handle, `csv://${input.platform}/${handle.toLowerCase()}`],
  );
  const id = rows[0]?.id;
  if (id) {
    return { connectionId: id, platformId: input.platform, handle, displayName: handle, accessMode: 'manual_csv', posts: 0 };
  }
  // La otra importación ganó la carrera: su cuenta es la nuestra. Un
  // solo reintento: si tampoco aparece, algo raro pasa y se dice.
  if (retry) return ensureCsvConnectionOnce(tx, input, false);
  throw new CsvImportError('connection_not_found', `csv:${input.platform}/${handle}`);
}

/**
 * TODO(CIM-3): el creador saldrá de la sesión. Hasta entonces, el
 * workspace del MVP tiene uno solo y la importación lo cuelga de él.
 * Nunca de uno borrado.
 */
async function getDefaultCreator(tx: WorkspaceTx): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    'SELECT id FROM creator_profile WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1',
  );
  const id = rows[0]?.id;
  if (!id) throw new CsvImportError('no_creator');
  return id;
}

/** post.media_type (CHECK en 0003). Lo que un CSV puede traer. */
export type CsvMediaType = 'video' | 'image' | 'carousel' | 'story';

/** Una fila ya validada, lista para escribirse. Los números son enteros o null. */
export interface CsvReading {
  externalPostId: string;
  /** ISO 8601. */
  publishedAt: string;
  mediaType: CsvMediaType;
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

export interface CsvImportResult {
  /** Posts creados por esta importación. */
  newPosts: number;
  /** Posts que ya existían y solo recibieron una lectura más. */
  knownPosts: number;
  /** Filas escritas en post_metric_snapshot. */
  readings: number;
  /**
   * Filas que NO se escribieron porque el video ya tenía una lectura
   * igual de reciente o más: un archivo exportado antes que el último
   * que se subió, o una conexión OAuth que ya leyó ese video después.
   */
  staleReadings: number;
  /** ISO del captured_at con el que entraron todas. */
  capturedAt: string;
}

/**
 * Escribe el lote: un post por fila nueva y, si no hay ya una más
 * reciente, una lectura. `age_hours` sale de la propia base
 * —captured_at menos published_at—, no del navegador.
 *
 * `capturedAt` es CUÁNDO SE EXPORTÓ el archivo, no cuándo se importa:
 * un archivo exportado el 1 de septiembre y subido el 20 describe los
 * videos como estaban el 1, y con el reloj de la importación cada video
 * parecía 19 días más viejo al leerse. Sin `capturedAt` —un archivo
 * exportado hoy— vale now() de la base, al microsegundo.
 *
 * Una lectura que llega más vieja que la última del video NO se
 * escribe: se cuenta en `staleReadings`. Las lecturas son append-only y
 * post_metrics_latest se queda con la de captured_at más alto, así que
 * escribirla no cambiaría la «última», pero sí contaría como importada
 * algo que no aporta nada. Y el reloj del módulo nunca retrocede.
 *
 * Es API pública de @mc/db, así que se protege sola y no confía en que
 * quien llama haya pasado por la revisión de la pantalla:
 *   - el id de la cuenta se valida con isUuid antes de consultar;
 *   - `capturedAt` tiene que ser un instante, no del futuro y no
 *     anterior a ningún video del lote (una lectura de antes de
 *     publicar no existe);
 *   - un lote con el mismo externalPostId dos veces se RECHAZA entero:
 *     serían dos lecturas del mismo video con el mismo captured_at, y
 *     no hay forma honesta de elegir cuál vale;
 *   - los posts nuevos se cuentan con lo que devuelve el INSERT, no
 *     restando conjuntos.
 */
export async function importCsvReadings(
  tx: WorkspaceTx,
  input: { connectionId: string; platform: PlatformId; rows: readonly CsvReading[]; capturedAt?: string },
): Promise<CsvImportResult> {
  assertPlatform(input.platform);
  if (!isUuid(input.connectionId)) throw new CsvImportError('invalid_connection', input.connectionId);
  if (input.rows.length === 0) throw new CsvImportError('empty_batch');
  const ids = input.rows.map((f) => f.externalPostId);
  const distintos = new Set(ids);
  if (distintos.size !== ids.length) {
    const repetidos = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    throw new CsvImportError('duplicate_ids', repetidos.slice(0, 5).join(', '));
  }
  if (input.capturedAt !== undefined) {
    const instante = Date.parse(input.capturedAt);
    const ultimoPublicado = Math.max(...input.rows.map((f) => Date.parse(f.publishedAt)));
    // Un minuto de margen para los relojes de la máquina y de la base.
    if (!Number.isFinite(instante) || instante > Date.now() + 60_000 || instante < ultimoPublicado) {
      throw new CsvImportError('invalid_captured_at', input.capturedAt);
    }
  }

  // La cuenta de destino se comprueba ANTES que nada: es la frontera
  // entre workspaces. RLS hace que una conexión ajena no exista.
  const { rows: cuenta } = await tx.query<{ id: string }>(
    'SELECT id FROM social_connection WHERE id = $1 AND deleted_at IS NULL AND platform_id = $2',
    [input.connectionId, input.platform],
  );
  if (!cuenta[0]) throw new CsvImportError('connection_not_found', input.connectionId);
  const creador = await getDefaultCreator(tx);

  // Un solo captured_at para todo el lote: las lecturas de un mismo
  // archivo son la misma foto, y así age_hours queda coherente entre ellas.
  // Sin fecha de exportación, now() con microsegundos y no con segundos:
  // dos importaciones del mismo archivo en el mismo segundo empataban en
  // captured_at, y la «última lectura» de post_metrics_latest (DISTINCT
  // ON … ORDER BY captured_at) pasaba a ser cualquiera de las dos.
  const { rows: reloj } = await tx.query<{ instante: string }>(
    `SELECT to_char(COALESCE($1::timestamptz, now()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS instante`,
    [input.capturedAt ?? null],
  );
  const capturedAt = reloj[0]!.instante;

  // jsonb_to_recordset casa por NOMBRE de campo, así que el lote viaja
  // con las claves de la tabla (snake_case), no con las del tipo.
  const datos = JSON.stringify(
    input.rows.map((f) => ({
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

  const { rows: nuevos } = await tx.query<{ id: string }>(
    `INSERT INTO post (workspace_id, creator_id, connection_id, platform_id, external_post_id,
                       url, media_type, title, duration_s, published_at)
     SELECT current_workspace_id(), $1, $2, $3, f.external_post_id, f.url, f.media_type, f.title,
            f.duration_s, f.published_at
     FROM jsonb_to_recordset($4::jsonb) AS f(
       external_post_id text, url text, media_type text, title text, duration_s numeric, published_at timestamptz)
     ON CONFLICT (platform_id, external_post_id, connection_id) DO NOTHING
     RETURNING id`,
    [creador, input.connectionId, input.platform, datos],
  );

  // El NOT EXISTS es la regla de «nunca hacia atrás»: si el video ya
  // tiene una lectura de este instante o posterior, esta no entra. El
  // conteo de `emparejadas` ve la tabla ANTES del INSERT (así funcionan
  // las CTE que escriben), que es justo lo que se quiere comparar.
  const { rows: escritas } = await tx.query<{ n: number; emparejadas: number }>(
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
              -- «No lo sabemos» no es «fue cero»: un archivo sin ninguna
              -- columna de interacción deja NULL, no una interacción de 0
              -- que nunca se midió y que leerían las tasas de interacción.
              CASE WHEN num_nonnulls(e.likes, e.comments, e.shares, e.saves) = 0 THEN NULL
                   ELSE COALESCE(e.likes, 0) + COALESCE(e.comments, 0) + COALESCE(e.shares, 0) + COALESCE(e.saves, 0)
              END,
              e.follows_from_post,
              CASE WHEN e.reach IS NOT NULL AND e.reach_non_followers IS NOT NULL
                   THEN e.reach - e.reach_non_followers END,
              e.reach_non_followers,
              'csv_import'
       FROM entrada e
       JOIN post p ON p.connection_id = $1 AND p.external_post_id = e.external_post_id
       WHERE NOT EXISTS (
         SELECT 1 FROM post_metric_snapshot s WHERE s.post_id = p.id AND s.captured_at >= $2::timestamptz
       )
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM escritas)::int AS n,
            (SELECT count(*) FROM entrada e
               JOIN post p ON p.connection_id = $1 AND p.external_post_id = e.external_post_id)::int AS emparejadas`,
    [input.connectionId, capturedAt, datos],
  );
  const escritasN = escritas[0]?.n ?? 0;

  // Solo una cuenta importada queda "sincronizada" al momento del
  // archivo. Una conexión OAuth NO: su last_synced_at es la última vez
  // que el recolector habló con la API, y moverlo aquí tapaba una
  // sincronización rota en connection_health y en Conexiones. La
  // frescura del contenido importado ya sale de post_metric_snapshot.
  // Y nunca hacia atrás: un archivo viejo no hace parecer más vieja la
  // última sincronización (greatest ignora el NULL de la primera vez).
  await tx.query(
    `UPDATE social_connection SET last_synced_at = greatest(last_synced_at, $2::timestamptz)
      WHERE id = $1 AND access_mode = 'manual_csv'`,
    [input.connectionId, capturedAt],
  );

  return {
    newPosts: nuevos.length,
    knownPosts: ids.length - nuevos.length,
    readings: escritasN,
    staleReadings: (escritas[0]?.emparejadas ?? 0) - escritasN,
    capturedAt,
  };
}
