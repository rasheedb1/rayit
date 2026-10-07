-- =====================================================================
-- Verificación del seed 0011 (Equipo de la demo con historia, ACC-4).
-- ---------------------------------------------------------------------
-- Cómo correrlo:
--   Postgres embebido, sin tocar Supabase:
--     node db/seed/verify/run.mjs 0011
--
-- Cada consulta con columna `ok` es una prueba: un false hace fallar
-- run.mjs. Lo que se cuida es que /accesos no nazca recién armada: la
-- dueña lleva un año, el mánager entró antes de conectar la cuenta que
-- conectó (0003, ACC-8), y hay una invitación pendiente que nadie puede
-- aceptar.
-- =====================================================================

SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);
SELECT set_config('app.user_id', '00000002-0000-4000-8000-000000000002', false);

-- (a) Laura, miembro desde hace un año o más; Andrés, desde hace más de
--     140 días (antes de su conexión de Instagram) y después que Laura.
SELECT 'a_fechas_de_alta' AS check_id,
       max(m.created_at) FILTER (WHERE m.user_id = '00000002-0000-4000-8000-000000000002') AS laura,
       max(m.created_at) FILTER (WHERE m.user_id = '00000002-0000-4000-8000-000000000004') AS andres,
       max(m.created_at) FILTER (WHERE m.user_id = '00000002-0000-4000-8000-000000000002') <= now() - interval '360 days'
       AND max(m.created_at) FILTER (WHERE m.user_id = '00000002-0000-4000-8000-000000000004') < now() - interval '140 days'
       AND max(m.created_at) FILTER (WHERE m.user_id = '00000002-0000-4000-8000-000000000004')
         > max(m.created_at) FILTER (WHERE m.user_id = '00000002-0000-4000-8000-000000000002') AS ok
  FROM membership m
 WHERE m.workspace_id = '00000002-0000-4000-8000-000000000001';

-- (b) La invitación de la demo: pendiente (sin aceptar ni revocar), de
--     Editor, firmada por Laura, y con un hash que no es el de ningún
--     token (sha256 de una frase de otra forma).
SELECT 'b_invitacion_pendiente' AS check_id,
       count(*) AS invitaciones,
       count(*) = 1
       AND bool_and(i.accepted_at IS NULL AND i.revoked_at IS NULL)
       AND bool_and(r.key = 'editor')
       AND bool_and(i.invited_by = '00000002-0000-4000-8000-000000000002')
       AND bool_and(i.token_hash = encode(sha256(convert_to('demo de On Cue: esta invitación no tiene enlace', 'UTF8')), 'hex'))
       AS ok
  FROM invitation i
  JOIN role r ON r.id = i.role_id
 WHERE i.id = '00000011-0000-4000-8000-0000000a0001';
