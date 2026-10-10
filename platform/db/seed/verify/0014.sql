-- =====================================================================
-- Verificación del seed 0014 (la Contadora de la demo, R2-ACC).
-- ---------------------------------------------------------------------
-- Cómo correrlo:
--   Postgres embebido, sin tocar Supabase:
--     node db/seed/verify/run.mjs 0014
--
-- Cada consulta con columna `ok` es una prueba: un false hace fallar
-- run.mjs.
-- =====================================================================

SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);
SELECT set_config('app.user_id', '00000002-0000-4000-8000-000000000002', false);

-- (a) Carolina es miembro con el rol de fábrica 'finance', desde hace al
--     menos 90 días y después que Andrés (0011).
SELECT 'a_contadora' AS check_id,
       r.key AS rol,
       m.created_at <= now() - interval '90 days' AS antigua,
       r.key = 'finance' AND r.workspace_id IS NULL
       AND m.created_at <= now() - interval '90 days'
       AND m.created_at > (SELECT max(created_at) FROM membership WHERE user_id = '00000002-0000-4000-8000-000000000004') AS ok
  FROM membership m
  JOIN role r ON r.id = m.role_id
 WHERE m.workspace_id = '00000002-0000-4000-8000-000000000001'
   AND m.user_id = '00000002-0000-4000-8000-000000000005';

-- (b) Sus permisos son exactamente los de Finanzas: ninguno de Campañas,
--     Ventas ni Cotizar (ACC-5: esas rutas le responden 404).
SELECT set_config('app.user_id', '00000002-0000-4000-8000-000000000005', false);
SELECT 'b_solo_finanzas' AS check_id,
       count(*) FILTER (WHERE k LIKE 'finanzas.%') AS finanzas,
       count(*) FILTER (WHERE k NOT LIKE 'finanzas.%') AS otros,
       count(*) FILTER (WHERE k LIKE 'finanzas.%') > 0 AND count(*) FILTER (WHERE k NOT LIKE 'finanzas.%') = 0 AS ok
  FROM session_permission_keys() AS k;
SELECT set_config('app.user_id', '00000002-0000-4000-8000-000000000002', false);
