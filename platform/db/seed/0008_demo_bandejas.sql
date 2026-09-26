-- =====================================================================
-- Seed 8 · La conversación completa en la bandeja de la demo (VEN-14)
-- ---------------------------------------------------------------------
-- El seed 0005 dejó las dos respuestas de la demo en outbound_message,
-- pero no los correos a los que responden: el despachador copia a
-- outbound_message cada envío que confirma (recordSent, VEN-10) y la
-- demo los escribió directo en outbound_touch. En /ventas/bandeja la
-- conversación con Daniel (Sabores Caseros) empezaba por su respuesta.
--
-- Aquí, para los correos enviados de la demo:
--   * su copia en outbound_message, como la deja recordSent: la misma
--     cuenta, el mismo hilo, el mismo Message-ID y la hora del envío;
--   * la fuente de la intención de las dos respuestas ya clasificadas
--     (0064: intent_source), para que la bandeja diga quién las clasificó.
--
-- Reglas del archivo (las de 0002 a 0007):
--   * Idempotente: la copia entra una vez (la clave única del proveedor,
--     outbound_message_provider_idx) y la fuente solo se llena si falta.
--   * Nada nuevo que pase por real: son los mismos envíos del seed 0005,
--     con sus mismas pruebas de proveedor (de .test).
--   * Requiere 0064, 0065 (automatic e intent_reason) y el seed 0005.
--
-- Y, desde la ronda 2 (abajo), los retenidos con su revisión, la
-- dirección postal y los hilos de LinkedIn e Instagram.
-- =====================================================================

SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);

INSERT INTO outbound_message
  (workspace_id, channel_account_id, enrollment_id, touch_id, contact_id, deal_id, direction, channel, thread_ref,
   provider_message_id, message_id_rfc, subject, body, occurred_at, created_at)
SELECT t.workspace_id, '00000005-0000-4000-8000-0000000ac001', t.enrollment_id, t.id, t.contact_id, t.deal_id, 'outbound', t.channel,
       t.thread_ref, t.provider_message_id, t.message_id_rfc, t.subject, t.body, t.sent_at, t.sent_at
  FROM outbound_touch t
 WHERE t.id IN ('00000005-0000-4000-8000-000000070002', '00000005-0000-4000-8000-000000070006',
                '00000005-0000-4000-8000-000000070008')
   AND t.status = 'sent' AND t.provider_message_id IS NOT NULL
ON CONFLICT (workspace_id, channel, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING;

UPDATE outbound_message
   SET intent_source = 'model'
 WHERE id IN ('00000005-0000-4000-8000-0000000a5001', '00000005-0000-4000-8000-0000000a5002')
   AND intent IS NOT NULL AND intent_source IS NULL;


-- =====================================================================
-- Ronda 2 · La demo cuenta la historia de las dos bandejas
-- ---------------------------------------------------------------------
-- Con un solo retenido, j y k no se podían probar, y su motivo era una
-- frase suelta («Nota»), no la revisión automática al estilo de Stripe
-- Radar. Y aprobar pedía antes ir a la política a guardar la dirección
-- postal. La bandeja solo tenía dos hilos de correo.
--
-- Mapa de identificadores nuevos (00000008-…, solo dígitos hexadecimales):
--   …-0000000ac003          outreach_channel_account  (el Instagram, conectado)
--   …-0000000e0001..002     outbound_enrollment       (Granos del Valle, Hogar Lindo)
--   …-000000070001..005     outbound_touch
--   …-0000000a6001..006     outbound_message          (los hilos de LinkedIn, Instagram y el «fuera de la oficina»)
--
-- Mismas reglas: idempotente (ON CONFLICT DO NOTHING, lo que pasó se
-- congela en la primera siembra), nada real (.test, sin secretos: el
-- Instagram no tiene secret_ref y no puede enviar) y la política sigue
-- APAGADA.
-- =====================================================================

-- 1 · La dirección postal del pie de los correos: sin ella no se aprueba nada.
UPDATE outbound_policy
   SET postal_address = 'Calle 85 # 11-53, oficina 402, Bogotá, Colombia'
 WHERE workspace_id = '00000002-0000-4000-8000-000000000001' AND postal_address IS NULL;

-- 2 · El Instagram de Laura, conectado por Unipile (sin secreto: no envía).
INSERT INTO outreach_channel_account
  (id, workspace_id, creator_id, channel, provider, provider_account_id, display_name, status,
   daily_cap, weekly_cap, warmup_started_at, last_ok_at, scopes)
VALUES
  ('00000008-0000-4000-8000-0000000ac003', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-000000000003', 'instagram_dm', 'unipile', 'unipile-demo-laura-instagram',
   'Laura Méndez', 'connected', 20, 100, now() - interval '20 days', now() - interval '2 hours', '{}')
ON CONFLICT (id) DO NOTHING;

-- 3 · Dos cadencias más, con lo que espera a Laura en la bandeja de aprobación.
INSERT INTO outbound_enrollment
  (id, workspace_id, sequence_id, contact_id, current_step_id, status, resume_at, context, enrolled_by, started_at, finished_at)
VALUES
  -- Granos del Valle: el comentario se saltó (no hay LinkedIn que funcione) y el correo lo retuvo el juez.
  ('00000008-0000-4000-8000-0000000e0001', '00000002-0000-4000-8000-000000000001',
   '00000005-0000-4000-8000-0000005e0001', '00000002-0000-4000-8000-0000000c0009',
   '00000005-0000-4000-8000-0000005e0102', 'active', NULL, '{"angles_used": []}'::jsonb,
   '00000002-0000-4000-8000-000000000002', now() - interval '1 day', NULL),
  -- Hogar Lindo: el correo pasó la revisión, pero es de los diez primeros de su tipo.
  ('00000008-0000-4000-8000-0000000e0002', '00000002-0000-4000-8000-000000000001',
   '00000005-0000-4000-8000-0000005e0001', '00000002-0000-4000-8000-0000000c0007',
   '00000005-0000-4000-8000-0000005e0102', 'active', NULL, '{"angles_used": []}'::jsonb,
   '00000002-0000-4000-8000-000000000002', now() - interval '1 day', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO outbound_touch
  (id, workspace_id, company_id, contact_id, sequence_id, step_index, enrollment_id, step_id, channel, subject, body,
   status, scheduled_for, held_reason, blocked_reason, status_changed_at, created_at)
VALUES
  ('00000008-0000-4000-8000-000000070001', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e6', '00000002-0000-4000-8000-0000000c0009',
   '00000005-0000-4000-8000-0000005e0001', 1, '00000008-0000-4000-8000-0000000e0001',
   '00000005-0000-4000-8000-0000005e0101', 'linkedin', NULL, '', 'skipped', NULL, NULL, 'skipped_by_person',
   now() - interval '20 hours', now() - interval '1 day'),
  ('00000008-0000-4000-8000-000000070002', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e6', '00000002-0000-4000-8000-0000000c0009',
   '00000005-0000-4000-8000-0000005e0001', 2, '00000008-0000-4000-8000-0000000e0001',
   '00000005-0000-4000-8000-0000005e0102', 'email', 'Granos para el desayuno de mi audiencia',
   'Hola, Laura: quienes me siguen desayunan en casa entre semana y buscan recetas con granos enteros, '
   'justo lo que vende Granos del Valle. El 40 % de mis videos de desayuno terminan en una compra. '
   '¿Te muestro cómo quedaría una receta con su avena?',
   'held', NULL, 'quality_risk:unsourced_figure', NULL, now() - interval '3 hours', now() - interval '1 day'),
  ('00000008-0000-4000-8000-000000070003', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e6', '00000002-0000-4000-8000-0000000c0009',
   '00000005-0000-4000-8000-0000005e0001', 3, '00000008-0000-4000-8000-0000000e0001',
   '00000005-0000-4000-8000-0000005e0103', 'linkedin', NULL,
   'Laura, te dejo el video de la avena horneada con frutos rojos: una receta así con Granos del Valle '
   'tendría el producto en el centro. ¿Te lo mando?',
   'held', NULL, 'needs_review', NULL, now() - interval '2 hours', now() - interval '1 day'),
  ('00000008-0000-4000-8000-000000070004', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e3', '00000002-0000-4000-8000-0000000c0007',
   '00000005-0000-4000-8000-0000005e0001', 1, '00000008-0000-4000-8000-0000000e0002',
   '00000005-0000-4000-8000-0000005e0101', 'linkedin', NULL, '', 'skipped', NULL, NULL, 'skipped_by_person',
   now() - interval '20 hours', now() - interval '1 day'),
  ('00000008-0000-4000-8000-000000070005', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e3', '00000002-0000-4000-8000-0000000c0007',
   '00000005-0000-4000-8000-0000005e0001', 2, '00000008-0000-4000-8000-0000000e0002',
   '00000005-0000-4000-8000-0000005e0102', 'email', 'Tu cocina en mis videos',
   'Hola, Andrea: grabo en una cocina pequeña, como la de quien me sigue, y siempre me preguntan por los '
   'utensilios. Hogar Lindo encaja en ese momento del video. ¿Hablamos de una receta con sus ollas?',
   'held', NULL, 'quality_warmup:3', NULL, now() - interval '1 hour', now() - interval '1 day')
ON CONFLICT (id) DO NOTHING;

-- El retenido de Vitalé decía su motivo en una frase suelta: pasa al código del motor.
UPDATE outbound_touch
   SET held_reason = 'quality_low:7.4'
 WHERE id = '00000005-0000-4000-8000-000000070004' AND held_reason LIKE 'El juez dejó%';

-- 4 · Lo que dijo la revisión automática de cada correo que redactó la IA:
--     una fila de outbound_review por intento (nota por dimensión, riesgos
--     y lo que el pre-vuelo no dejó pasar) y el intento elegido en
--     outbound_generation. Es lo que enseña «Por qué quedó retenido».
INSERT INTO outbound_generation
  (touch_id, workspace_id, stage, subject, body_marked, model, attempts, outcome, generated_at, reviewed_at,
   review_run, chosen_attempt, judge_note, total_score)
VALUES
  ('00000008-0000-4000-8000-000000070002', '00000002-0000-4000-8000-000000000001', 'reviewed',
   'Granos para el desayuno de mi audiencia',
   'Hola, Laura: quienes me siguen desayunan en casa entre semana y buscan recetas con granos enteros, '
   'justo lo que vende Granos del Valle. El 40 % de mis videos de desayuno terminan en una compra. '
   '¿Te muestro cómo quedaría una receta con su avena?',
   'claude-sonnet-5', 2, 'held', now() - interval '3 hours', now() - interval '3 hours', 1, 2,
   'Suena a persona y abre con ellos, pero cita una cifra de compras que no sale de tu perfil.', 7.60),
  ('00000008-0000-4000-8000-000000070005', '00000002-0000-4000-8000-000000000001', 'reviewed',
   'Tu cocina en mis videos',
   'Hola, Andrea: grabo en una cocina pequeña, como la de quien me sigue, y siempre me preguntan por los '
   'utensilios. Hogar Lindo encaja en ese momento del video. ¿Hablamos de una receta con sus ollas?',
   'claude-sonnet-5', 1, 'held', now() - interval '1 hour', now() - interval '1 hour', 1, 1,
   'Concreto y corto; la pregunta del cierre es una sola.', 8.70),
  ('00000005-0000-4000-8000-000000070004', '00000002-0000-4000-8000-000000000001', 'reviewed',
   NULL,
   'Una idea para su campaña de bebidas vegetales: tres desayunos de cinco minutos, uno por día, '
   'con el producto en la receta y no en la mesa.',
   'claude-sonnet-5', 3, 'held', now() - interval '3 hours', now() - interval '3 hours', 1, 3,
   'La idea es buena, pero no cierra con una pregunta y repite el ángulo del correo anterior.', 7.40)
ON CONFLICT (touch_id) DO NOTHING;

INSERT INTO outbound_review
  (workspace_id, touch_id, run, attempt, subject, body, gates, scores, total_score, regenerate_hint, risk_triggers,
   decision, model, input_tokens, output_tokens, cost, created_at)
VALUES
  ('00000002-0000-4000-8000-000000000001', '00000008-0000-4000-8000-000000070002', 1, 1,
   'Granos para el desayuno', 'Hola, Laura: sinergia entre mi audiencia y Granos del Valle. El 40 % de mis videos venden.',
   '{"preflight": {"issues": [{"code": "banned_word", "detail": "sinergia"}, {"code": "unsourced_figure", "detail": "40 %"}]}}'::jsonb,
   '{"relevance": 6.5, "quality": 5.5, "structure": 6.0, "voice": 6.0}'::jsonb, 6.00, 'more_specific', '{unsourced_figure}',
   'regenerate', 'claude-sonnet-5', 1850, 240, 0.009150, now() - interval '3 hours 1 minute'),
  ('00000002-0000-4000-8000-000000000001', '00000008-0000-4000-8000-000000070002', 1, 2,
   'Granos para el desayuno de mi audiencia',
   'Hola, Laura: quienes me siguen desayunan en casa entre semana y buscan recetas con granos enteros, '
   'justo lo que vende Granos del Valle. El 40 % de mis videos de desayuno terminan en una compra. '
   '¿Te muestro cómo quedaría una receta con su avena?',
   '{"preflight": {"issues": [{"code": "unsourced_figure", "detail": "40 %"}]}}'::jsonb,
   '{"relevance": 8.0, "quality": 7.5, "structure": 7.5, "voice": 7.5}'::jsonb, 7.60, NULL, '{unsourced_figure}',
   'hold', 'claude-sonnet-5', 1920, 260, 0.009660, now() - interval '3 hours'),
  ('00000002-0000-4000-8000-000000000001', '00000008-0000-4000-8000-000000070005', 1, 1,
   'Tu cocina en mis videos',
   'Hola, Andrea: grabo en una cocina pequeña, como la de quien me sigue, y siempre me preguntan por los '
   'utensilios. Hogar Lindo encaja en ese momento del video. ¿Hablamos de una receta con sus ollas?',
   '{"preflight": {"issues": []}}'::jsonb,
   '{"relevance": 8.5, "quality": 9.0, "structure": 8.5, "voice": 8.5}'::jsonb, 8.70, NULL, '{}',
   'pass', 'claude-sonnet-5', 1790, 220, 0.008670, now() - interval '1 hour'),
  ('00000002-0000-4000-8000-000000000001', '00000005-0000-4000-8000-000000070004', 1, 3,
   NULL,
   'Una idea para su campaña de bebidas vegetales: tres desayunos de cinco minutos, uno por día, '
   'con el producto en la receta y no en la mesa.',
   '{"preflight": {"issues": [{"code": "missing_closing_question", "detail": null}]}}'::jsonb,
   '{"relevance": 8.0, "quality": 7.5, "structure": 6.5, "voice": 7.5}'::jsonb, 7.40, 'other_angle', '{}',
   'hold', 'claude-sonnet-5', 2010, 250, 0.009780, now() - interval '3 hours')
ON CONFLICT (touch_id, run, attempt) DO NOTHING;

-- 5 · Los hilos de LinkedIn e Instagram y un «fuera de la oficina», con lo que
--     leyó el clasificador (§5.7). Lo nuestro, como lo deja recordSent; lo
--     suyo, como lo deja el lector o el webhook, ya clasificado.
INSERT INTO outbound_message
  (id, workspace_id, channel_account_id, contact_id, direction, channel, thread_ref, provider_message_id, from_address,
   subject, body, intent, intent_confidence, intent_source, intent_reason, classified_at, resume_at, referral,
   automatic, occurred_at, read_at, created_at)
VALUES
  -- LinkedIn · Camilo (Café Alma) nos remite a Mariana, de alianzas. La cuenta de LinkedIn está caída:
  -- el hilo enseña «reconéctala para responder».
  ('00000008-0000-4000-8000-0000000a6001', '00000002-0000-4000-8000-000000000001', '00000005-0000-4000-8000-0000000ac002',
   '00000002-0000-4000-8000-0000000c0004', 'outbound', 'linkedin', 'unipile-chat-demo-0004', 'unipile-demo-msg-0004-1', NULL,
   NULL, 'Camilo, vi el lanzamiento del café de origen en su cuenta: una receta de postre con él funcionaría muy bien con mi audiencia. ¿Quién ve las alianzas con creadores?',
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now() - interval '4 days', NULL, now() - interval '4 days'),
  ('00000008-0000-4000-8000-0000000a6002', '00000002-0000-4000-8000-000000000001', '00000005-0000-4000-8000-0000000ac002',
   '00000002-0000-4000-8000-0000000c0004', 'inbound', 'linkedin', 'unipile-chat-demo-0004', 'unipile-demo-msg-0004-2', NULL,
   NULL, 'Hola, Laura. Gracias por escribir. Las alianzas las lleva Mariana López, de mercadeo: mariana.lopez@cafealma.test. Escríbele de mi parte.',
   'referral', 0.910, 'model', 'Remite a Mariana López, de mercadeo, y da su correo.', now() - interval '3 days', NULL,
   '{"name": "Mariana López", "email": "mariana.lopez@cafealma.test", "role": "Mercadeo"}'::jsonb,
   NULL, now() - interval '3 days', NULL, now() - interval '3 days'),
  -- Instagram · Andrés (Fresko) contesta con un «ok»: no se sabe qué pide.
  ('00000008-0000-4000-8000-0000000a6003', '00000002-0000-4000-8000-000000000001', '00000008-0000-4000-8000-0000000ac003',
   '00000002-0000-4000-8000-0000000c0002', 'outbound', 'instagram_dm', 'unipile-ig-demo-0002', 'unipile-demo-ig-0002-1', NULL,
   NULL, 'Andrés, me encantó el reel del mercado de los sábados. Tengo una idea de receta con sus frutas de temporada para mi cuenta. ¿Te la cuento?',
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now() - interval '2 days', NULL, now() - interval '2 days'),
  ('00000008-0000-4000-8000-0000000a6004', '00000002-0000-4000-8000-000000000001', '00000008-0000-4000-8000-0000000ac003',
   '00000002-0000-4000-8000-0000000c0002', 'inbound', 'instagram_dm', 'unipile-ig-demo-0002', 'unipile-demo-ig-0002-2', NULL,
   NULL, 'Ok 👍',
   'ambiguous', 0.420, 'model', 'Solo dice «ok»: no queda claro si quiere seguir.', now() - interval '1 day', NULL, NULL,
   NULL, now() - interval '1 day', NULL, now() - interval '1 day'),
  -- Correo · Julián (Nutrive) está de vacaciones: la respuesta automática trae su fecha de vuelta.
  ('00000008-0000-4000-8000-0000000a6005', '00000002-0000-4000-8000-000000000001', '00000005-0000-4000-8000-0000000ac001',
   '00000002-0000-4000-8000-0000000c0005', 'outbound', 'email', 'gmail-thread-demo-0005', 'gmail-demo-0005-1', NULL,
   'Una receta de temporada con Nutrive',
   'Hola, Julián: quienes me siguen cocinan para la familia entre semana, el cliente de Nutrive. ¿Te interesa ver una receta de temporada con sus cereales?',
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now() - interval '2 days', NULL, now() - interval '2 days'),
  ('00000008-0000-4000-8000-0000000a6006', '00000002-0000-4000-8000-000000000001', '00000005-0000-4000-8000-0000000ac001',
   '00000002-0000-4000-8000-0000000c0005', 'inbound', 'email', 'gmail-thread-demo-0005', 'gmail-demo-0005-r1',
   'julian.mesa@nutrive.co', 'Respuesta automática: Una receta de temporada con Nutrive',
   'Gracias por tu correo. Estoy de vacaciones y vuelvo a la oficina en diez días. Para temas urgentes, escribe a mercadeo@nutrive.co.',
   'ooo', 0.950, 'model', 'Es una respuesta automática de vacaciones con la fecha de vuelta.', now() - interval '2 days',
   date_trunc('day', now()) + interval '10 days', NULL, true, now() - interval '2 days', now() - interval '1 day',
   now() - interval '2 days')
ON CONFLICT (id) DO NOTHING;
