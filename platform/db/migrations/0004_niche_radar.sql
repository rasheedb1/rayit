-- =====================================================================
-- 0004 · Tendencias del nicho (datos externos)
-- ---------------------------------------------------------------------
-- Dos diferencias importantes frente al dato interno:
--   1. De una cuenta ajena NO tenemos insights, solo lo público. El
--      esquema no finge lo contrario: hay views, likes y comentarios,
--      nada de alcance ni retención.
--   2. El outlier externo se mide contra la mediana de SU PROPIA cuenta,
--      igual que el interno. Por eso guardamos también la línea base de
--      cada cuenta vigilada.
-- =====================================================================

CREATE TABLE watchlist (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  creator_id        uuid REFERENCES creator_profile(id) ON DELETE CASCADE,
  name              text NOT NULL,
  niche_slug        text REFERENCES niche(slug),
  country           char(2),
  language          text DEFAULT 'es',
  is_default        boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON watchlist (workspace_id);

-- Qué vigilamos: cuentas, hashtags o sonidos.
CREATE TABLE watch_target (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watchlist_id      uuid NOT NULL REFERENCES watchlist(id) ON DELETE CASCADE,
  workspace_id      uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  platform_id       text NOT NULL REFERENCES platform(id),
  target_type       text NOT NULL CHECK (target_type IN ('account','hashtag','sound','keyword')),
  handle            text,                      -- '@chefpaula' o '#recetafacil'
  external_id       text,                      -- id estable si la API lo da
  url               text,
  followers         bigint,
  status            text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','paused','error','not_found')),
  last_checked_at   timestamptz,
  check_interval_h  int NOT NULL DEFAULT 24,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (watchlist_id, platform_id, target_type, handle)
);
CREATE INDEX ON watch_target (workspace_id, status);
CREATE INDEX ON watch_target (last_checked_at NULLS FIRST) WHERE status = 'active';

-- ---------------------------------------------------------------------
-- Video ajeno observado. Se deduplica por (plataforma, id externo) a
-- nivel GLOBAL, no por workspace: si dos clientes vigilan la misma
-- cuenta, el video se descarga y analiza una sola vez.
-- ---------------------------------------------------------------------
CREATE TABLE external_post (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id       text NOT NULL REFERENCES platform(id),
  external_post_id  text NOT NULL,
  external_account_id text,
  handle            text,
  url               text,
  cover_url         text,
  caption           text,
  hashtags          text[] NOT NULL DEFAULT '{}',
  duration_s        numeric(8,2),
  audio_type        text,
  audio_external_id text,
  audio_title       text,
  published_at      timestamptz,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  -- Rasgos extraídos por el analizador (mismo motor que el laboratorio
  -- de video). NULL mientras no se haya analizado.
  analysis_id       uuid,                      -- FK en 0005
  UNIQUE (platform_id, external_post_id)
);
CREATE INDEX ON external_post (platform_id, published_at DESC);
CREATE INDEX ON external_post USING gin (hashtags);

CREATE TABLE external_post_snapshot (
  id                bigserial PRIMARY KEY,
  external_post_id  uuid NOT NULL REFERENCES external_post(id) ON DELETE CASCADE,
  captured_at       timestamptz NOT NULL DEFAULT now(),
  age_hours         numeric(10,2),
  views             bigint,
  likes             bigint,
  comments          bigint,
  shares            bigint,
  saves             bigint,
  source            text NOT NULL DEFAULT 'api'
);
CREATE INDEX ON external_post_snapshot (external_post_id, captured_at DESC);

-- Línea base de la cuenta ajena, para saber qué es outlier PARA ELLA.
CREATE TABLE external_account_baseline (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id       text NOT NULL REFERENCES platform(id),
  external_account_id text NOT NULL,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  window_posts      int NOT NULL DEFAULT 20,
  sample_size       int NOT NULL,
  median_views      numeric(14,2),
  p75_views         numeric(14,2),
  followers         bigint,
  UNIQUE (platform_id, external_account_id, computed_at)
);
CREATE INDEX ON external_account_baseline (platform_id, external_account_id, computed_at DESC);

CREATE TABLE external_post_score (
  external_post_id  uuid PRIMARY KEY REFERENCES external_post(id) ON DELETE CASCADE,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  views_vs_median   numeric(8,3),
  is_outlier        boolean NOT NULL DEFAULT false,
  velocity_24h      bigint,                    -- views ganadas en las primeras 24 h
  niche_slug        text REFERENCES niche(slug)
);
CREATE INDEX ON external_post_score (niche_slug, views_vs_median DESC);

-- ---------------------------------------------------------------------
-- Lift de rasgos: el resultado del análisis comparativo. "El hook de
-- método aparece 2,6 veces más en los outliers que en el resto."
-- Se recalcula por nicho y ventana.
-- ---------------------------------------------------------------------
CREATE TABLE trait_lift (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope             text NOT NULL CHECK (scope IN ('niche','creator')),
  niche_slug        text REFERENCES niche(slug),
  creator_id        uuid REFERENCES creator_profile(id) ON DELETE CASCADE,
  platform_id       text REFERENCES platform(id),
  computed_at       timestamptz NOT NULL DEFAULT now(),
  window_days       int NOT NULL DEFAULT 7,

  trait_key         text NOT NULL,             -- 'hook.type=method' | 'duration.lt40s'
  trait_label       text NOT NULL,             -- texto para la UI, en español
  freq_outliers     numeric(6,5) NOT NULL,     -- 0..1
  freq_rest         numeric(6,5) NOT NULL,
  lift              numeric(8,3) NOT NULL,     -- freq_outliers / freq_rest
  sample_outliers   int NOT NULL,
  sample_rest       int NOT NULL,
  -- Sin esto se publican correlaciones de 3 videos como si fueran ley.
  is_significant    boolean NOT NULL DEFAULT false,
  p_value           numeric(8,6)
);
CREATE INDEX ON trait_lift (niche_slug, computed_at DESC, lift DESC) WHERE scope = 'niche';
CREATE INDEX ON trait_lift (creator_id, computed_at DESC) WHERE scope = 'creator';

-- Sonidos y hashtags en alza.
CREATE TABLE trend_signal (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id       text NOT NULL REFERENCES platform(id),
  niche_slug        text REFERENCES niche(slug),
  country           char(2),
  kind              text NOT NULL CHECK (kind IN ('sound','hashtag','keyword','format')),
  key               text NOT NULL,
  label             text NOT NULL,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  uses_current      bigint,
  uses_previous     bigint,
  growth            numeric(8,4),              -- (actual - previo) / previo
  source            text NOT NULL,             -- 'creative_center' | 'watchlist' | 'hashtag_search'
  UNIQUE (platform_id, kind, key, computed_at)
);
CREATE INDEX ON trend_signal (niche_slug, computed_at DESC, growth DESC);
