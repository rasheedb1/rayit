-- =====================================================================
-- Verificación del seed 0007 (portadas de la demo, VEN-11).
-- ---------------------------------------------------------------------
-- Cómo correrlo:
--   Postgres embebido, sin tocar Supabase:
--     node db/seed/verify/run.mjs 0007
--
-- Cada consulta con columna `ok` es una prueba: un false hace fallar
-- run.mjs. Lo que se cuida es que la demo enseñe portadas en «Tus cinco
-- mejores videos» de /ventas/perfil, con una ruta que la web sirve.
-- =====================================================================

SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);

-- (a) Todos los videos de Laura tienen portada, y es una de las ocho ilustraciones.
SELECT 'a_portadas' AS check_id,
       count(*) AS videos,
       count(*) FILTER (WHERE cover_url ~ '^/demo/portadas/[1-8]\.svg$') AS con_portada,
       count(*) > 0 AND count(*) = count(*) FILTER (WHERE cover_url ~ '^/demo/portadas/[1-8]\.svg$') AS ok
  FROM post
 WHERE workspace_id = '00000002-0000-4000-8000-000000000001'
   AND creator_id = '00000002-0000-4000-8000-000000000003';

-- (b) Los cinco de más «veces su mediana» (los que pinta el perfil) tienen portada, y no todas iguales.
SELECT 'b_mejores_con_portada' AS check_id,
       count(*) AS mejores,
       count(DISTINCT cover_url) AS distintas,
       count(*) = 5 AND bool_and(cover_url IS NOT NULL) AND count(DISTINCT cover_url) > 1 AS ok
  FROM (
    SELECT p.cover_url
      FROM post p
      JOIN post_score s ON s.post_id = p.id AND s.views_vs_median IS NOT NULL
     WHERE p.creator_id = '00000002-0000-4000-8000-000000000003' AND NOT p.deleted_on_platform
     ORDER BY s.views_vs_median DESC, p.id
     LIMIT 5
  ) mejores;
