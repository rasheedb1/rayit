-- =====================================================================
-- Seed 10 · El porqué de los mejores videos de la demo (VEN-11)
-- ---------------------------------------------------------------------
-- Hasta aquí ninguno de los cinco mejores videos de Laura mostraba «Lo
-- distingue» en /ventas/perfil: la lógica es honesta (whyContrast pide
-- tres OTROS videos a cada lado y que el grupo rinda 1,5 veces el resto)
-- y con los ganchos que se leen de los títulos ningún rasgo alcanzaba.
-- La demo nunca enseñaba la función que más vale del perfil.
--
-- Este seed deja lo que dejaría el laboratorio de video (0005) después
-- de analizar cinco videos de Laura que abren con un reto: un
-- video_asset por post (origin 'own_published'), su análisis terminado y
-- el rasgo hook.type = 'challenge' que lee creator_post_board. El gancho
-- del laboratorio gana al del título (hookFromAnalysis), así que esos
-- cinco pasan a «abre con un reto»:
--
--   0d06  La arepa que se hace sin plancha   (su caption dice «Reto: …»)
--   0d28  Pasta cremosa en cuatro minutos    (reto de tiempo)
--   0d16  Buñuelos que no se abren           (reto de técnica)
--   0d33  Qué cocino un lunes sin ganas      (reto de nevera)
--   0d19  Salsa que mejora cualquier cosa    (reto de sabor)
--
-- Con eso, dos de los cinco mejores (0d06 y 0d28) tienen cuatro OTROS
-- videos con reto que rinden unas 1,6 veces su mediana frente a menos de
-- 1,0 del resto, y el perfil dice «Tus otros videos que abren con un
-- reto hacen X frente a Y». No se toca ningún puntaje ni ninguna
-- métrica: solo se añade lo que el laboratorio habría encontrado.
--
-- Reglas del archivo (las de 0002, 0005 y 0007):
--   * Idempotente. UUID fijos y ON CONFLICT DO NOTHING; el enlace del
--     post solo se llena si falta (video_asset_id IS NULL): lo que un
--     análisis real haya puesto no se pisa.
--   * Nada real: ni archivo ni costo. storage_key queda NULL (la demo no
--     guarda binarios) y el análisis no dice lo que costó.
--   * Solo el workspace de la demo. Requiere 0005 y 0010 (migraciones) y
--     el seed 0002.
--
-- Mapa de identificadores (00000010-…, solo dígitos hexadecimales):
--   …-0000000a0SSS    video_asset     (SSS = los tres últimos del post)
--   …-0000000b0SSS    video_analysis
-- =====================================================================

SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);
SELECT set_config('TimeZone', 'UTC', false);

WITH retos (post) AS (
  VALUES ('d06'), ('d28'), ('d16'), ('d33'), ('d19')
),
base AS (
  SELECT ('00000002-0000-4000-8000-000000000' || r.post)::uuid AS post_id,
         ('00000010-0000-4000-8000-0000000a0' || r.post)::uuid AS asset_id
    FROM retos r
)
INSERT INTO video_asset (id, workspace_id, creator_id, origin, post_id, title, duration_s, language, status)
SELECT b.asset_id, p.workspace_id, p.creator_id, 'own_published', p.id, p.title, p.duration_s, 'es', 'analyzed'
  FROM base b
  JOIN post p ON p.id = b.post_id
ON CONFLICT (id) DO NOTHING;

INSERT INTO video_analysis (id, video_asset_id, workspace_id, analyzer_version, stages_done, status, started_at, finished_at)
SELECT ('00000010-0000-4000-8000-0000000b0' || right(a.id::text, 3))::uuid, a.id, a.workspace_id, 'demo-1.0',
       '{probe,asr,vision_llm}', 'done', a.created_at, a.created_at + interval '2 minutes'
  FROM video_asset a
 WHERE a.id IN (SELECT ('00000010-0000-4000-8000-0000000a0' || x)::uuid FROM (VALUES ('d06'), ('d28'), ('d16'), ('d33'), ('d19')) v(x))
ON CONFLICT (id) DO NOTHING;

INSERT INTO video_feature (analysis_id, key, value_text, confidence, extractor)
SELECT an.id, 'hook.type', 'challenge', 0.9, 'vision_llm'
  FROM video_analysis an
 WHERE an.id IN (SELECT ('00000010-0000-4000-8000-0000000b0' || x)::uuid FROM (VALUES ('d06'), ('d28'), ('d16'), ('d33'), ('d19')) v(x))
ON CONFLICT (analysis_id, key) DO NOTHING;

UPDATE post p
   SET video_asset_id = a.id
  FROM video_asset a
 WHERE a.post_id = p.id
   AND a.id IN (SELECT ('00000010-0000-4000-8000-0000000a0' || x)::uuid FROM (VALUES ('d06'), ('d28'), ('d16'), ('d33'), ('d19')) v(x))
   AND p.video_asset_id IS NULL;
