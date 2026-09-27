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
         -- El Instagram está desconectado y ya soltado: el recomendador no lo cuenta y nadie lo suelta otra vez.
         AND EXISTS (SELECT 1 FROM outreach_channel_account WHERE channel = 'instagram_dm' AND status = 'disconnected'
                       AND released_at IS NOT NULL AND secret_ref IS NULL)
         AND NOT EXISTS (SELECT 1 FROM outreach_channel_account WHERE channel = 'instagram_dm' AND status = 'connected')
         AS ok;

-- (f) Lo de este seed vive en fichas suyas (ronda 3): ni un retenido, ni
--     un enrolamiento, ni un hilo nuevo cuelga de una ficha de otro seed.
--     Las pruebas del recomendador y de la baja por respuesta miran
--     Fresko, Granos del Valle y compañía: esto no las toca.
SELECT 'f_filas_propias' AS check_id,
       (SELECT count(*) FROM outbound_touch WHERE id::text LIKE '00000008-%' AND contact_id::text NOT LIKE '00000008-%')
     + (SELECT count(*) FROM outbound_enrollment WHERE id::text LIKE '00000008-%' AND contact_id::text NOT LIKE '00000008-%')
     + (SELECT count(*) FROM outbound_message WHERE id::text LIKE '00000008-%' AND contact_id::text NOT LIKE '00000008-%') AS ajenas,
       (SELECT count(*) FROM company_link WHERE company_id::text LIKE '00000008-%') AS marcas,
       (SELECT count(*) FROM outbound_touch WHERE id::text LIKE '00000008-%' AND contact_id::text NOT LIKE '00000008-%')
     + (SELECT count(*) FROM outbound_enrollment WHERE id::text LIKE '00000008-%' AND contact_id::text NOT LIKE '00000008-%')
     + (SELECT count(*) FROM outbound_message WHERE id::text LIKE '00000008-%' AND contact_id::text NOT LIKE '00000008-%') = 0
         AND (SELECT count(*) FROM company_link WHERE company_id::text LIKE '00000008-%') = 6 AS ok;

-- (g) El retenido de Molino Andino enseña la regla de las cifras (ronda 4):
--     su «23 %» no lo respalda NINGUNA proporción de la audiencia de Laura
--     (el «40 %» de antes casaba por valor con la de 25 a 34 años), la IA
--     lo dejó sin marca y el texto del toque es el suyo. Así «Aprobar» tal
--     cual devuelve unsourced_figure y abre el editor. La llamada de verdad
--     a releaseHeldTouch (con todas las cifras del perfil, no solo la
--     audiencia) la hace apps/worker/test/outreach-bandejas.test.ts.
SELECT 'g_cifra_sin_origen' AS check_id,
       position('23 %' IN g.body_marked) > 0 AS cita_la_cifra,
       position('[claim:' IN g.body_marked) = 0 AS sin_marca,
       (SELECT count(*) FROM audience_breakdown a
         WHERE a.workspace_id = t.workspace_id AND a.share BETWEEN 0.23 AND 0.23 / 0.95) AS audiencias_que_casan,
       position('23 %' IN g.body_marked) > 0
         AND position('[claim:' IN g.body_marked) = 0
         AND t.body = g.body_marked
         AND t.held_reason = 'quality_risk:unsourced_figure'
         AND NOT EXISTS (SELECT 1 FROM audience_breakdown a
                          WHERE a.workspace_id = t.workspace_id AND a.share BETWEEN 0.23 AND 0.23 / 0.95) AS ok
  FROM outbound_touch t
  JOIN outbound_generation g ON g.touch_id = t.id
 WHERE t.id = '00000008-0000-4000-8000-000000070002';

-- (h) La demo enseña «me interesa → En conversación» (criterio de VEN-14):
--     la respuesta de Juliana (Frutos del Páramo) está clasificada como
--     interesada por el modelo, su negocio pasó de «Contactado» a «En
--     conversación» con «Responder hoy» y vence hoy (hora local), su
--     cadencia quedó 'replied' con el paso siguiente cancelado, y nada de
--     eso está en el futuro.
SELECT 'h_me_interesa_mueve_el_negocio' AS check_id,
       d.stage_id, d.next_action, p.due_state,
       (SELECT string_agg(coalesce(s.from_stage_id, '-') || '>' || s.to_stage_id, ',' ORDER BY s.changed_at)
          FROM deal_stage_history s WHERE s.deal_id = d.id) AS etapas,
       d.stage_id = 'conversacion' AND d.next_action = 'Responder hoy'
         AND (SELECT string_agg(coalesce(s.from_stage_id, '-') || '>' || s.to_stage_id, ',' ORDER BY s.changed_at)
                FROM deal_stage_history s WHERE s.deal_id = d.id) = '->contactado,contactado>conversacion'
         AND EXISTS (SELECT 1 FROM outbound_message m WHERE m.deal_id = d.id AND m.direction = 'inbound'
                       AND m.intent = 'interested' AND m.intent_source = 'model' AND m.occurred_at <= now()
                       AND m.classified_at <= now() AND m.read_at IS NULL)
         AND (SELECT e.status FROM outbound_enrollment e WHERE e.deal_id = d.id) = 'replied'
         AND (SELECT string_agg(t.status || coalesce(':' || t.blocked_reason, ''), ',' ORDER BY t.step_index)
                FROM outbound_touch t WHERE t.deal_id = d.id) = 'sent,sent,canceled:replied'
         AND d.last_contact_at <= now() AS ok
  FROM deal d
  JOIN deal_pipeline p ON p.id = d.id
 WHERE d.id = '00000008-0000-4000-8000-0000000dea01';

-- (h') Y vence hoy: deal_pipeline.due_state = 'hoy'. Va aparte de (h)
--      porque due_state sale del now() interno de la vista, que el reloj
--      desplazado de `run.mjs --dias N` no alcanza: con --dias se tolera
--      solo esta (TOLERADAS_CON_DIAS) y el resto de (h) sigue contando.
SELECT 'h_me_interesa_vence_hoy' AS check_id, p.due_state,
       p.due_state = 'hoy' AS ok
  FROM deal_pipeline p
 WHERE p.id = '00000008-0000-4000-8000-0000000dea01';

-- (i) Las horas de la bandeja (pulido r1): cada mensaje de este seed a una
--     hora de oficina del día local, no a la hora a la que se sembró; nada
--     en el futuro; y el «fuera de la oficina» de Esteban vuelve diez días
--     después del día en que respondió.
SELECT 'i_horas_de_la_bandeja' AS check_id,
       string_agg(to_char(m.occurred_at AT TIME ZONE 'America/Bogota', 'HH24:MI'), ',' ORDER BY m.id) AS horas,
       bool_and(m.occurred_at <= now()) AND bool_and(m.classified_at IS NULL OR m.classified_at >= m.occurred_at)
         AND bool_and(m.id = '00000008-0000-4000-8000-0000000a6008'
                      OR (m.occurred_at AT TIME ZONE 'America/Bogota')::time BETWEEN time '08:00' AND time '19:00')
         AND (SELECT (r.resume_at AT TIME ZONE 'America/Bogota')::date - (r.occurred_at AT TIME ZONE 'America/Bogota')::date
                FROM outbound_message r WHERE r.id = '00000008-0000-4000-8000-0000000a6006') = 10 AS ok
  FROM outbound_message m
 WHERE m.id::text LIKE '00000008-%';
