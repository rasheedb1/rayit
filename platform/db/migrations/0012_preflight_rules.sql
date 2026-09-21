-- =====================================================================
-- 0012 · Las reglas del semáforo "listo para publicar"
-- ---------------------------------------------------------------------
-- Cada regla lleva de dónde salió su umbral. Cuatro niveles:
--
--   platform_spec      Especificación publicada por la plataforma.
--   published_research Investigación revisada o código abierto de una
--                      empresa que sí tiene los datos (Google ABCDs).
--   internal_data      Calibrado con nuestros propios resultados. Hoy
--                      no hay ninguna; se irán promoviendo.
--   heuristic          Criterio del oficio. La interfaz lo dice.
--
-- Esto no es pedantería. La diferencia entre un producto que el creador
-- respeta y uno que abandona es si puede preguntar "¿por qué?" y recibir
-- una respuesta comprobable. Media industria repite que "el 71 % de si
-- te siguen viendo se decide en tres segundos" y esa cifra no tiene
-- ninguna fuente primaria localizable. Nosotros no la vamos a repetir.
--
-- HALLAZGO QUE ORDENA EL MÓDULO (investigación del 20-sep-2026, detalle
-- en docs/research/analisis-video.md):
--
--   Predecir VIEWS desde el contenido no funciona. En el SMP Challenge
--   2025, quitar los rasgos del creador degradó el error un 72 %;
--   quitar todo el contenido visual, solo un 4 %. Y en SMTPD (CVPR
--   2025) la variable más predictiva son las views del primer día, que
--   por definición no existen antes de publicar.
--
--   Predecir RETENCIÓN TEMPRANA sí funciona. En el reto VQualA 2025
--   (ICCV), con ciento veinte mil videos y arranque en frío, el mejor
--   modelo alcanzó Spearman 0,707 usando solo contenido.
--
-- Por eso el semáforo evalúa lo que el creador controla y el predictor
-- apunta a retención, no a views. Y como TikTok nos entrega la curva de
-- retención real, el predictor se calibra contra la verdad medida.
-- =====================================================================

INSERT INTO preflight_rule (
  id, ruleset_version, category, label_es, explanation_es, fix_es,
  severity, platforms, feature_key, operator, threshold_num, threshold_num_2,
  weight, evidence_level, evidence_source
) VALUES

-- ---------------------------------------------------------------------
-- TÉCNICO · especificaciones de la plataforma. Si esto falla, el video
-- se rechaza o se ve mal. No hay discusión posible.
-- ---------------------------------------------------------------------
('tecnico.aspecto_vertical', 'v1', 'tecnico',
 'Formato vertical 9:16',
 'El formato vertical es el que ocupa toda la pantalla; cualquier otro deja barras y pierde alcance.',
 'Exporta en 1080 por 1920. Si grabaste en horizontal, reencuadra: no basta con recortar los lados.',
 'blocker', '{tiktok,instagram,youtube,facebook}',
 'video.aspect_ratio', 'between', 0.5525, 0.5675,
 3, 'platform_spec', 'TikTok in-feed ads specs · ads.tiktok.com/help/article/tiktok-auction-in-feed-ads'),

('tecnico.resolucion_minima', 'v1', 'tecnico',
 'Resolución mínima',
 'Por debajo de 540 por 960 píxeles la plataforma comprime sobre material ya pobre y el resultado se ve sucio.',
 'Exporta a 1080 por 1920. Si la fuente es de menor resolución, vuelve a grabar: escalar no recupera detalle.',
 'blocker', '{tiktok,instagram,youtube,facebook}',
 'video.height', 'gte', 960, NULL,
 3, 'platform_spec', 'TikTok in-feed ads specs'),

('tecnico.duracion_tiktok', 'v1', 'tecnico',
 'Duración dentro del límite de publicación',
 'La API de publicación de TikTok acepta entre tres y seiscientos segundos.',
 'Recorta el video para que quede dentro del rango.',
 'blocker', '{tiktok}',
 'video.duration_s', 'between', 3, 600,
 3, 'platform_spec', 'TikTok Accounts API · /business/video/publish/'),

('tecnico.tiene_audio', 'v1', 'tecnico',
 'El video trae pista de audio',
 'Un video mudo pierde la mitad de las señales que usa el algoritmo y casi todo el enganche.',
 'Agrega voz, música o sonido ambiente. La gran mayoría del consumo ocurre con sonido.',
 'blocker', '{tiktok,instagram,youtube,facebook}',
 'audio.present', 'eq', 1, NULL,
 2, 'heuristic', 'Criterio del oficio'),

-- ---------------------------------------------------------------------
-- HOOK · los primeros segundos. Aquí están los umbrales con la mejor
-- fuente disponible: el PDF de consejos creativos de TikTok for
-- Business y las constantes del detector ABCDs de Google, que son
-- código abierto y vienen de quien sí tiene los datos.
-- ---------------------------------------------------------------------
('hook.mensaje_en_3s', 'v1', 'hook',
 'El mensaje central aparece en los primeros tres segundos',
 'TikTok midió que más del sesenta y tres por ciento de los videos con mejor tasa de clic muestran su mensaje o producto en los primeros tres segundos.',
 'Mueve la promesa al inicio. Di qué va a ganar quien se quede, antes del segundo tres.',
 'blocker', '{tiktok,instagram,youtube,facebook}',
 'hook.message_at_s', 'lte', 3, NULL,
 4, 'published_research', 'TikTok for Business · 9 Creative Tips to drive performance (PDF oficial)'),

('hook.texto_en_pantalla', 'v1', 'hook',
 'Hay texto en pantalla desde el principio',
 'El cuarenta por ciento de los anuncios de TikTok con mejor tasa de visualización usan texto superpuesto.',
 'Pon el gancho escrito en los primeros segundos, grande y en el tercio medio de la pantalla.',
 'warning', '{tiktok,instagram,youtube,facebook}',
 'hook.text_at_s', 'lte', 3, NULL,
 3, 'published_research', 'TikTok for Business · 9 Creative Tips'),

('hook.primer_corte', 'v1', 'hook',
 'El primer plano no se alarga',
 'El detector ABCDs de Google considera que un arranque es dinámico cuando el primer plano dura menos de tres segundos. Un plano fijo largo al inicio es la forma más común de perder audiencia.',
 'Corta antes del segundo tres. Cambia de tamaño de plano o de ángulo, no solo de encuadre.',
 'warning', '{tiktok,instagram,youtube,facebook}',
 'shots.first_duration_s', 'lt', 3, NULL,
 3, 'published_research', 'Google ABCDs Detector · dynamic_cutoff_ms = 3000'),

('hook.planos_iniciales', 'v1', 'hook',
 'Ritmo rápido en los primeros cinco segundos',
 'La rúbrica de ritmo rápido de Google pide al menos cinco planos en los primeros cinco segundos.',
 'Agrega cortes al inicio. Sirven planos de detalle del mismo material.',
 'hint', '{tiktok,instagram,youtube}',
 'shots.in_first_5s', 'gte', 5, NULL,
 2, 'published_research', 'Google ABCDs Detector · required_shots_for_quick_pacing = 5'),

('hook.sin_saludo', 'v1', 'hook',
 'No abre con saludo',
 'Un saludo gasta el segundo más valioso del video sin dar ninguna razón para quedarse.',
 'Empieza por la afirmación más fuerte. Preséntate después, o no te presentes.',
 'warning', '{tiktok,instagram,youtube,facebook}',
 'hook.starts_with_greeting', 'eq', 0, NULL,
 2, 'heuristic', 'Criterio del oficio, coherente con la regla del mensaje en tres segundos'),

('hook.rostro_a_camara', 'v1', 'hook',
 'Alguien mira a cámara al inicio',
 'TikTok observó que el treinta y tres por ciento de los anuncios con mejor tasa de visualización rompen la cuarta pared, con el creador hablando de frente al espectador.',
 'Abre con un plano de alguien mirando a cámara. No aplica si el formato es sin rostro.',
 'hint', '{tiktok,instagram}',
 'hook.eye_contact_in_first_3s', 'eq', 1, NULL,
 1, 'published_research', 'TikTok for Business · 9 Creative Tips'),

-- ---------------------------------------------------------------------
-- RITMO
-- ---------------------------------------------------------------------
('ritmo.duracion_media_plano', 'v1', 'ritmo',
 'Los planos no se estancan',
 'La rúbrica de ritmo general de Google usa dos segundos de duración media de plano como referencia.',
 'Corta los planos largos. Revisa el segundo donde el análisis marca la caída más grande.',
 'warning', '{tiktok,instagram,youtube}',
 'shots.avg_duration_s', 'lte', 2.5, NULL,
 2, 'published_research', 'Google ABCDs Detector · avg_shot_duration_seconds = 2'),

('ritmo.plano_eterno', 'v1', 'ritmo',
 'Ningún plano dura más de seis segundos',
 'Un plano muy largo sin movimiento ni texto nuevo es donde la audiencia se va.',
 'Parte ese plano en dos, o agrega un plano de detalle en medio.',
 'warning', '{tiktok,instagram,youtube,facebook}',
 'shots.max_duration_s', 'lte', 6, NULL,
 2, 'heuristic', 'Criterio del oficio'),

('ritmo.silencio_largo', 'v1', 'ritmo',
 'No hay silencios largos',
 'Más de dos segundos sin voz ni música se siente como un error de reproducción.',
 'Rellena con sonido ambiente o acorta esa parte.',
 'warning', '{tiktok,instagram,youtube,facebook}',
 'audio.longest_silence_s', 'lte', 2, NULL,
 2, 'heuristic', 'Criterio del oficio'),

-- ---------------------------------------------------------------------
-- AUDIO · la medición es estándar formal (norma EBU R128); los objetivos
-- por plataforma NO están publicados por las plataformas. Se marcan como
-- criterio y el mensaje al creador no cita ninguna cifra ajena.
-- ---------------------------------------------------------------------
('audio.sonoridad', 'v1', 'audio',
 'Volumen dentro del rango habitual',
 'Las plataformas bajan lo que viene muy alto pero no suben lo que viene muy bajo: un video flojo suena más débil que el siguiente del feed y se nota.',
 'Normaliza la mezcla entre menos dieciséis y menos nueve LUFS integrados.',
 'warning', '{tiktok,instagram,youtube,facebook}',
 'audio.integrated_lufs', 'between', -16, -9,
 2, 'heuristic', 'Medición según EBU R128; los objetivos por plataforma no están publicados oficialmente'),

('audio.pico_real', 'v1', 'audio',
 'Sin saturación',
 'Por encima de menos uno dBTP, la compresión de la plataforma introduce distorsión audible.',
 'Baja el limitador hasta que el pico real quede bajo menos uno dBTP.',
 'warning', '{tiktok,instagram,youtube,facebook}',
 'audio.true_peak_dbtp', 'lte', -1, NULL,
 2, 'published_research', 'Práctica estándar de masterización para códecs con pérdida'),

('audio.voz_sobre_musica', 'v1', 'audio',
 'La voz se entiende sobre la música',
 'Si la música tapa la voz, el espectador no entiende la promesa y se va.',
 'Baja la música al menos seis unidades de sonoridad por debajo de la voz.',
 'warning', '{tiktok,instagram,youtube,facebook}',
 'audio.speech_music_ratio_lu', 'gte', 6, NULL,
 2, 'heuristic', 'Convención de mezcla. Es objetiva y medible: se separan las pistas y se mide cada una por EBU R128'),

-- ---------------------------------------------------------------------
-- LEGIBILIDAD
-- ---------------------------------------------------------------------
('legible.zona_segura', 'v1', 'legibilidad',
 'El texto no queda bajo la interfaz de la aplicación',
 'Cada red tapa partes de la pantalla con sus botones y el pie de foto. El texto que cae ahí no se lee.',
 'Sube el texto al tercio medio. El análisis marca exactamente qué apariciones caen en zona tapada.',
 'blocker', '{tiktok,instagram,youtube,facebook}',
 'text.unsafe_zone_seconds', 'lte', 0, NULL,
 3, 'platform_spec', 'TikTok advierte que la zona segura varía según formato y pie de foto; Meta publica su guía de zona segura'),

('legible.tamano_texto', 'v1', 'legibilidad',
 'El texto se lee en un teléfono',
 'Un texto de menos del cuatro por ciento del alto de pantalla es ilegible en un móvil.',
 'Agranda el texto. Menos palabras y más grandes funcionan mejor que muchas y pequeñas.',
 'warning', '{tiktok,instagram,youtube,facebook}',
 'text.min_font_ratio', 'gte', 0.04, NULL,
 2, 'heuristic', 'Criterio del oficio'),

('legible.tiene_subtitulos', 'v1', 'legibilidad',
 'Tiene subtítulos',
 'Hacen el video accesible a quien no oye, y refuerzan el gancho para quien lo ve en silencio en un lugar público.',
 'Agrega subtítulos que cubran al menos el noventa por ciento de la voz. Dos o tres palabras por línea, en el tercio medio.',
 'warning', '{tiktok,instagram,youtube,facebook}',
 'text.subtitle_coverage', 'gte', 0.9, NULL,
 3, 'heuristic', 'Accesibilidad. OJO: la premisa habitual esta invertida. TikTok reporta que el noventa y tres por ciento consume CON sonido y YouTube el noventa y cinco; el ochenta y cinco por ciento sin sonido es una cifra de 2016 mal extrapolada. Tampoco citamos el doce por ciento de mas tiempo de visualizacion: no tiene fuente primaria'),

('legible.brillo', 'v1', 'legibilidad',
 'La imagen no está demasiado oscura',
 'Un video oscuro se ve peor en un teléfono a plena luz, que es donde se ve la mayoría.',
 'Sube la exposición o vuelve a grabar con más luz.',
 'hint', '{tiktok,instagram,youtube,facebook}',
 'video.avg_brightness', 'gte', 0.18, NULL,
 1, 'heuristic', 'Criterio del oficio'),

-- ---------------------------------------------------------------------
-- ESTRUCTURA
-- ---------------------------------------------------------------------
('estructura.ritmo_habla', 'v1', 'estructura',
 'Velocidad de habla razonable',
 'El español se habla más rápido que el inglés en sílabas por segundo, así que los umbrales copiados de guías en inglés no sirven. Este rango es provisional y se recalibrará con nuestros propios videos.',
 'Si vas muy rápido, corta palabras del guion en vez de hablar más lento.',
 'hint', '{tiktok,instagram,youtube,facebook}',
 'speech.words_per_minute', 'between', 120, 200,
 1, 'heuristic', 'Pellegrino et al., Language: el español va a 7,82 sílabas por segundo frente a 6,19 del inglés. El umbral en palabras por minuto para español no tiene fuente primaria'),

('estructura.cierre_con_cta', 'v1', 'estructura',
 'Cierra con una acción clara',
 'Sin una instrucción final, el espectador se va sin guardar, seguir ni comentar.',
 'Termina pidiendo una sola cosa concreta. Guardar suele rendir más que seguir.',
 'hint', '{tiktok,instagram,youtube,facebook}',
 'structure.has_cta', 'eq', 1, NULL,
 1, 'heuristic', 'Criterio del oficio'),

('estructura.sin_final_abrupto', 'v1', 'estructura',
 'El final no se corta a media frase',
 'Un corte a media palabra se lee como error y desperdicia la única oportunidad de pedir algo.',
 'Deja medio segundo de aire después de la última palabra.',
 'warning', '{tiktok,instagram,youtube,facebook}',
 'structure.ends_mid_word', 'eq', 0, NULL,
 2, 'heuristic', 'Criterio del oficio'),

('hook.algo_pasa_en_1_5s', 'v1', 'hook',
 'Algo ocurre antes del segundo uno y medio',
 'Meta recomienda captar la atención en los dos primeros segundos. Empezar con una pausa muda regala el momento más caro del video.',
 'Que la primera palabra o el primer texto entre antes del segundo uno y medio. Recorta el aire del inicio.',
 'warning', '{tiktok,instagram,youtube,facebook}',
 'hook.first_signal_at_s', 'lte', 1.5, NULL,
 3, 'published_research', 'Guía creativa de Meta: captar la atención en los dos primeros segundos. Se aplica más estricto para orgánico'),

('ritmo.densidad_plano_cerrado', 'v1', 'ritmo',
 'Ni todo plano cerrado ni todo plano abierto',
 'La rúbrica de Shorts de Google sitúa el punto justo entre el treinta y el sesenta por ciento de la duración en plano cerrado.',
 'Alterna. Si todo el video es un primer plano hablando, intercala planos de detalle o de contexto.',
 'hint', '{tiktok,instagram,youtube}',
 'shots.closeup_density', 'between', 0.30, 0.60,
 1, 'published_research', 'Google ABCDs Detector · rúbrica de Shorts'),

('audio.voz_presente', 'v1', 'audio',
 'Hay voz durante buena parte del video',
 'La gran mayoría del consumo ocurre con sonido: TikTok reporta noventa y tres por ciento y YouTube noventa y cinco. Un video sin voz desperdicia ese canal.',
 'Agrega narración. Si el formato es sin voz, usa texto en pantalla que cuente la historia completa.',
 'hint', '{tiktok,instagram,youtube,facebook}',
 'audio.speech_ratio', 'gte', 0.5, NULL,
 2, 'published_research', 'Datos de consumo con sonido publicados por TikTok y YouTube'),

-- ---------------------------------------------------------------------
-- CUMPLIMIENTO · lo que puede costar la monetización o la cuenta
-- ---------------------------------------------------------------------
('cumplimiento.etiqueta_ia', 'v1', 'cumplimiento',
 'Contenido generado con IA declarado',
 'Publicar contenido realista hecho con IA sin etiquetarlo viola las políticas de las plataformas y pone en riesgo la monetización.',
 'Activa la etiqueta de contenido generado por IA al publicar.',
 'blocker', '{tiktok,instagram,youtube,facebook}',
 'compliance.ai_generated_undeclared', 'eq', 0, NULL,
 3, 'platform_spec', 'Políticas de contenido sintético de las plataformas'),

('cumplimiento.marca_de_agua', 'v1', 'cumplimiento',
 'Sin marca de agua de otra plataforma',
 'Las redes reducen el alcance del contenido que llega con la marca de agua de una competidora.',
 'Exporta sin marca de agua desde la herramienta de edición.',
 'warning', '{tiktok,instagram,youtube,facebook}',
 'compliance.foreign_watermark', 'eq', 0, NULL,
 2, 'heuristic', 'Criterio del oficio, ampliamente reportado'),

('cumplimiento.colaboracion_pagada', 'v1', 'cumplimiento',
 'Colaboración pagada declarada',
 'Si el video es parte de una campaña, la ley y las plataformas exigen declararlo. Además, declararlo le da a la marca acceso a las métricas del post.',
 'Activa la etiqueta de colaboración pagada y menciona a la marca.',
 'blocker', '{tiktok,instagram,youtube,facebook}',
 'compliance.campaign_undisclosed', 'eq', 0, NULL,
 3, 'platform_spec', 'Políticas de contenido de marca de las plataformas');

-- ---------------------------------------------------------------------
-- El predictor apunta a retención, no a views. La tabla lo refleja.
-- ---------------------------------------------------------------------
COMMENT ON TABLE video_prediction IS
  'Predicción de RETENCIÓN TEMPRANA, no de views. La evidencia publicada '
  '(VQualA 2025, ICCV, 120 mil videos, arranque en frío) sitúa el techo del '
  'contenido en Spearman 0,71 para retención; para views, quitar los rasgos '
  'del creador degrada el error un 72 por ciento (SMP Challenge 2025), y la '
  'variable más predictiva son las views del primer día, que no existen antes '
  'de publicar. Prometer views sería vender humo.';

COMMENT ON COLUMN video_prediction.predicted_retention_3s IS
  'Objetivo principal del modelo. Se calibra contra post_retention_curve, '
  'que para TikTok es la curva real medida por la plataforma.';

COMMENT ON COLUMN video_prediction.p_outlier IS
  'Secundario y con intervalo ancho a propósito. Solo se muestra cuando el '
  'creador tiene línea base confiable.';
