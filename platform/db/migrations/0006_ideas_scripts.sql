-- =====================================================================
-- 0006 · Ideas y guiones
-- ---------------------------------------------------------------------
-- La idea nace del cruce entre lo que le funciona al creador (interno) y
-- lo que está funcionando en el nicho (externo). El esquema guarda la
-- EVIDENCIA de cada idea, no solo el texto: sin eso la recomendación es
-- un oráculo y nadie la sigue.
-- El guion usa la rejilla ya definida: 9 bloques de 10 s con roles
-- hook / build / giro / cierre.
-- =====================================================================

CREATE TABLE idea (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  creator_id          uuid NOT NULL REFERENCES creator_profile(id) ON DELETE CASCADE,

  title               text NOT NULL,
  angle               text,                    -- 'método que no conocías'
  format              text,                    -- 'lista' | 'comparación' | 'tutorial'
  target_platforms    text[] NOT NULL DEFAULT '{}',
  target_duration_s   int,
  niche_slug          text REFERENCES niche(slug),

  -- Predicción de la idea ANTES de producirla.
  p_outlier           numeric(6,5),
  score               int CHECK (score BETWEEN 0 AND 100),

  status              text NOT NULL DEFAULT 'suggested'
                           CHECK (status IN ('suggested','saved','scripted','in_production',
                                             'published','discarded')),
  -- Cuando se publica, se enlaza con el post real: así medimos si las
  -- ideas que sugerimos funcionaron.
  resulting_post_id   uuid REFERENCES post(id) ON DELETE SET NULL,
  resulting_asset_id  uuid REFERENCES video_asset(id) ON DELETE SET NULL,

  generated_by        text NOT NULL DEFAULT 'system'
                           CHECK (generated_by IN ('system','user')),
  model_version       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON idea (workspace_id, status, created_at DESC);
CREATE TRIGGER idea_updated BEFORE UPDATE ON idea
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Cada razón por la que sugerimos la idea, con su fuente verificable.
CREATE TABLE idea_evidence (
  id                  bigserial PRIMARY KEY,
  idea_id             uuid NOT NULL REFERENCES idea(id) ON DELETE CASCADE,
  source              text NOT NULL CHECK (source IN ('internal','niche','platform','season')),
  text_es             text NOT NULL,
  -- Referencias comprobables: el post propio o ajeno que lo respalda.
  ref_post_id         uuid REFERENCES post(id) ON DELETE SET NULL,
  ref_external_post_id uuid REFERENCES external_post(id) ON DELETE SET NULL,
  ref_trait_lift_id   uuid REFERENCES trait_lift(id) ON DELETE SET NULL,
  ref_trend_signal_id uuid REFERENCES trend_signal(id) ON DELETE SET NULL,
  weight              numeric(5,2) NOT NULL DEFAULT 1
);
CREATE INDEX ON idea_evidence (idea_id);

-- ---------------------------------------------------------------------
-- Guion
-- ---------------------------------------------------------------------
CREATE TABLE script (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idea_id             uuid REFERENCES idea(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  version             int  NOT NULL DEFAULT 1,
  title               text NOT NULL,
  -- Rejilla: por defecto 9 bloques de 10 s, pero configurable.
  block_count         int  NOT NULL DEFAULT 9,
  block_seconds       int  NOT NULL DEFAULT 10,
  words_per_block_min int  NOT NULL DEFAULT 20,
  words_per_block_max int  NOT NULL DEFAULT 23,
  -- El objeto físico que atraviesa el video y escala. Regla del formato.
  through_object      text,
  language            text NOT NULL DEFAULT 'es',

  -- Verificación de hechos: obligatoria para el nicho de historia.
  fact_check_status   text NOT NULL DEFAULT 'pending'
                           CHECK (fact_check_status IN ('pending','passed','failed','not_required')),
  fact_check_notes    text,

  voice_id            text,                    -- voz de ElevenLabs
  voice_recorded_at   timestamptz,
  measured_duration_s numeric(8,3),            -- duración REAL de la voz grabada
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idea_id, version)
);
CREATE TRIGGER script_updated BEFORE UPDATE ON script
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE script_block (
  script_id           uuid NOT NULL REFERENCES script(id) ON DELETE CASCADE,
  block_index         int  NOT NULL,           -- 1..9
  role                text NOT NULL CHECK (role IN ('hook','build','giro','cierre')),
  line                text NOT NULL,           -- narración
  word_count          int  NOT NULL,
  shots               text,                    -- descripción de los planos
  shot_count          int  NOT NULL DEFAULT 5,
  -- Validación del formato: números escritos como palabras, no dígitos.
  has_digits          boolean NOT NULL DEFAULT false,
  measured_speech_s   numeric(8,3),            -- tras grabar la voz
  PRIMARY KEY (script_id, block_index)
);

-- Variante por red: el mismo guion recortado para cada plataforma.
CREATE TABLE script_variant (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  script_id           uuid NOT NULL REFERENCES script(id) ON DELETE CASCADE,
  platform_id         text NOT NULL REFERENCES platform(id),
  blocks_used         int[] NOT NULL,
  duration_s          int,
  caption             text,
  hashtags            text[] NOT NULL DEFAULT '{}',
  on_screen_hook      text,
  sound_external_id   text,
  suggested_post_at   timestamptz,
  UNIQUE (script_id, platform_id)
);

-- ---------------------------------------------------------------------
-- Mejor hora para publicar. Se calcula por creador y plataforma a partir
-- de seguidores conectados (Instagram) y del desempeño histórico propio.
-- ---------------------------------------------------------------------
CREATE TABLE posting_window (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id          uuid NOT NULL REFERENCES creator_profile(id) ON DELETE CASCADE,
  platform_id         text NOT NULL REFERENCES platform(id),
  computed_at         timestamptz NOT NULL DEFAULT now(),
  weekday             int NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  hour                int NOT NULL CHECK (hour BETWEEN 0 AND 23),
  score               numeric(6,4) NOT NULL,   -- 0..1
  basis               text NOT NULL CHECK (basis IN ('online_followers','own_performance','mixed')),
  sample_size         int,
  UNIQUE (creator_id, platform_id, weekday, hour, computed_at)
);
CREATE INDEX ON posting_window (creator_id, platform_id, computed_at DESC);
