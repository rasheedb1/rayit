-- =====================================================================
-- Seed 6 · Entregabilidad de la demo (VEN-15)
-- ---------------------------------------------------------------------
-- Hasta aquí la demo no enseñaba ningún rebote ni ninguna alerta: en
-- /ventas/politica «Últimos rebotes» salía vacío, ninguna ficha decía
-- «Rebotó el …: 550 5.1.1 …» y la campana no tenía ningún aviso del
-- outreach. Quien enseña el producto no podía mostrar la entregabilidad.
-- Este seed deja lo que dejarían el job outbound.bounces y el job
-- outbound.alerts con el Gmail de Laura conectado:
--
--   * un correo a Natalia Vélez (Nutrivé; su correo vino de un proveedor
--     de datos, el que suele estar viejo) que rebotó DURO: el aviso de
--     Gmail, casado con ese correo por su Message-ID (verified), y la
--     ficha marcada email_invalid con el diagnóstico del servidor;
--   * un aviso BLANDO (buzón lleno, 4.2.2) del correo a Olla Fácil, que
--     Gmail siguió intentando y que al final llegó (Carolina contestó,
--     seed 0005): se anota y no marca nada;
--   * la alerta outreach_account_down del día, que cuadra con el LinkedIn
--     que pide reconectar (seed 0005), con el texto y el enlace que deja
--     el job (/ventas/politica#cuentas).
--
-- Ronda 4: la demo tiene que CONTAR la entregabilidad al abrir
-- /ventas/politica, y antes no lo hacía (todo era de hace días: «Salud de
-- hoy» decía 0 enviados y «Sin envíos todavía» encima de dos rebotes, y
-- con un tope de 20 al día el recuadro del calentamiento solo decía que
-- no hacía falta calentar). Ahora:
--   * el correo a Natalia sale hace cinco horas, dentro de la ventana de
--     24 horas, y tres correos más salen hoy: «Rebotes» tiene cifra
--     (1 de 4) y «Correos enviados» también;
--   * la política de la demo sube a 80 correos al día con 14 días de
--     calentamiento, así que la rampa se pinta. Solo si sigue con el tope
--     de 0002 (20): lo que alguien haya cambiado a mano no se pisa.
-- Como lo demás que ya pasó, los envíos se congelan en la primera
-- siembra: una base sembrada hace días enseña lo de ese día.
--
-- Reglas del archivo (las de 0002, 0004 y 0005):
--   * Idempotente. UUID fijos y ON CONFLICT. Lo que ya pasó (el correo, los
--     avisos, la marca de la ficha) se congela en la primera corrida. Lo
--     único que la demo mira HOY, la alerta del día, vuelve a hoy cada vez
--     que se siembra, sin leer.
--   * Nada real: direcciones de la demo, ids de Gmail inventados, el
--     token del enlace de baja se sortea y solo queda su sha256.
--   * Requiere 0038 (outbound_bounce, contact.email_invalid y los avisos
--     del outreach en notification) y el seed 0005 (el Gmail de Laura y el
--     correo a Olla Fácil).
--
-- Mapa de identificadores (00000006-…, solo dígitos hexadecimales):
--   …-000000070001          outbound_touch            (el correo que rebotó)
--   …-000000070002..004     outbound_touch            (los tres correos de hoy, r4)
--   …-0000000b0001..002     outbound_bounce           (b = rebote)
--   …-0000000a1001          notification              (a1 = alerta)
-- =====================================================================

SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);
SELECT set_config('app.user_id', '00000002-0000-4000-8000-000000000002', false);
SELECT set_config('TimeZone', 'UTC', false);


-- =====================================================================
-- 1 · El correo que rebotó
-- ---------------------------------------------------------------------
-- Un correo suelto (sin secuencia) a Natalia Vélez, enviado hace cinco
-- horas desde el Gmail de Laura (dentro de la ventana de «Salud de hoy»), con lo que deja el despachador: el
-- intento, la hora del reclamo, la dirección EXACTA, el id de Gmail y la
-- cabecera Message-ID.
-- =====================================================================
INSERT INTO outbound_touch
  (id, workspace_id, company_id, contact_id, channel, subject, body, status, scheduled_for, claimed_at, sent_at,
   attempt_count, recipient_address, provider_message_id, message_id_rfc, thread_ref, status_changed_at, created_at)
VALUES
  ('00000006-0000-4000-8000-000000070001', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e4', '00000002-0000-4000-8000-0000000c0006', 'email',
   'Una idea para el trade de Nutrivé',
   'Hola, Natalia: grabo recetas rápidas con productos de supermercado, y las de Nutrivé ya salen en mis videos. '
   '¿Te interesa ver una propuesta para el punto de venta?',
   'sent', now() - interval '5 hours', now() - interval '5 hours' - interval '6 seconds', now() - interval '5 hours', 1,
   'natalia.velez@nutrive.co', 'gmail-demo-6001', '<demo-6001@mail.gmail.com>', 'gmail-thread-demo-6001',
   now() - interval '5 hours', now() - interval '6 hours')
ON CONFLICT (id) DO NOTHING;

-- Los tres correos de hoy (r4), sueltos como el de Natalia y a fichas
-- con correo que no están en ninguna secuencia de la demo: llegaron, así
-- que no tienen aviso de rebote.
INSERT INTO outbound_touch
  (id, workspace_id, company_id, contact_id, channel, subject, body, status, scheduled_for, claimed_at, sent_at,
   attempt_count, recipient_address, provider_message_id, message_id_rfc, thread_ref, status_changed_at, created_at)
VALUES
  ('00000006-0000-4000-8000-000000070002', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e2', '00000002-0000-4000-8000-0000000c0001', 'email',
   'Recetas de mercado para Fresko',
   'Hola, Camila: mis recetas de esta semana salen de un mercado de barrio como los de Fresko. '
   '¿Te muestro cómo quedaría una con sus productos frescos?',
   'sent', now() - interval '9 hours', now() - interval '9 hours' - interval '5 seconds', now() - interval '9 hours', 1,
   'camila.rojas@freskomarket.co', 'gmail-demo-6002', '<demo-6002@mail.gmail.com>', 'gmail-thread-demo-6002',
   now() - interval '9 hours', now() - interval '10 hours'),
  ('00000006-0000-4000-8000-000000070003', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e3', '00000002-0000-4000-8000-0000000c0007', 'email',
   'La cocina de Hogar Lindo, en cámara',
   'Hola, Andrea: grabo en una cocina pequeña y quien me sigue pregunta por cada utensilio. '
   '¿Hablamos de una serie con los de Hogar Lindo?',
   'sent', now() - interval '7 hours', now() - interval '7 hours' - interval '4 seconds', now() - interval '7 hours', 1,
   'andrea.salazar@hogarlindo.co', 'gmail-demo-6003', '<demo-6003@mail.gmail.com>', 'gmail-thread-demo-6003',
   now() - interval '7 hours', now() - interval '8 hours'),
  ('00000006-0000-4000-8000-000000070004', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e6', '00000002-0000-4000-8000-0000000c0009', 'email',
   'Granos del Valle en el almuerzo de la semana',
   'Hola, Laura: el video de lentejas de la semana pasada fue el más guardado del mes. '
   '¿Te interesa una receta con Granos del Valle?',
   'sent', now() - interval '3 hours', now() - interval '3 hours' - interval '7 seconds', now() - interval '3 hours', 1,
   'lquintero@granosdelvalle.co', 'gmail-demo-6004', '<demo-6004@mail.gmail.com>', 'gmail-thread-demo-6004',
   now() - interval '3 hours', now() - interval '4 hours')
ON CONFLICT (id) DO NOTHING;

-- Sus enlaces de baja, como los deja el despachador al reclamar (0037 §4.5).
INSERT INTO outbound_optout_link
  (token_hash, workspace_id, touch_id, contact_id, attempt, recipient_address, claimed_at, sent_at)
SELECT encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex'),
       t.workspace_id, t.id, t.contact_id, t.attempt_count, t.recipient_address, t.claimed_at, t.sent_at
  FROM outbound_touch t
 WHERE t.id IN ('00000006-0000-4000-8000-000000070001', '00000006-0000-4000-8000-000000070002',
                '00000006-0000-4000-8000-000000070003', '00000006-0000-4000-8000-000000070004')
   AND NOT EXISTS (SELECT 1 FROM outbound_optout_link l WHERE l.touch_id = t.id AND l.attempt = t.attempt_count);


-- =====================================================================
-- 2 · Los dos avisos, como los anota outbound.bounces
-- ---------------------------------------------------------------------
-- Los dos traen el Message-ID de un correo que Laura envió: verified. El
-- duro llegó cinco minutos después del envío; el blando, diez minutos
-- después del correo a Olla Fácil (seed 0005), y Gmail siguió intentando
-- hasta entregarlo. received_at y detected_at salen del correo, que se
-- congela en la primera siembra.
-- =====================================================================
INSERT INTO outbound_bounce
  (id, workspace_id, channel_account_id, provider_message_id, touch_id, contact_id, recipient_address, verified, kind,
   status_code, smtp_code, reason, received_at, detected_at)
SELECT '00000006-0000-4000-8000-0000000b0001', t.workspace_id, '00000005-0000-4000-8000-0000000ac001',
       'gmail-demo-bounce-6001', t.id, t.contact_id, t.recipient_address, true, 'hard', '5.1.1', 550,
       '550-5.1.1 The email account that you tried to reach does not exist.',
       t.sent_at + interval '5 minutes', t.sent_at + interval '20 minutes'
  FROM outbound_touch t
 WHERE t.id = '00000006-0000-4000-8000-000000070001'
ON CONFLICT DO NOTHING;

INSERT INTO outbound_bounce
  (id, workspace_id, channel_account_id, provider_message_id, touch_id, contact_id, recipient_address, verified, kind,
   status_code, smtp_code, reason, received_at, detected_at)
SELECT '00000006-0000-4000-8000-0000000b0002', t.workspace_id, '00000005-0000-4000-8000-0000000ac001',
       'gmail-demo-bounce-6002', t.id, t.contact_id, t.recipient_address, true, 'soft', '4.2.2', 452,
       '452-4.2.2 The email account that you tried to reach is over quota. Gmail seguirá intentando.',
       t.sent_at + interval '10 minutes', t.sent_at + interval '30 minutes'
  FROM outbound_touch t
 WHERE t.id = '00000005-0000-4000-8000-000000070008'
ON CONFLICT DO NOTHING;

-- La ficha de Natalia, marcada como la deja el job: el correo no existe
-- (email_invalid, con el diagnóstico y la hora) y la píldora «Correo
-- rebotado» (bounced). Solo la primera vez: si alguien le corrige el
-- correo, la marca se borra (0038 §1) y volver a sembrar no la repone.
UPDATE contact c
   SET email_invalid = true, email_invalid_at = b.detected_at, email_invalid_reason = b.reason, bounced = true
  FROM outbound_bounce b
 WHERE c.id = '00000002-0000-4000-8000-0000000c0006'
   AND b.id = '00000006-0000-4000-8000-0000000b0001'
   AND c.email = b.recipient_address
   AND NOT c.email_invalid;


-- =====================================================================
-- 3 · La política de la demo, con calentamiento que se vea (r4)
-- ---------------------------------------------------------------------
-- 0002 la deja en 20 correos al día: con ese tope no hay nada que
-- calentar y /ventas/politica no enseña la rampa, que es la referencia
-- de Lemlist e Instantly de la historia. 80 al día con 14 días de
-- calentamiento: la cuenta nueva empieza en 20 y llega a 80 el día 14.
-- Solo si sigue con el tope de 0002: un cambio hecho a mano se respeta.
-- =====================================================================
UPDATE outbound_policy
   SET max_emails_per_day = 80, warmup_days = 14
 WHERE workspace_id = '00000002-0000-4000-8000-000000000001'
   AND max_emails_per_day = 20;


-- =====================================================================
-- 4 · La alerta del día
-- ---------------------------------------------------------------------
-- La que deja outbound.alerts para el LinkedIn que pide reconectar (seed
-- 0005), con su texto en el idioma del workspace y su enlace. La cuenta
-- se nombra como la nombra el job (channelAccountLabel, r4): su nombre
-- ya dice «(LinkedIn)», así que el canal no va delante otra vez. Vuelve a
-- hoy, sin leer, cada vez que se siembra: la campana de la demo siempre
-- tiene el aviso del día. Va con emailed_at puesto: es de la demo, y el
-- resumen por correo del job no tiene por qué mandarla a nadie.
-- =====================================================================
INSERT INTO notification (id, workspace_id, user_id, kind, severity, title_es, body_es, action_url, created_at,
                          emailed_at)
VALUES
  ('00000006-0000-4000-8000-0000000a1001', '00000002-0000-4000-8000-000000000001', NULL, 'outreach_account_down',
   'critical', 'Una cuenta de envío necesita atención',
   'No sale nada por Laura · Cocina fácil (LinkedIn) hasta que se reconecte: lo de ese canal espera en la '
   'cola. En tu política de envío ves qué dijo el proveedor y qué hacer.',
   '/ventas/politica#cuentas', now(), now())
ON CONFLICT (id) DO UPDATE SET body_es = EXCLUDED.body_es, created_at = now(), emailed_at = now(), read_at = NULL,
                               dismissed_at = NULL;
