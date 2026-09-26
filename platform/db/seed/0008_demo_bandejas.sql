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
--     (0069: intent_source), para que la bandeja diga quién las clasificó.
--
-- Reglas del archivo (las de 0002 a 0007):
--   * Idempotente: la copia entra una vez (la clave única del proveedor,
--     outbound_message_provider_idx) y la fuente solo se llena si falta.
--   * Nada nuevo que pase por real: son los mismos envíos del seed 0005,
--     con sus mismas pruebas de proveedor (de .test).
--   * Requiere 0069, 0070 (automatic e intent_reason) y el seed 0005.
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

-- Las dos respuestas de 0005 llegaban «hace N días» a la hora exacta en
-- que se sembró (una siembra de medianoche las dejaba a las 11:49 p. m.).
-- Se quedan en su día local y pasan a una hora de oficina: Daniel a las
-- 16:20, Carolina a las 11:05; la clasificación, tres minutos después; lo
-- leído, una hora después; y la fecha a la que vuelve el «ahora no», a los
-- noventa días de la respuesta, como la calcula notNowResumeAt. Siguen
-- después de su correo y antes de lo que cancelaron (verify/0005.sql (h)).
-- Idempotente: solo toca la que no está ya a su hora.
WITH r AS (
  SELECT m.id, ((m.occurred_at AT TIME ZONE w.timezone)::date + v.hora) AT TIME ZONE w.timezone AS cuando
    FROM outbound_message m
    JOIN workspace w ON w.id = m.workspace_id
    JOIN (VALUES ('00000005-0000-4000-8000-0000000a5001'::uuid, time '16:20'),
                 ('00000005-0000-4000-8000-0000000a5002'::uuid, time '11:05')) AS v(id, hora) ON v.id = m.id
   WHERE (m.occurred_at AT TIME ZONE w.timezone)::time <> v.hora
)
UPDATE outbound_message m
   SET occurred_at = r.cuando, created_at = r.cuando,
       classified_at = CASE WHEN m.classified_at IS NOT NULL THEN r.cuando + interval '3 minutes' END,
       read_at = CASE WHEN m.read_at IS NOT NULL THEN r.cuando + interval '1 hour' END,
       resume_at = CASE WHEN m.intent = 'not_now' THEN r.cuando + interval '90 days' ELSE m.resume_at END
  FROM r
 WHERE m.id = r.id;

UPDATE outbound_touch t
   SET replied_at = m.occurred_at
  FROM outbound_message m
 WHERE m.touch_id = t.id AND m.direction = 'inbound'
   AND m.id IN ('00000005-0000-4000-8000-0000000a5001', '00000005-0000-4000-8000-0000000a5002')
   AND t.replied_at IS DISTINCT FROM m.occurred_at;


-- =====================================================================
-- Ronda 2 · La demo cuenta la historia de las dos bandejas
-- ---------------------------------------------------------------------
-- Con un solo retenido, j y k no se podían probar, y su motivo era una
-- frase suelta («Nota»), no la revisión automática al estilo de Stripe
-- Radar. Y aprobar pedía antes ir a la política a guardar la dirección
-- postal. La bandeja solo tenía dos hilos de correo.
--
-- Ronda 3 · Lo de las bandejas va en filas SUYAS. La ronda 2 colgaba los
-- retenidos y los hilos de fichas que ya usan otras pruebas (Fresko,
-- Granos del Valle, Café Alma, Nutrivé, Hogar Lindo) y conectaba el
-- Instagram de Laura: el recomendador (VEN-13) veía Instagram conectado y
-- a Andrés alcanzable, y la baja por respuesta de canales (VEN-9)
-- cancelaba cuatro toques de Laura Quintero en vez de dos. Ahora:
--   * cinco marcas propias de esta demo, con su ficha y su persona, que
--     ninguna otra prueba nombra ni busca;
--   * el Instagram de Laura está DESCONECTADO (y ya soltado, released_at):
--     el recomendador lo cuenta como que no hay cuenta, el despachador no
--     lo suelta otra vez, y el hilo de Instagram enseña «reconéctala para
--     responder», como el de LinkedIn.
--
-- Mapa de identificadores nuevos (00000008-…, solo dígitos hexadecimales):
--   …-0000000000e1..e5      company y company_link (las cinco marcas)
--   …-0000000c0001..005     contact                (una persona por marca)
--   …-0000000ac003          outreach_channel_account  (el Instagram, desconectado)
--   …-0000000e0001..002     outbound_enrollment       (Molino Andino, Casa Olivo)
--   …-000000070001..005     outbound_touch
--   …-0000000a6001..006     outbound_message          (los hilos de LinkedIn, Instagram y el «fuera de la oficina»)
--   (y los de la sección 7: la sexta marca, su negocio y su hilo «me interesa»)
--
-- Mismas reglas: idempotente (ON CONFLICT DO NOTHING, lo que pasó se
-- congela en la primera siembra), nada real (dominios .test, sin
-- secretos: el Instagram no tiene secret_ref) y la política sigue
-- APAGADA.
-- =====================================================================

-- 1 · La dirección postal del pie de los correos: sin ella no se aprueba nada.
UPDATE outbound_policy
   SET postal_address = 'Calle 85 # 11-53, oficina 402, Bogotá, Colombia'
 WHERE workspace_id = '00000002-0000-4000-8000-000000000001' AND postal_address IS NULL;

-- 2 · El Instagram de Laura: se conectó por Unipile hace veinte días y ya
--     está desconectado y soltado. Sus conversaciones quedan en la bandeja.
INSERT INTO outreach_channel_account
  (id, workspace_id, creator_id, channel, provider, provider_account_id, display_name, status,
   daily_cap, weekly_cap, warmup_started_at, last_ok_at, released_at, scopes)
VALUES
  ('00000008-0000-4000-8000-0000000ac003', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-000000000003', 'instagram_dm', 'unipile', 'unipile-demo-laura-instagram',
   'Laura Méndez', 'disconnected', 20, 100, now() - interval '20 days', now() - interval '12 hours',
   now() - interval '6 hours', '{}')
ON CONFLICT (id) DO NOTHING;

-- 3 · Las cinco marcas de la demo de bandejas, cada una con su persona.
INSERT INTO company (id, name, legal_name, domain, country, city, industry, niche_slugs, size_bucket, socials, runs_ads)
VALUES
  ('00000008-0000-4000-8000-0000000000e1', 'Molino Andino',      'Molino Andino S.A.S.',      'molinoandino.test',      'CO', 'Manizales', 'alimentos', '{cocina}', 'mediana', '{"instagram": "molinoandino"}',      true),
  ('00000008-0000-4000-8000-0000000000e2', 'Casa Olivo',         'Casa Olivo Ltda.',          'casaolivo.test',         'CO', 'Medellín',  'hogar',     '{hogar}',  'pyme',    '{"instagram": "casaolivo"}',         false),
  ('00000008-0000-4000-8000-0000000000e3', 'Tostadores del Sur', 'Tostadores del Sur S.A.S.', 'tostadoresdelsur.test',  'CO', 'Pasto',     'alimentos', '{cocina}', 'pyme',    '{"instagram": "tostadoresdelsur"}',  false),
  ('00000008-0000-4000-8000-0000000000e4', 'Huerta Viva',        'Huerta Viva S.A.S.',        'huertaviva.test',        'CO', 'Bogotá',    'alimentos', '{cocina}', 'pyme',    '{"instagram": "huertaviva"}',        true),
  ('00000008-0000-4000-8000-0000000000e5', 'Cereal Aurora',      'Cereal Aurora S.A.S.',      'cerealaurora.test',      'CO', 'Cali',      'alimentos', '{cocina}', 'mediana', '{"instagram": "cerealaurora"}',      true)
ON CONFLICT DO NOTHING;

INSERT INTO company_link (workspace_id, company_id, owner_user_id, relationship, fit_score, fit_explain, notes)
SELECT '00000002-0000-4000-8000-000000000001', c.id, '00000002-0000-4000-8000-000000000002', 'contacted', 0.7500,
       '{"audience_overlap": 0.75, "niche": "cocina", "country": "CO"}'::jsonb, 'Marca de la demo de bandejas (seed 0008).'
  FROM company c
 WHERE c.id IN ('00000008-0000-4000-8000-0000000000e1', '00000008-0000-4000-8000-0000000000e2', '00000008-0000-4000-8000-0000000000e3',
                '00000008-0000-4000-8000-0000000000e4', '00000008-0000-4000-8000-0000000000e5')
ON CONFLICT DO NOTHING;

INSERT INTO contact (id, company_id, full_name, role_title, email, linkedin_url, instagram_handle, source, source_url)
VALUES
  ('00000008-0000-4000-8000-0000000c0001', '00000008-0000-4000-8000-0000000000e1', 'Paula Restrepo', 'Brand manager',
   'paula.restrepo@molinoandino.test', 'https://www.linkedin.com/in/paula-restrepo-molinoandino', NULL,
   'public_website', 'https://molinoandino.test/prensa'),
  ('00000008-0000-4000-8000-0000000c0002', '00000008-0000-4000-8000-0000000000e2', 'Mónica Villa', 'Coordinadora de marketing',
   'monica.villa@casaolivo.test', NULL, NULL, 'public_website', 'https://casaolivo.test/contacto'),
  ('00000008-0000-4000-8000-0000000c0003', '00000008-0000-4000-8000-0000000000e3', 'Felipe Ortega', 'Marketing digital',
   'felipe.ortega@tostadoresdelsur.test', 'https://www.linkedin.com/in/felipe-ortega-tostadores', NULL,
   'public_profile', 'https://www.linkedin.com/in/felipe-ortega-tostadores'),
  ('00000008-0000-4000-8000-0000000c0004', '00000008-0000-4000-8000-0000000000e4', 'Tomás Arango', 'Community manager',
   NULL, NULL, 'tomas.huertaviva', 'public_profile', 'https://www.instagram.com/huertaviva'),
  ('00000008-0000-4000-8000-0000000c0005', '00000008-0000-4000-8000-0000000000e5', 'Esteban Mora', 'Gerente de mercadeo',
   'esteban.mora@cerealaurora.test', NULL, NULL, 'public_website', 'https://cerealaurora.test/equipo')
ON CONFLICT (id) DO NOTHING;

-- 4 · Dos cadencias más, con lo que espera a Laura en la bandeja de aprobación.
INSERT INTO outbound_enrollment
  (id, workspace_id, sequence_id, contact_id, current_step_id, status, resume_at, context, enrolled_by, started_at, finished_at)
VALUES
  -- Molino Andino: el comentario se saltó (no hay LinkedIn que funcione) y el correo lo retuvo el juez.
  ('00000008-0000-4000-8000-0000000e0001', '00000002-0000-4000-8000-000000000001',
   '00000005-0000-4000-8000-0000005e0001', '00000008-0000-4000-8000-0000000c0001',
   '00000005-0000-4000-8000-0000005e0102', 'active', NULL, '{"angles_used": []}'::jsonb,
   '00000002-0000-4000-8000-000000000002', now() - interval '1 day', NULL),
  -- Casa Olivo: el correo pasó la revisión, pero es de los diez primeros de su tipo.
  ('00000008-0000-4000-8000-0000000e0002', '00000002-0000-4000-8000-000000000001',
   '00000005-0000-4000-8000-0000005e0001', '00000008-0000-4000-8000-0000000c0002',
   '00000005-0000-4000-8000-0000005e0102', 'active', NULL, '{"angles_used": []}'::jsonb,
   '00000002-0000-4000-8000-000000000002', now() - interval '1 day', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO outbound_touch
  (id, workspace_id, company_id, contact_id, sequence_id, step_index, enrollment_id, step_id, channel, subject, body,
   status, scheduled_for, held_reason, blocked_reason, status_changed_at, created_at)
VALUES
  ('00000008-0000-4000-8000-000000070001', '00000002-0000-4000-8000-000000000001',
   '00000008-0000-4000-8000-0000000000e1', '00000008-0000-4000-8000-0000000c0001',
   '00000005-0000-4000-8000-0000005e0001', 1, '00000008-0000-4000-8000-0000000e0001',
   '00000005-0000-4000-8000-0000005e0101', 'linkedin', NULL, '', 'skipped', NULL, NULL, 'skipped_by_person',
   now() - interval '20 hours', now() - interval '1 day'),
  ('00000008-0000-4000-8000-000000070002', '00000002-0000-4000-8000-000000000001',
   '00000008-0000-4000-8000-0000000000e1', '00000008-0000-4000-8000-0000000c0001',
   '00000005-0000-4000-8000-0000005e0001', 2, '00000008-0000-4000-8000-0000000e0001',
   '00000005-0000-4000-8000-0000005e0102', 'email', 'Granos para el desayuno de mi audiencia',
   'Hola, Paula: quienes me siguen desayunan en casa entre semana y buscan recetas con granos enteros, '
   'justo lo que vende Molino Andino. El 23 % de mis videos de desayuno terminan en una compra. '
   '¿Te muestro cómo quedaría una receta con su avena?',
   'held', NULL, 'quality_risk:unsourced_figure', NULL, now() - interval '3 hours', now() - interval '1 day'),
  ('00000008-0000-4000-8000-000000070003', '00000002-0000-4000-8000-000000000001',
   '00000008-0000-4000-8000-0000000000e1', '00000008-0000-4000-8000-0000000c0001',
   '00000005-0000-4000-8000-0000005e0001', 3, '00000008-0000-4000-8000-0000000e0001',
   '00000005-0000-4000-8000-0000005e0103', 'linkedin', NULL,
   'Paula, te dejo el video de la avena horneada con frutos rojos: una receta así con Molino Andino '
   'tendría el producto en el centro. ¿Te lo mando?',
   'held', NULL, 'needs_review', NULL, now() - interval '2 hours', now() - interval '1 day'),
  ('00000008-0000-4000-8000-000000070004', '00000002-0000-4000-8000-000000000001',
   '00000008-0000-4000-8000-0000000000e2', '00000008-0000-4000-8000-0000000c0002',
   '00000005-0000-4000-8000-0000005e0001', 1, '00000008-0000-4000-8000-0000000e0002',
   '00000005-0000-4000-8000-0000005e0101', 'linkedin', NULL, '', 'skipped', NULL, NULL, 'skipped_by_person',
   now() - interval '20 hours', now() - interval '1 day'),
  ('00000008-0000-4000-8000-000000070005', '00000002-0000-4000-8000-000000000001',
   '00000008-0000-4000-8000-0000000000e2', '00000008-0000-4000-8000-0000000c0002',
   '00000005-0000-4000-8000-0000005e0001', 2, '00000008-0000-4000-8000-0000000e0002',
   '00000005-0000-4000-8000-0000005e0102', 'email', 'Tu cocina en mis videos',
   'Hola, Mónica: grabo en una cocina pequeña, como la de quien me sigue, y siempre me preguntan por los '
   'utensilios. Casa Olivo encaja en ese momento del video. ¿Hablamos de una receta con sus ollas?',
   'held', NULL, 'quality_warmup:3', NULL, now() - interval '1 hour', now() - interval '1 day')
ON CONFLICT (id) DO NOTHING;


-- El retenido de Vitalé decía su motivo en una frase suelta: pasa al código del motor.
UPDATE outbound_touch
   SET held_reason = 'quality_low:7.4'
 WHERE id = '00000005-0000-4000-8000-000000070004' AND held_reason LIKE 'El juez dejó%';


-- 5 · Lo que dijo la revisión automática de cada correo que redactó la IA:
--     una fila de outbound_review por intento (nota por dimensión, riesgos
--     y lo que el pre-vuelo no dejó pasar) y el intento elegido en
--     outbound_generation. Es lo que enseña «Por qué quedó retenido».
INSERT INTO outbound_generation
  (touch_id, workspace_id, stage, subject, body_marked, model, attempts, outcome, generated_at, reviewed_at,
   review_run, chosen_attempt, judge_note, total_score)
VALUES
  ('00000008-0000-4000-8000-000000070002', '00000002-0000-4000-8000-000000000001', 'reviewed',
   'Granos para el desayuno de mi audiencia',
   'Hola, Paula: quienes me siguen desayunan en casa entre semana y buscan recetas con granos enteros, '
   'justo lo que vende Molino Andino. El 23 % de mis videos de desayuno terminan en una compra. '
   '¿Te muestro cómo quedaría una receta con su avena?',
   'claude-sonnet-5', 2, 'held', now() - interval '3 hours', now() - interval '3 hours', 1, 2,
   'Suena a persona y abre con ellos, pero cita una cifra de compras que no sale de tu perfil.', 7.60),
  ('00000008-0000-4000-8000-000000070005', '00000002-0000-4000-8000-000000000001', 'reviewed',
   'Tu cocina en mis videos',
   'Hola, Mónica: grabo en una cocina pequeña, como la de quien me sigue, y siempre me preguntan por los '
   'utensilios. Casa Olivo encaja en ese momento del video. ¿Hablamos de una receta con sus ollas?',
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
   'Granos para el desayuno', 'Hola, Paula: sinergia entre mi audiencia y Molino Andino. El 23 % de mis videos venden.',
   '{"preflight": {"issues": [{"code": "banned_word", "detail": "sinergia"}, {"code": "unsourced_figure", "detail": "23 %"}]}}'::jsonb,
   '{"relevance": 6.5, "quality": 5.5, "structure": 6.0, "voice": 6.0}'::jsonb, 6.00, 'more_specific', '{unsourced_figure}',
   'regenerate', 'claude-sonnet-5', 1850, 240, 0.009150, now() - interval '3 hours 1 minute'),
  ('00000002-0000-4000-8000-000000000001', '00000008-0000-4000-8000-000000070002', 1, 2,
   'Granos para el desayuno de mi audiencia',
   'Hola, Paula: quienes me siguen desayunan en casa entre semana y buscan recetas con granos enteros, '
   'justo lo que vende Molino Andino. El 23 % de mis videos de desayuno terminan en una compra. '
   '¿Te muestro cómo quedaría una receta con su avena?',
   '{"preflight": {"issues": [{"code": "unsourced_figure", "detail": "23 %"}]}}'::jsonb,
   '{"relevance": 8.0, "quality": 7.5, "structure": 7.5, "voice": 7.5}'::jsonb, 7.60, NULL, '{unsourced_figure}',
   'hold', 'claude-sonnet-5', 1920, 260, 0.009660, now() - interval '3 hours'),
  ('00000002-0000-4000-8000-000000000001', '00000008-0000-4000-8000-000000070005', 1, 1,
   'Tu cocina en mis videos',
   'Hola, Mónica: grabo en una cocina pequeña, como la de quien me sigue, y siempre me preguntan por los '
   'utensilios. Casa Olivo encaja en ese momento del video. ¿Hablamos de una receta con sus ollas?',
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

-- 6 · Los hilos de LinkedIn e Instagram y un «fuera de la oficina», con lo que
--     leyó el clasificador (§5.7). Lo nuestro, como lo deja recordSent; lo
--     suyo, como lo deja el lector o el webhook, ya clasificado.
--
--     Las horas (pulido r1): cada mensaje a una hora fija del día local
--     del workspace, N días atrás. Con `now() - interval 'N days'` todos
--     heredaban la hora a la que se sembró, y una siembra de medianoche
--     dejaba la bandeja entera escrita «a las 11:49 p. m.». La clasificación,
--     tres minutos después del mensaje; la fecha de vuelta de Esteban, diez
--     días después del día en que respondió (lo que dice su mensaje), no
--     diez días desde hoy.
WITH ws AS (
  SELECT w.timezone AS tz, (now() AT TIME ZONE w.timezone)::date AS hoy
    FROM workspace w WHERE w.id = '00000002-0000-4000-8000-000000000001'
),
m AS (
  SELECT v.*, ((ws.hoy - v.dias) + v.hora) AT TIME ZONE ws.tz AS cuando, ws.tz, ws.hoy
    FROM ws, (VALUES
      -- LinkedIn · Felipe (Tostadores del Sur) nos remite a Mariana, de alianzas. La cuenta de LinkedIn está caída:
      -- el hilo enseña «reconéctala para responder».
      ('00000008-0000-4000-8000-0000000a6001'::uuid, '00000005-0000-4000-8000-0000000ac002'::uuid,
       '00000008-0000-4000-8000-0000000c0003'::uuid, 'outbound', 'linkedin', 'unipile-chat-demo-0004', 'unipile-demo-msg-0004-1',
       NULL::text, NULL::text,
       'Felipe, vi el lanzamiento del café de origen en su cuenta: una receta de postre con él funcionaría muy bien con mi audiencia. ¿Quién ve las alianzas con creadores?',
       NULL::text, NULL::numeric, NULL::text, NULL::text, NULL::jsonb, NULL::boolean, 4, time '10:40', false),
      ('00000008-0000-4000-8000-0000000a6002', '00000005-0000-4000-8000-0000000ac002',
       '00000008-0000-4000-8000-0000000c0003', 'inbound', 'linkedin', 'unipile-chat-demo-0004', 'unipile-demo-msg-0004-2',
       NULL, NULL,
       'Hola, Laura. Gracias por escribir. Las alianzas las lleva Mariana López, de mercadeo: mariana.lopez@tostadoresdelsur.test. Escríbele de mi parte.',
       'referral', 0.910, 'model', 'Remite a Mariana López, de mercadeo, y da su correo.',
       '{"name": "Mariana López", "email": "mariana.lopez@tostadoresdelsur.test", "role": "Mercadeo"}'::jsonb, NULL, 3, time '15:05', false),
      -- Instagram · Tomás (Huerta Viva) contesta con un «ok»: no se sabe qué pide. El Instagram ya
      -- está desconectado: el hilo enseña «reconéctala para responder».
      ('00000008-0000-4000-8000-0000000a6003', '00000008-0000-4000-8000-0000000ac003',
       '00000008-0000-4000-8000-0000000c0004', 'outbound', 'instagram_dm', 'unipile-ig-demo-0002', 'unipile-demo-ig-0002-1',
       NULL, NULL,
       'Tomás, me encantó el reel del mercado de los sábados. Tengo una idea de receta con sus frutas de temporada para mi cuenta. ¿Te la cuento?',
       NULL, NULL, NULL, NULL, NULL, NULL, 2, time '11:20', false),
      ('00000008-0000-4000-8000-0000000a6004', '00000008-0000-4000-8000-0000000ac003',
       '00000008-0000-4000-8000-0000000c0004', 'inbound', 'instagram_dm', 'unipile-ig-demo-0002', 'unipile-demo-ig-0002-2',
       NULL, NULL, 'Ok 👍',
       'ambiguous', 0.420, 'model', 'Solo dice «ok»: no queda claro si quiere seguir.', NULL, NULL, 1, time '18:45', false),
      -- Correo · Esteban (Cereal Aurora) está de vacaciones: la respuesta automática trae su fecha de vuelta.
      ('00000008-0000-4000-8000-0000000a6005', '00000005-0000-4000-8000-0000000ac001',
       '00000008-0000-4000-8000-0000000c0005', 'outbound', 'email', 'gmail-thread-demo-0005', 'gmail-demo-0005-1',
       NULL, 'Una receta de temporada con Cereal Aurora',
       'Hola, Esteban: quienes me siguen cocinan para la familia entre semana, el cliente de Cereal Aurora. ¿Te interesa ver una receta de temporada con sus cereales?',
       NULL, NULL, NULL, NULL, NULL, NULL, 2, time '09:35', false),
      ('00000008-0000-4000-8000-0000000a6006', '00000005-0000-4000-8000-0000000ac001',
       '00000008-0000-4000-8000-0000000c0005', 'inbound', 'email', 'gmail-thread-demo-0005', 'gmail-demo-0005-r1',
       'esteban.mora@cerealaurora.test', 'Respuesta automática: Una receta de temporada con Cereal Aurora',
       'Gracias por tu correo. Estoy de vacaciones y vuelvo a la oficina en diez días. Para temas urgentes, escribe a mercadeo@cerealaurora.test.',
       'ooo', 0.950, 'model', 'Es una respuesta automática de vacaciones con la fecha de vuelta.', NULL, true, 2, time '09:36', true)
    ) AS v(id, cuenta, contacto, direction, channel, thread_ref, provider_message_id, from_address, subject, body,
           intent, confianza, fuente, razon, referral, automatic, dias, hora, leido)
)
INSERT INTO outbound_message
  (id, workspace_id, channel_account_id, contact_id, direction, channel, thread_ref, provider_message_id, from_address,
   subject, body, intent, intent_confidence, intent_source, intent_reason, classified_at, resume_at, referral,
   automatic, occurred_at, read_at, created_at)
SELECT m.id, '00000002-0000-4000-8000-000000000001', m.cuenta, m.contacto, m.direction, m.channel, m.thread_ref,
       m.provider_message_id, m.from_address, m.subject, m.body, m.intent, m.confianza, m.fuente, m.razon,
       CASE WHEN m.intent IS NOT NULL THEN m.cuando + interval '3 minutes' END,
       -- «Vuelvo en diez días», contados desde el día en que respondió.
       CASE WHEN m.intent = 'ooo' THEN (m.hoy - m.dias + 10)::timestamp AT TIME ZONE m.tz END,
       m.referral, m.automatic, m.cuando,
       -- Lo leído, a la mañana siguiente.
       CASE WHEN m.leido THEN (m.hoy - m.dias + 1 + time '08:50') AT TIME ZONE m.tz END,
       m.cuando
  FROM m
ON CONFLICT (id) DO NOTHING;


-- =====================================================================
-- 7 · «Me interesa» → «En conversación» (pulido r1)
-- ---------------------------------------------------------------------
-- El único hilo «Interesada» de la demo (Daniel, seed 0005) ya estaba en
-- Negociación: nunca se veía lo que pide el criterio de VEN-14, que un
-- «me interesa» mueve el negocio a «En conversación» con «Responder hoy».
-- Aquí, una sexta marca propia, Frutos del Páramo, con la cadencia de
-- 0005 («Marca con campaña activa») recorrida como la deja el motor:
--   * el comentario en LinkedIn (paso 1) y el correo (paso 2) salieron en
--     días hábiles anteriores, en la ventana laboral, desde las cuentas de
--     Laura (el seed 0009 los suma a sus contadores, como todo lo que el
--     despachador reclamó);
--   * Juliana respondió HOY por la mañana, el modelo la clasificó como
--     interesada y se aplicó la intención (applyIntent): el enrolamiento
--     quedó 'replied', el paso 3 cancelado ('replied') y el negocio, que
--     estaba en «Contactado», pasó a «En conversación» con «Responder hoy»
--     y vencimiento al final del día local.
-- El negocio no tiene monto todavía (una conversación que empieza), así
-- que las cifras del pipeline de 0002 no cambian; verify/0002.sql cuenta
-- los negocios de SU seed, igual que ya contaba sus marcas.
--
-- Mapa (00000008-…): …-0000000000e6 la marca, …-0000000c0006 Juliana,
-- …-0000000dea01 el negocio, …-0000000e0003 el enrolamiento,
-- …-000000070006..008 los toques, …-0000000a6007..008 el hilo.
-- Idempotente: DO NOTHING, y la historia de etapas solo si falta.
-- =====================================================================
INSERT INTO company (id, name, legal_name, domain, country, city, industry, niche_slugs, size_bucket, socials, runs_ads)
VALUES ('00000008-0000-4000-8000-0000000000e6', 'Frutos del Páramo', 'Frutos del Páramo S.A.S.', 'frutosdelparamo.test',
        'CO', 'Tunja', 'alimentos', '{cocina}', 'pyme', '{"instagram": "frutosdelparamo"}', true)
ON CONFLICT DO NOTHING;

INSERT INTO company_link (workspace_id, company_id, owner_user_id, relationship, fit_score, fit_explain, notes)
VALUES ('00000002-0000-4000-8000-000000000001', '00000008-0000-4000-8000-0000000000e6', '00000002-0000-4000-8000-000000000002',
        'contacted', 0.8000, '{"audience_overlap": 0.80, "niche": "cocina", "country": "CO"}'::jsonb,
        'Marca de la demo de bandejas (seed 0008).')
ON CONFLICT DO NOTHING;

INSERT INTO contact (id, company_id, full_name, role_title, email, linkedin_url, instagram_handle, source, source_url)
VALUES ('00000008-0000-4000-8000-0000000c0006', '00000008-0000-4000-8000-0000000000e6', 'Juliana Duarte', 'Jefe de marca',
        'juliana.duarte@frutosdelparamo.test', 'https://www.linkedin.com/in/juliana-duarte-frutosdelparamo', NULL,
        'public_website', 'https://frutosdelparamo.test/equipo')
ON CONFLICT (id) DO NOTHING;

-- Las horas: días hábiles antes de hoy, en la ventana laboral de Bogotá
-- (verify/0005.sql (h)); la respuesta, hoy a las 08:40, o un poco antes
-- de sembrar si se siembra de madrugada (nunca en el futuro).
WITH ws AS (SELECT (now() AT TIME ZONE 'America/Bogota')::date AS hoy),
dias AS (
  SELECT array_agg(g::date ORDER BY g DESC) AS habiles
    FROM ws, generate_series(ws.hoy - 1, ws.hoy - 30, interval '-1 day') g
   WHERE extract(isodow FROM g) < 6),
h AS (
  SELECT (habiles[6] + time '09:30') AT TIME ZONE 'America/Bogota' AS creado,
         (habiles[5] + time '10:05') AT TIME ZONE 'America/Bogota' AS paso_1,
         (habiles[3] + time '10:45') AT TIME ZONE 'America/Bogota' AS paso_2,
         least((ws.hoy + time '08:40') AT TIME ZONE 'America/Bogota', now() - interval '10 minutes') AS respuesta,
         -- «Responder hoy»: al final del día local, como endOfLocalDay.
         (ws.hoy + time '23:59:59') AT TIME ZONE 'America/Bogota' AS vence
    FROM ws, dias)
INSERT INTO deal (id, workspace_id, company_id, creator_id, owner_user_id, name, stage_id, amount, currency, expected_close_date,
                  next_action, next_action_due, next_action_user_id, last_contact_at, created_at)
SELECT '00000008-0000-4000-8000-0000000dea01', '00000002-0000-4000-8000-000000000001', '00000008-0000-4000-8000-0000000000e6',
       '00000002-0000-4000-8000-000000000003', '00000002-0000-4000-8000-000000000002', 'Recetas de temporada con Frutos del Páramo',
       'conversacion', NULL, 'COP', CURRENT_DATE + 30, 'Responder hoy', h.vence, '00000002-0000-4000-8000-000000000002',
       h.respuesta, h.creado
  FROM h
-- Lo que pasó se congela; el cierre esperado es un plan y se refresca al
-- volver a sembrar (como los negocios de 0002): el tablero no envejece.
ON CONFLICT (id) DO UPDATE SET expected_close_date = EXCLUDED.expected_close_date
WHERE deal.won_at IS NULL AND deal.lost_at IS NULL;

INSERT INTO deal_stage_history (deal_id, from_stage_id, to_stage_id, changed_by, changed_at)
SELECT d.id, x.desde, x.hacia, NULL, x.cuando
  FROM deal d
  CROSS JOIN LATERAL (VALUES (NULL::text, 'contactado', d.created_at),
                             ('contactado', 'conversacion', d.last_contact_at + interval '3 minutes')) AS x(desde, hacia, cuando)
 WHERE d.id = '00000008-0000-4000-8000-0000000dea01'
   AND NOT EXISTS (SELECT 1 FROM deal_stage_history s WHERE s.deal_id = d.id);

INSERT INTO outbound_enrollment
  (id, workspace_id, sequence_id, contact_id, deal_id, current_step_id, status, context, enrolled_by, started_at, finished_at)
SELECT '00000008-0000-4000-8000-0000000e0003', '00000002-0000-4000-8000-000000000001', '00000005-0000-4000-8000-0000005e0001',
       '00000008-0000-4000-8000-0000000c0006', d.id, '00000005-0000-4000-8000-0000005e0103', 'replied',
       '{"angles_used": ["temporada"]}'::jsonb, '00000002-0000-4000-8000-000000000002', d.created_at, d.last_contact_at
  FROM deal d WHERE d.id = '00000008-0000-4000-8000-0000000dea01'
ON CONFLICT (id) DO NOTHING;

WITH ws AS (SELECT (now() AT TIME ZONE 'America/Bogota')::date AS hoy),
dias AS (
  SELECT array_agg(g::date ORDER BY g DESC) AS habiles
    FROM ws, generate_series(ws.hoy - 1, ws.hoy - 30, interval '-1 day') g
   WHERE extract(isodow FROM g) < 6),
h AS (
  SELECT (habiles[5] + time '10:05') AT TIME ZONE 'America/Bogota' AS paso_1,
         (habiles[3] + time '10:45') AT TIME ZONE 'America/Bogota' AS paso_2,
         (SELECT d.last_contact_at FROM deal d WHERE d.id = '00000008-0000-4000-8000-0000000dea01') AS respuesta,
         -- El paso 3 iba a salir el siguiente día hábil, a las 10:30: la respuesta lo canceló antes.
         (SELECT (min(g)::date + time '10:30') AT TIME ZONE 'America/Bogota'
            FROM ws, generate_series(ws.hoy + 1, ws.hoy + 7, interval '1 day') g WHERE extract(isodow FROM g) < 6) AS proximo
    FROM dias)
INSERT INTO outbound_touch
  (id, workspace_id, company_id, contact_id, deal_id, sequence_id, step_index, enrollment_id, step_id, channel,
   subject, body, status, scheduled_for, claimed_at, sent_at, attempt_count, recipient_address, provider_message_id,
   message_id_rfc, thread_ref, blocked_reason, status_changed_at, created_at, channel_account_id)
SELECT v.id, '00000002-0000-4000-8000-000000000001', '00000008-0000-4000-8000-0000000000e6', '00000008-0000-4000-8000-0000000c0006',
       '00000008-0000-4000-8000-0000000dea01', '00000005-0000-4000-8000-0000005e0001', v.paso, '00000008-0000-4000-8000-0000000e0003',
       v.step, v.channel, v.subject, v.body, v.status, v.cuando,
       CASE WHEN v.status = 'sent' THEN v.cuando - interval '8 seconds' END,
       CASE WHEN v.status = 'sent' THEN v.cuando END,
       CASE WHEN v.status = 'sent' THEN 1 ELSE 0 END,
       v.recipient, v.provider_id, v.rfc, v.thread,
       CASE WHEN v.status = 'canceled' THEN 'replied' END,
       CASE WHEN v.status = 'canceled' THEN h.respuesta ELSE v.cuando END,
       h.paso_1 - interval '1 hour', v.cuenta
  FROM h, LATERAL (VALUES
    ('00000008-0000-4000-8000-000000070006'::uuid, 1, '00000005-0000-4000-8000-0000005e0101'::uuid, 'linkedin', NULL::text,
     'Qué buena la cosecha de uchuvas que mostraron esta semana. El video del empaque a mano dice mucho de la marca.',
     'sent', h.paso_1, NULL::text, 'unipile-demo-comment-0008-6', NULL::text, NULL::text, '00000005-0000-4000-8000-0000000ac002'::uuid),
    ('00000008-0000-4000-8000-000000070007', 2, '00000005-0000-4000-8000-0000005e0102', 'email', 'Uchuvas en el desayuno de mi audiencia',
     'Hola, Juliana: quienes me siguen desayunan en casa y buscan fruta de temporada para sus recetas. Las uchuvas de Frutos del '
     'Páramo encajan en una serie de desayunos de cinco minutos. ¿Te muestro cómo quedaría la primera receta?',
     'sent', h.paso_2, 'juliana.duarte@frutosdelparamo.test', 'gmail-demo-0008-6', '<demo-0008-6@mail.gmail.com>',
     'gmail-thread-demo-0008-6', '00000005-0000-4000-8000-0000000ac001'),
    ('00000008-0000-4000-8000-000000070008', 3, '00000005-0000-4000-8000-0000005e0103', 'linkedin', NULL,
     'Juliana, te dejo el video de la avena con uchuvas que grabé esta semana. ¿Lo vemos juntas?',
     'canceled', h.proximo, NULL, NULL, NULL, NULL, NULL)
  ) AS v(id, paso, step, channel, subject, body, status, cuando, recipient, provider_id, rfc, thread, cuenta)
ON CONFLICT (id) DO NOTHING;

-- El enlace de baja del correo que salió, como lo deja el despachador (0005 §5).
INSERT INTO outbound_optout_link
  (token_hash, workspace_id, touch_id, contact_id, attempt, recipient_address, claimed_at, sent_at)
SELECT encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex'),
       t.workspace_id, t.id, t.contact_id, t.attempt_count, t.recipient_address, t.claimed_at, t.sent_at
  FROM outbound_touch t
 WHERE t.id = '00000008-0000-4000-8000-000000070007' AND t.status = 'sent'
   AND NOT EXISTS (SELECT 1 FROM outbound_optout_link l WHERE l.touch_id = t.id AND l.attempt = t.attempt_count);

-- El hilo: nuestro correo, como lo copia recordSent, y la respuesta de
-- Juliana, clasificada por el modelo y con la intención ya aplicada.
INSERT INTO outbound_message
  (id, workspace_id, channel_account_id, enrollment_id, touch_id, contact_id, deal_id, direction, channel, thread_ref,
   provider_message_id, message_id_rfc, in_reply_to, from_address, subject, body, intent, intent_confidence, intent_source,
   intent_reason, classified_at, occurred_at, read_at, created_at)
SELECT t.id, t.workspace_id, t.channel_account_id, t.enrollment_id, t.touch_id, t.contact_id, t.deal_id, t.direction, 'email',
       'gmail-thread-demo-0008-6', t.provider_id, t.rfc, t.in_reply_to, t.from_address, t.subject, t.body, t.intent, t.confianza,
       t.fuente, t.razon, CASE WHEN t.intent IS NOT NULL THEN t.cuando + interval '3 minutes' END, t.cuando, NULL, t.cuando
  FROM (
    SELECT '00000008-0000-4000-8000-0000000a6007'::uuid AS id, x.workspace_id, x.channel_account_id, x.enrollment_id, x.id AS touch_id,
           x.contact_id, x.deal_id, 'outbound' AS direction, x.provider_message_id AS provider_id, x.message_id_rfc AS rfc,
           NULL::text AS in_reply_to, NULL::text AS from_address, x.subject, x.body, NULL::text AS intent, NULL::numeric AS confianza,
           NULL::text AS fuente, NULL::text AS razon, x.sent_at AS cuando
      FROM outbound_touch x WHERE x.id = '00000008-0000-4000-8000-000000070007'
    UNION ALL
    SELECT '00000008-0000-4000-8000-0000000a6008', x.workspace_id, x.channel_account_id, x.enrollment_id, x.id, x.contact_id, x.deal_id,
           'inbound', 'gmail-demo-0008-6-r1', '<juliana-0008-6@frutosdelparamo.test>', x.message_id_rfc,
           'juliana.duarte@frutosdelparamo.test', 'Re: ' || x.subject,
           'Hola, Laura. Nos encanta la idea de los desayunos: justo estamos lanzando la temporada de uchuvas. '
           '¿Me mandas tus tarifas y hablamos esta semana?',
           'interested', 0.960, 'model', 'Pide tarifas y propone hablar esta semana.',
           (SELECT d.last_contact_at FROM deal d WHERE d.id = x.deal_id)
      FROM outbound_touch x WHERE x.id = '00000008-0000-4000-8000-000000070007'
  ) t
ON CONFLICT (id) DO NOTHING;

UPDATE outbound_touch SET replied_at = (SELECT d.last_contact_at FROM deal d WHERE d.id = '00000008-0000-4000-8000-0000000dea01')
 WHERE id = '00000008-0000-4000-8000-000000070007' AND replied_at IS NULL;
