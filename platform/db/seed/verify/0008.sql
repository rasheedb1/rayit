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

-- (c) La bandeja de aprobación tiene con qué probar j y k: cuatro retenidos,
--     cada uno con el código del motor (no una frase suelta), y los que
--     redactó la IA con su revisión (nota por dimensión, riesgos y pre-vuelo).
SELECT 'c_retenidos_con_motivo' AS check_id,
       string_agg(t.held_reason, ',' ORDER BY t.id) AS motivos,
       count(*) FILTER (WHERE g.review_run IS NOT NULL) AS con_revision,
       count(*) = 4
         AND bool_and(t.held_reason ~ '^[a-z_]+(:[A-Za-z0-9_.,]+)?$')
         AND count(*) FILTER (WHERE t.held_reason = 'quality_risk:unsourced_figure') = 1
         AND count(*) FILTER (WHERE t.held_reason LIKE 'quality_warmup:%') = 1
         AND count(*) FILTER (WHERE t.held_reason = 'needs_review' AND t.channel = 'linkedin') = 1
         AND count(*) FILTER (WHERE g.review_run IS NOT NULL
                                AND EXISTS (SELECT 1 FROM outbound_review r
                                             WHERE r.touch_id = t.id AND r.run = g.review_run AND r.attempt = g.chosen_attempt
                                               AND r.scores ? 'relevance' AND r.scores ? 'voice')) = 3 AS ok
  FROM outbound_touch t
  LEFT JOIN outbound_generation g ON g.touch_id = t.id
 WHERE t.workspace_id = '00000002-0000-4000-8000-000000000001' AND t.status = 'held';

-- (d) Aprobar no pide antes ir a la política: la dirección postal está.
SELECT 'd_direccion_postal' AS check_id, p.postal_address,
       p.postal_address IS NOT NULL AND NOT p.enabled AS ok
  FROM outbound_policy p
 WHERE p.workspace_id = '00000002-0000-4000-8000-000000000001';

-- (e) La bandeja unificada tiene los tres canales y las intenciones de §5.7
--     que la historia enseña: un referido con su propuesta, un «fuera de la
--     oficina» con su fecha y automático, y una ambigua sin leer.
SELECT 'e_hilos_por_canal' AS check_id,
       (SELECT string_agg(DISTINCT channel, ',' ORDER BY channel) FROM outbound_message WHERE direction = 'inbound') AS canales,
       (SELECT string_agg(intent || ':' || channel, ',' ORDER BY intent) FROM outbound_message
         WHERE id::text LIKE '00000008-%' AND direction = 'inbound') AS intenciones,
       (SELECT string_agg(DISTINCT channel, ',' ORDER BY channel) FROM outbound_message WHERE direction = 'inbound')
         = 'email,instagram_dm,linkedin'
         AND EXISTS (SELECT 1 FROM outbound_message WHERE intent = 'referral' AND referral->>'email' IS NOT NULL
                       AND intent_source = 'model' AND intent_reason IS NOT NULL)
         AND EXISTS (SELECT 1 FROM outbound_message WHERE intent = 'ooo' AND resume_at IS NOT NULL AND automatic)
         AND EXISTS (SELECT 1 FROM outbound_message WHERE intent = 'ambiguous' AND channel = 'instagram_dm' AND read_at IS NULL)
         AND EXISTS (SELECT 1 FROM outreach_channel_account WHERE channel = 'instagram_dm' AND status = 'connected' AND secret_ref IS NULL)
         AS ok;
