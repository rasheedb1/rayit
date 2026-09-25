-- =====================================================================
-- Verificación del seed 0005 (outreach de la demo, VEN-9).
-- ---------------------------------------------------------------------
-- Cómo correrlo:
--   Postgres embebido, sin tocar Supabase:
--     node db/seed/verify/run.mjs 0005
--   Contra una base con 0037 y los seeds, como quien migra (mc_app no
--   lee los enlaces de baja):
--     node db/sql.mjs --admin -f db/seed/verify/0005.sql
--
-- Cada consulta con columna `ok` es una prueba: un false hace fallar
-- run.mjs. Lo que se cuida es que la demo cuente una cadencia entera,
-- escrita como la dejarían el callback del proveedor y el despachador.
-- =====================================================================

SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);

-- (a) Conteos: dos cuentas (una conectada, una por reconectar), una
--     secuencia desde la plantilla, tres enrolamientos (uno por
--     desenlace) y nueve toques en los estados que enseña la pantalla.
SELECT 'a_conteos' AS check_id,
       (SELECT count(*) FROM outreach_channel_account WHERE status = 'connected')       AS conectadas,
       (SELECT count(*) FROM outreach_channel_account WHERE status = 'needs_reconnect') AS por_reconectar,
       (SELECT string_agg(status, ',' ORDER BY status) FROM outbound_enrollment)        AS enrolamientos,
       (SELECT string_agg(status || '=' || n, ',' ORDER BY status)
          FROM (SELECT status, count(*) AS n FROM outbound_touch GROUP BY status) x)   AS toques,
       (SELECT count(*) FROM outreach_channel_account WHERE status = 'connected') = 1
         AND (SELECT count(*) FROM outreach_channel_account WHERE status = 'needs_reconnect') = 1
         AND (SELECT string_agg(status, ',' ORDER BY status) FROM outbound_enrollment) = 'active,cooldown,replied'
         AND (SELECT string_agg(status || '=' || n, ',' ORDER BY status)
                FROM (SELECT status, count(*) AS n FROM outbound_touch GROUP BY status) x)
             = 'canceled=2,draft=1,held=1,scheduled=1,sent=4' AS ok;

-- (b) La secuencia es la plantilla «Marca con campaña activa» copiada:
--     los mismos seis pasos, en el mismo orden, con su ángulo resuelto.
SELECT 'b_secuencia_desde_plantilla' AS check_id,
       (SELECT count(*) FROM outbound_step st WHERE st.sequence_id = s.id)                  AS pasos,
       (SELECT count(*) FROM outbound_step st WHERE st.sequence_id = s.id AND st.angle_id IS NULL) AS sin_angulo,
       s.status, s.active,
       (SELECT array_agg(st.step_type || '@' || st.day_offset ORDER BY st.day_offset, st.order_in_day)
          FROM outbound_step st WHERE st.sequence_id = s.id)
         = (SELECT array_agg((p->>'step_type') || '@' || (p->>'day_offset') ORDER BY n)
              FROM jsonb_array_elements(tpl.steps) WITH ORDINALITY AS e(p, n))
         AND (SELECT count(*) FROM outbound_step st WHERE st.sequence_id = s.id AND st.angle_id IS NULL) = 0
         AND s.status = 'active' AND s.active AS ok
  FROM outbound_sequence s
  JOIN outbound_sequence_template tpl ON tpl.id = s.template_id
 WHERE s.id = '00000005-0000-4000-8000-0000005e0001';

-- (c) Todo correo enviado tiene lo que prueba que la plataforma lo
--     envió (dirección, id de Gmail, Message-ID) y el enlace de baja de
--     su intento, con la misma dirección y confirmado.
SELECT 'c_correos_con_pruebas_y_enlace' AS check_id,
       count(*) AS correos_enviados,
       count(*) FILTER (WHERE t.recipient_address IS NOT NULL AND t.provider_message_id IS NOT NULL
                          AND t.message_id_rfc IS NOT NULL AND l.token_hash IS NOT NULL
                          AND l.recipient_address = t.recipient_address AND l.sent_at IS NOT NULL) AS completos,
       count(*) = 3
         AND count(*) FILTER (WHERE t.recipient_address IS NOT NULL AND t.provider_message_id IS NOT NULL
                                AND t.message_id_rfc IS NOT NULL AND l.token_hash IS NOT NULL
                                AND l.recipient_address = t.recipient_address AND l.sent_at IS NOT NULL) = 3 AS ok
  FROM outbound_touch t
  LEFT JOIN outbound_optout_link l ON l.touch_id = t.id AND l.attempt = t.attempt_count
 WHERE t.status = 'sent' AND t.channel = 'email';

-- (d) La salud del workspace demo ya no es todo cero: la cola tiene lo
--     que la pantalla enseña y la cuenta de LinkedIn cuenta como caída.
--     La ventana depende del reloj (lo enviado se congela en la primera
--     siembra), así que aquí solo se mira la cola y las cuentas.
SELECT 'd_salud' AS check_id,
       h->'queue' AS cola, h->'accountsDown' AS cuentas_caidas, h->'enabled' AS encendido,
       (h->'queue'->>'draft')::int = 1 AND (h->'queue'->>'scheduled')::int = 1
         AND (h->'queue'->>'held')::int = 1 AND (h->'queue'->>'processing')::int = 0
         AND (h->>'accountsDown')::int = 1
         -- Sembrar la demo no enciende el envío: la política de 0002 sigue apagada.
         AND NOT (h->>'enabled')::boolean AS ok
  FROM (SELECT outbound_health('00000002-0000-4000-8000-000000000001', 720) AS h) x;

-- (e) El programado es para el futuro: volver a sembrar lo reprograma
--     para mañana a las 10:30 de Bogotá.
SELECT 'e_programado_al_dia' AS check_id,
       scheduled_for,
       scheduled_for > now()
         AND to_char(scheduled_for AT TIME ZONE 'America/Bogota', 'HH24:MI') = '10:30' AS ok
  FROM outbound_touch
 WHERE id = '00000005-0000-4000-8000-000000070003';

-- (f) Los desenlaces cuadran con lo que respondió cada marca: el
--     enfriamiento vuelve a los 90 días de la respuesta, y lo que el
--     enrolamiento ya no va a enviar está cancelado con su motivo.
SELECT 'f_desenlaces' AS check_id,
       e.status, e.resume_at, m.resume_at AS vuelve_segun_la_respuesta,
       (SELECT string_agg(coalesce(t.blocked_reason, '-'), ',') FROM outbound_touch t
         WHERE t.enrollment_id = e.id AND t.status = 'canceled') AS cancelados,
       (e.status <> 'cooldown' OR abs(extract(epoch FROM e.resume_at - m.resume_at)) < 86400 * 2)
         AND (SELECT bool_and(t.blocked_reason IS NOT NULL) FROM outbound_touch t
               WHERE t.enrollment_id = e.id AND t.status = 'canceled') IS NOT FALSE AS ok
  FROM outbound_enrollment e
  LEFT JOIN outbound_message m ON m.enrollment_id = e.id AND m.direction = 'inbound'
 ORDER BY e.status;

-- (g) En last_error solo hay CÓDIGOS (docs/ventas-outreach.md §9.2), con
--     la forma que fija 0044: 'provider_error', 'unipile_status:CREDENTIALS'.
--     Una frase aquí sale en la pantalla como el motivo genérico y la demo
--     pierde su historia. Que cada código sea uno que la pantalla traduce
--     lo comprueba la prueba de la web (canales.test.ts, «la demo
--     sembrada»). El LinkedIn caído lleva el nombre de la persona, como el
--     que trae connection_params.im, sin el canal repetido.
SELECT 'g_last_error_son_codigos' AS check_id,
       string_agg(coalesce(last_error, '-'), ',' ORDER BY id) AS motivos,
       bool_and(last_error IS NULL OR last_error ~ '^[a-z_]+(:[A-Z_]+)?$')
         AND (SELECT last_error = 'unipile_status:CREDENTIALS' AND display_name NOT LIKE '%LinkedIn%'
                FROM outreach_channel_account WHERE id = '00000005-0000-4000-8000-0000000ac002') AS ok
  FROM outreach_channel_account;
