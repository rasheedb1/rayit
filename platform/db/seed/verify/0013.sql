-- =====================================================================
-- Verificación del seed 0013 (una agencia de demo con alcance, ACC-7).
-- ---------------------------------------------------------------------
-- Cómo correrlo:
--   Postgres embebido, sin tocar Supabase:
--     node db/seed/verify/run.mjs 0013
--
-- Cada consulta con columna `ok` es una prueba: un false hace fallar
-- run.mjs. Corre como quien migra, al que la política por creador (TO
-- mc_app) no le aplica: lo que comprueba es el escenario y, con las
-- mismas funciones que pide la política (session_sees_all_creators,
-- scope_allows, open_deal_out_of_scope), qué vería cada persona. La
-- política en sí la prueba packages/db/test/alcance-rls.test.ts.
-- =====================================================================

SELECT set_config('app.workspace_id', '000000a7-0000-4000-8000-000000000001', false);
SELECT set_config('app.user_id', '000000a7-0000-4000-8000-000000000002', false);

-- (a) Una Dueña sin alcance; Diego acotado a Camilo, Andrea a Camilo y
--     Mariana, Sara a Tomás (dado de baja), y nada más en membership_scope.
SELECT 'a_personas_y_alcance' AS check_id,
       (SELECT r.key FROM membership m JOIN role r ON r.id = m.role_id
         WHERE m.user_id = '000000a7-0000-4000-8000-000000000002') AS valentina,
       (SELECT r.key FROM membership m JOIN role r ON r.id = m.role_id
         WHERE m.user_id = '000000a7-0000-4000-8000-000000000004') AS diego,
       (SELECT r.key FROM membership m JOIN role r ON r.id = m.role_id
         WHERE m.user_id = '000000a7-0000-4000-8000-000000000002') = 'owner'
       AND (SELECT r.key FROM membership m JOIN role r ON r.id = m.role_id
             WHERE m.user_id = '000000a7-0000-4000-8000-000000000004') = 'manager'
       AND (SELECT array_agg(s.user_id::text || ':' || s.scope_type || ':' || s.scope_id::text ORDER BY s.user_id, s.scope_id)
              FROM membership_scope s)
           = ARRAY['000000a7-0000-4000-8000-000000000004:creator:000000a7-0000-4000-8000-0000000000a3',
                   '000000a7-0000-4000-8000-000000000006:creator:000000a7-0000-4000-8000-0000000000a3',
                   '000000a7-0000-4000-8000-000000000006:creator:000000a7-0000-4000-8000-0000000000b3',
                   '000000a7-0000-4000-8000-000000000008:creator:000000a7-0000-4000-8000-0000000000c3']
       AND (SELECT count(*) FROM membership m JOIN role r ON r.id = m.role_id
             WHERE m.workspace_id = '000000a7-0000-4000-8000-000000000001' AND r.key = 'manager') = 3
       AS ok;

-- (b) Dos negocios de cada creador y uno sin creador; una campaña de cada uno.
SELECT 'b_negocios_y_campanas_por_creador' AS check_id,
       count(*) FILTER (WHERE d.creator_id = '000000a7-0000-4000-8000-0000000000a3') AS de_camilo,
       count(*) FILTER (WHERE d.creator_id = '000000a7-0000-4000-8000-0000000000b3') AS de_mariana,
       count(*) FILTER (WHERE d.creator_id IS NULL) AS sin_creador,
       count(*) FILTER (WHERE d.creator_id = '000000a7-0000-4000-8000-0000000000a3') = 2
       AND count(*) FILTER (WHERE d.creator_id = '000000a7-0000-4000-8000-0000000000b3') = 2
       AND count(*) FILTER (WHERE d.creator_id IS NULL) = 1
       AND (SELECT array_agg(c.creator_id::text ORDER BY c.creator_id) FROM campaign c)
           = ARRAY['000000a7-0000-4000-8000-0000000000a3', '000000a7-0000-4000-8000-0000000000b3']
       AS ok
  FROM deal d;

-- (c) Valentina ve a todos: el predicado de la política la deja pasar en
--     todas las filas, y no le esconde ningún negocio de ninguna marca.
SELECT 'c_la_duena_ve_todo' AS check_id,
       session_sees_all_creators() AS ve_a_todos,
       session_sees_all_creators()
       AND NOT open_deal_out_of_scope('000000a7-0000-4000-8000-0000000000e2')
       AS ok;

-- (d) Diego, con el mismo predicado que la política: solo los dos de
--     Camilo (ni los de Mariana ni el «Sin creador»), una sola campaña, y
--     Mercado Verde tiene un negocio abierto que él no ve (el aviso de la
--     ficha). Su selector de «Nuevo negocio» tiene a Camilo y a nadie más.
SELECT set_config('app.user_id', '000000a7-0000-4000-8000-000000000004', false);
SELECT 'd_el_ejecutivo_solo_camilo' AS check_id,
       (SELECT count(*) FROM deal d WHERE session_sees_all_creators() OR scope_allows('creator', d.creator_id)) AS negocios,
       NOT session_sees_all_creators()
       AND (SELECT array_agg(d.id::text ORDER BY d.id) FROM deal d WHERE scope_allows('creator', d.creator_id))
           = ARRAY['000000a7-0000-4000-8000-0000000dea01', '000000a7-0000-4000-8000-0000000dea02']
       AND (SELECT count(*) FROM campaign c WHERE scope_allows('creator', c.creator_id)) = 1
       AND open_deal_out_of_scope('000000a7-0000-4000-8000-0000000000e2')
       AND (SELECT array_agg(c ORDER BY c) FROM creators_for_session('000000a7-0000-4000-8000-000000000001') AS c)
           = ARRAY['000000a7-0000-4000-8000-0000000000a3'::uuid]
       AS ok;
SELECT set_config('app.user_id', '000000a7-0000-4000-8000-000000000002', false);

-- (f) Andrea, acotada a los dos: ve los cuatro negocios con creador (no
--     el «Sin creador»), las dos campañas, y su selector tiene a los dos:
--     «Nuevo negocio» le pide elegir.
SELECT set_config('app.user_id', '000000a7-0000-4000-8000-000000000006', false);
SELECT 'f_la_ejecutiva_de_los_dos' AS check_id,
       NOT session_sees_all_creators()
       AND (SELECT count(*) FROM deal d WHERE scope_allows('creator', d.creator_id)) = 4
       AND (SELECT count(*) FROM campaign c WHERE scope_allows('creator', c.creator_id)) = 2
       AND (SELECT array_agg(c ORDER BY c) FROM creators_for_session('000000a7-0000-4000-8000-000000000001') AS c)
           = ARRAY['000000a7-0000-4000-8000-0000000000a3'::uuid, '000000a7-0000-4000-8000-0000000000b3'::uuid]
       AS ok;

-- (g) Sara, acotada solo a un creador dado de baja: no ve ningún negocio
--     ni campaña, y no tiene a quién poner en uno nuevo.
SELECT set_config('app.user_id', '000000a7-0000-4000-8000-000000000008', false);
SELECT 'g_la_ejecutiva_sin_creadores_vivos' AS check_id,
       NOT session_sees_all_creators()
       AND (SELECT count(*) FROM deal d WHERE scope_allows('creator', d.creator_id)) = 0
       AND (SELECT count(*) FROM campaign c WHERE scope_allows('creator', c.creator_id)) = 0
       AND NOT EXISTS (SELECT 1 FROM creators_for_session('000000a7-0000-4000-8000-000000000001'))
       AND sole_creator_for_session('000000a7-0000-4000-8000-000000000001') IS NULL
       AS ok;
SELECT set_config('app.user_id', '000000a7-0000-4000-8000-000000000002', false);

-- (e) La tabla de alcance sigue con FORCE después de sembrar.
SELECT 'e_membership_scope_con_force' AS check_id,
       c.relforcerowsecurity AS ok
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'membership_scope';
