-- =====================================================================
-- Verificación del seed 0002 (CIM-6): las cifras del mock, por consulta.
-- ---------------------------------------------------------------------
-- Cómo correrlo:
--   Postgres embebido, sin tocar Supabase (migraciones + seeds, dos
--   veces, con conteos por tabla):
--     node db/seed/verify/run.mjs 0002
--   Contra Supabase, como mc_app (después de make db.unlock):
--     node db/sql.mjs -f db/seed/verify/0002.sql
--
-- Cada consulta trae una columna `ok`; run.mjs falla si alguna es
-- false. Los comentarios dicen el valor esperado y de dónde sale.
-- =====================================================================

-- RLS: sin el workspace fijado, todas las consultas devuelven cero filas.
SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);

-- (a) Conteos fijos de este seed.
SELECT 'a_conteos' AS check_id,
       (SELECT count(*) FROM social_connection WHERE deleted_at IS NULL) AS conexiones,
       (SELECT count(*) FROM post)                                       AS posts,
       (SELECT count(*) FROM account_metric_snapshot)                    AS dias_cuenta,
       (SELECT count(*) FROM audience_breakdown)                         AS audiencia,
       (SELECT count(*) FROM creator_baseline)                           AS lineas_base,
       (SELECT count(*) FROM company_link)                               AS empresas,
       (SELECT count(*) FROM contact WHERE opted_out)                    AS bajas,
       (SELECT count(*) FROM signal)                                     AS senales,
       (SELECT count(*) FROM deal)                                       AS deals,
       (SELECT count(*) FROM activity)                                   AS actividades,
       (SELECT count(*) FROM social_connection WHERE deleted_at IS NULL) = 4
         AND (SELECT count(*) FROM post) = 60
         AND (SELECT count(*) FROM account_metric_snapshot) = 360
         AND (SELECT count(*) FROM audience_breakdown) = 60
         AND (SELECT count(*) FROM creator_baseline) = 16
         AND (SELECT count(*) FROM company_link) = 8
         AND (SELECT count(*) FROM contact WHERE opted_out) = 1
         AND (SELECT count(*) FROM signal) = 12
         AND (SELECT count(*) FROM deal) = 15
         AND (SELECT count(*) FROM activity) = 36 AS ok;

-- (b) Seguidores hoy, por red: FOLLOWERS_NOW del mock (412 000 en total).
SELECT 'b_seguidores' AS check_id, c.platform_id, s.followers, s.day,
       s.followers = CASE c.platform_id WHEN 'tiktok' THEN 214000 WHEN 'instagram' THEN 128000
                                        WHEN 'youtube' THEN 49000 ELSE 21000 END
         AND s.day = CURRENT_DATE AS ok
FROM social_connection c
JOIN LATERAL (
  SELECT followers, day FROM account_metric_snapshot a
  WHERE a.connection_id = c.id ORDER BY a.day DESC LIMIT 1
) s ON true
ORDER BY c.platform_id;

-- (b2) Total de seguidores y delta a 30 días (el KPI "Seguidores en
--      total": 412 K, ≈ +2..3 %). La serie nunca baja.
WITH hoy AS (
  SELECT sum(followers) AS n FROM account_metric_snapshot WHERE day = CURRENT_DATE
), hace30 AS (
  SELECT sum(followers) AS n FROM account_metric_snapshot WHERE day = CURRENT_DATE - 30
), caidas AS (
  SELECT count(*) AS n FROM (
    SELECT followers - lag(followers) OVER (PARTITION BY connection_id ORDER BY day) AS d
    FROM account_metric_snapshot
  ) x WHERE d < 0
)
SELECT 'b2_total' AS check_id, hoy.n AS seguidores, hace30.n AS hace_30_dias,
       round((hoy.n - hace30.n)::numeric / hace30.n, 4) AS delta, caidas.n AS dias_en_baja,
       hoy.n = 412000 AND caidas.n = 0 AS ok
FROM hoy, hace30, caidas;

-- (c) Views en 30 días. Dos lecturas que deben ser del mismo orden que
--     el mock (≈ 2,6 M): las views diarias de la cuenta y las views
--     actuales de los videos publicados en la ventana.
SELECT 'c_views_30d' AS check_id,
       (SELECT sum(views) FROM account_metric_snapshot WHERE day > CURRENT_DATE - 30) AS cuenta_30d,
       (SELECT sum(views) FROM account_metric_snapshot WHERE day > CURRENT_DATE - 60 AND day <= CURRENT_DATE - 30) AS cuenta_30d_previos,
       (SELECT sum(m.views) FROM post p JOIN post_metrics_latest m ON m.post_id = p.id
         WHERE p.published_at > now() - interval '30 days') AS videos_30d,
       (SELECT count(*) FROM post WHERE published_at > now() - interval '30 days') AS videos,
       (SELECT sum(views) FROM account_metric_snapshot WHERE day > CURRENT_DATE - 30) BETWEEN 2000000 AND 3500000
         AND (SELECT sum(m.views) FROM post p JOIN post_metrics_latest m ON m.post_id = p.id
               WHERE p.published_at > now() - interval '30 days') BETWEEN 2000000 AND 4000000 AS ok;

-- (d) La tabla "Mis videos" del mock: views, × mediana y nivel de cada
--     uno de los doce, desde creator_post_board. Los outliers claros
--     (≥ 2×) son la arepa, los tres desayunos, el error del arroz y la
--     pasta cremosa; la sopa y las preguntas quedan por debajo. El
--     postre sin horno sale 'under' y no 'normal': el mock le da 0,8×
--     con 44 K views, pero contra su propia mediana de Instagram (62 K
--     a 7 días) 44 K es 0,66×; se respetan las views del mock.
SELECT 'd_mis_videos' AS check_id, b.platform_id, b.title, b.views, b.views_vs_median, b.outlier_tier,
       round(b.saves_per_1k, 1) AS saves_1k, round(b.non_follower_share, 2) AS no_seg, b.skip_rate_3s,
       round(b.age_hours / 24) AS dias,
       CASE b.title
         WHEN 'La arepa que se hace sin plancha'    THEN b.outlier_tier = 'outlier' AND b.views_vs_median BETWEEN 3.5 AND 5.5
         WHEN 'Tres desayunos con dos ingredientes' THEN b.outlier_tier = 'outlier'
         WHEN 'El error que arruina tu arroz'       THEN b.outlier_tier = 'outlier'
         WHEN 'Pasta cremosa en cuatro minutos'     THEN b.outlier_tier = 'outlier'
         WHEN 'Sopa de la abuela paso a paso'       THEN b.outlier_tier = 'under'
         WHEN 'Respondo sus preguntas de cocina'    THEN b.outlier_tier = 'under'
         WHEN 'Postre sin horno para visitas'       THEN b.outlier_tier IN ('under', 'normal')
         ELSE b.outlier_tier IN ('normal', 'good')
       END AS ok
FROM creator_post_board b
WHERE b.title IN ('La arepa que se hace sin plancha', 'Tres desayunos con dos ingredientes', 'El error que arruina tu arroz',
                  'Pasta cremosa en cuatro minutos', 'Salsa que mejora cualquier cosa', 'Huevo perfecto: el truco del vaso',
                  'Qué cocino un lunes sin ganas', 'Compras de la semana por 80 mil', 'Mi cocina en 60 segundos',
                  'Sopa de la abuela paso a paso', 'Postre sin horno para visitas', 'Respondo sus preguntas de cocina')
ORDER BY b.views_vs_median DESC NULLS LAST;

-- (d2) Outliers en total: entre 3 y 7 videos con ≥ 2× (los cuatro del
--      mock más los dos de la campaña de Café Alma), y a lo sumo un
--      breakout: el reel del cold brew, 412 K views contra una mediana
--      de Instagram de 62 K. Todo video con 24 h tiene puntaje.
SELECT 'd2_outliers' AS check_id,
       count(*) FILTER (WHERE is_outlier) AS outliers,
       count(*) FILTER (WHERE outlier_tier = 'breakout') AS breakouts,
       count(*) AS puntuados,
       (SELECT count(*) FROM post WHERE published_at <= now() - interval '24 hours') AS con_24h,
       count(*) FILTER (WHERE is_outlier) BETWEEN 3 AND 7
         AND count(*) FILTER (WHERE outlier_tier = 'breakout') <= 1
         AND count(*) = (SELECT count(*) FROM post WHERE published_at <= now() - interval '24 hours') AS ok
FROM post_score;

-- (e) Línea base por red y corte: 16 filas, todas confiables (≥ 8
--     videos), mediana creciente con el corte, y la de TikTok a 30 días
--     del orden de las views promedio del tarifario del mock (138 K).
SELECT 'e_linea_base' AS check_id, platform_id, age_hours_cut, sample_size, median_views, p25_views, p75_views,
       median_saves_per_1k, median_skip_3s, median_completion, is_reliable,
       is_reliable AND sample_size >= 8 AND median_views > 0 AS ok
FROM creator_baseline
ORDER BY CASE platform_id WHEN 'tiktok' THEN 1 WHEN 'instagram' THEN 2 WHEN 'youtube' THEN 3 ELSE 4 END, age_hours_cut;

-- (e2) Coherencia del puntaje con la línea base: views_vs_median es
--      views_at_cut / median_views redondeado a 3 decimales, y el nivel
--      sigue los umbrales de scoring.ts.
SELECT 'e2_puntaje_coherente' AS check_id, count(*) AS puntuados,
       count(*) FILTER (WHERE s.views_vs_median <> round(s.views_at_cut / b.median_views, 3)) AS ratio_mal,
       count(*) FILTER (WHERE s.outlier_tier <> CASE WHEN s.views_vs_median >= 5 THEN 'breakout' WHEN s.views_vs_median >= 2 THEN 'outlier'
                                                     WHEN s.views_vs_median >= 1.2 THEN 'good' WHEN s.views_vs_median >= 0.7 THEN 'normal' ELSE 'under' END) AS nivel_mal,
       count(*) FILTER (WHERE s.is_outlier <> (s.views_vs_median >= 2)) AS bandera_mal,
       count(*) FILTER (WHERE s.views_vs_median <> round(s.views_at_cut / b.median_views, 3)) = 0
         AND count(*) FILTER (WHERE s.outlier_tier <> CASE WHEN s.views_vs_median >= 5 THEN 'breakout' WHEN s.views_vs_median >= 2 THEN 'outlier'
                                                     WHEN s.views_vs_median >= 1.2 THEN 'good' WHEN s.views_vs_median >= 0.7 THEN 'normal' ELSE 'under' END) = 0
         AND count(*) FILTER (WHERE s.is_outlier <> (s.views_vs_median >= 2)) = 0 AS ok
FROM post_score s
JOIN creator_baseline b ON b.id = s.baseline_id;

-- (f) Las curvas: acumuladas (nunca bajan), rápidas al principio (a las
--     72 h ya va ≥ 65 % de lo que hay a 30 días) y age_hours coherente
--     con published_at en toda lectura de la API (las cinco manuales de
--     0003 tienen su propia fecha de captura).
WITH s AS (
  SELECT s.post_id, s.age_hours, s.views, s.captured_at, p.published_at,
         lag(s.views) OVER (PARTITION BY s.post_id ORDER BY s.age_hours) AS prev
  FROM post_metric_snapshot s JOIN post p ON p.id = s.post_id
  WHERE s.source = 'api'
)
SELECT 'f_curvas' AS check_id,
       count(*) AS lecturas,
       count(*) FILTER (WHERE views < prev) AS bajadas,
       count(*) FILTER (WHERE abs(EXTRACT(EPOCH FROM (captured_at - published_at)) / 3600 - age_hours) > 0.01) AS edad_mal,
       (SELECT round(avg(a72.views::numeric / a720.views), 3)
          FROM post_metrics_at_cut a72 JOIN post_metrics_at_cut a720 ON a720.post_id = a72.post_id AND a720.cut_hours = 720
         WHERE a72.cut_hours = 72 AND a720.age_hours = 720) AS share_72h_sobre_720h,
       count(*) FILTER (WHERE views < prev) = 0
         AND count(*) FILTER (WHERE abs(EXTRACT(EPOCH FROM (captured_at - published_at)) / 3600 - age_hours) > 0.01) = 0
         AND (SELECT avg(a72.views::numeric / a720.views)
                FROM post_metrics_at_cut a72 JOIN post_metrics_at_cut a720 ON a720.post_id = a72.post_id AND a720.cut_hours = 720
               WHERE a72.cut_hours = 72 AND a720.age_hours = 720) BETWEEN 0.65 AND 0.95 AS ok
FROM s;

-- (g) Los posts de las campañas de 0003 llegan a sus views de 30 días
--     (412 K, 300 K, 140 K, 125 K, 58 K) por la misma curva.
SELECT 'g_posts_campana' AS check_id, p.external_post_id, m.views AS views_720h,
       m.views = CASE right(p.external_post_id, 3) WHEN 'd01' THEN 412000 WHEN 'd02' THEN 300000
                                                    WHEN 'd03' THEN 140000 WHEN 'd04' THEN 125000 ELSE 58000 END AS ok
FROM post p
JOIN post_metric_snapshot m ON m.post_id = p.id AND m.age_hours = 720 AND m.source = 'api'
WHERE p.is_branded_content
ORDER BY p.external_post_id;

-- (h) Demografía: cada dimensión suma 1 en cada cuenta; 18–34 ≈ 71 %,
--     mujeres ≈ 64 % y Colombia ≈ 71 % en Instagram (la base del media kit).
SELECT 'h_audiencia' AS check_id, c.platform_id, a.dimension, round(sum(a.share), 4) AS suma, sum(a.absolute) AS personas,
       round(sum(a.share), 4) = 1.0000 AS ok
FROM audience_breakdown a JOIN social_connection c ON c.id = a.connection_id
GROUP BY c.platform_id, a.dimension
ORDER BY c.platform_id, a.dimension;

SELECT 'h2_media_kit' AS check_id,
       sum(share) FILTER (WHERE dimension = 'age' AND bucket IN ('18-24', '25-34')) AS entre_18_y_34,
       sum(share) FILTER (WHERE dimension = 'gender' AND bucket = 'F') AS mujeres,
       sum(share) FILTER (WHERE dimension = 'country' AND bucket = 'CO') AS colombia,
       sum(share) FILTER (WHERE dimension = 'age' AND bucket IN ('18-24', '25-34')) = 0.71
         AND sum(share) FILTER (WHERE dimension = 'gender' AND bucket = 'F') = 0.64
         AND sum(share) FILTER (WHERE dimension = 'country' AND bucket = 'CO') = 0.71 AS ok
FROM audience_breakdown
WHERE connection_id = '00000002-0000-4000-8000-0000000000c1';

-- (i) Pipeline (deal_pipeline): 8 abiertos por COP 80 M, ponderado
--     36,6 M, 2 seguimientos vencidos, 2 para hoy, 1 sin fecha; 4
--     ganados (3 en Q3 por 12,8 M) y 3 perdidos. El mock tiene 17
--     abiertos por 129,3 M; con ocho marcas el orden es el mismo.
SELECT 'i_pipeline' AS check_id,
       count(*) FILTER (WHERE NOT p.is_won AND NOT p.is_lost) AS abiertos,
       sum(p.amount) FILTER (WHERE NOT p.is_won AND NOT p.is_lost) AS en_pipeline,
       sum(p.weighted_amount) FILTER (WHERE NOT p.is_won AND NOT p.is_lost) AS ponderado,
       count(*) FILTER (WHERE NOT p.is_won AND NOT p.is_lost AND p.due_state = 'vencido') AS vencidos,
       count(*) FILTER (WHERE NOT p.is_won AND NOT p.is_lost AND p.due_state = 'hoy') AS hoy,
       count(*) FILTER (WHERE NOT p.is_won AND NOT p.is_lost AND p.due_state = 'sin_fecha') AS sin_fecha,
       count(*) FILTER (WHERE p.is_won) AS ganados,
       sum(p.amount) FILTER (WHERE p.is_won AND EXTRACT(QUARTER FROM d.won_at) = 3 AND EXTRACT(YEAR FROM d.won_at) = 2026) AS ganado_q3,
       count(*) FILTER (WHERE p.is_lost) AS perdidos,
       count(*) FILTER (WHERE NOT p.is_won AND NOT p.is_lost) = 8
         AND sum(p.amount) FILTER (WHERE NOT p.is_won AND NOT p.is_lost) = 80000000
         AND sum(p.weighted_amount) FILTER (WHERE NOT p.is_won AND NOT p.is_lost) = 36600000
         AND count(*) FILTER (WHERE NOT p.is_won AND NOT p.is_lost AND p.due_state = 'vencido') = 2
         AND count(*) FILTER (WHERE NOT p.is_won AND NOT p.is_lost AND p.due_state = 'hoy') = 2
         AND count(*) FILTER (WHERE p.is_won) = 4
         AND sum(p.amount) FILTER (WHERE p.is_won AND EXTRACT(QUARTER FROM d.won_at) = 3 AND EXTRACT(YEAR FROM d.won_at) = 2026) = 12800000
         AND count(*) FILTER (WHERE p.is_lost) = 3 AS ok
FROM deal_pipeline p
JOIN deal d ON d.id = p.id;

-- (i2) El tablero: cada deal con su etapa, valor, próxima acción y estado.
SELECT 'i2_tablero' AS check_id, stage_position AS pos, stage_label, company_name, name, amount, probability, weighted_amount,
       next_action, due_state, true AS ok
FROM deal_pipeline
ORDER BY stage_position, amount DESC;

-- (j) Radar: 4 por revisar, 6 aceptadas (cada una con su deal), 1
--     duplicada, 1 descartada con motivo. dedupe_key única.
SELECT 'j_radar' AS check_id, status, count(*) AS senales,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM deal d WHERE d.origin_signal_id = s.id)) AS con_deal,
       CASE status WHEN 'pending' THEN count(*) = 4
                   WHEN 'accepted' THEN count(*) = 6 AND count(*) FILTER (WHERE EXISTS (SELECT 1 FROM deal d WHERE d.origin_signal_id = s.id)) = 6
                   WHEN 'duplicate' THEN count(*) = 1
                   WHEN 'discarded' THEN count(*) = 1 AND bool_and(discard_reason IS NOT NULL)
                   ELSE false END AS ok
FROM signal s
GROUP BY status
ORDER BY status;

-- (k) La cadena señal → deal → campaña → factura → cobro se recorre
--     desde Café Alma: la campaña reportada tiene deal, resultado y, con
--     0003 aplicado, factura.
SELECT 'k_cadena' AS check_id, co.name AS marca, s.headline_es AS senal, d.name AS deal, d.stage_id, c.name AS campana, c.status,
       r.views, r.brand_followers_gained, r.code_redemptions,
       (SELECT count(*) FROM invoice i WHERE i.campaign_id = c.id) AS facturas,
       d.stage_id = 'ganado' AND c.status = 'reported' AND r.views = 712000 AS ok
FROM campaign c
JOIN deal d ON d.id = c.deal_id
JOIN company co ON co.id = c.company_id
LEFT JOIN signal s ON s.id = d.origin_signal_id
JOIN campaign_result r ON r.campaign_id = c.id
WHERE c.id = '00000003-0000-4000-8000-000000ca0001';

-- (l) Salud de las conexiones: las cuatro activas, sincronizadas hace
--     menos de un día, con sus posts contados; YouTube avisa que el
--     token vence pronto.
SELECT 'l_conexiones' AS check_id, platform_id, status, round(hours_since_sync, 1) AS horas_sin_sync, posts_tracked, token_expiring_soon,
       status = 'active' AND hours_since_sync < 24
         AND posts_tracked = CASE platform_id WHEN 'tiktok' THEN 21 WHEN 'instagram' THEN 17 WHEN 'youtube' THEN 12 ELSE 10 END
         AND token_expiring_soon = (platform_id IN ('youtube', 'tiktok')) AS ok
FROM connection_health
ORDER BY platform_id;

-- (m) Aislamiento: con otro workspace no se ve nada de esto.
SELECT set_config('app.workspace_id', '00000009-0000-4000-8000-000000000001', false);
SELECT 'm_aislamiento' AS check_id,
       (SELECT count(*) FROM post) AS posts,
       (SELECT count(*) FROM deal_pipeline) AS deals,
       (SELECT count(*) FROM creator_post_board) AS tablero,
       (SELECT count(*) FROM post) = 0 AND (SELECT count(*) FROM deal_pipeline) = 0
         AND (SELECT count(*) FROM creator_post_board) = 0 AS ok;
SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);
