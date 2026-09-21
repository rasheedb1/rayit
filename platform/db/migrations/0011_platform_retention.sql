-- =====================================================================
-- 0011 · Curvas por segundo que entrega la propia plataforma
-- ---------------------------------------------------------------------
-- CORRECCIÓN IMPORTANTE de una suposición previa del proyecto.
--
-- Hasta ahora asumíamos que TikTok no daba retención por video y que la
-- demografía solo existía a nivel de cuenta. Eso es cierto para la
-- Display API (developers.tiktok.com), que entrega 16 campos y cuatro
-- contadores. Pero existe una SEGUNDA familia de API, separada y poco
-- documentada: la Accounts API de TikTok for Business
-- (business-api.tiktok.com/open_api/v1.3/business/video/list/), que con
-- el scope `video.insights` entrega, por video:
--
--   * video_view_retention  → { second, percentage }  ← RETENCIÓN POR SEGUNDO
--   * engagement_likes      → likes en cada segundo del timeline
--   * impression_sources    → For You / Follow / Sound / Search / …
--   * audience_countries, audience_cities, audience_genders  POR VIDEO
--   * audience_types        → nuevo vs recurrente, seguidor vs no
--   * total_time_watched, average_time_watched, full_video_watched_rate
--   * reach, new_followers, profile_views
--
-- Consecuencia de producto: para TikTok NO necesitamos predecir la
-- retención, la medimos. El predictor del laboratorio de video se
-- entrena contra retención REAL, que es exactamente lo que hacía falta
-- para que la predicción deje de ser folclore.
--
-- Consecuencias operativas, todas en el plan de equipo:
--   1. Son dos apps distintas, con OAuth y auditoría propios.
--   2. Desde el 20 de marzo de 2026 hay que llenar el Accounts API
--      Access Application Form ANTES de someter la app. Es el camino
--      crítico del proyecto.
--   3. Los datos llegan con 24 a 48 h de retraso: nada es "en vivo".
--   4. TikTok deja de actualizar un post a los 365 días → nuestros
--      snapshots son la única memoria histórica del creador.
--   5. Descargar el mp4 está prohibido por los términos. Por eso el
--      laboratorio de video se alimenta del máster que sube el creador,
--      y publicamos nosotros. Eso no es un rodeo: es la arquitectura.
-- =====================================================================

-- Corrige las capacidades declaradas de TikTok.
UPDATE platform SET capabilities = jsonb_build_object(
  'api_family_analytics',   'accounts_api',
  'demographics_per_post',  true,       -- país, ciudad y género, con video.insights
  'demographics_per_account', true,     -- edad incluida, requiere >= 100 seguidores
  'retention_curve',        true,       -- video_view_retention, por segundo
  'engagement_curve',       true,       -- engagement_likes, por segundo
  'impression_sources',     true,
  'viewer_types',           true,       -- nuevo/recurrente, seguidor/no seguidor
  'file_download',          false,      -- prohibido por términos
  'data_freshness_hours',   48,
  'history_limit_days',     365,
  'requires_analytics_optin', true      -- el creador pulsa "Turn On" en la app
), updated_at = now()
WHERE id = 'tiktok';

UPDATE platform SET limits = jsonb_build_object(
  'display_api_rpm',        600,
  'accounts_api_qpm_per_account_endpoint', 40,
  'accounts_api_qpm_app_basic', 600,
  'video_list_max_count',   20,
  'publish_per_min',        6,
  'publish_per_day',        15,
  'inactive_post_days_before_gaps', 7
), updated_at = now()
WHERE id = 'tiktok';

-- ---------------------------------------------------------------------
-- Curva de retención REAL del post, tal como la entrega la plataforma.
-- ---------------------------------------------------------------------
-- Es append-only como el resto de métricas: la curva cambia mientras el
-- video sigue recibiendo vistas, y queremos poder comparar la curva de
-- las primeras 48 h con la de los 30 días.
-- ---------------------------------------------------------------------
CREATE TABLE post_retention_curve (
  id                  bigserial PRIMARY KEY,
  post_id             uuid NOT NULL REFERENCES post(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  captured_at         timestamptz NOT NULL DEFAULT now(),
  age_hours           numeric(10,2) NOT NULL,
  source              text NOT NULL DEFAULT 'tiktok_accounts_api'
                           CHECK (source IN ('tiktok_accounts_api','youtube_analytics',
                                             'csv_import','estimated')),
  -- La curva completa en un jsonb ordenado: [{s:0,p:1.0},{s:1,p:0.82},…]
  -- Se guarda así para leerla de un tirón al pintar el gráfico.
  curve               jsonb NOT NULL,
  seconds_count       int NOT NULL,
  -- Derivadas que se consultan sin abrir el jsonb.
  retention_1s        numeric(6,5),
  retention_3s        numeric(6,5),
  retention_50pct_at  numeric(8,3),   -- en qué segundo queda la mitad
  biggest_drop_at     int,            -- segundo con la mayor caída
  biggest_drop_size   numeric(6,5),
  full_watch_rate     numeric(6,5),
  avg_watch_time_s    numeric(10,3),
  total_watch_time_s  bigint,
  UNIQUE (post_id, captured_at, source)
);
CREATE INDEX ON post_retention_curve (post_id, captured_at DESC);
CREATE INDEX ON post_retention_curve (workspace_id, retention_3s);

-- ---------------------------------------------------------------------
-- Likes por segundo del timeline. TikTok lo da y es oro puro: dice
-- exactamente qué momento del video emocionó. Ninguna otra plataforma
-- lo expone.
-- ---------------------------------------------------------------------
CREATE TABLE post_engagement_curve (
  id                  bigserial PRIMARY KEY,
  post_id             uuid NOT NULL REFERENCES post(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  captured_at         timestamptz NOT NULL DEFAULT now(),
  kind                text NOT NULL DEFAULT 'likes' CHECK (kind IN ('likes','shares','comments')),
  curve               jsonb NOT NULL,          -- [{s:0,v:12},…]
  peak_at             int,
  peak_value          bigint,
  UNIQUE (post_id, captured_at, kind)
);
CREATE INDEX ON post_engagement_curve (post_id, captured_at DESC);

-- ---------------------------------------------------------------------
-- De dónde vinieron las vistas. Explica por qué un video funcionó:
-- no es lo mismo crecer por For You que por Search o por el sonido.
-- ---------------------------------------------------------------------
CREATE TABLE post_impression_source (
  id                  bigserial PRIMARY KEY,
  post_id             uuid NOT NULL REFERENCES post(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  captured_at         timestamptz NOT NULL DEFAULT now(),
  source_name         text NOT NULL,           -- 'For You' | 'Search' | 'Sound' | …
  share               numeric(7,6),
  absolute            bigint,
  UNIQUE (post_id, captured_at, source_name)
);
CREATE INDEX ON post_impression_source (post_id, captured_at DESC);

-- Nuevos valores de dimensión ahora que TikTok da demografía por video
-- y tipo de espectador.
ALTER TABLE audience_breakdown DROP CONSTRAINT audience_breakdown_dimension_check;
ALTER TABLE audience_breakdown ADD CONSTRAINT audience_breakdown_dimension_check
  CHECK (dimension IN ('age','gender','country','city','language','device',
                       'follow_type','age_gender','viewer_type'));
-- viewer_type: NEW_VIEWER | RETURN_VIEWER | FOLLOWER | NON_FOLLOWER

-- ---------------------------------------------------------------------
-- Enlace entre la curva real de la plataforma y el análisis del archivo.
-- ---------------------------------------------------------------------
-- Aquí está el valor compuesto del producto: para cada segundo tenemos
-- lo que PASA en el video (video_second) y cuánta gente SIGUE VIENDO
-- (post_retention_curve). Cruzarlos da la respuesta que ningún creador
-- tiene hoy: "perdiste el 31 % de la audiencia en el segundo 7, donde
-- hay un plano estático de cuatro segundos sin texto en pantalla".
-- ---------------------------------------------------------------------
CREATE VIEW second_by_second AS
SELECT p.id                       AS post_id,
       p.workspace_id,
       p.platform_id,
       vs.t                       AS second,
       -- Qué pasa en el video en ese segundo
       vs.shot_index,
       vs.cuts_in_second,
       vs.motion,
       vs.brightness,
       vs.has_text,
       vs.text_in_unsafe_zone,
       vs.face_count,
       vs.speech,
       vs.music,
       vs.words_in_second,
       vs.loudness_lufs,
       vs.narrative_role,
       -- Cuánta gente sigue ahí, según la plataforma
       (rc.curve -> vs.t ->> 'p')::numeric      AS retention,
       -- Cuánta se fue justo en ese segundo
       (rc.curve -> vs.t ->> 'p')::numeric
         - (rc.curve -> (vs.t + 1) ->> 'p')::numeric  AS drop_next,
       (ec.curve -> vs.t ->> 'v')::bigint       AS likes_in_second
FROM post p
JOIN video_asset va      ON va.id = p.video_asset_id
JOIN video_analysis an   ON an.video_asset_id = va.id AND an.status = 'done'
JOIN video_second vs     ON vs.analysis_id = an.id
LEFT JOIN LATERAL (
  SELECT c.curve FROM post_retention_curve c
  WHERE c.post_id = p.id ORDER BY c.captured_at DESC LIMIT 1
) rc ON true
LEFT JOIN LATERAL (
  SELECT e.curve FROM post_engagement_curve e
  WHERE e.post_id = p.id AND e.kind = 'likes'
  ORDER BY e.captured_at DESC LIMIT 1
) ec ON true;

-- ---------------------------------------------------------------------
-- Prerrequisitos que el creador debe cumplir en cada plataforma para que
-- una métrica exista. La UI los lee para explicar huecos en vez de
-- mostrar celdas vacías, que es lo que genera soporte por WhatsApp.
-- ---------------------------------------------------------------------
CREATE TABLE metric_requirement (
  id                  text PRIMARY KEY,
  platform_id         text NOT NULL REFERENCES platform(id),
  metric_group        text NOT NULL,
  requirement         text NOT NULL
                           CHECK (requirement IN ('business_account','verified_business',
                                                  'min_followers_100','analytics_optin',
                                                  'scope_video_insights','app_audited',
                                                  'post_active_7d')),
  message_es          text NOT NULL,
  fix_url             text
);

INSERT INTO metric_requirement (id, platform_id, metric_group, requirement, message_es) VALUES
  ('tt.insights.scope',    'tiktok', 'retencion_y_audiencia', 'scope_video_insights',
   'Falta el permiso de analítica de video. Vuelve a conectar la cuenta y acepta el permiso de insights.'),
  ('tt.insights.optin',    'tiktok', 'retencion_y_audiencia', 'analytics_optin',
   'Activa Analytics en la app de TikTok (Herramientas de creador, botón Activar). Sin eso TikTok no entrega datos por API.'),
  ('tt.profile_views',     'tiktok', 'visitas_al_perfil',     'business_account',
   'Las visitas al perfil por video solo existen en cuentas Business de TikTok.'),
  ('tt.contact_clicks',    'tiktok', 'clics_de_contacto',     'verified_business',
   'Los clics a sitio web y contacto requieren cuenta Business verificada.'),
  ('tt.audience_age',      'tiktok', 'demografia_de_cuenta',  'min_followers_100',
   'La demografía de seguidores necesita al menos cien seguidores.'),
  ('tt.inactive',          'tiktok', 'alcance_y_retencion',   'post_active_7d',
   'TikTok deja de reportar alcance y retención de videos sin interacción en los últimos siete días.'),
  ('ig.demographics',      'instagram', 'demografia_de_cuenta','min_followers_100',
   'La demografía de Instagram necesita al menos cien seguidores o cien interacciones en el período.');

CREATE INDEX ON metric_requirement (platform_id, metric_group);

-- Las tablas nuevas también quedan aisladas por workspace.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['post_retention_curve','post_engagement_curve','post_impression_source'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_ws_isolation ON %I USING (workspace_id = current_workspace_id())', t, t);
  END LOOP;
END $$;
