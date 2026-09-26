-- =====================================================================
-- Verificación del seed 0008 (la conversación completa de la bandeja, VEN-14).
-- ---------------------------------------------------------------------
--   node db/seed/verify/run.mjs 0008
-- Cada consulta con columna `ok` es una prueba: un false hace fallar run.mjs.
-- =====================================================================

SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);

-- (a) Cada correo enviado de la demo tiene su copia saliente, en su hilo,
--     y la conversación con Daniel empieza por nuestro correo.
SELECT 'a_copias_salientes' AS check_id,
       (SELECT count(*) FROM outbound_message WHERE direction = 'outbound'
         AND touch_id IN ('00000005-0000-4000-8000-000000070002', '00000005-0000-4000-8000-000000070006',
                          '00000005-0000-4000-8000-000000070008')) AS copias,
       (SELECT direction FROM outbound_message WHERE contact_id = '00000002-0000-4000-8000-0000000c0008'
         ORDER BY occurred_at LIMIT 1) AS primero_con_daniel,
       (SELECT count(*) FROM outbound_message WHERE direction = 'outbound'
         AND touch_id IN ('00000005-0000-4000-8000-000000070002', '00000005-0000-4000-8000-000000070006',
                          '00000005-0000-4000-8000-000000070008')) = 3
         AND (SELECT direction FROM outbound_message WHERE contact_id = '00000002-0000-4000-8000-0000000c0008'
               ORDER BY occurred_at LIMIT 1) = 'outbound' AS ok;

-- (b) Las dos respuestas clasificadas dicen quién las clasificó.
SELECT 'b_fuente_de_la_intencion' AS check_id,
       (SELECT string_agg(intent_source, ',' ORDER BY id) FROM outbound_message
         WHERE id IN ('00000005-0000-4000-8000-0000000a5001', '00000005-0000-4000-8000-0000000a5002')) AS fuentes,
       (SELECT string_agg(intent_source, ',' ORDER BY id) FROM outbound_message
         WHERE id IN ('00000005-0000-4000-8000-0000000a5001', '00000005-0000-4000-8000-0000000a5002')) = 'model,model' AS ok;
