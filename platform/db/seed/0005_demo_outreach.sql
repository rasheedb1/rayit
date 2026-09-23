-- =====================================================================
-- Seed 5 · Outreach de la creadora de demostración (VEN-9, para VEN-10,
-- VEN-13 y la pantalla de canales).
-- ---------------------------------------------------------------------
-- Hasta aquí la demo no contaba ninguna historia de outreach: la única
-- fila era la política de 0002, y outbound_health del workspace demo
-- devolvía todo en cero. Este seed pone una cadencia viva, escrita como
-- la dejarían el callback del proveedor y el despachador:
--
--   * dos cuentas de canal de Laura: su Gmail conectado y su LinkedIn
--     pidiendo reconectar (lo que la pantalla de canales pinta en rojo);
--   * una secuencia creada desde la plantilla global «Marca con campaña
--     activa», con sus seis pasos copiados a outbound_step;
--   * tres enrolamientos, uno por desenlace: Vitalé (Sofía Cárdenas)
--     sigue activo, Sabores Caseros (Daniel Restrepo) respondió y Olla
--     Fácil (Carolina Ruiz) dijo «ahora no» y está en enfriamiento;
--   * nueve toques en todos los estados que la pantalla enseña: draft,
--     scheduled, held, sent (cuatro, tres de ellos correos con su
--     dirección, su id de Gmail y su enlace de baja) y canceled;
--   * las dos respuestas que llegaron, en outbound_message.
--
-- Cómo se escribe lo que es del despachador. provider_message_id,
-- message_id_rfc, recipient_address, el estado autenticado de una
-- cuenta y el enlace de baja los escribe solo el despachador (0037
-- §2.1, §4.2, §4.5). Los seeds los corre el dueño del esquema
-- (mc_migrator en Supabase, mc_migrator_test en la verificación), que
-- outreach_is_dispatcher() reconoce: no hace falta desactivar ningún
-- candado. Y el enlace de baja entra por la política
-- outbound_optout_link_seed, acotada al workspace fijado.
--
-- Reglas del archivo (las de 0002 y 0004):
--   * Idempotente. UUID fijos y ON CONFLICT (id). Lo que ya PASÓ (los
--     envíos, las respuestas, los desenlaces) se congela en la primera
--     corrida con DO NOTHING. Lo único que la demo mira HOY, el toque
--     programado de Vitalé, se reprograma para mañana a las 10:30
--     locales cada vez que se siembra, mientras siga programado.
--   * Nada real. Las direcciones del Gmail y la cuenta de Unipile son
--     de .test, la cuenta conectada no tiene secreto (secret_ref NULL:
--     el despachador no puede enviar con ella) y la política de 0002
--     sigue APAGADA: sembrar la demo en Supabase no manda nada.
--   * El token de los enlaces de baja no va en el archivo (el
--     repositorio es público): se sortea en la primera corrida y solo
--     queda su sha256.
--   * Requiere 0037 (se siembra después de aplicarla).
--
-- Mapa de identificadores (00000005-…, solo dígitos hexadecimales):
--   …-0000000ac001..002     outreach_channel_account  (ac = cuenta)
--   …-0000005e0001          outbound_sequence         (5e = secuencia)
--   …-0000005e01NN          outbound_step             (NN = posición 01..06)
--   …-0000000e0001..003     outbound_enrollment       (e0 = enrolamiento)
--   …-000000070001..009     outbound_touch            (7 = toque)
--   …-0000000a5001..002     outbound_message          (a5 = respuesta)
-- =====================================================================

SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);
SELECT set_config('app.user_id', '00000002-0000-4000-8000-000000000002', false);
SELECT set_config('TimeZone', 'UTC', false);


-- =====================================================================
-- 1 · Las cuentas de canal
-- ---------------------------------------------------------------------
-- El Gmail conectado por el OAuth (con los dos alcances que pide VEN-9)
-- y el LinkedIn de Unipile caído: Unipile avisó que la sesión expiró y
-- la cuenta espera que Laura la reconecte. Los topes están por debajo
-- del techo de cada canal (outreach_channel_account_channel_caps_check).
-- =====================================================================
INSERT INTO outreach_channel_account
  (id, workspace_id, creator_id, channel, provider, provider_account_id, display_name, status,
   daily_cap, weekly_cap, warmup_started_at, last_ok_at, last_error_at, last_error, scopes)
VALUES
  ('00000005-0000-4000-8000-0000000ac001', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-000000000003', 'email', 'gmail_oauth', 'laura@cocina-facil.test',
   'laura@cocina-facil.test', 'connected', 40, 200, now() - interval '20 days', now() - interval '1 hour',
   NULL, NULL, '{gmail.send,gmail.modify}'),
  ('00000005-0000-4000-8000-0000000ac002', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-000000000003', 'linkedin', 'unipile', 'unipile-demo-laura-linkedin',
   'Laura · Cocina fácil (LinkedIn)', 'needs_reconnect', 25, 100, now() - interval '20 days',
   now() - interval '3 days', now() - interval '2 days',
   'Unipile: la sesión de LinkedIn expiró (CREDENTIALS). Hay que volver a conectar la cuenta.', '{}')
ON CONFLICT (id) DO NOTHING;


-- =====================================================================
-- 2 · La secuencia, copiada de la plantilla
-- ---------------------------------------------------------------------
-- Lo que hará VEN-13 al crear una secuencia desde una plantilla: la fila
-- con template_id y un outbound_step por cada paso del jsonb, con el
-- ángulo resuelto por su clave en el catálogo global.
-- =====================================================================
INSERT INTO outbound_sequence (id, workspace_id, name, channel, status, automation_mode, template_id)
SELECT '00000005-0000-4000-8000-0000005e0001', '00000002-0000-4000-8000-000000000001',
       tpl.name_es, 'email', 'active', 'review', tpl.id
  FROM outbound_sequence_template tpl
 WHERE tpl.slug = 'marca-con-campana-activa'
ON CONFLICT (id) DO NOTHING;

INSERT INTO outbound_step
  (id, workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time, angle_id,
   guidance_es, generate_with_ai, requires_asset)
SELECT ('00000005-0000-4000-8000-0000005e01' || lpad(s.n::text, 2, '0'))::uuid,
       '00000002-0000-4000-8000-000000000001', '00000005-0000-4000-8000-0000005e0001',
       (s.paso->>'day_offset')::int, (s.paso->>'order_in_day')::int, s.paso->>'step_type', s.paso->>'channel',
       (s.paso->>'scheduled_time')::time,
       (SELECT a.id FROM outbound_angle a WHERE a.workspace_id IS NULL AND a.key = s.paso->>'angle_key'),
       s.paso->>'guidance_es', (s.paso->>'generate_with_ai')::boolean, s.paso->>'requires_asset'
  FROM outbound_sequence_template tpl
 CROSS JOIN LATERAL jsonb_array_elements(tpl.steps) WITH ORDINALITY AS s(paso, n)
 WHERE tpl.slug = 'marca-con-campana-activa'
ON CONFLICT (id) DO NOTHING;


-- =====================================================================
-- 3 · Los tres enrolamientos
-- ---------------------------------------------------------------------
-- Uno por desenlace. context guarda los ángulos ya usados, que es lo
-- que el generador lee para no repetirse (§5.3).
-- =====================================================================
INSERT INTO outbound_enrollment
  (id, workspace_id, sequence_id, contact_id, current_step_id, status, resume_at, context, enrolled_by,
   started_at, finished_at)
VALUES
  -- Vitalé: va por el tercer paso (el mensaje de LinkedIn de mañana).
  ('00000005-0000-4000-8000-0000000e0001', '00000002-0000-4000-8000-000000000001',
   '00000005-0000-4000-8000-0000005e0001', '00000002-0000-4000-8000-0000000c0011',
   '00000005-0000-4000-8000-0000005e0103', 'active', NULL,
   '{"angles_used": ["presencia", "encaje_audiencia"]}'::jsonb, '00000002-0000-4000-8000-000000000002',
   now() - interval '2 days', NULL),
  -- Sabores Caseros: Daniel contestó al correo; lo pendiente se canceló.
  ('00000005-0000-4000-8000-0000000e0002', '00000002-0000-4000-8000-000000000001',
   '00000005-0000-4000-8000-0000005e0001', '00000002-0000-4000-8000-0000000c0008',
   '00000005-0000-4000-8000-0000005e0102', 'replied', NULL,
   '{"angles_used": ["presencia", "encaje_audiencia"]}'::jsonb, '00000002-0000-4000-8000-000000000002',
   now() - interval '7 days', now() - interval '5 days'),
  -- Olla Fácil: «ahora no»; vuelve a los 90 días de su respuesta (§5.7).
  ('00000005-0000-4000-8000-0000000e0003', '00000002-0000-4000-8000-000000000001',
   '00000005-0000-4000-8000-0000005e0001', '00000002-0000-4000-8000-0000000c0012',
   '00000005-0000-4000-8000-0000005e0102', 'cooldown', now() + interval '79 days',
   '{"angles_used": ["encaje_audiencia"]}'::jsonb, '00000002-0000-4000-8000-000000000002',
   now() - interval '13 days', NULL)
ON CONFLICT (id) DO NOTHING;


-- =====================================================================
-- 4 · Los toques
-- ---------------------------------------------------------------------
-- Lo enviado lleva lo que dejó el despachador: el intento (attempt_count
-- 1), la hora del reclamo, el id del proveedor y, en los correos, la
-- dirección EXACTA a la que salió, la cabecera Message-ID y el hilo.
-- status_changed_at es la hora del último cambio de estado: la de envío
-- para lo enviado, la de la cancelación para lo cancelado.
-- =====================================================================
INSERT INTO outbound_touch
  (id, workspace_id, company_id, contact_id, sequence_id, step_index, enrollment_id, step_id, channel,
   subject, body, status, scheduled_for, claimed_at, sent_at, attempt_count, recipient_address,
   provider_message_id, message_id_rfc, thread_ref, opened_at, replied_at, held_reason, blocked_reason,
   status_changed_at, created_at)
VALUES
  -- Vitalé · 1: el comentario en su último post (LinkedIn).
  ('00000005-0000-4000-8000-000000070001', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e7', '00000002-0000-4000-8000-0000000c0011',
   '00000005-0000-4000-8000-0000005e0001', 1, '00000005-0000-4000-8000-0000000e0001',
   '00000005-0000-4000-8000-0000005e0101', 'linkedin', NULL,
   'Qué buena la idea de la avena con frutos rojos para arrancar la semana. La probé en casa y funciona.',
   'sent', now() - interval '2 days', now() - interval '2 days' - interval '10 seconds', now() - interval '2 days', 1,
   NULL, 'unipile-demo-comment-0001', NULL, NULL, NULL, NULL, NULL, NULL,
   now() - interval '2 days', now() - interval '2 days' - interval '1 hour'),
  -- Vitalé · 2: el correo del encaje de audiencia; lo abrió.
  ('00000005-0000-4000-8000-000000070002', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e7', '00000002-0000-4000-8000-0000000c0011',
   '00000005-0000-4000-8000-0000005e0001', 2, '00000005-0000-4000-8000-0000000e0001',
   '00000005-0000-4000-8000-0000005e0102', 'email', 'Tu audiencia y la mía desayunan igual',
   'Hola, Sofía: el 64 % de quienes me siguen son mujeres de 25 a 34 años que cocinan entre semana, '
   'el mismo cliente de Vitalé. ¿Te interesa ver cómo le fue a una receta de desayuno en mi cuenta?',
   'sent', now() - interval '1 day', now() - interval '1 day' - interval '8 seconds', now() - interval '1 day', 1,
   'sofia@vitale.co', 'gmail-demo-0002', '<demo-0002@mail.gmail.com>', 'gmail-thread-demo-0002',
   now() - interval '20 hours', NULL, NULL, NULL,
   now() - interval '1 day', now() - interval '1 day' - interval '1 hour'),
  -- Vitalé · 3: el mensaje de LinkedIn con la prueba de desempeño, programado.
  ('00000005-0000-4000-8000-000000070003', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e7', '00000002-0000-4000-8000-0000000c0011',
   '00000005-0000-4000-8000-0000005e0001', 3, '00000005-0000-4000-8000-0000000e0001',
   '00000005-0000-4000-8000-0000005e0103', 'linkedin', NULL,
   'Sofía, te dejo el video de la granola casera: 212 mil views, cuatro veces mi mediana. '
   'Una receta así con Vitalé funcionaría igual de bien.',
   'scheduled', (date_trunc('day', now() AT TIME ZONE 'America/Bogota') + interval '1 day 10 hours 30 minutes')
                  AT TIME ZONE 'America/Bogota',
   NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   now() - interval '1 day', now() - interval '1 day'),
  -- Vitalé · 4: la respuesta en el hilo, retenida por el juez.
  ('00000005-0000-4000-8000-000000070004', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e7', '00000002-0000-4000-8000-0000000c0011',
   '00000005-0000-4000-8000-0000005e0001', 4, '00000005-0000-4000-8000-0000000e0001',
   '00000005-0000-4000-8000-0000005e0104', 'email', 'Re: Tu audiencia y la mía desayunan igual',
   'Una idea para su campaña de bebidas vegetales: tres desayunos de cinco minutos, uno por día, '
   'con el producto en la receta y no en la mesa.',
   'held', NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL,
   'El juez dejó 7,6 de 8,0: cita una campaña de Vitalé sin fuente. Revísalo antes de programarlo.', NULL,
   now() - interval '3 hours', now() - interval '3 hours'),
  -- Vitalé · 5: la prueba social, todavía en borrador.
  ('00000005-0000-4000-8000-000000070005', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e7', '00000002-0000-4000-8000-0000000c0011',
   '00000005-0000-4000-8000-0000005e0001', 5, '00000005-0000-4000-8000-0000000e0001',
   '00000005-0000-4000-8000-0000005e0105', 'linkedin', NULL,
   'Con Café Alma hicimos tres videos en abril: 712 mil views y un código de descuento que se usó 1.840 veces.',
   'draft', NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   now() - interval '3 hours', now() - interval '3 hours'),
  -- Sabores Caseros · 2: el correo al que Daniel respondió.
  ('00000005-0000-4000-8000-000000070006', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e5', '00000002-0000-4000-8000-0000000c0008',
   '00000005-0000-4000-8000-0000005e0001', 2, '00000005-0000-4000-8000-0000000e0002',
   '00000005-0000-4000-8000-0000005e0102', 'email', 'Recetas caseras para su temporada',
   'Hola, Daniel: mi audiencia cocina en casa de lunes a viernes y compra en supermercado de barrio, '
   'justo donde está Sabores Caseros. ¿Hablamos de su temporada de fin de año?',
   'sent', now() - interval '6 days', now() - interval '6 days' - interval '9 seconds', now() - interval '6 days', 1,
   'daniel.restrepo@saborescaseros.co', 'gmail-demo-0006', '<demo-0006@mail.gmail.com>',
   'gmail-thread-demo-0006', now() - interval '6 days' + interval '2 hours', now() - interval '5 days', NULL, NULL,
   now() - interval '6 days', now() - interval '6 days' - interval '1 hour'),
  -- Sabores Caseros · 3: cancelado por la respuesta.
  ('00000005-0000-4000-8000-000000070007', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e5', '00000002-0000-4000-8000-0000000c0008',
   '00000005-0000-4000-8000-0000005e0001', 3, '00000005-0000-4000-8000-0000000e0002',
   '00000005-0000-4000-8000-0000005e0103', 'linkedin', NULL,
   'Daniel, te comparto el video de las arepas rellenas: 180 mil views en una semana.',
   'canceled', now() - interval '4 days', NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'replied',
   now() - interval '5 days', now() - interval '6 days'),
  -- Olla Fácil · 2: el correo al que Carolina contestó «ahora no».
  ('00000005-0000-4000-8000-000000070008', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e8', '00000002-0000-4000-8000-0000000c0012',
   '00000005-0000-4000-8000-0000005e0001', 2, '00000005-0000-4000-8000-0000000e0003',
   '00000005-0000-4000-8000-0000005e0102', 'email', 'Ollas que se ven en cámara',
   'Hola, Carolina: la mitad de mis videos se graban con la olla en primer plano, y quien me sigue '
   'pregunta siempre cuál es. ¿Te interesa que la próxima sea de Olla Fácil?',
   'sent', now() - interval '12 days', now() - interval '12 days' - interval '7 seconds',
   now() - interval '12 days', 1, 'hola@ollafacil.co', 'gmail-demo-0008', '<demo-0008@mail.gmail.com>',
   'gmail-thread-demo-0008', now() - interval '12 days' + interval '3 hours', now() - interval '11 days', NULL, NULL,
   now() - interval '12 days', now() - interval '12 days' - interval '1 hour'),
  -- Olla Fácil · 4: cancelado por el «ahora no».
  ('00000005-0000-4000-8000-000000070009', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e8', '00000002-0000-4000-8000-0000000c0012',
   '00000005-0000-4000-8000-0000005e0001', 4, '00000005-0000-4000-8000-0000000e0003',
   '00000005-0000-4000-8000-0000005e0104', 'email', 'Re: Ollas que se ven en cámara',
   'Una idea: «una olla, cinco cenas», una serie corta con la olla como protagonista.',
   'canceled', now() - interval '8 days', NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'not_now',
   now() - interval '11 days', now() - interval '12 days')
-- Lo único que la demo mira hoy: el programado vuelve a mañana a las
-- 10:30 locales cada vez que se siembra, mientras siga programado.
ON CONFLICT (id) DO UPDATE SET scheduled_for = EXCLUDED.scheduled_for
WHERE outbound_touch.status = 'scheduled';


-- =====================================================================
-- 5 · Los enlaces de baja de los tres correos enviados
-- ---------------------------------------------------------------------
-- Uno por intento, como los deja el despachador al reclamar (0037 §4.5):
-- la dirección, el intento y, como el proveedor confirmó, sent_at. El
-- token se sortea aquí y no se guarda: de la demo no se puede pulsar
-- ningún enlace, y el repositorio no enseña uno que funcione.
-- =====================================================================
INSERT INTO outbound_optout_link
  (token_hash, workspace_id, touch_id, contact_id, attempt, recipient_address, claimed_at, sent_at)
SELECT encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex'),
       t.workspace_id, t.id, t.contact_id, t.attempt_count, t.recipient_address, t.claimed_at, t.sent_at
  FROM outbound_touch t
 WHERE t.id IN ('00000005-0000-4000-8000-000000070002', '00000005-0000-4000-8000-000000070006',
                '00000005-0000-4000-8000-000000070008')
   AND NOT EXISTS (SELECT 1 FROM outbound_optout_link l WHERE l.touch_id = t.id AND l.attempt = t.attempt_count);


-- =====================================================================
-- 6 · Las dos respuestas
-- ---------------------------------------------------------------------
-- Lo que el webhook de Gmail dejará en la bandeja (VEN-14), ya
-- clasificado por el modelo barato (§5.7): Daniel quiere hablar;
-- Carolina, «ahora no», con la fecha a la que vuelve su enrolamiento.
-- =====================================================================
INSERT INTO outbound_message
  (id, workspace_id, channel_account_id, enrollment_id, touch_id, contact_id, direction, channel, thread_ref,
   provider_message_id, message_id_rfc, in_reply_to, from_address, subject, body, intent, intent_confidence,
   classified_at, resume_at, occurred_at, read_at)
VALUES
  ('00000005-0000-4000-8000-0000000a5001', '00000002-0000-4000-8000-000000000001',
   '00000005-0000-4000-8000-0000000ac001', '00000005-0000-4000-8000-0000000e0002',
   '00000005-0000-4000-8000-000000070006', '00000002-0000-4000-8000-0000000c0008', 'inbound', 'email',
   'gmail-thread-demo-0006', 'gmail-demo-0006-r1', '<daniel-0006@saborescaseros.co>', '<demo-0006@mail.gmail.com>',
   'daniel.restrepo@saborescaseros.co', 'Re: Recetas caseras para su temporada',
   'Hola, Laura. Sí, justo estamos armando la temporada. ¿Te sirve una llamada el jueves?',
   'interested', 0.940, now() - interval '5 days', NULL, now() - interval '5 days', now() - interval '5 days'),
  ('00000005-0000-4000-8000-0000000a5002', '00000002-0000-4000-8000-000000000001',
   '00000005-0000-4000-8000-0000000ac001', '00000005-0000-4000-8000-0000000e0003',
   '00000005-0000-4000-8000-000000070008', '00000002-0000-4000-8000-0000000c0012', 'inbound', 'email',
   'gmail-thread-demo-0008', 'gmail-demo-0008-r1', '<carolina-0008@ollafacil.co>', '<demo-0008@mail.gmail.com>',
   'hola@ollafacil.co', 'Re: Ollas que se ven en cámara',
   'Gracias, Laura. Este trimestre no tenemos presupuesto para creadores; escríbeme después de enero.',
   'not_now', 0.910, now() - interval '11 days', now() - interval '11 days' + interval '90 days',
   now() - interval '11 days', NULL)
ON CONFLICT (id) DO NOTHING;
