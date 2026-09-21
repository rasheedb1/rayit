-- =====================================================================
-- 0003 · Contenido publicado y métricas (datos internos del creador)
-- ---------------------------------------------------------------------
-- Principio central del producto: las métricas de TikTok e Instagram son
-- ACUMULADAS, no diarias. Si solo guardamos el último valor perdemos la
-- curva, y sin curva no hay outliers ni "cómo va a las 24 h".
-- Por eso post_metric_snapshot es APPEND-ONLY: una fila por lectura.
-- El delta diario se calcula con window functions, no se almacena.
-- =====================================================================

CREATE TABLE post (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  creator_id          uuid NOT NULL REFERENCES creator_profile(id) ON DELETE CASCADE,
  connection_id       uuid NOT NULL REFERENCES social_connection(id) ON DELETE CASCADE,
  platform_id         text NOT NULL REFERENCES platform(id),

  external_post_id    text NOT NULL,           -- video id / media id / video_id
  url                 text,
  permalink           text,
  cover_url           text,

  -- Qué es: condiciona qué métricas existen (una historia no tiene saves).
  media_type          text NOT NULL DEFAULT 'video'
                           CHECK (media_type IN ('video','image','carousel','story','text','live')),
  surface             text CHECK (surface IN ('feed','reels','story','shorts','video','ad')),

  caption             text,
  title               text,
  hashtags            text[] NOT NULL DEFAULT '{}',
  mentions            text[] NOT NULL DEFAULT '{}',
  duration_s          numeric(8,2),
  width               int,
  height              int,
  audio_type          text,                    -- 'MUSIC' | 'ORIGINAL_SOUND' | null
  audio_external_id   text,
  is_ai_generated     boolean,                 -- etiqueta de IA declarada en la plataforma
  is_branded_content  boolean,                 -- etiqueta de colaboración pagada

  -- Enlace con el laboratorio de video: si este post salió de un archivo
  -- que analizamos antes de publicar, aquí queda la trazabilidad. Es lo
  -- que nos permitirá calibrar el predictor con resultados reales.
  video_asset_id      uuid,                    -- FK en 0005 (evita ciclo de migraciones)

  published_at        timestamptz,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  deleted_on_platform boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (platform_id, external_post_id, connection_id)
);
CREATE INDEX ON post (workspace_id, published_at DESC);
CREATE INDEX ON post (creator_id, platform_id, published_at DESC);
CREATE INDEX ON post (connection_id, published_at DESC);
CREATE INDEX ON post USING gin (hashtags);
CREATE TRIGGER post_updated BEFORE UPDATE ON post
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Snapshot de métricas de un post. APPEND-ONLY.
-- ---------------------------------------------------------------------
-- Columnas explícitas para lo que existe en las 4 plataformas, y jsonb
-- para lo específico de cada una. Razón: las consultas del dashboard
-- (mediana, outliers, curvas) tienen que ser rápidas y tipadas; lo raro
-- puede vivir en jsonb sin costar una migración cada vez que Meta
-- renombra una métrica.
-- ---------------------------------------------------------------------
CREATE TABLE post_metric_snapshot (
  id                  bigserial PRIMARY KEY,
  post_id             uuid NOT NULL REFERENCES post(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  captured_at         timestamptz NOT NULL DEFAULT now(),
  -- Edad del post en horas al momento de la captura. Es la columna que
  -- hace posible comparar "views a las 24 h" entre videos distintos.
  age_hours           numeric(10,2) NOT NULL,

  views               bigint,
  reach               bigint,
  likes               bigint,
  comments            bigint,
  shares              bigint,
  saves               bigint,
  reposts             bigint,
  total_interactions  bigint,

  -- Retención (donde exista)
  avg_watch_time_s    numeric(10,3),
  total_watch_time_s  bigint,
  completion_rate     numeric(6,5),            -- 0..1
  skip_rate_3s        numeric(6,5),            -- Instagram: reels_skip_rate
  views_p25           bigint,                  -- cuartiles de reproducción
  views_p50           bigint,
  views_p75           bigint,
  views_p100          bigint,

  -- Conversión hacia la cuenta
  profile_visits      bigint,
  follows_from_post   bigint,
  link_clicks         bigint,

  -- Seguidor vs no seguidor (TikTok e Instagram lo dan por contenido)
  reach_followers     bigint,
  reach_non_followers bigint,

  raw                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  source              text NOT NULL DEFAULT 'api'
                           CHECK (source IN ('api','aggregator','csv_import','manual'))
);
CREATE INDEX ON post_metric_snapshot (post_id, captured_at DESC);
CREATE INDEX ON post_metric_snapshot (workspace_id, captured_at DESC);
-- Índice para los cortes canónicos (24 h, 72 h, 7 d, 30 d).
CREATE INDEX ON post_metric_snapshot (post_id, age_hours);

-- ---------------------------------------------------------------------
-- Snapshot de la cuenta. También append-only.
-- ---------------------------------------------------------------------
CREATE TABLE account_metric_snapshot (
  id                  bigserial PRIMARY KEY,
  connection_id       uuid NOT NULL REFERENCES social_connection(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  captured_at         timestamptz NOT NULL DEFAULT now(),
  day                 date NOT NULL,

  followers           bigint,
  following           bigint,
  media_count         bigint,
  views               bigint,
  reach               bigint,
  profile_views       bigint,
  accounts_engaged    bigint,
  total_interactions  bigint,
  follows             bigint,
  unfollows           bigint,
  website_clicks      bigint,

  raw                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  source              text NOT NULL DEFAULT 'api',
  UNIQUE (connection_id, day, source)
);
CREATE INDEX ON account_metric_snapshot (workspace_id, day DESC);

-- ---------------------------------------------------------------------
-- Demografía. Hereda el diseño verificado del proyecto anterior: el
-- scope dice si el dato es por post (solo YouTube, y Facebook parcial)
-- o por cuenta (TikTok Business e Instagram).
-- ---------------------------------------------------------------------
CREATE TABLE audience_breakdown (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  scope             text NOT NULL CHECK (scope IN ('post','account')),
  post_id           uuid REFERENCES post(id) ON DELETE CASCADE,
  connection_id     uuid REFERENCES social_connection(id) ON DELETE CASCADE,
  captured_at       timestamptz NOT NULL DEFAULT now(),
  day               date NOT NULL,
  -- Qué audiencia: seguidores, audiencia alcanzada o la que interactuó.
  population        text NOT NULL DEFAULT 'followers'
                         CHECK (population IN ('followers','reached','engaged','viewers')),
  dimension         text NOT NULL
                         CHECK (dimension IN ('age','gender','country','city','language',
                                              'device','follow_type','age_gender')),
  bucket            text NOT NULL,             -- '25-34' | 'F' | 'CO' | '25-34|F'
  share             numeric(7,6),              -- 0..1
  absolute          bigint,
  CHECK ((scope = 'post' AND post_id IS NOT NULL)
      OR (scope = 'account' AND connection_id IS NOT NULL))
);
CREATE INDEX ON audience_breakdown (connection_id, day DESC, dimension)
  WHERE scope = 'account';
CREATE INDEX ON audience_breakdown (post_id, dimension) WHERE scope = 'post';

-- =====================================================================
-- Línea base del creador: la mediana contra la que se comparan sus
-- propios videos. Se recalcula a diario por un job.
-- ---------------------------------------------------------------------
-- Es LA tabla que sostiene el producto: el puntaje "× mediana" de todo
-- el dashboard sale de aquí. Se guarda materializada y no se calcula al
-- vuelo porque se consulta en cada pantalla.
-- =====================================================================
CREATE TABLE creator_baseline (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  creator_id        uuid NOT NULL REFERENCES creator_profile(id) ON DELETE CASCADE,
  platform_id       text NOT NULL REFERENCES platform(id),
  computed_at       timestamptz NOT NULL DEFAULT now(),
  -- Ventana de cálculo: últimos N videos publicados.
  window_posts      int NOT NULL DEFAULT 20,
  -- Corte de edad en el que se mide (24 h, 72 h, 168 h, 720 h).
  age_hours_cut     int NOT NULL,

  sample_size       int NOT NULL,
  median_views      numeric(14,2),
  p25_views         numeric(14,2),
  p75_views         numeric(14,2),
  median_reach      numeric(14,2),
  median_engagement numeric(8,6),
  median_saves_per_1k numeric(10,4),
  median_completion numeric(6,5),
  median_skip_3s    numeric(6,5),
  -- Confiabilidad: con menos de 8 videos la mediana miente. La UI lo dice.
  is_reliable       boolean NOT NULL DEFAULT false,

  UNIQUE (creator_id, platform_id, age_hours_cut, computed_at)
);
CREATE INDEX ON creator_baseline (creator_id, platform_id, age_hours_cut, computed_at DESC);

-- ---------------------------------------------------------------------
-- Puntaje de cada post contra su línea base. Materializado por un job
-- tras cada recolección, para que la tabla de "Mis videos" sea un SELECT.
-- ---------------------------------------------------------------------
CREATE TABLE post_score (
  post_id           uuid PRIMARY KEY REFERENCES post(id) ON DELETE CASCADE,
  workspace_id      uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  baseline_id       uuid REFERENCES creator_baseline(id) ON DELETE SET NULL,

  age_hours_cut     int NOT NULL,
  views_at_cut      bigint,
  -- El número que manda en todo el producto.
  views_vs_median   numeric(8,3),
  reach_vs_median   numeric(8,3),
  saves_vs_median   numeric(8,3),
  engagement_vs_median numeric(8,3),

  is_outlier        boolean NOT NULL DEFAULT false,   -- views_vs_median >= 2
  outlier_tier      text CHECK (outlier_tier IN ('under','normal','good','outlier','breakout')),
  -- 'breakout' = >= 5x. Dispara notificación e idea de secuela.
  notified_at       timestamptz
);
CREATE INDEX ON post_score (workspace_id, views_vs_median DESC);
CREATE INDEX ON post_score (workspace_id, is_outlier) WHERE is_outlier;
