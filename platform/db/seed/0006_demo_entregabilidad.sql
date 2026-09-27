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
--     el job (/ventas/canales, CANALES_URL desde la integración de la
--     fase 4).
--
-- Ronda 4: la demo tiene que CONTAR la entregabilidad al abrir
-- /ventas/politica, y antes no lo hacía (todo era de hace días: «Salud de
-- hoy» decía 0 enviados y «Sin envíos todavía» encima de dos rebotes, y
-- con un tope de 20 al día el recuadro del calentamiento solo decía que
-- no hacía falta calentar). Ahora:
--   * el correo a Natalia y tres más salen el último día hábil, dentro de
--     la ventana de envío del espacio (pulido r3, §1): entre semana por la
--     tarde «Rebotes» tiene cifra (1 de 4) y «Correos enviados» también;
--     en fin de semana no sale nada, como en el producto;
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
--   * Requiere entregabilidad (outbound_bounce, contact.email_invalid y los avisos
--     del outreach en notification) y el seed 0005 (el Gmail de Laura y el
--     correo a Olla Fácil).
--
-- Mapa de identificadores (00000006-…, solo dígitos hexadecimales):
--   …-000000070001          outbound_touch            (el correo que rebotó)
--   …-000000070002..004     outbound_touch            (los otros tres del día, r4)
--   …-0000000b0001..002     outbound_bounce           (b = rebote)
--   …-0000000a1001          notification              (a1 = alerta)
-- =====================================================================

SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);
SELECT set_config('app.user_id', '00000002-0000-4000-8000-000000000002', false);
SELECT set_config('TimeZone', 'UTC', false);


-- =====================================================================
-- 1 · Los cuatro correos del último día hábil (el que rebotó y tres más)
-- ---------------------------------------------------------------------
-- Correos sueltos (sin secuencia) desde el Gmail de Laura, con lo que deja
-- el despachador: el intento, la hora del reclamo, la dirección EXACTA, el
-- id de Gmail y la cabecera Message-ID. El de Natalia Vélez rebota (§2);
-- los otros tres van a fichas con correo que no están en ninguna
-- secuencia de la demo, y llegaron.
--
-- Cuándo salen (pulido r3). Antes salían «hace 3, 5, 7 y 9 horas» del
-- reloj de quien sembraba, sin mirar el día: sembrada un domingo, la demo
-- enseñaba cuatro correos reclamados en domingo (y a las 2 de la mañana,
-- si se sembraba temprano), su contador diario caía en fin de semana y
-- verify/0009 (c) salía en rojo cada sábado y cada domingo. La demo
-- contradecía la ventana de envío que el propio producto impone (0056).
-- Ahora salen dentro de la ventana de la política del espacio
-- (send_window_start/end; 09:00–17:00 si no hay política), en su zona
-- horaria (workspace.timezone), el ÚLTIMO día hábil en que ya pasaron:
--   · a los 10, 35, 55 y 80 % de la ventana (09:48, 11:48, 13:24 y 15:24
--     con la de la demo), el de Natalia el tercero;
--   · el día es hoy si es de lunes a viernes y ya pasó el último más media
--     hora (lo que tarda el aviso de rebote en llegar y leerse, §2); si
--     no, el día hábil anterior. Un sábado, un domingo o un lunes a
--     primera hora, el viernes.
-- Entre semana por la tarde «Salud de hoy» cuenta los cuatro (1 rebote de
-- 4); en fin de semana dice, con razón, que no salió nada en 24 horas.
-- Lo comprueban verify/0006.sql (e) y db/seed/verify/ancla.test.mjs, que
-- evalúa `ws` y `ancla` a varias horas y días sin depender del reloj.
--
-- Con la ficha de Natalia ya marcada (la segunda pasada), la regla del
-- correo inválido (entregabilidad §2) rechaza dar de alta un correo 'sent'
-- a esa dirección antes de que ON CONFLICT lo descarte (el disparador
-- BEFORE corre primero). Por eso solo se insertan las filas que no
-- existen: con cero filas, el disparador no corre.
-- =====================================================================
WITH ws AS (
  SELECT w.timezone AS tz,
         coalesce(p.send_window_start, time '09:00') AS ini,
         coalesce(p.send_window_end, time '17:00') - coalesce(p.send_window_start, time '09:00') AS largo
    FROM workspace w
    LEFT JOIN outbound_policy p ON p.workspace_id = w.id
   WHERE w.id = '00000002-0000-4000-8000-000000000001'
),
ancla AS (
  SELECT ws.tz, ws.ini, ws.largo, max(g::date) AS dia
    FROM ws, generate_series((now() AT TIME ZONE ws.tz)::date - 7, (now() AT TIME ZONE ws.tz)::date, interval '1 day') g
   WHERE extract(isodow FROM g) < 6
     AND ((g::date + ws.ini + ws.largo * 0.8::float8 + interval '30 minutes') AT TIME ZONE ws.tz) <= now()
   GROUP BY ws.tz, ws.ini, ws.largo
),
correos (id, company_id, contact_id, subject, body, recipient_address, n, fraccion, reclamo) AS (
  VALUES
  ('00000006-0000-4000-8000-000000070002'::uuid, '00000002-0000-4000-8000-0000000000e2'::uuid,
   '00000002-0000-4000-8000-0000000c0001'::uuid,
   'Recetas de mercado para Fresko',
   'Hola, Camila: mis recetas de esta semana salen de un mercado de barrio como los de Fresko. '
   '¿Te muestro cómo quedaría una con sus productos frescos?',
   'camila.rojas@freskomarket.co', 6002, 0.10::float8, interval '5 seconds'),
  ('00000006-0000-4000-8000-000000070003', '00000002-0000-4000-8000-0000000000e3',
   '00000002-0000-4000-8000-0000000c0007',
   'La cocina de Hogar Lindo, en cámara',
   'Hola, Andrea: grabo en una cocina pequeña y quien me sigue pregunta por cada utensilio. '
   '¿Hablamos de una serie con los de Hogar Lindo?',
   'andrea.salazar@hogarlindo.co', 6003, 0.35, interval '4 seconds'),
  ('00000006-0000-4000-8000-000000070001', '00000002-0000-4000-8000-0000000000e4',
   '00000002-0000-4000-8000-0000000c0006',
   'Una idea para el trade de Nutrivé',
   'Hola, Natalia: grabo recetas rápidas con productos de supermercado, y las de Nutrivé ya salen en mis videos. '
   '¿Te interesa ver una propuesta para el punto de venta?',
   'natalia.velez@nutrive.co', 6001, 0.55, interval '6 seconds'),
  ('00000006-0000-4000-8000-000000070004', '00000002-0000-4000-8000-0000000000e6',
   '00000002-0000-4000-8000-0000000c0009',
   'Granos del Valle en el almuerzo de la semana',
   'Hola, Laura: el video de lentejas de la semana pasada fue el más guardado del mes. '
   '¿Te interesa una receta con Granos del Valle?',
   'lquintero@granosdelvalle.co', 6004, 0.80, interval '7 seconds')
),
x AS (
  SELECT c.*, date_trunc('minute', a.dia + a.ini + a.largo * c.fraccion) AT TIME ZONE a.tz AS enviado
    FROM correos c, ancla a
)
INSERT INTO outbound_touch
  (id, workspace_id, company_id, contact_id, channel, subject, body, status, scheduled_for, claimed_at, sent_at,
   attempt_count, recipient_address, provider_message_id, message_id_rfc, thread_ref, status_changed_at, created_at)
SELECT x.id, '00000002-0000-4000-8000-000000000001', x.company_id, x.contact_id, 'email', x.subject, x.body, 'sent',
       x.enviado, x.enviado - x.reclamo, x.enviado, 1,
       x.recipient_address, 'gmail-demo-' || x.n, '<demo-' || x.n || '@mail.gmail.com>', 'gmail-thread-demo-' || x.n,
       x.enviado, x.enviado - interval '1 hour'
  FROM x
 WHERE NOT EXISTS (SELECT 1 FROM outbound_touch t WHERE t.id = x.id)
ON CONFLICT (id) DO NOTHING;

-- Sus enlaces de baja, como los deja el despachador al reclamar (0046 §4.5).
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
-- correo, la marca se borra (entregabilidad §1) y volver a sembrar no la repone.
UPDATE contact c
   SET email_invalid = true, email_invalid_at = b.detected_at, email_invalid_reason = b.reason, bounced = true
  FROM outbound_bounce b
 WHERE c.id = '00000002-0000-4000-8000-0000000c0006'
   AND b.id = '00000006-0000-4000-8000-0000000b0001'
   AND c.email = b.recipient_address
   AND NOT c.email_invalid;

-- El cursor de rebotes del Gmail de la demo, como lo deja el job cada
-- media hora (r5). Sin él, «Salud de hoy» decía «todavía no leemos los
-- rebotes de tu Gmail» encima de una tabla con dos rebotes: la página se
-- contradecía. Con él, la demo cuenta lo que se verá cuando la lectura
-- esté conectada (VEN-9); una cuenta real sin leer sigue con su aviso.
-- Se mueve en cada siembra: la demo siempre está leída hace poco.
UPDATE outreach_channel_account
   SET bounces_read_at = now() - interval '20 minutes'
 WHERE id = '00000005-0000-4000-8000-0000000ac001';

-- El LinkedIn caído de 0005 guardaba una frase con la jerga del proveedor
-- («Unipile: … (CREDENTIALS)»), y «Salud de hoy» la enseñaba tal cual.
-- En last_error solo van CÓDIGOS (CHANNEL_ERROR_CODES de VEN-9, y
-- 'unipile_status:<X>' para lo que Unipile dice de una sesión): la
-- pantalla los traduce en el idioma del espacio. Solo si todavía tiene la
-- frase de 0005: lo que el keepalive haya escrito después se respeta.
UPDATE outreach_channel_account
   SET last_error = 'unipile_status:CREDENTIALS'
 WHERE id = '00000005-0000-4000-8000-0000000ac002'
   AND last_error LIKE 'Unipile:%';


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
   -- La misma frase que deja el job (messages.ts): sin «en tu política de
   -- envío ves…», porque se lee dentro de esa misma página.
   -- La cuenta se llama como la trae Unipile (seed 0005, VEN-9 r4): «Laura Méndez», y el job le antepone el canal.
   'No sale nada por LinkedIn: Laura Méndez hasta que se reconecte: lo de ese canal espera en la cola.',
   '/ventas/canales', now(), now())
ON CONFLICT (id) DO UPDATE SET body_es = EXCLUDED.body_es, action_url = EXCLUDED.action_url, created_at = now(), emailed_at = now(), read_at = NULL,
                               dismissed_at = NULL;
