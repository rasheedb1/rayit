-- =====================================================================
-- 0010 · Vistas analíticas y aislamiento por fila (RLS)
-- ---------------------------------------------------------------------
-- Las vistas de aquí son las que consume el dashboard. La regla es:
-- ninguna pantalla hace aritmética de métricas en el cliente. Si una
-- pantalla necesita un número derivado, existe una vista que lo entrega.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Última lectura de cada post. Resuelve el problema de las métricas
-- acumuladas: el dashboard casi siempre quiere "el valor de ahora".
-- ---------------------------------------------------------------------
CREATE VIEW post_metrics_latest AS
SELECT DISTINCT ON (s.post_id)
       s.post_id,
       s.workspace_id,
       s.captured_at,
       s.age_hours,
       s.views, s.reach, s.likes, s.comments, s.shares, s.saves,
       s.total_interactions,
       s.avg_watch_time_s, s.completion_rate, s.skip_rate_3s,
       s.profile_visits, s.follows_from_post,
       s.reach_followers, s.reach_non_followers,
       CASE WHEN s.reach > 0
            THEN s.reach_non_followers::numeric / s.reach END AS non_follower_share,
       CASE WHEN s.views > 0
            THEN s.total_interactions::numeric / s.views END AS engagement_per_view,
       CASE WHEN s.views > 0
            THEN (s.saves::numeric * 1000) / s.views END AS saves_per_1k
FROM post_metric_snapshot s
ORDER BY s.post_id, s.captured_at DESC;

-- ---------------------------------------------------------------------
-- Valor de cada post a un corte de edad canónico (24 h, 72 h, 7 d, 30 d).
-- Toma el snapshot más cercano al corte SIN pasarse, que es lo correcto
-- para comparar videos publicados en momentos distintos.
-- ---------------------------------------------------------------------
CREATE VIEW post_metrics_at_cut AS
SELECT DISTINCT ON (s.post_id, c.cut_hours)
       s.post_id,
       s.workspace_id,
       c.cut_hours,
       s.age_hours,
       s.views, s.reach, s.likes, s.comments, s.shares, s.saves,
       s.total_interactions, s.completion_rate, s.skip_rate_3s
FROM post_metric_snapshot s
CROSS JOIN (VALUES (24), (72), (168), (720)) AS c(cut_hours)
WHERE s.age_hours <= c.cut_hours
ORDER BY s.post_id, c.cut_hours, s.age_hours DESC;

-- ---------------------------------------------------------------------
-- Delta diario: convierte la serie acumulada en "cuánto ganó ese día".
-- Es lo que dibuja la curva de crecimiento.
-- ---------------------------------------------------------------------
CREATE VIEW post_metrics_daily_delta AS
SELECT post_id,
       workspace_id,
       captured_at::date AS day,
       max(views)  - lag(max(views))  OVER w AS views_gained,
       max(reach)  - lag(max(reach))  OVER w AS reach_gained,
       max(likes)  - lag(max(likes))  OVER w AS likes_gained,
       max(views) AS views_cumulative
FROM post_metric_snapshot
GROUP BY post_id, workspace_id, captured_at::date
WINDOW w AS (PARTITION BY post_id ORDER BY captured_at::date);

-- ---------------------------------------------------------------------
-- Tabla "Mis videos" del dashboard, lista para servir.
-- ---------------------------------------------------------------------
CREATE VIEW creator_post_board AS
SELECT p.id                AS post_id,
       p.workspace_id,
       p.creator_id,
       p.platform_id,
       p.title,
       p.caption,
       p.url,
       p.cover_url,
       p.duration_s,
       p.published_at,
       EXTRACT(EPOCH FROM (now() - p.published_at)) / 3600 AS age_hours,
       m.views, m.reach, m.saves, m.shares,
       m.skip_rate_3s,
       m.non_follower_share,
       m.saves_per_1k,
       sc.views_vs_median,
       sc.outlier_tier,
       sc.is_outlier,
       f_hook.value_text  AS hook_type,
       p.video_asset_id
FROM post p
LEFT JOIN post_metrics_latest m ON m.post_id = p.id
LEFT JOIN post_score sc         ON sc.post_id = p.id
LEFT JOIN video_asset va        ON va.id = p.video_asset_id
LEFT JOIN LATERAL (
  SELECT vf.value_text
  FROM video_analysis an
  JOIN video_feature vf ON vf.analysis_id = an.id AND vf.key = 'hook.type'
  WHERE an.video_asset_id = va.id AND an.status = 'done'
  ORDER BY an.created_at DESC
  LIMIT 1
) f_hook ON true
WHERE p.deleted_on_platform = false;

-- ---------------------------------------------------------------------
-- Salud de las conexiones: la pantalla que evita el soporte por WhatsApp.
-- ---------------------------------------------------------------------
CREATE VIEW connection_health AS
SELECT c.id,
       c.workspace_id,
       c.creator_id,
       c.platform_id,
       c.handle,
       c.status,
       c.account_type,
       c.last_synced_at,
       EXTRACT(EPOCH FROM (now() - c.last_synced_at)) / 3600 AS hours_since_sync,
       c.consecutive_failures,
       c.access_expires_at,
       (c.access_expires_at IS NOT NULL
        AND c.access_expires_at < now() + interval '24 hours') AS token_expiring_soon,
       (SELECT count(*) FROM post p WHERE p.connection_id = c.id) AS posts_tracked,
       (SELECT count(*) FROM api_call_log l
         WHERE l.connection_id = c.id
           AND l.called_at > now() - interval '24 hours'
           AND l.ok = false) AS failed_calls_24h
FROM social_connection c
WHERE c.deleted_at IS NULL;

-- ---------------------------------------------------------------------
-- Pipeline ponderado: el número que el creador y la agencia miran.
-- ---------------------------------------------------------------------
CREATE VIEW deal_pipeline AS
SELECT d.id,
       d.workspace_id,
       d.company_id,
       co.name AS company_name,
       d.creator_id,
       d.name,
       d.stage_id,
       st.label_es AS stage_label,
       st.position AS stage_position,
       d.amount,
       d.currency,
       COALESCE(d.probability, st.default_probability) AS probability,
       d.amount * COALESCE(d.probability, st.default_probability) AS weighted_amount,
       d.next_action,
       d.next_action_due,
       CASE
         WHEN d.next_action_due IS NULL THEN 'sin_fecha'
         WHEN d.next_action_due < now() THEN 'vencido'
         WHEN d.next_action_due::date = CURRENT_DATE THEN 'hoy'
         ELSE 'futuro'
       END AS due_state,
       d.last_contact_at,
       d.expected_close_date,
       st.is_won, st.is_lost
FROM deal d
JOIN pipeline_stage st ON st.id = d.stage_id
JOIN company co        ON co.id = d.company_id;

-- ---------------------------------------------------------------------
-- Cuentas por cobrar con estado de mora.
-- ---------------------------------------------------------------------
CREATE VIEW receivables AS
SELECT i.id,
       i.workspace_id,
       i.company_id,
       co.name AS company_name,
       i.campaign_id,
       i.number,
       i.total,
       i.paid_amount,
       i.total - i.paid_amount AS outstanding,
       i.currency,
       i.due_on,
       (CURRENT_DATE - i.due_on) AS days_overdue,
       i.status,
       CASE
         WHEN i.status = 'paid' THEN 'pagada'
         WHEN CURRENT_DATE > i.due_on THEN 'vencida'
         WHEN i.due_on - CURRENT_DATE <= 7 THEN 'vence_pronto'
         ELSE 'al_dia'
       END AS aging_bucket
FROM invoice i
JOIN company co ON co.id = i.company_id
WHERE i.status NOT IN ('void', 'draft');

-- ---------------------------------------------------------------------
-- Resumen del laboratorio de video: una fila por análisis con su
-- veredicto por plataforma agregado.
-- ---------------------------------------------------------------------
CREATE VIEW video_analysis_summary AS
SELECT a.id                AS analysis_id,
       a.video_asset_id,
       va.workspace_id,
       va.title,
       va.duration_s,
       va.status           AS asset_status,
       a.status            AS analysis_status,
       a.analyzer_version,
       a.finished_at,
       (SELECT count(*) FROM video_shot s WHERE s.analysis_id = a.id) AS shot_count,
       CASE WHEN va.duration_s > 0
            THEN (SELECT count(*) FROM video_shot s WHERE s.analysis_id = a.id)
                 * 60.0 / va.duration_s END AS cuts_per_minute,
       t.words_per_minute,
       ap.integrated_lufs,
       (SELECT count(*) FROM preflight_result r
         WHERE r.analysis_id = a.id AND r.outcome = 'fail') AS failures,
       (SELECT count(*) FROM preflight_result r
         WHERE r.analysis_id = a.id AND r.outcome = 'warn') AS warnings,
       (SELECT jsonb_object_agg(v.platform_id,
                jsonb_build_object('status', v.status, 'score', v.score))
          FROM preflight_verdict v WHERE v.analysis_id = a.id) AS verdicts
FROM video_analysis a
JOIN video_asset va          ON va.id = a.video_asset_id
LEFT JOIN video_transcript t ON t.analysis_id = a.id
LEFT JOIN video_audio_profile ap ON ap.analysis_id = a.id;

-- =====================================================================
-- Row Level Security
-- ---------------------------------------------------------------------
-- Se activa en las tablas con workspace_id. La aplicación fija
-- `app.workspace_id` por transacción. Dejarlo desde el principio evita
-- la migración dolorosa de después, cuando ya hay clientes reales.
-- =====================================================================
CREATE OR REPLACE FUNCTION current_workspace_id() RETURNS uuid AS $$
  SELECT nullif(current_setting('app.workspace_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'creator_profile','social_connection','data_consent','post','post_metric_snapshot',
    'account_metric_snapshot','audience_breakdown','creator_baseline','post_score',
    'watchlist','watch_target','video_asset','video_analysis','idea','script',
    'company_link','signal','deal','activity','outbound_brief','outbound_sequence',
    'outbound_touch','rate_card','media_kit','quote','campaign','campaign_brand_input',
    'campaign_result','report','report_schedule','invoice','payment','expense',
    'platform_payout','tax_reserve','notification','job_run','audit_log'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- Falla ruidosamente si alguien agrega a la lista una tabla sin
    -- workspace_id: una tabla sin aislamiento es una fuga de datos entre
    -- clientes, no un detalle menor.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'workspace_id'
    ) THEN
      RAISE EXCEPTION 'La tabla % está en la lista de RLS pero no tiene workspace_id', t;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_ws_isolation ON %I USING (workspace_id = current_workspace_id())',
      t, t);
  END LOOP;
END $$;

-- El rol de los workers necesita saltarse RLS para los jobs globales
-- (radar, tendencias, vigilancia del nicho). Se crea aquí y la app
-- nunca usa este rol para servir peticiones de usuario.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mc_worker') THEN
    CREATE ROLE mc_worker NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mc_app') THEN
    CREATE ROLE mc_app NOLOGIN;
  END IF;
END $$;
