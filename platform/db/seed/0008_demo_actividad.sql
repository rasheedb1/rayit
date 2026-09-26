-- =====================================================================
-- Seed 8 · La actividad del outreach en la demo (VEN-16)
-- ---------------------------------------------------------------------
-- Hasta aquí la demo no enseñaba /ventas/actividad: no había ningún
-- toque fallido (no se veía el reintento ni por qué no se ofrece) y
-- ningún contador de uso (el widget de /ventas/canales decía «0 de 20» en
-- todas las cuentas y los 14 días estaban vacíos). Este seed deja lo que
-- dejarían el despachador y sus contadores con el Gmail de Laura
-- conectado y su LinkedIn caído (seed 0005):
--
--   * Camilo Herrera (Café Alma) entró en «Marca con campaña activa» y su
--     primer paso, el comentario en LinkedIn, FALLÓ con account_auth: la
--     cuenta de LinkedIn perdió el permiso. Como no hay otro LinkedIn
--     conectado, la actividad no ofrece «Reintentar» sino reconectar
--     (outbound_touch_retry_block = account_down, 0065);
--   * Laura Quintero (Granos del Valle) recibió el comentario hace tres
--     días hábiles (antes de que LinkedIn cayera) y su correo del paso 2
--     FALLÓ ayer con rejected: se puede reintentar, y el botón «Correo · 1»
--     de la cola lo devuelve a la cola;
--   * los dos enrolamientos quedaron 'completed', como los deja el motor
--     cuando falla el único toque vivo (advanceEnrollment); reintentar el
--     correo de Laura reabre el suyo;
--   * los contadores del Gmail de Laura en sus últimos días hábiles: el
--     día de la cuenta, el día del espacio (una sola cuenta de correo: la
--     misma cifra) y la semana de la cuenta (la suma de sus días), como
--     los suma outbound_counter_bump_at (0052). Así el widget de uso tiene
--     barra hoy y una historia de 14 días con un día lleno y uno cerca.
--
-- Reglas del archivo (las de 0002, 0004, 0005 y 0006):
--   * Idempotente. UUID fijos y ON CONFLICT. Lo que ya pasó se congela en
--     la primera corrida (DO NOTHING). Un día nuevo añade su fila de
--     contador (outbound_counter crece con el reloj, y verify/run.mjs lo
--     sabe: CRECEN_CON_EL_RELOJ); la semana se recalcula como la suma de
--     sus días, nunca por debajo de lo que ya tenía.
--   * Nada real: direcciones y ids de la demo. La política de envío sigue
--     APAGADA (0002): el widget pinta estas cuentas «Sin envío», que es la
--     verdad de la demo, y sembrar en Supabase no manda nada.
--   * Requiere 0037, 0052 y 0065, y los seeds 0002 y 0005.
--
-- Mapa de identificadores (00000008-…, solo dígitos hexadecimales):
--   …-0000000e0004..005     outbound_enrollment       (e0 = enrolamiento)
--   …-000000070001..003     outbound_touch            (7 = toque)
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
    -- Camilo Herrera (Café Alma): el comentario de ayer falló.
    ('00000008-0000-4000-8000-0000000e0004', '00000002-0000-4000-8000-0000000c0004', '00000005-0000-4000-8000-0000005e0101',
     '{"angles_used": []}', 1, time '10:10:05'),
    -- Laura Quintero (Granos del Valle): el correo de ayer falló.
    ('00000008-0000-4000-8000-0000000e0005', '00000002-0000-4000-8000-0000000c0009', '00000005-0000-4000-8000-0000005e0102',
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
  SELECT (habiles[1] + time '10:10') AT TIME ZONE 'America/Bogota' AS camilo_1,
         (habiles[3] + time '10:20') AT TIME ZONE 'America/Bogota' AS laura_1,
         (habiles[1] + time '09:40') AT TIME ZONE 'America/Bogota' AS laura_2
    FROM dias)
INSERT INTO outbound_touch
  (id, workspace_id, company_id, contact_id, sequence_id, step_index, enrollment_id, step_id, channel,
   subject, body, status, scheduled_for, claimed_at, sent_at, attempt_count, recipient_address,
   provider_message_id, blocked_reason, status_changed_at, created_at, channel_account_id)
VALUES
  -- Camilo · 1: el comentario en LinkedIn, fallido: la cuenta perdió el permiso.
  ('00000008-0000-4000-8000-000000070001', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e1', '00000002-0000-4000-8000-0000000c0004',
   '00000005-0000-4000-8000-0000005e0001', 1, '00000008-0000-4000-8000-0000000e0004',
   '00000005-0000-4000-8000-0000005e0101', 'linkedin', NULL,
   'Muy buena la cata de café de origen del viernes. El video del tostado en cámara lenta es de lo mejor que vi esta semana.',
   'failed', (SELECT camilo_1 FROM h), (SELECT camilo_1 FROM h), NULL, 1, NULL, NULL, 'account_auth',
   (SELECT camilo_1 FROM h) + interval '5 seconds', (SELECT camilo_1 FROM h) - interval '1 hour',
   '00000005-0000-4000-8000-0000000ac002'),
  -- Laura Quintero · 1: el comentario en LinkedIn, enviado antes de que la cuenta cayera.
  ('00000008-0000-4000-8000-000000070002', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e6', '00000002-0000-4000-8000-0000000c0009',
   '00000005-0000-4000-8000-0000005e0001', 1, '00000008-0000-4000-8000-0000000e0005',
   '00000005-0000-4000-8000-0000005e0101', 'linkedin', NULL,
   'La receta de arepas con maíz del Valle quedó perfecta. Se nota el cuidado en el grano.',
   'sent', (SELECT laura_1 FROM h), (SELECT laura_1 FROM h) - interval '9 seconds', (SELECT laura_1 FROM h), 1, NULL,
   'unipile-demo-comment-0008', NULL,
   (SELECT laura_1 FROM h), (SELECT laura_1 FROM h) - interval '1 hour', '00000005-0000-4000-8000-0000000ac002'),
  -- Laura Quintero · 2: el correo del encaje de audiencia, rechazado por el proveedor. Se puede reintentar.
  ('00000008-0000-4000-8000-000000070003', '00000002-0000-4000-8000-000000000001',
   '00000002-0000-4000-8000-0000000000e6', '00000002-0000-4000-8000-0000000c0009',
   '00000005-0000-4000-8000-0000005e0001', 2, '00000008-0000-4000-8000-0000000e0005',
   '00000005-0000-4000-8000-0000005e0102', 'email', 'Tu grano y mi cocina',
   'Hola, Laura: la mitad de mis recetas de la semana llevan maíz o fríjol, y quien me sigue pregunta de dónde sale el grano. '
   '¿Te interesa ver cómo le fue a una receta con producto de origen en mi cuenta?',
   'failed', (SELECT laura_2 FROM h), (SELECT laura_2 FROM h), NULL, 1, 'lquintero@granosdelvalle.co', NULL, 'rejected',
   (SELECT laura_2 FROM h) + interval '6 seconds', (SELECT laura_2 FROM h) - interval '1 hour',
   '00000005-0000-4000-8000-0000000ac001')
ON CONFLICT (id) DO NOTHING;


-- =====================================================================
-- 3 · Los contadores del Gmail de Laura
-- ---------------------------------------------------------------------
-- Los últimos siete días locales, solo los hábiles (el motor no envía en
-- fin de semana), con cifras dentro del tope de la cuenta (20): hoy 12,
-- y hacia atrás 17 (cerca del límite), 20 (lleno), 9, 14, 11 y 8. Cada
-- día va dos veces, como lo suma el reclamo: en la fila de la cuenta y en
-- la del espacio (channel_account_id NULL: una sola cuenta de correo, la
-- misma cifra). La semana de la cuenta es la suma de sus días.
-- =====================================================================
WITH hoy AS (SELECT (now() AT TIME ZONE 'America/Bogota')::date AS d),
uso AS (
  SELECT hoy.d - k AS dia, (ARRAY[12, 17, 20, 9, 14, 11, 8])[k + 1] AS n
    FROM hoy, generate_series(0, 6) AS k
   WHERE extract(isodow FROM hoy.d - k) < 6
)
INSERT INTO outbound_counter (workspace_id, channel_account_id, period, period_start, action_type, count)
SELECT '00000002-0000-4000-8000-000000000001', cuenta.id, 'day', uso.dia, 'email', uso.n
  FROM uso, (VALUES ('00000005-0000-4000-8000-0000000ac001'::uuid), (NULL::uuid)) AS cuenta(id)
ON CONFLICT (workspace_id, channel_account_id, period, period_start, action_type) DO NOTHING;

INSERT INTO outbound_counter (workspace_id, channel_account_id, period, period_start, action_type, count)
SELECT c.workspace_id, c.channel_account_id, 'week', c.period_start - (extract(isodow FROM c.period_start)::int - 1), 'email',
       sum(c.count)::int
  FROM outbound_counter c
 WHERE c.workspace_id = '00000002-0000-4000-8000-000000000001'
   AND c.channel_account_id = '00000005-0000-4000-8000-0000000ac001'
   AND c.period = 'day' AND c.action_type = 'email'
 GROUP BY c.workspace_id, c.channel_account_id, c.period_start - (extract(isodow FROM c.period_start)::int - 1)
ON CONFLICT (workspace_id, channel_account_id, period, period_start, action_type)
DO UPDATE SET count = greatest(outbound_counter.count, EXCLUDED.count);
