-- =====================================================================
-- Seed 9 · La actividad del outreach en la demo (VEN-16)
-- ---------------------------------------------------------------------
-- Hasta aquí la demo no enseñaba /ventas/actividad: no había ningún
-- toque fallido (no se veía el reintento ni por qué no se ofrece) y
-- ningún contador de uso (el widget de /ventas/canales decía «0 de 20» en
-- todas las cuentas y los 14 días estaban vacíos). Este seed deja lo que
-- dejarían el despachador y sus contadores con el Gmail de Laura
-- conectado y su LinkedIn caído (seed 0005):
--
--   * Camilo Herrera (Café Alma) entró en «Marca con campaña activa»:
--     Laura le dejó el comentario en LinkedIn a mano (paso 1), su correo
--     salió (paso 2) y el mensaje de LinkedIn del paso 3 FALLÓ ayer con
--     account_auth: la cuenta de LinkedIn perdió el permiso. Como no hay
--     otro LinkedIn conectado, la actividad no ofrece «Reintentar» sino
--     reconectar (outbound_touch_retry_block = account_down, 0072);
--   * Laura Quintero (Granos del Valle) recibió el comentario hace tres
--     días hábiles y su correo del paso 2 FALLÓ ayer con rejected: se
--     puede reintentar, y el botón «Correo · 1» de la cola lo devuelve a
--     la cola;
--   * los comentarios del paso 1 son gestos a mano (TEXTLESS_STEP_TYPES:
--     On Cue no los redacta ni los envía): quedan 'skipped' con
--     blocked_reason 'done_by_hand', «Hecho a mano», sin cuenta ni id del
--     proveedor, y no cuentan en el uso (pulido r6: antes figuraban como
--     enviados por Unipile o fallidos por la cuenta, estados que el
--     producto no produce; verify/0009.sql (f) lo vigila);
--   * los dos enrolamientos quedaron 'completed', como los deja el motor
--     cuando falla el único toque vivo (advanceEnrollment); reintentar el
--     correo de Laura reabre el suyo;
--   * los contadores de las cuentas de Laura, sacados de los toques que
--     el despachador reclamó (§3): el widget de uso dice lo mismo que el
--     historial, día por día, y cada uno de esos toques dice desde qué
--     cuenta salió.
--
-- Reglas del archivo (las de 0002, 0004, 0005 y 0006):
--   * Idempotente. UUID fijos y ON CONFLICT. Lo que ya pasó se congela en
--     la primera corrida (DO NOTHING), y los contadores salen de ello:
--     no crecen con el reloj.
--   * Nada real: direcciones y ids de la demo. La política de envío sigue
--     APAGADA (0002): el widget pinta estas cuentas «Sin envío», que es la
--     verdad de la demo, y sembrar en Supabase no manda nada.
--   * Requiere 0046, 0057 y 0072, y los seeds 0002 y 0005.
--
-- Y el paso 1 de Daniel y de Carolina (seed 0005), que empezaban la
-- cadencia en el paso 2: el embudo de la vista de flujo crecía hacia
-- abajo (verify/0009.sql lo vigila, paso a paso).
--
-- Mapa de identificadores (00000009-…, solo dígitos hexadecimales):
--   …-0000000e0004..005     outbound_enrollment       (e0 = enrolamiento)
--   …-000000070001..008     outbound_touch            (7 = toque)
-- =====================================================================

SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);
SELECT set_config('app.user_id', '00000002-0000-4000-8000-000000000002', false);
SELECT set_config('TimeZone', 'UTC', false);


-- =====================================================================
-- 1 · Los dos enrolamientos, terminados por su fallo
-- =====================================================================
WITH hoy AS (SELECT (now() AT TIME ZONE 'America/Bogota')::date AS d),
dias AS (
  SELECT array_agg(g::date ORDER BY g DESC) AS habiles
    FROM hoy, generate_series(hoy.d - 1, hoy.d - 30, interval '-1 day') g
   WHERE extract(isodow FROM g) < 6)
INSERT INTO outbound_enrollment
  (id, workspace_id, sequence_id, contact_id, current_step_id, status, context, enrolled_by, started_at, finished_at)
SELECT e.id::uuid, '00000002-0000-4000-8000-000000000001', '00000005-0000-4000-8000-0000005e0001', e.contact::uuid,
       e.step::uuid, 'completed', e.context::jsonb, '00000002-0000-4000-8000-000000000002',
       (habiles[e.desde] + time '09:00') AT TIME ZONE 'America/Bogota',
       (habiles[1] + e.fin) AT TIME ZONE 'America/Bogota'
  FROM dias, (VALUES
    -- Camilo Herrera (Café Alma): el mensaje de LinkedIn de ayer (paso 3) falló.
    ('00000009-0000-4000-8000-0000000e0004', '00000002-0000-4000-8000-0000000c0004', '00000005-0000-4000-8000-0000005e0103',
     '{"angles_used": ["presencia", "encaje_audiencia"]}', 5, time '10:10:05'),
    -- Laura Quintero (Granos del Valle): el correo de ayer falló.
    ('00000009-0000-4000-8000-0000000e0005', '00000002-0000-4000-8000-0000000c0009', '00000005-0000-4000-8000-0000005e0102',
     '{"angles_used": ["presencia"]}', 3, time '09:40:06')
  ) AS e(id, contact, step, context, desde, fin)
ON CONFLICT (id) DO NOTHING;


-- =====================================================================
-- 2 · Los toques
-- ---------------------------------------------------------------------
-- Como los deja el despachador: el intento (attempt_count 1), la hora del
-- reclamo, la cuenta con la que se intentó y, en lo fallido, el CÓDIGO
-- del motivo en blocked_reason (la pantalla lo traduce). En la ventana
-- laboral de Bogotá, como lo demás de la demo (verify/0005.sql (h)).
-- =====================================================================
WITH hoy AS (SELECT (now() AT TIME ZONE 'America/Bogota')::date AS d),
dias AS (
  SELECT array_agg(g::date ORDER BY g DESC) AS habiles
    FROM hoy, generate_series(hoy.d - 1, hoy.d - 30, interval '-1 day') g
   WHERE extract(isodow FROM g) < 6),
h AS (
  SELECT (habiles[5] + time '10:05') AT TIME ZONE 'America/Bogota' AS camilo_1,
         (habiles[3] + time '10:25') AT TIME ZONE 'America/Bogota' AS camilo_2,
         (habiles[1] + time '10:10') AT TIME ZONE 'America/Bogota' AS camilo_3,
         (habiles[3] + time '10:20') AT TIME ZONE 'America/Bogota' AS laura_1,
         (habiles[1] + time '09:40') AT TIME ZONE 'America/Bogota' AS laura_2,
         -- El paso 1 de Daniel y de Carolina (seed 0005), un día hábil antes de su correo.
         (habiles[7] + time '10:10') AT TIME ZONE 'America/Bogota' AS daniel_1,
         (habiles[11] + time '10:00') AT TIME ZONE 'America/Bogota' AS carolina_1,
         -- El paso 3 de Carolina iba a salir el primer día hábil después de su «ahora no».
         (SELECT (min(g)::date + time '10:30') AT TIME ZONE 'America/Bogota'
            FROM hoy, generate_series(hoy.d - 10, hoy.d - 1, interval '1 day') g WHERE extract(isodow FROM g) < 6) AS carolina_3
    FROM dias)
INSERT INTO outbound_touch
  (id, workspace_id, company_id, contact_id, sequence_id, step_index, enrollment_id, step_id, channel,
   subject, body, status, scheduled_for, claimed_at, sent_at, attempt_count, recipient_address,
   provider_message_id, blocked_reason, status_changed_at, created_at, channel_account_id)
VALUES
  -- Camilo · 1: el comentario en LinkedIn, hecho a mano.
  ('00000009-0000-4000-8000-000000070001', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e1', '00000002-0000-4000-8000-0000000c0004',
   '00000005-0000-4000-8000-0000005e0001', 1, '00000009-0000-4000-8000-0000000e0004',
   '00000005-0000-4000-8000-0000005e0101', 'linkedin', NULL, '',
   'skipped', (SELECT camilo_1 FROM h), NULL, NULL, 0, NULL, NULL, 'done_by_hand',
   (SELECT camilo_1 FROM h), (SELECT camilo_1 FROM h) - interval '1 hour', NULL),
  -- Camilo · 3: el mensaje de LinkedIn con la prueba de desempeño, fallido: la cuenta perdió el permiso.
  ('00000009-0000-4000-8000-000000070008', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e1', '00000002-0000-4000-8000-0000000c0004',
   '00000005-0000-4000-8000-0000005e0001', 3, '00000009-0000-4000-8000-0000000e0004',
   '00000005-0000-4000-8000-0000005e0103', 'linkedin', NULL,
   'Camilo, te dejo el video del café de olla que grabé con grano de origen: le fue mejor que a casi todo lo que publiqué este año.',
   'failed', (SELECT camilo_3 FROM h), (SELECT camilo_3 FROM h), NULL, 1, NULL, NULL, 'account_auth',
   (SELECT camilo_3 FROM h) + interval '5 seconds', (SELECT camilo_3 FROM h) - interval '1 hour',
   '00000005-0000-4000-8000-0000000ac002'),
  -- Laura Quintero · 1: el comentario en LinkedIn, hecho a mano.
  ('00000009-0000-4000-8000-000000070002', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e6', '00000002-0000-4000-8000-0000000c0009',
   '00000005-0000-4000-8000-0000005e0001', 1, '00000009-0000-4000-8000-0000000e0005',
   '00000005-0000-4000-8000-0000005e0101', 'linkedin', NULL, '',
   'skipped', (SELECT laura_1 FROM h), NULL, NULL, 0, NULL, NULL, 'done_by_hand',
   (SELECT laura_1 FROM h), (SELECT laura_1 FROM h) - interval '1 hour', NULL),
  -- Laura Quintero · 2: el correo del encaje de audiencia, rechazado por el proveedor. Se puede reintentar.
  ('00000009-0000-4000-8000-000000070003', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e6', '00000002-0000-4000-8000-0000000c0009',
   '00000005-0000-4000-8000-0000005e0001', 2, '00000009-0000-4000-8000-0000000e0005',
   '00000005-0000-4000-8000-0000005e0102', 'email', 'Tu grano y mi cocina',
   'Hola, Laura: la mitad de mis recetas de la semana llevan maíz o fríjol, y quien me sigue pregunta de dónde sale el grano. '
   '¿Te interesa ver cómo le fue a una receta con producto de origen en mi cuenta?',
   'failed', (SELECT laura_2 FROM h), (SELECT laura_2 FROM h), NULL, 1, 'lquintero@granosdelvalle.co', NULL, 'rejected',
   (SELECT laura_2 FROM h) + interval '6 seconds', (SELECT laura_2 FROM h) - interval '1 hour',
   '00000005-0000-4000-8000-0000000ac001'),
  -- Daniel Restrepo · 1 (pulido r1): el comentario en LinkedIn antes de su correo, hecho a mano. Sin él, el
  -- embudo de la cadencia crecía hacia abajo (el paso 2 salía a más gente que el paso 1).
  ('00000009-0000-4000-8000-000000070004', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e5', '00000002-0000-4000-8000-0000000c0008',
   '00000005-0000-4000-8000-0000005e0001', 1, '00000005-0000-4000-8000-0000000e0002',
   '00000005-0000-4000-8000-0000005e0101', 'linkedin', NULL, '',
   'skipped', (SELECT daniel_1 FROM h), NULL, NULL, 0, NULL, NULL, 'done_by_hand',
   (SELECT daniel_1 FROM h), (SELECT daniel_1 FROM h) - interval '1 hour', NULL),
  -- Carolina Ruiz · 1: el comentario en LinkedIn antes de su correo, hecho a mano.
  ('00000009-0000-4000-8000-000000070005', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e8', '00000002-0000-4000-8000-0000000c0012',
   '00000005-0000-4000-8000-0000005e0001', 1, '00000005-0000-4000-8000-0000000e0003',
   '00000005-0000-4000-8000-0000005e0101', 'linkedin', NULL, '',
   'skipped', (SELECT carolina_1 FROM h), NULL, NULL, 0, NULL, NULL, 'done_by_hand',
   (SELECT carolina_1 FROM h), (SELECT carolina_1 FROM h) - interval '1 hour', NULL),
  -- Carolina Ruiz · 3: el mensaje de LinkedIn, cancelado por su «ahora no» (como su paso 4 en 0005).
  ('00000009-0000-4000-8000-000000070006', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e8', '00000002-0000-4000-8000-0000000c0012',
   '00000005-0000-4000-8000-0000005e0001', 3, '00000005-0000-4000-8000-0000000e0003',
   '00000005-0000-4000-8000-0000005e0103', 'linkedin', NULL,
   'Carolina, te dejo el video de la olla en primer plano: 150 mil visualizaciones en una semana.',
   'canceled', (SELECT carolina_3 FROM h), NULL, NULL, 0, NULL, NULL, 'not_now',
   now() - interval '11 days', (SELECT carolina_1 FROM h) - interval '1 hour', NULL)
ON CONFLICT (id) DO NOTHING;


-- Camilo · 2: el correo del encaje de audiencia, que salió (con el hilo y el enlace de baja, como lo deja el
-- despachador: 0005 §5).
WITH hoy AS (SELECT (now() AT TIME ZONE 'America/Bogota')::date AS d),
dias AS (
  SELECT array_agg(g::date ORDER BY g DESC) AS habiles
    FROM hoy, generate_series(hoy.d - 1, hoy.d - 30, interval '-1 day') g
   WHERE extract(isodow FROM g) < 6),
h AS (SELECT (habiles[3] + time '10:25') AT TIME ZONE 'America/Bogota' AS camilo_2 FROM dias)
INSERT INTO outbound_touch
  (id, workspace_id, company_id, contact_id, sequence_id, step_index, enrollment_id, step_id, channel,
   subject, body, status, scheduled_for, claimed_at, sent_at, attempt_count, recipient_address,
   provider_message_id, message_id_rfc, thread_ref, status_changed_at, created_at, channel_account_id)
SELECT '00000009-0000-4000-8000-000000070007', '00000002-0000-4000-8000-000000000001',
       '00000002-0000-4000-8000-0000000000e1', '00000002-0000-4000-8000-0000000c0004',
       '00000005-0000-4000-8000-0000005e0001', 2, '00000009-0000-4000-8000-0000000e0004',
       '00000005-0000-4000-8000-0000005e0102', 'email', 'Café de origen en la cocina de mi audiencia',
       'Hola, Camilo: quienes me siguen preparan el café en casa cada mañana y siempre preguntan qué grano uso. '
       '¿Te cuento cómo le fue a la receta con grano de origen que hicimos juntos en abril?',
       'sent', h.camilo_2, h.camilo_2 - interval '8 seconds', h.camilo_2, 1, 'c.herrera@cafealma.co',
       'gmail-demo-0009-7', '<demo-0009-7@mail.gmail.com>', 'gmail-thread-demo-0009-7',
       h.camilo_2, h.camilo_2 - interval '1 hour', '00000005-0000-4000-8000-0000000ac001'
  FROM h
ON CONFLICT (id) DO NOTHING;

INSERT INTO outbound_optout_link
  (token_hash, workspace_id, touch_id, contact_id, attempt, recipient_address, claimed_at, sent_at)
SELECT encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex'),
       t.workspace_id, t.id, t.contact_id, t.attempt_count, t.recipient_address, t.claimed_at, t.sent_at
  FROM outbound_touch t
 WHERE t.id = '00000009-0000-4000-8000-000000070007' AND t.status = 'sent'
   AND NOT EXISTS (SELECT 1 FROM outbound_optout_link l WHERE l.touch_id = t.id AND l.attempt = t.attempt_count);


-- =====================================================================
-- 3 · Los contadores de las cuentas de Laura
-- ---------------------------------------------------------------------
-- Lo que sumó el reclamo, sacado de lo que la demo enseña: una acción por
-- cada toque que el despachador reclamó (enviado o fallido, con su
-- claimed_at) en el día local de su reclamo, en la cuenta de su canal (el
-- Gmail de Laura para el correo, su LinkedIn para LinkedIn) y, en el
-- correo, también en la fila del espacio (channel_account_id NULL: una
-- sola cuenta de correo, la misma cifra). La semana de cada cuenta es la
-- suma de sus días. Como lo suma outbound_counter_bump_at (0057).
--
-- Así el widget de uso de /ventas/canales casa con el historial de
-- /ventas/actividad, barra por barra: cada día es lo que salió o se
-- intentó ese día. La historia de la demo es que el envío salió unas
-- horas (los correos del último día hábil de 0006) y después se apagó
-- (0002: «Sin envío»); el uso de ese día es el de esos correos, y nada
-- más, y ningún día de fin de semana tiene uso. Antes el
-- seed inventaba cifras (12 hoy, 72 en la semana) que no casaban con
-- ningún envío: un creador que recorría la demo veía un uso que no había
-- salido.
--
-- Idempotente y quieto con el reloj: los toques enviados y fallidos se
-- congelan en la primera corrida, así que los contadores son siempre los
-- mismos (DO UPDATE los deja en la cifra que sale de los toques, también
-- sobre una base sembrada por una versión anterior de este archivo).
--
-- Antes de sumar, cada toque reclamado lleva la cuenta con la que salió
-- (r5): los correos sueltos de 0005 y 0006 no la traían, y el widget
-- decía «Correo 4 de 20 · laura@cocina-facil.test» mientras esas filas
-- del historial no llevaban «Desde laura@…». El despachador la anota al
-- reclamar (claimDueTouches); aquí se anota la única cuenta de ese canal
-- en la demo, solo donde falta: idempotente, y no pisa la de nadie.
-- =====================================================================
UPDATE outbound_touch t
   SET channel_account_id = CASE t.channel WHEN 'email' THEN '00000005-0000-4000-8000-0000000ac001'::uuid
                                           ELSE '00000005-0000-4000-8000-0000000ac002'::uuid END
 WHERE t.workspace_id = '00000002-0000-4000-8000-000000000001'
   AND t.status IN ('sent', 'failed') AND t.claimed_at IS NOT NULL
   AND t.channel IN ('email', 'linkedin')
   AND t.channel_account_id IS NULL;

WITH reclamados AS (
  SELECT t.workspace_id, t.channel, (t.claimed_at AT TIME ZONE w.timezone)::date AS dia, count(*)::int AS n
    FROM outbound_touch t
    JOIN workspace w ON w.id = t.workspace_id
   WHERE t.workspace_id = '00000002-0000-4000-8000-000000000001'
     AND t.status IN ('sent', 'failed') AND t.claimed_at IS NOT NULL
     AND t.channel IN ('email', 'linkedin')
   GROUP BY t.workspace_id, t.channel, (t.claimed_at AT TIME ZONE w.timezone)::date
),
filas AS (
  SELECT r.workspace_id,
         CASE r.channel WHEN 'email' THEN '00000005-0000-4000-8000-0000000ac001'::uuid
                        ELSE '00000005-0000-4000-8000-0000000ac002'::uuid END AS cuenta,
         r.dia, r.channel AS accion, r.n
    FROM reclamados r
  UNION ALL
  SELECT r.workspace_id, NULL::uuid, r.dia, 'email', r.n FROM reclamados r WHERE r.channel = 'email'
)
INSERT INTO outbound_counter (workspace_id, channel_account_id, period, period_start, action_type, count)
SELECT workspace_id, cuenta, 'day', dia, accion, n FROM filas
ON CONFLICT (workspace_id, channel_account_id, period, period_start, action_type)
DO UPDATE SET count = EXCLUDED.count;

INSERT INTO outbound_counter (workspace_id, channel_account_id, period, period_start, action_type, count)
SELECT c.workspace_id, c.channel_account_id, 'week', c.period_start - (extract(isodow FROM c.period_start)::int - 1), c.action_type,
       sum(c.count)::int
  FROM outbound_counter c
 WHERE c.workspace_id = '00000002-0000-4000-8000-000000000001'
   AND c.channel_account_id IN ('00000005-0000-4000-8000-0000000ac001', '00000005-0000-4000-8000-0000000ac002')
   AND c.period = 'day'
 GROUP BY c.workspace_id, c.channel_account_id, c.action_type, c.period_start - (extract(isodow FROM c.period_start)::int - 1)
ON CONFLICT (workspace_id, channel_account_id, period, period_start, action_type)
DO UPDATE SET count = EXCLUDED.count;
