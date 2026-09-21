-- =====================================================================
-- 0005 · Laboratorio de video: análisis segundo a segundo y semáforo
--        de "listo para publicar"
-- ---------------------------------------------------------------------
-- Este módulo sirve a tres flujos con el MISMO motor:
--   A. El creador sube un video editado que todavía no publicó  → preflight
--   B. Analizamos sus videos ya publicados                       → aprendizaje
--   C. Analizamos videos ajenos del nicho                        → tendencias
-- Por eso video_asset tiene `origin` y el análisis no asume que el video
-- sea del creador.
--
-- Decisiones de diseño que importan:
--   * El análisis es VERSIONADO (analyzer_version). Cuando mejoremos el
--     modelo no se pisa el histórico: se crea una corrida nueva. Sin esto
--     no se puede medir si el predictor mejoró.
--   * La granularidad base es 1 segundo (video_second) y encima va la
--     capa de planos (video_shot). Un segundo puede contener varios
--     cortes; ambos se guardan.
--   * Las reglas del semáforo viven en la BASE DE DATOS, no en el código:
--     son parámetros que se calibran con resultados reales por nicho y
--     plataforma, y el creador tiene que poder ver el umbral exacto.
-- =====================================================================

-- ---------------------------------------------------------------------
-- El archivo
-- ---------------------------------------------------------------------
CREATE TABLE video_asset (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid REFERENCES workspace(id) ON DELETE CASCADE,
  creator_id          uuid REFERENCES creator_profile(id) ON DELETE SET NULL,
  uploaded_by         uuid REFERENCES app_user(id) ON DELETE SET NULL,

  origin              text NOT NULL DEFAULT 'upload'
                           CHECK (origin IN ('upload','own_published','external','generated')),
  -- 'generated' = salió de nuestra propia generación con IA (Higgsfield).

  -- Si es un video ya publicado o ajeno, de dónde vino.
  post_id             uuid REFERENCES post(id) ON DELETE SET NULL,
  external_post_id    uuid REFERENCES external_post(id) ON DELETE SET NULL,

  title               text,
  notes               text,
  intended_platforms  text[] NOT NULL DEFAULT '{}',   -- para qué redes se piensa
  intended_niche      text REFERENCES niche(slug),
  language            text DEFAULT 'es',

  -- Almacenamiento: nunca guardamos el binario en Postgres.
  storage_key         text,                    -- clave en S3/R2
  storage_bucket      text,
  content_hash        text,                    -- sha256: deduplica reprocesos
  file_size_bytes     bigint,
  mime_type           text,

  -- Ficha técnica (ffprobe)
  duration_s          numeric(8,3),
  width               int,
  height              int,
  fps                 numeric(6,3),
  video_codec         text,
  audio_codec         text,
  bitrate_kbps        int,
  has_audio           boolean,
  audio_channels      int,
  audio_sample_rate   int,
  rotation            int,

  status              text NOT NULL DEFAULT 'uploaded'
                           CHECK (status IN ('uploaded','probing','queued','analyzing',
                                             'analyzed','failed','archived')),
  status_detail       text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  -- Retención: el archivo original se borra a los N días; el análisis queda.
  purge_file_after    timestamptz
);
CREATE INDEX ON video_asset (workspace_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ON video_asset (status) WHERE status IN ('queued','analyzing');
CREATE UNIQUE INDEX ON video_asset (content_hash) WHERE content_hash IS NOT NULL AND deleted_at IS NULL;
CREATE TRIGGER video_asset_updated BEFORE UPDATE ON video_asset
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Cerramos el ciclo de FKs que quedó abierto en migraciones anteriores.
ALTER TABLE post
  ADD CONSTRAINT post_video_asset_fk
  FOREIGN KEY (video_asset_id) REFERENCES video_asset(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- Una corrida de análisis
-- ---------------------------------------------------------------------
CREATE TABLE video_analysis (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_asset_id      uuid NOT NULL REFERENCES video_asset(id) ON DELETE CASCADE,
  workspace_id        uuid REFERENCES workspace(id) ON DELETE CASCADE,

  analyzer_version    text NOT NULL,           -- 'v1.3.0'
  ruleset_version     text,                    -- versión del semáforo aplicado
  -- Qué etapas corrieron: permite análisis parciales y reintentos finos.
  stages_done         text[] NOT NULL DEFAULT '{}',
  -- probe, shots, frames, ocr, asr, audio, faces, vision_llm, scoring

  status              text NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued','running','done','failed','partial')),
  error               text,

  -- Costo real de la corrida: sin esto no se puede fijar el precio del
  -- plan ni saber cuánto cuesta un análisis.
  cost_usd            numeric(10,4),
  compute_ms          int,
  tokens_in           int,
  tokens_out          int,

  started_at          timestamptz,
  finished_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (video_asset_id, analyzer_version)
);
CREATE INDEX ON video_analysis (video_asset_id, created_at DESC);
CREATE INDEX ON video_analysis (status) WHERE status IN ('queued','running');

ALTER TABLE external_post
  ADD CONSTRAINT external_post_analysis_fk
  FOREIGN KEY (analysis_id) REFERENCES video_analysis(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- SEGUNDO A SEGUNDO. Una fila por segundo de video.
-- ---------------------------------------------------------------------
-- Un video de 90 s son 90 filas. Con 10.000 videos analizados al mes son
-- 900.000 filas/mes: Postgres lo maneja sin despeinarse durante años.
-- Todas las columnas son medibles sin modelo de IA salvo las marcadas.
-- ---------------------------------------------------------------------
CREATE TABLE video_second (
  analysis_id         uuid NOT NULL REFERENCES video_analysis(id) ON DELETE CASCADE,
  t                   int  NOT NULL,           -- segundo (0-based)

  -- Imagen
  shot_index          int,                     -- a qué plano pertenece
  cuts_in_second      int NOT NULL DEFAULT 0,  -- cortes que ocurren en este segundo
  brightness          numeric(6,4),            -- 0..1 luma media
  contrast            numeric(6,4),
  saturation          numeric(6,4),
  colorfulness        numeric(8,4),
  motion              numeric(8,4),            -- magnitud media de flujo óptico
  blur                numeric(8,4),            -- varianza del laplaciano (bajo = borroso)
  -- Rostro: el mayor detectado en el segundo
  face_count          int NOT NULL DEFAULT 0,
  face_area_ratio     numeric(6,5),            -- área del rostro / área del cuadro
  face_centered       boolean,
  eye_contact         boolean,                 -- mirada a cámara (modelo)

  -- Texto en pantalla
  has_text            boolean NOT NULL DEFAULT false,
  text_area_ratio     numeric(6,5),
  text_chars          int,
  -- Zona segura: ¿el texto cae donde la UI de la red lo tapa?
  text_in_unsafe_zone boolean,

  -- Audio
  loudness_lufs       numeric(7,2),            -- momentánea, EBU R128
  is_silence          boolean NOT NULL DEFAULT false,
  speech              boolean NOT NULL DEFAULT false,
  music               boolean NOT NULL DEFAULT false,
  speech_music_ratio  numeric(6,3),
  words_in_second     int NOT NULL DEFAULT 0,

  -- Semántica (modelo multimodal). Nullable a propósito: el análisis
  -- barato no las llena.
  scene_label         text,
  narrative_role      text CHECK (narrative_role IN
                           ('hook','setup','build','proof','turn','payoff','cta','outro')),
  info_density        numeric(6,4),            -- cuánta información nueva aporta
  predicted_dropoff   numeric(6,5),            -- riesgo de abandono en este segundo

  PRIMARY KEY (analysis_id, t)
);
-- Consulta típica: "dame los primeros 3 segundos de este análisis".
CREATE INDEX ON video_second (analysis_id, t) WHERE t < 5;

-- ---------------------------------------------------------------------
-- Planos (cortes detectados)
-- ---------------------------------------------------------------------
CREATE TABLE video_shot (
  analysis_id         uuid NOT NULL REFERENCES video_analysis(id) ON DELETE CASCADE,
  shot_index          int  NOT NULL,
  start_s             numeric(8,3) NOT NULL,
  end_s               numeric(8,3) NOT NULL,
  duration_s          numeric(8,3) NOT NULL,
  transition          text CHECK (transition IN ('cut','fade','dissolve','wipe','unknown')),
  shot_size           text CHECK (shot_size IN
                           ('extreme_close','close','medium_close','medium','medium_wide','wide','extreme_wide')),
  camera_angle        text CHECK (camera_angle IN ('eye','high','low','overhead','dutch','unknown')),
  camera_movement     text CHECK (camera_movement IN ('static','pan','tilt','zoom','handheld','orbit','unknown')),
  subject             text,
  keyframe_key        text,                    -- fotograma representativo en S3
  description         text,                    -- descripción del modelo multimodal
  PRIMARY KEY (analysis_id, shot_index)
);

-- ---------------------------------------------------------------------
-- Transcripción con marca de tiempo por palabra.
-- Es lo que permite medir el hook exacto, las palabras por minuto y
-- saber si la promesa se dice antes del segundo 3.
-- ---------------------------------------------------------------------
CREATE TABLE video_transcript (
  analysis_id         uuid PRIMARY KEY REFERENCES video_analysis(id) ON DELETE CASCADE,
  language            text,
  language_confidence numeric(5,4),
  engine              text NOT NULL,           -- 'faster-whisper-large-v3' | 'deepgram-nova-3'
  full_text           text,
  word_count          int,
  words_per_minute    numeric(7,2),
  speech_seconds      numeric(8,3),
  silence_seconds     numeric(8,3),
  -- Legibilidad del guion hablado, adaptada al español.
  readability         numeric(6,2)
);

CREATE TABLE video_transcript_word (
  analysis_id         uuid NOT NULL REFERENCES video_analysis(id) ON DELETE CASCADE,
  idx                 int  NOT NULL,
  word                text NOT NULL,
  start_s             numeric(8,3) NOT NULL,
  end_s               numeric(8,3) NOT NULL,
  confidence          numeric(5,4),
  speaker             text,
  PRIMARY KEY (analysis_id, idx)
);
CREATE INDEX ON video_transcript_word (analysis_id, start_s);

-- ---------------------------------------------------------------------
-- Texto en pantalla (OCR), agrupado en apariciones y no por fotograma.
-- ---------------------------------------------------------------------
CREATE TABLE video_onscreen_text (
  id                  bigserial PRIMARY KEY,
  analysis_id         uuid NOT NULL REFERENCES video_analysis(id) ON DELETE CASCADE,
  text                text NOT NULL,
  start_s             numeric(8,3) NOT NULL,
  end_s               numeric(8,3) NOT NULL,
  -- Caja normalizada 0..1 respecto al cuadro.
  bbox_x              numeric(6,5),
  bbox_y              numeric(6,5),
  bbox_w              numeric(6,5),
  bbox_h              numeric(6,5),
  font_size_ratio     numeric(6,5),            -- alto del texto / alto del cuadro
  confidence          numeric(5,4),
  role                text CHECK (role IN ('hook','caption','subtitle','label','cta','watermark','other')),
  -- ¿Cae bajo la UI de la red? Se evalúa por plataforma en 0005b.
  unsafe_platforms    text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX ON video_onscreen_text (analysis_id, start_s);

-- ---------------------------------------------------------------------
-- Audio global
-- ---------------------------------------------------------------------
CREATE TABLE video_audio_profile (
  analysis_id         uuid PRIMARY KEY REFERENCES video_analysis(id) ON DELETE CASCADE,
  integrated_lufs     numeric(7,2),            -- EBU R128 integrada
  loudness_range_lu   numeric(7,2),
  true_peak_dbtp      numeric(7,2),
  clipping_seconds    numeric(8,3),
  noise_floor_db      numeric(7,2),
  music_present       boolean,
  music_ratio         numeric(6,4),            -- proporción del video con música
  speech_ratio        numeric(6,4),
  longest_silence_s   numeric(8,3),
  silence_count       int
);

-- ---------------------------------------------------------------------
-- Rasgos: la capa que consumen el semáforo, el lift del nicho y el
-- generador de ideas. Clave/valor tipado para poder comparar cualquier
-- rasgo entre videos propios y ajenos sin cambiar el esquema.
-- ---------------------------------------------------------------------
CREATE TABLE video_feature (
  analysis_id         uuid NOT NULL REFERENCES video_analysis(id) ON DELETE CASCADE,
  key                 text NOT NULL,           -- 'hook.type' | 'duration.s' | 'cuts.per_min'
  value_text          text,
  value_num           numeric(14,4),
  value_bool          boolean,
  confidence          numeric(5,4),
  -- De dónde salió: sirve para saber qué se puede recalcular gratis.
  extractor           text NOT NULL
                           CHECK (extractor IN ('ffprobe','ffmpeg','scenedetect','opencv',
                                                'ocr','asr','audio','vision_llm','derived')),
  PRIMARY KEY (analysis_id, key)
);
CREATE INDEX ON video_feature (key, value_text);
CREATE INDEX ON video_feature (key, value_num);

-- =====================================================================
-- SEMÁFORO "LISTO PARA PUBLICAR"
-- ---------------------------------------------------------------------
-- Las reglas son datos, no código. Cada regla sabe:
--   * qué mide (feature_key o una expresión sobre video_second),
--   * su umbral, que puede variar por plataforma y por nicho,
--   * su severidad (bloqueante, advertencia, sugerencia),
--   * y su procedencia: si el umbral viene de una fuente publicada o es
--     criterio del oficio. La UI lo muestra: nunca presentamos folclore
--     como si fuera un dato duro.
-- =====================================================================
CREATE TABLE preflight_rule (
  id                  text PRIMARY KEY,        -- 'hook.text_in_first_3s'
  ruleset_version     text NOT NULL,
  category            text NOT NULL
                           CHECK (category IN ('tecnico','hook','ritmo','audio',
                                               'legibilidad','estructura','cumplimiento','plataforma')),
  label_es            text NOT NULL,
  explanation_es      text NOT NULL,           -- por qué importa, en una frase
  fix_es              text NOT NULL,           -- qué hacer si falla
  severity            text NOT NULL
                           CHECK (severity IN ('blocker','warning','hint')),
  -- Alcance
  platforms           text[] NOT NULL DEFAULT '{tiktok,instagram,youtube,facebook}',
  niches              text[] NOT NULL DEFAULT '{}',   -- vacío = todos
  -- Evaluación
  feature_key         text,                    -- rasgo que lee
  operator            text CHECK (operator IN ('lt','lte','gt','gte','eq','neq','between','exists','custom')),
  threshold_num       numeric(14,4),
  threshold_num_2     numeric(14,4),           -- para 'between'
  threshold_text      text,
  custom_evaluator    text,                    -- nombre de función en el worker
  weight              numeric(5,2) NOT NULL DEFAULT 1,
  -- Procedencia del umbral: honestidad intelectual como columna.
  evidence_level      text NOT NULL DEFAULT 'heuristic'
                           CHECK (evidence_level IN ('platform_spec','published_research',
                                                     'internal_data','heuristic')),
  evidence_source     text,
  enabled             boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER preflight_rule_updated BEFORE UPDATE ON preflight_rule
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Resultado de una regla sobre un análisis concreto.
CREATE TABLE preflight_result (
  id                  bigserial PRIMARY KEY,
  analysis_id         uuid NOT NULL REFERENCES video_analysis(id) ON DELETE CASCADE,
  rule_id             text NOT NULL REFERENCES preflight_rule(id) ON DELETE CASCADE,
  platform_id         text REFERENCES platform(id),   -- NULL = aplica a todas
  outcome             text NOT NULL CHECK (outcome IN ('pass','warn','fail','skipped','unknown')),
  observed_num        numeric(14,4),
  observed_text       text,
  -- Dónde falla exactamente, para poder saltar ahí en el reproductor.
  at_second           int,
  detail_es           text,
  UNIQUE (analysis_id, rule_id, platform_id)
);
CREATE INDEX ON preflight_result (analysis_id, outcome);

-- Veredicto agregado por plataforma.
CREATE TABLE preflight_verdict (
  analysis_id         uuid NOT NULL REFERENCES video_analysis(id) ON DELETE CASCADE,
  platform_id         text NOT NULL REFERENCES platform(id),
  status              text NOT NULL CHECK (status IN ('ready','fix_first','not_ready')),
  score               int  NOT NULL CHECK (score BETWEEN 0 AND 100),
  blockers            int  NOT NULL DEFAULT 0,
  warnings            int  NOT NULL DEFAULT 0,
  -- Resumen accionable en lenguaje del creador.
  summary_es          text,
  computed_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (analysis_id, platform_id)
);

-- ---------------------------------------------------------------------
-- Predicción de desempeño. Separada del semáforo a propósito: el
-- semáforo es determinista y explicable; la predicción es un modelo y
-- puede equivocarse. Se guarda con su intervalo y luego se contrasta
-- contra el resultado real (calibración).
-- ---------------------------------------------------------------------
CREATE TABLE video_prediction (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id         uuid NOT NULL REFERENCES video_analysis(id) ON DELETE CASCADE,
  platform_id         text NOT NULL REFERENCES platform(id),
  model_version       text NOT NULL,
  predicted_at        timestamptz NOT NULL DEFAULT now(),

  -- Predicción relativa, nunca absoluta: "1,8 veces tu mediana", no
  -- "500.000 views". Lo absoluto no es predecible y destruye confianza.
  p_outlier           numeric(6,5),            -- probabilidad de superar 2x la mediana
  expected_vs_median  numeric(8,3),
  ci_low              numeric(8,3),
  ci_high             numeric(8,3),
  predicted_retention_3s numeric(6,5),
  -- Qué rasgos empujaron la predicción (explicabilidad tipo SHAP).
  drivers             jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Calibración: se llena cuando el video se publica y madura.
  actual_post_id      uuid REFERENCES post(id) ON DELETE SET NULL,
  actual_vs_median    numeric(8,3),
  actual_measured_at  timestamptz,
  error               numeric(8,3)
);
CREATE INDEX ON video_prediction (analysis_id);
CREATE INDEX ON video_prediction (model_version, predicted_at DESC);
-- Para el tablero de calibración del modelo.
CREATE INDEX ON video_prediction (model_version) WHERE actual_vs_median IS NOT NULL;

-- ---------------------------------------------------------------------
-- Recomendaciones concretas que salen del análisis. Son las que el
-- creador ve y puede marcar como aplicadas.
-- ---------------------------------------------------------------------
CREATE TABLE video_recommendation (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id         uuid NOT NULL REFERENCES video_analysis(id) ON DELETE CASCADE,
  priority            int  NOT NULL DEFAULT 3, -- 1 = primero
  kind                text NOT NULL
                           CHECK (kind IN ('cut','hook','text','audio','pacing','caption',
                                           'hashtag','timing','thumbnail','cta')),
  title_es            text NOT NULL,
  detail_es           text NOT NULL,
  at_second           int,
  -- Impacto estimado si se aplica, en la misma unidad que la predicción.
  expected_gain       numeric(8,3),
  source_rule_id      text REFERENCES preflight_rule(id) ON DELETE SET NULL,
  applied             boolean NOT NULL DEFAULT false,
  applied_at          timestamptz,
  dismissed           boolean NOT NULL DEFAULT false
);
CREATE INDEX ON video_recommendation (analysis_id, priority);
