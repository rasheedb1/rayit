-- =====================================================================
-- 0013 · Cifras de referencia, y las que NO se pueden citar
-- ---------------------------------------------------------------------
-- El producto va a poner números en pantalla y en reportes que las
-- marcas leerán. Esta tabla existe para que ningún número salga sin
-- fuente, y para que las cifras que circulan por la industria sin
-- respaldo queden explícitamente vetadas en la base de datos.
--
-- La segunda tabla (blocked_claim) es tan importante como la primera.
-- Media industria del video corto repite cifras que no tienen fuente
-- primaria localizable. Si alguien del equipo las mete en una pantalla
-- o en un pitch dentro de seis meses, esta tabla explica por qué no.
-- =====================================================================

CREATE TABLE benchmark (
  id                  text PRIMARY KEY,
  platform_id         text REFERENCES platform(id),
  metric              text NOT NULL,
  label_es            text NOT NULL,
  value_num           numeric(14,5),
  unit                text NOT NULL CHECK (unit IN ('ratio','seconds','count','percent_points')),
  sample_size         bigint,
  source_name         text NOT NULL,
  source_url          text,
  published_on        date,
  evidence_level      text NOT NULL
                           CHECK (evidence_level IN ('peer_reviewed','platform_published',
                                                     'large_sample_study','internal_data')),
  note_es             text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

INSERT INTO benchmark
  (id, platform_id, metric, label_es, value_num, unit, sample_size,
   source_name, source_url, evidence_level, note_es) VALUES

('tiktok.abandono_temprano', 'tiktok', 'early_abandon',
 'La mitad de los videos se abandona antes del diez por ciento de su duración',
 0.50, 'ratio', 2650000,
 'CHI 2026', 'https://arxiv.org/abs/2503.20030', 'peer_reviewed',
 'Revisado por pares y con dos millones seiscientas cincuenta mil observaciones. Es el ancla honesta para hablar del arranque, en lugar de las cifras sin fuente que circulan.'),

('tiktok.full_watch_rate', 'tiktok', 'full_watch_rate',
 'Tasa media de video visto completo en TikTok',
 0.0630, 'ratio', 2314756,
 'Estudio TikTok 2026 de Metricool', 'https://metricool.com/press-release-tiktok-study-2026/', 'large_sample_study',
 'Seis coma tres por ciento. Cualquier referencia que hable de cuarenta a ochenta por ciento de finalización está errada en un orden de magnitud. Esta es la cifra contra la que hay que comparar a un creador.'),

('instagram.watch_time_medio', 'instagram', 'avg_watch_time_s',
 'Tiempo medio de visualización de un Reel',
 8.5, 'seconds', NULL,
 'Estudio de Metricool', NULL, 'large_sample_study',
 'Ocho segundos y medio. Pone en perspectiva cuánto vale cada segundo del arranque.'),

('tiktok.duracion_larga_alcance', 'tiktok', 'reach_lift_60s_plus',
 'Los videos de más de sesenta segundos alcanzan más que los de treinta a sesenta',
 0.43, 'ratio', 1100000,
 'Buffer', NULL, 'large_sample_study',
 'Más cuarenta y tres por ciento de alcance y más sesenta y cuatro por ciento de tiempo visto. Contradice el folclore de que corto siempre es mejor. Por eso NO tenemos una regla de duración óptima en el semáforo.'),

('tiktok.consumo_con_sonido', 'tiktok', 'sound_on_rate',
 'Proporción del consumo que ocurre con sonido en TikTok',
 0.93, 'ratio', NULL,
 'TikTok', NULL, 'platform_published',
 'Noventa y tres por ciento CON sonido. Invierte la premisa habitual de que la mayoría ve en silencio.'),

('youtube.consumo_con_sonido', 'youtube', 'sound_on_rate',
 'Proporción del consumo que ocurre con sonido en YouTube',
 0.95, 'ratio', NULL,
 'YouTube', NULL, 'platform_published',
 'Noventa y cinco por ciento con sonido.'),

('modelo.techo_retencion', NULL, 'model_ceiling_srocc',
 'Techo de correlación al predecir retención temprana solo con contenido',
 0.707, 'ratio', 120651,
 'Reto VQualA 2025, ICCV', 'https://arxiv.org/html/2509.02969v1', 'peer_reviewed',
 'Spearman cero coma setenta y uno, con arranque en frío y sin ningún dato de la cuenta. Es la vara contra la que medimos nuestro propio predictor, y la cifra honesta para cualquier conversación comercial.'),

('modelo.contenido_vs_creador', NULL, 'content_ablation_mape',
 'Peso del contenido frente al creador al predecir views',
 0.036, 'ratio', 6000,
 'SMP Challenge 2025', 'https://arxiv.org/html/2507.00950v1', 'peer_reviewed',
 'Quitar todos los rasgos visuales empeora el error un tres coma seis por ciento; quitar los rasgos del creador, un setenta y dos. Por eso no prometemos predecir views.');

CREATE INDEX ON benchmark (platform_id, metric);

-- ---------------------------------------------------------------------
-- Cifras vetadas. No se citan en pantallas, reportes, pitches ni en el
-- sitio. Si alguien las propone, aquí está por qué no.
-- ---------------------------------------------------------------------
CREATE TABLE blocked_claim (
  id                  text PRIMARY KEY,
  claim_es            text NOT NULL,
  why_blocked_es      text NOT NULL,
  use_instead         text REFERENCES benchmark(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

INSERT INTO blocked_claim (id, claim_es, why_blocked_es, use_instead) VALUES
('regla_3_segundos',
 'El setenta y uno por ciento de si te siguen viendo se decide en los primeros tres segundos',
 'Circula en decenas de blogs y no tiene fuente primaria localizable. La variante del ochenta y siete por ciento tampoco.',
 'tiktok.abandono_temprano'),

('sin_sonido_85',
 'El ochenta y cinco por ciento del video se ve sin sonido',
 'Viene de una cifra de 2016 sobre Facebook, mal extrapolada. Las propias plataformas publican lo contrario: TikTok reporta noventa y tres por ciento CON sonido.',
 'tiktok.consumo_con_sonido'),

('subtitulos_12',
 'Los subtítulos aumentan el tiempo de visualización un doce por ciento',
 'Se atribuye a un estudio de Meta de 2016 que no se puede localizar, sin muestra ni grupo de control. Los subtítulos se justifican por accesibilidad, que no necesita cifra inventada.',
 NULL),

('duracion_optima_21_34',
 'La duración óptima está entre veintiuno y treinta y cuatro segundos',
 'No tiene fuente, y la evidencia de muestra grande apunta en sentido contrario.',
 'tiktok.duracion_larga_alcance'),

('completion_62',
 'Una tasa de finalización del sesenta y dos por ciento es normal',
 'Sale de un blog comercial con quinientos videos y sin metodología. La medición de dos millones de posts da seis coma tres por ciento.',
 'tiktok.full_watch_rate'),

('vtr_35_45',
 'Una tasa de visualización a tres segundos de treinta y cinco a cuarenta y cinco por ciento es buena',
 'Solo aparece en blogs de agencias, sin fuente ni muestra.',
 'tiktok.abandono_temprano'),

('primer_corte_1_5s',
 'El primer corte tiene que ocurrir antes del segundo uno y medio',
 'No tiene fuente. Lo más cercano con respaldo es la constante de tres segundos del detector ABCDs de Google, que es la que usamos.',
 NULL);

COMMENT ON TABLE blocked_claim IS
  'Cifras que la industria repite sin fuente y que este producto no cita. '
  'La credibilidad frente a una marca se pierde una sola vez.';
