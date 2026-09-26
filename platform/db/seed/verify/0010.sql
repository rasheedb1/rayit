-- =====================================================================
-- Verificación del seed 0010 (el porqué de los mejores videos, VEN-11).
-- ---------------------------------------------------------------------
-- Cómo correrlo:
--   Postgres embebido, sin tocar Supabase:
--     node db/seed/verify/run.mjs 0010
--
-- Cada consulta con columna `ok` es una prueba: un false hace fallar
-- run.mjs. Lo que se cuida es que la demo enseñe «Lo distingue» en al
-- menos uno de los cinco mejores videos de /ventas/perfil: la regla de
-- whyContrast (@mc/core/outreach/perfil) sobre el eje del gancho.
-- =====================================================================

SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);

-- (a) Los cinco videos con reto: su análisis terminado y el gancho visible en creator_post_board.
SELECT 'a_ganchos_del_laboratorio' AS check_id,
       count(*) AS videos,
       count(*) FILTER (WHERE b.hook_type = 'challenge') AS con_reto,
       count(*) = 5 AND count(*) FILTER (WHERE b.hook_type = 'challenge') = 5 AS ok
  FROM creator_post_board b
 WHERE b.post_id IN ('00000002-0000-4000-8000-000000000d06', '00000002-0000-4000-8000-000000000d28',
                     '00000002-0000-4000-8000-000000000d16', '00000002-0000-4000-8000-000000000d33',
                     '00000002-0000-4000-8000-000000000d19');

-- (b) Algún video de los cinco mejores abre con un reto y los OTROS con reto
--     (tres o más) rinden 1,5 veces o más la mediana del resto (tres o más).
WITH puntuados AS (
  SELECT p.id, s.views_vs_median AS x, coalesce(b.hook_type = 'challenge', false) AS reto
    FROM post p
    JOIN post_score s ON s.post_id = p.id AND s.views_vs_median IS NOT NULL
    LEFT JOIN creator_post_board b ON b.post_id = p.id
   WHERE p.creator_id = '00000002-0000-4000-8000-000000000003' AND NOT p.deleted_on_platform
),
mejores AS (
  SELECT id FROM puntuados ORDER BY x DESC, id LIMIT 5
),
contraste AS (
  SELECT m.id,
         (SELECT count(*) FROM puntuados o WHERE o.reto AND o.id <> m.id) AS grupo,
         (SELECT count(*) FROM puntuados o WHERE NOT o.reto AND o.id <> m.id) AS resto,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY o.x) FROM puntuados o WHERE o.reto AND o.id <> m.id) AS mediana_grupo,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY o.x) FROM puntuados o WHERE NOT o.reto AND o.id <> m.id) AS mediana_resto
    FROM mejores m
    JOIN puntuados p ON p.id = m.id AND p.reto
)
SELECT 'b_lo_distingue' AS check_id,
       count(*) AS mejores_con_reto,
       min(round((mediana_grupo / nullif(mediana_resto, 0))::numeric, 2)) AS contraste_minimo,
       count(*) > 0 AND bool_and(grupo >= 3 AND resto >= 3 AND mediana_grupo >= 1.5 * mediana_resto) AS ok
  FROM contraste;
