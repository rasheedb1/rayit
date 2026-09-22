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
-- El mismo reloj que el seed: CURRENT_DATE en UTC, no en la zona de la
-- sesión (ver la cabecera del seed).
SELECT set_config('TimeZone', 'UTC', false);

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
         AND (SELECT count(*) FROM activity) = 38 AS ok;

-- El último día de la serie de la cuenta es el ANTERIOR al día en que el
-- seed corrió por primera vez: el job nocturno solo tiene cerrado ayer
-- (el día 0 se ancla a lo ya guardado; ver sección 5 del seed). Las
-- comprobaciones de la serie se anclan a ese día, no a CURRENT_DATE,
-- para que valgan también contra una base sembrada hace días; y se
-- exige que ese día sea anterior a hoy y que la serie sean 90 días
-- seguidos por conexión.
-- (b) Seguidores hoy, por red: FOLLOWERS_NOW del mock (412 000 en total).
SELECT 'b_seguidores' AS check_id, c.platform_id, s.followers, s.day, s.dias,
       s.followers = CASE c.platform_id WHEN 'tiktok' THEN 214000 WHEN 'instagram' THEN 128000
                                        WHEN 'youtube' THEN 49000 ELSE 21000 END
         AND s.day = (SELECT max(day) FROM account_metric_snapshot)
         AND s.day < CURRENT_DATE
         AND s.dias = 90 AND s.primer_dia = s.day - 89 AS ok
FROM social_connection c
JOIN LATERAL (
  SELECT max(day) AS day, min(day) AS primer_dia, count(*) AS dias,
         (SELECT followers FROM account_metric_snapshot x WHERE x.connection_id = c.id ORDER BY x.day DESC LIMIT 1) AS followers
  FROM account_metric_snapshot a
  WHERE a.connection_id = c.id
) s ON true
ORDER BY c.platform_id;

-- (b2) Total de seguidores y delta a 30 días (el KPI "Seguidores en
--      total": 412 K, ≈ +2..3 %). La serie nunca baja.
WITH ancla AS (
  SELECT max(day) AS dia FROM account_metric_snapshot
), hoy AS (
  SELECT sum(followers) AS n FROM account_metric_snapshot, ancla WHERE day = ancla.dia
), hace30 AS (
  SELECT sum(followers) AS n FROM account_metric_snapshot, ancla WHERE day = ancla.dia - 30
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

-- (c) Views en 30 días. El KPI del mock es ≈ 2,6 M sobre las views
--     diarias de la cuenta: se exige entre 2,4 y 2,9 M, un margen que
--     sí defiende la cifra (la base diaria, la tendencia y el pico de
--     la arepa están calibrados para eso). Las views actuales de los
--     videos publicados en la ventana son otra lectura del mismo orden
--     (los doce del mock traen sus views tal cual): algo por debajo de
--     la cuenta, porque la cuenta también suma lo que siguen ganando
--     los videos de antes de la ventana.
WITH ancla AS (
  SELECT max(day) AS dia FROM account_metric_snapshot
)
SELECT 'c_views_30d' AS check_id,
       (SELECT sum(views) FROM account_metric_snapshot, ancla WHERE day > ancla.dia - 30) AS cuenta_30d,
       (SELECT sum(views) FROM account_metric_snapshot, ancla WHERE day > ancla.dia - 60 AND day <= ancla.dia - 30) AS cuenta_30d_previos,
       (SELECT sum(m.views) FROM post p JOIN post_metrics_latest m ON m.post_id = p.id, ancla
         WHERE p.published_at > (ancla.dia + 1)::timestamp AT TIME ZONE 'UTC' - interval '30 days') AS videos_30d,
       (SELECT count(*) FROM post, ancla WHERE published_at > (ancla.dia + 1)::timestamp AT TIME ZONE 'UTC' - interval '30 days') AS videos,
       (SELECT sum(views) FROM account_metric_snapshot, ancla WHERE day > ancla.dia - 30) BETWEEN 2400000 AND 2900000
         AND (SELECT sum(m.views) FROM post p JOIN post_metrics_latest m ON m.post_id = p.id, ancla
               WHERE p.published_at > (ancla.dia + 1)::timestamp AT TIME ZONE 'UTC' - interval '30 days') BETWEEN 2000000 AND 3200000 AS ok
FROM ancla;

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
--      de Instagram de 62 K. Todo video con 24 h según el reloj del
--      seed (medianoche UTC del día de la última corrida, que es el
--      computed_at más reciente de post_score) tiene puntaje.
SELECT 'd2_outliers' AS check_id,
       count(*) FILTER (WHERE is_outlier) AS outliers,
       count(*) FILTER (WHERE outlier_tier = 'breakout') AS breakouts,
       count(*) AS puntuados,
       (SELECT count(*) FROM post WHERE published_at <= (SELECT max(computed_at) FROM post_score) - interval '24 hours') AS con_24h,
       count(*) FILTER (WHERE is_outlier) BETWEEN 3 AND 7
         AND count(*) FILTER (WHERE outlier_tier = 'breakout') <= 1
         AND (SELECT max(computed_at) FROM post_score) <= now()
         AND count(*) = (SELECT count(*) FROM post WHERE published_at <= (SELECT max(computed_at) FROM post_score) - interval '24 hours') AS ok
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

-- (g) Los posts de las campañas de 0003 siguen la curva que lleva a sus
--     views de 30 días (412 K, 300 K, 140 K, 125 K, 58 K). Se comprueba
--     por construcción, en los cinco: la lectura de mayor edad de cada
--     uno vale round(v_ref · f(edad) / f(720)) con la fórmula de la
--     sección 4 del seed, y los que ya cumplieron 30 días tienen la
--     lectura de 720 h exacta. Así la consulta no queda vacía para los
--     videos que todavía no llegan a 30 días.
WITH esperado AS (
  SELECT * FROM (VALUES
    ('00000002-0000-4000-8000-000000000d01'::uuid, 412000, 30.0),
    ('00000002-0000-4000-8000-000000000d02'::uuid, 300000, 24.0),
    ('00000002-0000-4000-8000-000000000d03'::uuid, 140000, 24.0),
    ('00000002-0000-4000-8000-000000000d04'::uuid, 125000, 24.0),
    ('00000002-0000-4000-8000-000000000d05'::uuid,  58000, 48.0)
  ) AS v(post_id, v_ref, tau1)
), ultima AS (
  SELECT DISTINCT ON (s.post_id) s.post_id, s.age_hours::int AS age_hours, s.views
  FROM post_metric_snapshot s
  WHERE s.source = 'api' AND s.post_id IN (SELECT post_id FROM esperado)
  ORDER BY s.post_id, s.age_hours DESC
), comparado AS (
  SELECT p.external_post_id, u.age_hours, u.views, e.v_ref,
         round(e.v_ref
               * (0.85 * (1 - exp(-u.age_hours / e.tau1)) + 0.15 * (1 - exp(-u.age_hours / 400.0)))
               / (0.85 * (1 - exp(-720 / e.tau1))         + 0.15 * (1 - exp(-720 / 400.0))))::bigint AS esperado,
         EXISTS (SELECT 1 FROM post_metric_snapshot x
                  WHERE x.post_id = e.post_id AND x.source = 'api' AND x.age_hours = 720 AND x.views = e.v_ref) AS tiene_720h
  FROM esperado e
  JOIN ultima u ON u.post_id = e.post_id
  JOIN post p ON p.id = e.post_id AND p.is_branded_content
)
SELECT 'g_posts_campana' AS check_id, external_post_id, age_hours AS edad_h, views, esperado, v_ref AS views_a_720h, tiene_720h,
       (SELECT count(*) FROM comparado) = 5
         AND views = esperado
         AND (age_hours < 720 OR tiene_720h) AS ok
FROM comparado
ORDER BY external_post_id;

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

-- (i) Pipeline (deal_pipeline): 10 abiertos por COP 95,5 M, ponderado
--     43,15 M, 2 seguimientos vencidos, 2 para hoy, 1 sin fecha; 4
--     ganados (3 en Q3 por 12,8 M) y 1 perdido. El mock tiene 17
--     abiertos por 129,3 M y ponderado 49,4 M; con ocho marcas y quince
--     deals el orden es el mismo (docs/propuestas/CIM-6.md §3.1).
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
       count(*) FILTER (WHERE NOT p.is_won AND NOT p.is_lost) = 10
         AND sum(p.amount) FILTER (WHERE NOT p.is_won AND NOT p.is_lost) = 95500000
         AND sum(p.weighted_amount) FILTER (WHERE NOT p.is_won AND NOT p.is_lost) = 43150000
         AND count(*) FILTER (WHERE NOT p.is_won AND NOT p.is_lost AND p.due_state = 'vencido') = 2
         AND count(*) FILTER (WHERE NOT p.is_won AND NOT p.is_lost AND p.due_state = 'hoy') = 2
         AND count(*) FILTER (WHERE NOT p.is_won AND NOT p.is_lost AND p.due_state = 'sin_fecha') = 1
         AND count(*) FILTER (WHERE p.is_won) = 4
         AND sum(p.amount) FILTER (WHERE p.is_won AND EXTRACT(QUARTER FROM d.won_at) = 3 AND EXTRACT(YEAR FROM d.won_at) = 2026) = 12800000
         AND count(*) FILTER (WHERE p.is_lost) = 1 AS ok
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

-- (n) Nada del seed está en el futuro: ni un resultado de campaña
--     calculado antes de que el video cumpla 30 días, ni un reporte
--     "enviado" mañana, ni una lectura capturada antes de la edad que
--     dice tener (vale para las lecturas manuales de 0003 también).
SELECT 'n_sin_futuro' AS check_id,
       (SELECT count(*) FROM campaign_result WHERE computed_at > now())                        AS resultados_futuros,
       (SELECT count(*) FROM activity WHERE occurred_at > now())                               AS actividades_futuras,
       (SELECT count(*) FROM post_metric_snapshot WHERE captured_at > now())                   AS lecturas_futuras,
       (SELECT count(*) FROM post_metric_snapshot s JOIN post p ON p.id = s.post_id
         WHERE s.captured_at < p.published_at + make_interval(hours => s.age_hours::int))     AS lecturas_antes_de_su_edad,
       (SELECT count(*) FROM signal WHERE detected_at > now() OR reviewed_at > now())          AS senales_futuras,
       (SELECT count(*) FROM deal WHERE created_at > now() OR last_contact_at > now()
                                     OR won_at > now() OR lost_at > now())                     AS deals_futuros,
       (SELECT count(*) FROM deal_stage_history WHERE changed_at > now())                      AS etapas_futuras,
       (SELECT count(*) FROM campaign_brand_input WHERE received_at > now())                   AS aportes_futuros,
       (SELECT count(*) FROM campaign_result cr JOIN campaign_post cp ON cp.campaign_id = cr.campaign_id
          JOIN post p ON p.id = cp.post_id
         WHERE cr.computed_at < p.published_at + make_interval(hours => cr.cut_hours))         AS resultados_antes_del_corte,
       (SELECT count(*) FROM campaign_result WHERE computed_at > now()) = 0
         AND (SELECT count(*) FROM activity WHERE occurred_at > now()) = 0
         AND (SELECT count(*) FROM post_metric_snapshot WHERE captured_at > now()) = 0
         AND (SELECT count(*) FROM post_metric_snapshot s JOIN post p ON p.id = s.post_id
               WHERE s.captured_at < p.published_at + make_interval(hours => s.age_hours::int)) = 0
         AND (SELECT count(*) FROM signal WHERE detected_at > now() OR reviewed_at > now()) = 0
         AND (SELECT count(*) FROM deal WHERE created_at > now() OR last_contact_at > now()
                                           OR won_at > now() OR lost_at > now()) = 0
         AND (SELECT count(*) FROM deal_stage_history WHERE changed_at > now()) = 0
         AND (SELECT count(*) FROM campaign_brand_input WHERE received_at > now()) = 0
         AND (SELECT count(*) FROM campaign_result cr JOIN campaign_post cp ON cp.campaign_id = cr.campaign_id
                JOIN post p ON p.id = cp.post_id
               WHERE cr.computed_at < p.published_at + make_interval(hours => cr.cut_hours)) = 0 AS ok;

-- (o) La baja de Mateo Giraldo se respeta en todos los canales: el
--     disparador de outbound_touch (0007) rechaza programar o enviar
--     un toque a un contacto con opted_out, con ERRCODE check_violation.
--     Se intenta en los tres canales permitidos y en los dos estados
--     que el disparador vigila; si alguno pasa, el bloque lanza un error
--     distinto (raise_exception) que run.mjs no traga, y la consulta
--     de después exige que no quede ningún toque para ese contacto.
DO $$
DECLARE
  canal text;
  estado text;
BEGIN
  FOREACH canal IN ARRAY ARRAY['email', 'linkedin', 'instagram_dm'] LOOP
    FOREACH estado IN ARRAY ARRAY['scheduled', 'sent'] LOOP
      BEGIN
        INSERT INTO outbound_touch (workspace_id, company_id, contact_id, channel, subject, body, status, scheduled_for, sent_at)
        VALUES ('00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e6',
                '00000002-0000-4000-8000-0000000c0010', canal, 'Prueba de la baja',
                'Este toque no debería poder programarse ni enviarse.', estado,
                CASE WHEN estado = 'scheduled' THEN now() + interval '1 day' END,
                CASE WHEN estado = 'sent' THEN now() END);
        RAISE EXCEPTION 'la baja no se respetó: canal %, estado %', canal, estado;
      EXCEPTION WHEN check_violation THEN
        NULL; -- lo esperado: el disparador lo bloqueó
      END;
    END LOOP;
  END LOOP;
END $$;

SELECT 'o_baja_respetada' AS check_id, c.full_name, c.opted_out, c.opted_out_at,
       (SELECT count(*) FROM outbound_touch t WHERE t.contact_id = c.id) AS toques,
       c.opted_out AND c.opted_out_at IS NOT NULL
         AND (SELECT count(*) FROM outbound_touch t WHERE t.contact_id = c.id) = 0 AS ok
FROM contact c
WHERE c.id = '00000002-0000-4000-8000-0000000c0010';

-- (p) Lo que el tablero mira hoy no envejece: ningún deal abierto tiene
--     el cierre esperado en el pasado (los planes van relativos a
--     CURRENT_DATE, sección 10 del seed; solo Olla Fácil, recién
--     entrado, no lo tiene), ninguna señal pendiente lleva más de 14
--     días en la bandeja y el brief activo todavía no cerró su ventana.
--     Es la comprobación que `run.mjs --dias N` vigila con el reloj a
--     +N días: sembrada en limpio cualquier día, Ventas cuenta la misma
--     historia.
SELECT 'p_planes_vivos' AS check_id,
       (SELECT count(*) FROM deal d JOIN pipeline_stage st ON st.id = d.stage_id
         WHERE NOT st.is_won AND NOT st.is_lost AND d.expected_close_date < CURRENT_DATE)    AS cierres_en_el_pasado,
       (SELECT count(*) FROM deal d JOIN pipeline_stage st ON st.id = d.stage_id
         WHERE NOT st.is_won AND NOT st.is_lost AND d.expected_close_date IS NULL)           AS abiertos_sin_cierre,
       (SELECT count(*) FROM signal WHERE status = 'pending' AND detected_at < now() - interval '14 days') AS senales_viejas,
       (SELECT count(*) FROM outbound_brief WHERE status = 'active' AND availability_to < CURRENT_DATE)    AS briefs_vencidos,
       (SELECT count(*) FROM deal d JOIN pipeline_stage st ON st.id = d.stage_id
         WHERE NOT st.is_won AND NOT st.is_lost AND d.expected_close_date < CURRENT_DATE) = 0
         AND (SELECT count(*) FROM deal d JOIN pipeline_stage st ON st.id = d.stage_id
               WHERE NOT st.is_won AND NOT st.is_lost AND d.expected_close_date IS NULL) = 1
         AND (SELECT count(*) FROM signal WHERE status = 'pending' AND detected_at < now() - interval '14 days') = 0
         AND (SELECT count(*) FROM outbound_brief WHERE status = 'active' AND availability_to < CURRENT_DATE) = 0 AS ok;
